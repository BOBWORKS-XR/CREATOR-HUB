use super::*;
use crate::{
    archive, production_verify, ArchiveBinding, VerifiedPackage, ENTRYPOINT, MAX_ARCHIVE,
    MAX_ENTRIES, MAX_TOTAL,
};
use flate2::{write::GzEncoder, Compression};
use std::{cell::Cell, collections::BTreeMap, io::Write};

#[test]
fn workflow_runner_temp_is_scoped_to_each_cargo_step_not_job_environment() {
    let workflow = include_str!("../../../.github/workflows/linux-portable-deployment.yml")
        .replace("\r\n", "\n");
    let step_environment = concat!(
        "        env:\n",
        "          CARGO_TARGET_DIR: ${{ runner.temp }}/linux-portable-deployment-target\n",
        "        run: |\n",
        "          set -euo pipefail\n",
    );
    assert!(
        !workflow.contains("\n    env:"),
        "runner context is not available in job-level env"
    );
    assert_eq!(workflow.matches("runner.temp").count(), 2);
    assert_eq!(workflow.matches(step_environment).count(), 2);
    for first_command in [
        "cargo fmt --manifest-path",
        "cargo test --locked --manifest-path",
    ] {
        assert!(workflow.contains(&format!("{step_environment}          {first_command}")));
    }
}

fn test_verify(bytes: &[u8], signature: &[u8]) -> Result<()> {
    require(
        signature == digest(bytes).as_bytes(),
        "Test fixture signature changed",
    )
}

fn elf(marker: u8) -> Vec<u8> {
    let mut data = vec![0; 64];
    data[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
    data[18] = 0x3e;
    data[63] = marker;
    data
}

fn gzip(data: &[u8]) -> Vec<u8> {
    let mut gzip = GzEncoder::new(Vec::new(), Compression::fast());
    gzip.write_all(data).unwrap();
    gzip.finish().unwrap()
}

fn tar(entries: &[(&str, &[u8], u32, u8)]) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    for (path, data, mode, kind) in entries {
        let mut header = tar::Header::new_ustar();
        header.set_path(path).unwrap();
        header.set_entry_type(tar::EntryType::new(*kind));
        header.set_mode(*mode);
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        header.set_size(data.len() as u64);
        header.set_cksum();
        builder.append(&header, *data).unwrap();
    }
    builder.into_inner().unwrap()
}

struct Fixture {
    manifest: Manifest,
    raw: Vec<u8>,
}

impl Fixture {
    fn new(version: &str) -> Self {
        let binary = elf(if version == "0.1.16" { 16 } else { 17 });
        let entries = BTreeMap::from([
            ("usr".into(), Entry::Directory { mode: 0o755 }),
            ("usr/bin".into(), Entry::Directory { mode: 0o755 }),
            (
                ENTRYPOINT.into(),
                Entry::File {
                    size: binary.len() as u64,
                    sha256: digest(&binary),
                    mode: 0o755,
                },
            ),
            (
                "usr/data.txt".into(),
                Entry::File {
                    size: 9,
                    sha256: digest(b"preserved"),
                    mode: 0o644,
                },
            ),
        ]);
        let raw = gzip(&tar(&[
            ("usr", b"", 0o755, b'5'),
            ("usr/bin", b"", 0o755, b'5'),
            (ENTRYPOINT, &binary, 0o755, b'0'),
            ("usr/data.txt", b"preserved", 0o644, b'0'),
        ]));
        Self {
            manifest: Manifest {
                schema_version: 1,
                app_id: "creator-hub".into(),
                platform: "linux".into(),
                architecture: "x86_64".into(),
                version: version.into(),
                source_commit: "a".repeat(40),
                source_tree: "b".repeat(40),
                format: "appdir-tar-gzip-v1".into(),
                entrypoint: ENTRYPOINT.into(),
                archive: ArchiveBinding {
                    size: raw.len() as u64,
                    sha256: digest(&raw),
                    unpacked_size: 73,
                },
                entries,
            },
            raw,
        }
    }
    fn bind(&mut self) {
        self.manifest.archive.size = self.raw.len() as u64;
        self.manifest.archive.sha256 = digest(&self.raw);
    }
    fn bytes(&self) -> Vec<u8> {
        serde_json::to_vec(&self.manifest).unwrap()
    }
    fn package(&self) -> Result<VerifiedPackage> {
        let bytes = self.bytes();
        let signature = digest(&bytes).into_bytes();
        let manifest = signed_manifest(
            &bytes,
            &signature,
            &Expected::linux_x86_64(&self.manifest.version)?,
            &test_verify,
        )?;
        let contents = archive::decode(&self.raw, &manifest)?;
        Ok(VerifiedPackage {
            manifest,
            bytes,
            signature,
            contents,
        })
    }
}

fn setup() -> (tempfile::TempDir, Store) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap().join("portable");
    let store = Store::create_inner(&root).unwrap();
    (temp, store)
}
fn stage(store: &Store, package: &VerifiedPackage) -> String {
    store
        .stage_with(package, &|| false, &|_| Ok(()), &test_verify)
        .unwrap()
}
fn activate(
    store: &Store,
    package: &VerifiedPackage,
    previous: Option<&SelectionSnapshot>,
) -> SelectionSnapshot {
    let id = stage(store, package);
    match store
        .activate_with(
            &id,
            &Expected::linux_x86_64(&package.manifest.version).unwrap(),
            previous,
            &|| false,
            &|_| Ok(()),
            &test_verify,
        )
        .unwrap()
    {
        Activation::Committed(value) => value,
        Activation::Unchanged(_) => panic!("new fixture must commit"),
    }
}
fn interrupt(site: &'static str) -> impl Fn(&str) -> Result<()> {
    move |actual| {
        if site == actual {
            Err(refused("simulated interruption"))
        } else {
            Ok(())
        }
    }
}

#[test]
fn complete_archive_and_manifest_round_trip() {
    let f = Fixture::new("0.1.16");
    let p = f.package().unwrap();
    assert_eq!(p.generation(), digest(&f.bytes()));
    assert_eq!(p.contents.len(), 4);
    assert_eq!(p.manifest().entrypoint, ENTRYPOINT);
}

#[test]
fn complete_ustar_prefix_paths_are_verified_and_staged_without_extensions() {
    let mut fixture = Fixture::new("0.1.16");
    let directory = format!("usr/share/{}", "d".repeat(64));
    let resource = format!("{directory}/{}.bin", "r".repeat(64));
    assert!(resource.len() > 100);
    for name in ["usr/share", directory.as_str()] {
        fixture
            .manifest
            .entries
            .insert(name.into(), Entry::Directory { mode: 0o755 });
    }
    fixture.manifest.entries.insert(
        resource.clone(),
        Entry::File {
            size: 5,
            sha256: digest(b"asset"),
            mode: 0o644,
        },
    );
    fixture.manifest.archive.unpacked_size += 5;
    let binary = elf(16);
    fixture.raw = gzip(&tar(&[
        ("usr/", b"", 0o755, b'5'),
        ("usr/bin/", b"", 0o755, b'5'),
        (ENTRYPOINT, &binary, 0o755, b'0'),
        ("usr/data.txt", b"preserved", 0o644, b'0'),
        ("usr/share/", b"", 0o755, b'5'),
        (&directory, b"", 0o755, b'5'),
        (&resource, b"asset", 0o644, b'0'),
    ]));
    fixture.bind();
    let package = fixture.package().unwrap();
    assert_eq!(package.contents[&resource], b"asset");
    let (_temp, store) = setup();
    let selected = activate(&store, &package, None);
    assert_eq!(store.snapshot_with(&test_verify).unwrap(), Some(selected));
    assert_eq!(
        fs::read(
            store
                .root
                .join("generations")
                .join(package.generation())
                .join("AppDir")
                .join(resource)
        )
        .unwrap(),
        b"asset"
    );
}

#[test]
fn production_key_cannot_be_replaced_by_the_internal_test_seam() {
    let f = Fixture::new("0.1.16");
    let temp = tempfile::tempdir().unwrap();
    let archive = temp.path().join("payload.tar.gz");
    fs::write(&archive, &f.raw).unwrap();
    assert!(crate::verify(
        &f.bytes(),
        digest(&f.bytes()).as_bytes(),
        &archive,
        &Expected::linux_x86_64("0.1.16").unwrap()
    )
    .is_err());
    assert!(production_verify(&f.bytes(), b"").is_err());
}

#[test]
fn actual_minisign_library_verifies_known_public_fixture_and_rejects_production_key() {
    let key = minisign_verify::PublicKey::from_base64(
        "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3",
    )
    .unwrap();
    let sig = b"untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==";
    let signature = minisign_verify::Signature::decode(std::str::from_utf8(sig).unwrap()).unwrap();
    key.verify(b"test", &signature, false).unwrap();
    assert!(key.verify(b"changed", &signature, false).is_err());
    assert!(production_verify(b"test", sig).is_err());
}

#[test]
fn changed_signature_or_signed_manifest_is_refused_before_archive() {
    let f = Fixture::new("0.1.16");
    let bytes = f.bytes();
    assert!(signed_manifest(
        &bytes,
        b"other",
        &Expected::linux_x86_64("0.1.16").unwrap(),
        &test_verify
    )
    .is_err());
    let mut changed = bytes.clone();
    changed.push(b' ');
    assert!(signed_manifest(
        &changed,
        digest(&bytes).as_bytes(),
        &Expected::linux_x86_64("0.1.16").unwrap(),
        &test_verify
    )
    .is_err());
}

#[test]
fn expected_version_architecture_platform_source_format_and_entrypoint_are_finite() {
    let f = Fixture::new("0.1.16");
    for (key, value) in [
        ("version", "0.1.17"),
        ("architecture", "aarch64"),
        ("platform", "windows"),
        ("appId", "other"),
        ("sourceCommit", "unknown"),
        ("sourceTree", "UNKNOWN"),
        ("format", "zip"),
        ("entrypoint", "AppRun"),
    ] {
        let mut value_json = serde_json::to_value(&f.manifest).unwrap();
        value_json[key] = value.into();
        let bytes = serde_json::to_vec(&value_json).unwrap();
        assert!(
            signed_manifest(
                &bytes,
                digest(&bytes).as_bytes(),
                &Expected::linux_x86_64("0.1.16").unwrap(),
                &test_verify
            )
            .is_err(),
            "{key}"
        );
    }
    for version in ["v0.1.16", "0.1", "0.1.16-preview.1", "0.1.16+metadata"] {
        assert!(Expected::linux_x86_64(version).is_err());
    }
}

#[test]
fn duplicate_unknown_and_oversized_manifest_fields_are_refused() {
    let f = Fixture::new("0.1.16");
    let raw = String::from_utf8(f.bytes()).unwrap();
    for bytes in [
        raw.replacen('{', "{\"schemaVersion\":1,", 1).into_bytes(),
        raw.replacen(
            "\"entries\":{",
            "\"entries\":{\"usr\":{\"kind\":\"directory\",\"mode\":493},",
            1,
        )
        .into_bytes(),
        raw.replacen('{', "{\"unknown\":true,", 1).into_bytes(),
        vec![b' '; crate::MAX_MANIFEST + 1],
    ] {
        assert!(signed_manifest(
            &bytes,
            digest(&bytes).as_bytes(),
            &Expected::linux_x86_64("0.1.16").unwrap(),
            &test_verify
        )
        .is_err());
    }
}

#[test]
fn manifest_requires_complete_parents_ordinary_modes_and_consistent_bounds() {
    for change in 0..9 {
        let mut f = Fixture::new("0.1.16");
        match change {
            0 => {
                f.manifest.entries.remove("usr/bin");
            }
            1 => {
                f.manifest
                    .entries
                    .insert("usr".into(), Entry::Directory { mode: 0o777 });
            }
            2 => {
                f.manifest.archive.size = MAX_ARCHIVE + 1;
            }
            3 => {
                f.manifest.archive.unpacked_size = MAX_TOTAL + 1;
            }
            4 => {
                f.manifest.archive.unpacked_size = 0;
            }
            5 => {
                f.manifest
                    .entries
                    .insert("USR".into(), Entry::Directory { mode: 0o755 });
            }
            6 => {
                f.manifest.entries.insert(
                    ENTRYPOINT.into(),
                    Entry::File {
                        size: 64,
                        sha256: "a".repeat(64),
                        mode: 0o4755,
                    },
                );
            }
            7 => {
                for n in 0..MAX_ENTRIES {
                    f.manifest
                        .entries
                        .insert(format!("x{n}"), Entry::Directory { mode: 0o755 });
                }
            }
            _ => f.manifest.archive.sha256 = "A".repeat(64),
        }
        assert!(f.package().is_err(), "case {change}");
    }
}

#[test]
fn traversal_ambiguous_windows_and_noncanonical_names_are_refused() {
    for name in [
        "../outside",
        "usr/../outside",
        "./usr",
        "/absolute",
        "usr//x",
        "usr\\x",
        "C:/x",
        "usr/x:",
        "usr/x.",
        "usr/x ",
        "usr/NUL",
        "usr/COM1.txt",
        "usr/\n",
        "usr/\u{00e9}",
        "usr/",
    ] {
        assert!(!archive::relative(name), "{name:?}");
    }
}

#[test]
fn archive_hash_size_trailing_gzip_and_corrupt_compression_refuse() {
    for change in 0..4 {
        let mut f = Fixture::new("0.1.16");
        match change {
            0 => f.raw[8] ^= 1,
            1 => f.manifest.archive.size += 1,
            2 => {
                f.raw.extend(gzip(b"second member"));
                f.bind();
            }
            _ => {
                f.raw = b"not gzip".to_vec();
                f.bind();
            }
        }
        assert!(f.package().is_err());
    }
}

#[test]
fn archive_decompression_bound_and_truncated_gzip_are_refused() {
    let mut oversized = Fixture::new("0.1.16");
    let bound = oversized.manifest.archive.unpacked_size
        + oversized.manifest.entries.len() as u64 * 1024
        + 10240;
    oversized.raw = gzip(&vec![0; bound as usize + 1]);
    oversized.bind();
    assert!(oversized.package().is_err());
    let mut truncated = Fixture::new("0.1.16");
    truncated.raw.truncate(truncated.raw.len() - 4);
    truncated.bind();
    assert!(truncated.package().is_err());
}

#[test]
fn archives_cannot_add_remove_duplicate_link_or_special_members() {
    let binary = elf(16);
    for kind in *b"12346xLS" {
        let mut f = Fixture::new("0.1.16");
        f.raw = gzip(&tar(&[
            ("usr", b"", 0o755, b'5'),
            ("usr/bin", b"", 0o755, b'5'),
            (ENTRYPOINT, &binary, 0o755, b'0'),
            ("usr/data.txt", b"preserved", 0o644, kind),
        ]));
        f.bind();
        assert!(f.package().is_err(), "kind {}", kind as char);
    }
    for extra in [false, true] {
        let mut f = Fixture::new("0.1.16");
        let mut entries = vec![
            ("usr", b"".as_slice(), 0o755, b'5'),
            ("usr/bin", b"".as_slice(), 0o755, b'5'),
            (ENTRYPOINT, binary.as_slice(), 0o755, b'0'),
        ];
        if extra {
            entries.extend([
                ("usr/data.txt", b"preserved".as_slice(), 0o644, b'0'),
                ("usr/data.txt", b"preserved".as_slice(), 0o644, b'0'),
            ]);
        }
        f.raw = gzip(&tar(&entries));
        f.bind();
        assert!(f.package().is_err());
    }
}

#[test]
fn archive_mode_member_hash_and_elf_architecture_are_checked() {
    for change in 0..3 {
        let mut f = Fixture::new("0.1.16");
        let mut binary = elf(16);
        if change == 2 {
            binary[18] = 0xb7;
            f.manifest.entries.insert(
                ENTRYPOINT.into(),
                Entry::File {
                    size: 64,
                    sha256: digest(&binary),
                    mode: 0o755,
                },
            );
        }
        f.raw = gzip(&tar(&[
            ("usr", b"", 0o755, b'5'),
            ("usr/bin", b"", 0o755, b'5'),
            (
                ENTRYPOINT,
                &binary,
                if change == 0 { 0o777 } else { 0o755 },
                b'0',
            ),
            (
                "usr/data.txt",
                if change == 1 {
                    b"modified!"
                } else {
                    b"preserved"
                },
                0o644,
                b'0',
            ),
        ]));
        f.bind();
        assert!(f.package().is_err());
    }
}

#[test]
fn tar_padding_hidden_tail_and_nonroot_headers_are_refused() {
    let binary = elf(16);
    let base = tar(&[
        ("usr", b"", 0o755, b'5'),
        ("usr/bin", b"", 0o755, b'5'),
        (ENTRYPOINT, &binary, 0o755, b'0'),
        ("usr/data.txt", b"preserved", 0o644, b'0'),
    ]);
    for change in 0..3 {
        let mut raw = base.clone();
        match change {
            0 => raw[3 * 512 + 64] = 1,
            1 => {
                let last = raw.len() - 1;
                raw[last] = 1;
            }
            _ => {
                let header = tar::Header::from_byte_slice(&raw[..512]);
                let mut owned = header.clone();
                owned.set_uid(1000);
                owned.set_cksum();
                raw[..512].copy_from_slice(owned.as_bytes());
            }
        }
        let mut f = Fixture::new("0.1.16");
        f.raw = gzip(&raw);
        f.bind();
        assert!(f.package().is_err());
    }
}

#[test]
fn store_never_adopts_an_existing_directory_or_settings_tree() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    fs::write(root.join("settings.json"), b"preserve").unwrap();
    assert!(Store::create_inner(&root).is_err());
    assert!(Store::open_inner(&root).is_err());
    assert_eq!(fs::read(root.join("settings.json")).unwrap(), b"preserve");
}

#[test]
fn staging_is_verified_readonly_and_does_not_select() {
    let (_temp, store) = setup();
    let package = Fixture::new("0.1.16").package().unwrap();
    let id = stage(&store, &package);
    assert!(store.snapshot_with(&test_verify).unwrap().is_none());
    assert_eq!(stage(&store, &package), id);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let root = store.root.join("generations").join(id);
        assert_eq!(
            fs::metadata(root.join("AppDir").join(ENTRYPOINT))
                .unwrap()
                .mode()
                & 0o777,
            0o555
        );
        assert_eq!(
            fs::metadata(root.join("AppDir/usr/data.txt"))
                .unwrap()
                .mode()
                & 0o777,
            0o444
        );
    }
}

#[test]
fn cancelled_or_interrupted_staging_never_changes_prior_selection() {
    for site in [
        "cancel",
        "metadata-staged",
        "member-staged",
        "generation-verified",
        "generation-published",
    ] {
        let (_temp, store) = setup();
        let first = Fixture::new("0.1.16").package().unwrap();
        let second = Fixture::new("0.1.17").package().unwrap();
        let old = activate(&store, &first, None);
        assert!(store
            .stage_with(
                &second,
                &|| site == "cancel",
                &interrupt(site),
                &test_verify
            )
            .is_err());
        assert_eq!(store.snapshot_with(&test_verify).unwrap(), Some(old));
    }
}

#[test]
fn atomic_update_retains_prior_selection_generation_and_unrelated_content() {
    let (temp, store) = setup();
    let unrelated = temp.path().join("settings-project-runtime-sentinel");
    fs::write(&unrelated, b"keep bytes").unwrap();
    let first = Fixture::new("0.1.16").package().unwrap();
    let old = activate(&store, &first, None);
    let second = Fixture::new("0.1.17").package().unwrap();
    let new = activate(&store, &second, Some(&old));
    assert_eq!(
        store.snapshot_with(&test_verify).unwrap(),
        Some(new.clone())
    );
    assert_eq!(
        new.selection.previous_generation.as_deref(),
        Some(first.generation().as_str())
    );
    store
        .generation(
            &first.generation(),
            &Expected::linux_x86_64("0.1.16").unwrap(),
            &test_verify,
        )
        .unwrap();
    assert_eq!(
        fs::read(
            store
                .root
                .join("history")
                .join(format!("selection-{}.json", digest(&old.bytes)))
        )
        .unwrap(),
        old.bytes
    );
    assert_eq!(fs::read(unrelated).unwrap(), b"keep bytes");
    assert!(store.recovery_with(&test_verify).unwrap().is_none());
}

#[test]
fn stale_review_downgrade_same_version_and_unverified_generation_refuse() {
    let (_temp, store) = setup();
    let first = Fixture::new("0.1.16").package().unwrap();
    let old = activate(&store, &first, None);
    let second = Fixture::new("0.1.17").package().unwrap();
    let id = stage(&store, &second);
    assert!(store
        .activate_with(
            &id,
            &Expected::linux_x86_64("0.1.17").unwrap(),
            None,
            &|| false,
            &|_| Ok(()),
            &test_verify
        )
        .is_err());
    let new = activate(&store, &second, Some(&old));
    assert!(store
        .activate_with(
            &first.generation(),
            &Expected::linux_x86_64("0.1.16").unwrap(),
            Some(&new),
            &|| false,
            &|_| Ok(()),
            &test_verify
        )
        .is_err());
    let mut changed = Fixture::new("0.1.17");
    changed.manifest.source_tree = "c".repeat(40);
    let changed = changed.package().unwrap();
    let changed_id = stage(&store, &changed);
    assert!(store
        .activate_with(
            &changed_id,
            &Expected::linux_x86_64("0.1.17").unwrap(),
            Some(&new),
            &|| false,
            &|_| Ok(()),
            &test_verify
        )
        .is_err());
    assert!(store
        .activate_with(
            &"f".repeat(64),
            &Expected::linux_x86_64("0.1.18").unwrap(),
            Some(&new),
            &|| false,
            &|_| Ok(()),
            &test_verify
        )
        .is_err());
}

#[test]
fn cancellation_before_commit_leaves_old_selection_readable_and_requires_recovery_if_journaled() {
    for site in [
        "prior-retained",
        "journal-synced",
        "selection-staged",
        "before-commit",
    ] {
        let (_temp, store) = setup();
        let old = activate(&store, &Fixture::new("0.1.16").package().unwrap(), None);
        let target = Fixture::new("0.1.17").package().unwrap();
        let id = stage(&store, &target);
        let cancel_now = Cell::new(false);
        let checkpoint = |at: &str| {
            if at == site {
                cancel_now.set(true);
            }
            Ok(())
        };
        let error = store
            .activate_with(
                &id,
                &Expected::linux_x86_64("0.1.17").unwrap(),
                Some(&old),
                &|| cancel_now.get(),
                &checkpoint,
                &test_verify,
            )
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::Cancelled);
        assert_eq!(
            store.snapshot_with(&test_verify).unwrap(),
            Some(old.clone())
        );
        if site != "prior-retained" {
            let recovery = store.recovery_with(&test_verify).unwrap().unwrap();
            assert_eq!(recovery.state, RecoveryState::PreparedOldSelectionRetained);
            assert_eq!(recovery.current, Some(old.clone()));
            let error = store
                .activate_with(
                    &id,
                    &Expected::linux_x86_64("0.1.17").unwrap(),
                    Some(&old),
                    &|| false,
                    &|_| Ok(()),
                    &test_verify,
                )
                .unwrap_err();
            assert_eq!(error.kind, ErrorKind::RecoveryRequired);
            store.acknowledge_with(&recovery, &test_verify).unwrap();
            assert_eq!(store.snapshot_with(&test_verify).unwrap(), Some(old));
        }
    }
}

#[test]
fn interruption_after_commit_is_unknown_and_recovery_never_rolls_back_or_claims_app_success() {
    for site in ["selection-committed", "current-synced"] {
        let (_temp, store) = setup();
        let old = activate(&store, &Fixture::new("0.1.16").package().unwrap(), None);
        let target = Fixture::new("0.1.17").package().unwrap();
        let id = stage(&store, &target);
        let error = store
            .activate_with(
                &id,
                &Expected::linux_x86_64("0.1.17").unwrap(),
                Some(&old),
                &|| false,
                &interrupt(site),
                &test_verify,
            )
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::OutcomeUnknown);
        let recovery = store.recovery_with(&test_verify).unwrap().unwrap();
        assert_eq!(recovery.state, RecoveryState::SelectionCommitted);
        assert_eq!(recovery.previous, Some(old));
        let committed = store.snapshot_with(&test_verify).unwrap();
        store.acknowledge_with(&recovery, &test_verify).unwrap();
        assert_eq!(store.snapshot_with(&test_verify).unwrap(), committed);
    }
}

#[test]
fn interruption_at_every_precommit_checkpoint_keeps_prior_selection_and_recovery_evidence() {
    for site in [
        "prior-retained",
        "journal-synced",
        "selection-staged",
        "before-commit",
    ] {
        let (_temp, store) = setup();
        let old = activate(&store, &Fixture::new("0.1.16").package().unwrap(), None);
        let target = Fixture::new("0.1.17").package().unwrap();
        let id = stage(&store, &target);
        let error = store
            .activate_with(
                &id,
                &Expected::linux_x86_64("0.1.17").unwrap(),
                Some(&old),
                &|| false,
                &interrupt(site),
                &test_verify,
            )
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::Refused);
        assert_eq!(
            store.snapshot_with(&test_verify).unwrap(),
            Some(old.clone())
        );
        let recovery = store.recovery_with(&test_verify).unwrap();
        if site == "prior-retained" {
            assert!(recovery.is_none());
        } else {
            let recovery = recovery.unwrap();
            assert_eq!(recovery.state, RecoveryState::PreparedOldSelectionRetained);
            assert_eq!(recovery.current, Some(old));
            assert_eq!(recovery.target_generation, id);
        }
    }
}

#[test]
fn cancellation_observed_after_atomic_commit_cannot_report_cancelled_or_undo_selection() {
    let (_temp, store) = setup();
    let old = activate(&store, &Fixture::new("0.1.16").package().unwrap(), None);
    let target = Fixture::new("0.1.17").package().unwrap();
    let id = stage(&store, &target);
    let cancel_now = Cell::new(false);
    let activation = store
        .activate_with(
            &id,
            &Expected::linux_x86_64("0.1.17").unwrap(),
            Some(&old),
            &|| cancel_now.get(),
            &|site| {
                if site == "selection-committed" {
                    cancel_now.set(true);
                }
                Ok(())
            },
            &test_verify,
        )
        .unwrap();
    let Activation::Committed(selected) = activation else {
        panic!("new generation must commit");
    };
    assert!(cancel_now.get());
    assert_eq!(selected.selection.generation, id);
    assert_eq!(store.snapshot_with(&test_verify).unwrap(), Some(selected));
    assert!(store.recovery_with(&test_verify).unwrap().is_none());
}

#[test]
fn changed_recovery_record_is_not_acknowledged() {
    let (_temp, store) = setup();
    let old = activate(&store, &Fixture::new("0.1.16").package().unwrap(), None);
    let target = Fixture::new("0.1.17").package().unwrap();
    let id = stage(&store, &target);
    store
        .activate_with(
            &id,
            &Expected::linux_x86_64("0.1.17").unwrap(),
            Some(&old),
            &|| false,
            &interrupt("journal-synced"),
            &test_verify,
        )
        .unwrap_err();
    let recovery = store.recovery_with(&test_verify).unwrap().unwrap();
    fs::write(store.root.join("pending.json"), b"{}").unwrap();
    assert!(store.acknowledge_with(&recovery, &test_verify).is_err());
    assert_eq!(fs::read(store.root.join("pending.json")).unwrap(), b"{}");
    assert_eq!(store.snapshot_with(&test_verify).unwrap(), Some(old));
}

#[test]
fn modified_generation_is_never_repaired_or_activated() {
    let (_temp, store) = setup();
    let package = Fixture::new("0.1.16").package().unwrap();
    let id = stage(&store, &package);
    let target = store
        .root
        .join("generations")
        .join(&id)
        .join("AppDir/usr/data.txt");
    disk::set_mode(&target, 0o644).unwrap();
    fs::write(&target, b"user edit").unwrap();
    assert!(store
        .stage_with(&package, &|| false, &|_| Ok(()), &test_verify)
        .is_err());
    assert!(store
        .activate_with(
            &id,
            &Expected::linux_x86_64("0.1.16").unwrap(),
            None,
            &|| false,
            &|_| Ok(()),
            &test_verify
        )
        .is_err());
    assert_eq!(fs::read(target).unwrap(), b"user edit");
}

#[test]
fn extra_deployed_files_are_not_accepted() {
    let (_temp, store) = setup();
    let package = Fixture::new("0.1.16").package().unwrap();
    let id = stage(&store, &package);
    let appdir = store.root.join("generations").join(&id).join("AppDir");
    disk::set_mode(&appdir, 0o755).unwrap();
    fs::write(appdir.join("extra"), b"unlisted").unwrap();
    disk::set_mode(&appdir, 0o555).unwrap();
    assert!(store
        .generation(
            &id,
            &Expected::linux_x86_64("0.1.16").unwrap(),
            &test_verify
        )
        .is_err());
}

#[test]
fn extra_generation_root_files_are_rejected_without_touching_current_or_unknown_files() {
    let (_temp, store) = setup();
    let old = activate(&store, &Fixture::new("0.1.16").package().unwrap(), None);
    let target = Fixture::new("0.1.17").package().unwrap();
    let id = stage(&store, &target);
    let root = store.root.join("generations").join(&id);
    disk::set_mode(&root, 0o755).unwrap();
    for leaf in ["extra-a", "extra-b"] {
        fs::write(root.join(leaf), b"unknown; do not remove").unwrap();
    }
    disk::set_mode(&root, 0o555).unwrap();
    assert!(store
        .activate_with(
            &id,
            &Expected::linux_x86_64("0.1.17").unwrap(),
            Some(&old),
            &|| false,
            &|_| Ok(()),
            &test_verify,
        )
        .is_err());
    assert_eq!(store.snapshot_with(&test_verify).unwrap(), Some(old));
    assert!(store.recovery_with(&test_verify).unwrap().is_none());
    for leaf in ["extra-a", "extra-b"] {
        assert_eq!(
            fs::read(root.join(leaf)).unwrap(),
            b"unknown; do not remove"
        );
    }
}

#[test]
fn concurrent_transactions_are_refused_without_selection_changes() {
    let (_temp, store) = setup();
    let package = Fixture::new("0.1.16").package().unwrap();
    let _held = disk::lock(&store.root.join("transaction.lock")).unwrap();
    assert!(store
        .stage_with(&package, &|| false, &|_| Ok(()), &test_verify)
        .is_err());
    assert!(store.snapshot_with(&test_verify).unwrap().is_none());
}

#[test]
fn malformed_selection_never_falls_back_to_an_existing_generation() {
    let (_temp, store) = setup();
    let package = Fixture::new("0.1.16").package().unwrap();
    stage(&store, &package);
    disk::write_new(&store.root.join("current.json"), b"{}", 0o600).unwrap();
    assert!(store.snapshot_with(&test_verify).is_err());
    assert_eq!(fs::read(store.root.join("current.json")).unwrap(), b"{}");
}

#[test]
fn public_store_admission_never_uses_windows_as_linux_authority() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap().join("production-api");
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    if unsafe { libc::getuid() } > 0 {
        let store = Store::create(&root).unwrap();
        assert!(store.snapshot().unwrap().is_none());
        assert!(store.recovery().unwrap().is_none());
        Store::open(&root).unwrap();
        return;
    }
    assert!(Store::create(&root).is_err());
    assert!(!root.exists());
}

#[test]
fn authoritative_new_records_are_atomic_and_never_overwrite_existing_history() {
    let (_temp, store) = setup();
    let path = store.root.join("history/record.json");
    atomic_new_record(&path, b"complete old record").unwrap();
    assert!(atomic_new_record(&path, b"replacement").is_err());
    assert_eq!(fs::read(path).unwrap(), b"complete old record");
}

#[test]
fn interruption_before_first_commit_preserves_no_selection_without_adopting_target() {
    let (_temp, store) = setup();
    let package = Fixture::new("0.1.16").package().unwrap();
    let id = stage(&store, &package);
    store
        .activate_with(
            &id,
            &Expected::linux_x86_64("0.1.16").unwrap(),
            None,
            &|| false,
            &interrupt("journal-synced"),
            &test_verify,
        )
        .unwrap_err();
    assert!(store.snapshot_with(&test_verify).unwrap().is_none());
    let recovery = store.recovery_with(&test_verify).unwrap().unwrap();
    assert_eq!(recovery.state, RecoveryState::PreparedOldSelectionRetained);
    assert!(recovery.previous.is_none());
    store.acknowledge_with(&recovery, &test_verify).unwrap();
    assert!(store.snapshot_with(&test_verify).unwrap().is_none());
}

#[test]
fn exact_current_generation_is_idempotent_but_does_not_skip_validation() {
    let (_temp, store) = setup();
    let package = Fixture::new("0.1.16").package().unwrap();
    let old = activate(&store, &package, None);
    assert!(matches!(
        store
            .activate_with(
                &package.generation(),
                &Expected::linux_x86_64("0.1.16").unwrap(),
                Some(&old),
                &|| false,
                &|_| Ok(()),
                &test_verify
            )
            .unwrap(),
        Activation::Unchanged(_)
    ));
    assert!(store
        .activate_with(
            &package.generation(),
            &Expected::linux_x86_64("0.1.17").unwrap(),
            Some(&old),
            &|| false,
            &|_| Ok(()),
            &test_verify
        )
        .is_err());
}

#[test]
fn interrupted_pending_state_with_foreign_selection_is_not_adopted() {
    let (_temp, store) = setup();
    let old = activate(&store, &Fixture::new("0.1.16").package().unwrap(), None);
    let package = Fixture::new("0.1.17").package().unwrap();
    let id = stage(&store, &package);
    store
        .activate_with(
            &id,
            &Expected::linux_x86_64("0.1.17").unwrap(),
            Some(&old),
            &|| false,
            &interrupt("journal-synced"),
            &test_verify,
        )
        .unwrap_err();
    let unrelated = Fixture::new("0.1.18").package().unwrap();
    let other_id = stage(&store, &unrelated);
    let selection = Selection {
        schema_version: 1,
        generation: other_id,
        version: "0.1.18".into(),
        previous_generation: None,
    };
    let changed = serde_json::to_vec(&selection).unwrap();
    fs::write(store.root.join("current.json"), &changed).unwrap();
    assert!(store.recovery_with(&test_verify).is_err());
    assert_eq!(fs::read(store.root.join("current.json")).unwrap(), changed);
    assert!(store.root.join("pending.json").is_file());
}

#[test]
fn wrong_architecture_retained_tree_cannot_bypass_the_archive_verifier() {
    let (_temp, store) = setup();
    let mut fixture = Fixture::new("0.1.16");
    let mut data = elf(16);
    data[18] = 0xb7;
    fixture.manifest.entries.insert(
        ENTRYPOINT.into(),
        Entry::File {
            size: 64,
            sha256: digest(&data),
            mode: 0o755,
        },
    );
    // Private seam simulates a populated generation; public verify rejects it.
    let bytes = fixture.bytes();
    let signature = digest(&bytes).into_bytes();
    let mut contents = Fixture::new("0.1.16").package().unwrap().contents;
    contents.insert(ENTRYPOINT.into(), data);
    let forged = VerifiedPackage {
        manifest: fixture.manifest,
        bytes,
        signature,
        contents,
    };
    assert!(store
        .stage_with(&forged, &|| false, &|_| Ok(()), &test_verify)
        .is_err());
    assert!(store.snapshot_with(&test_verify).unwrap().is_none());
}

#[test]
fn modified_retained_signature_is_never_ignored() {
    let (_temp, store) = setup();
    let package = Fixture::new("0.1.16").package().unwrap();
    let id = stage(&store, &package);
    let signature = store
        .root
        .join("generations")
        .join(&id)
        .join("manifest.minisig");
    disk::set_mode(&signature, 0o644).unwrap();
    fs::write(&signature, b"other-key").unwrap();
    disk::set_mode(&signature, 0o444).unwrap();
    assert!(store
        .generation(
            &id,
            &Expected::linux_x86_64("0.1.16").unwrap(),
            &test_verify
        )
        .is_err());
}

#[cfg(unix)]
#[test]
fn unix_foreign_writable_ancestry_and_store_permissions_are_rejected_without_repair() {
    let temp = tempfile::tempdir().unwrap();
    let parent = temp.path().canonicalize().unwrap();
    disk::set_mode(&parent, 0o777).unwrap();
    assert!(Store::create_inner(&parent.join("unsafe")).is_err());
    disk::set_mode(&parent, 0o700).unwrap();
    let store = Store::create_inner(&parent.join("private")).unwrap();
    disk::set_mode(&store.root, 0o755).unwrap();
    assert!(Store::open_inner(&store.root).is_err());
    use std::os::unix::fs::MetadataExt;
    assert_eq!(fs::metadata(&store.root).unwrap().mode() & 0o777, 0o755);
}

#[cfg(unix)]
#[test]
fn unix_shared_reader_observes_complete_selection_or_refuses_a_race() {
    let (_temp, store) = setup();
    let old = activate(&store, &Fixture::new("0.1.16").package().unwrap(), None);
    let package = Fixture::new("0.1.17").package().unwrap();
    let id = stage(&store, &package);
    std::thread::scope(|scope| {
        let shared = &store;
        let old_id = &old.selection.generation;
        let id = &id;
        let reader = scope.spawn(move || {
            for _ in 0..40 {
                if let Ok(Some(snapshot)) = shared.snapshot_with(&test_verify) {
                    assert!(
                        snapshot.selection.generation == *old_id
                            || snapshot.selection.generation == *id
                    );
                }
            }
        });
        store
            .activate_with(
                id,
                &Expected::linux_x86_64("0.1.17").unwrap(),
                Some(&old),
                &|| false,
                &|_| Ok(()),
                &test_verify,
            )
            .unwrap();
        reader.join().unwrap();
    });
}

#[cfg(unix)]
#[test]
fn unix_symlink_hardlink_and_fifo_inputs_are_rejected() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    fs::write(root.join("source"), b"sentinel").unwrap();
    symlink(root.join("source"), root.join("link")).unwrap();
    assert!(disk::read_regular(&root.join("link"), 128, true).is_err());
    fs::hard_link(root.join("source"), root.join("hard")).unwrap();
    assert!(disk::read_regular(&root.join("hard"), 128, true).is_err());
    let fifo = std::ffi::CString::new(root.join("fifo").to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    assert!(disk::read_regular(&root.join("fifo"), 128, true).is_err());
}

#[cfg(unix)]
#[test]
fn unix_redirected_store_and_modified_readonly_modes_refuse() {
    use std::os::unix::fs::symlink;
    let (temp, store) = setup();
    let package = Fixture::new("0.1.16").package().unwrap();
    let id = stage(&store, &package);
    let alias = temp.path().join("alias");
    symlink(&store.root, &alias).unwrap();
    assert!(Store::open_inner(&alias).is_err());
    let path = store
        .root
        .join("generations")
        .join(&id)
        .join("AppDir")
        .join(ENTRYPOINT);
    disk::set_mode(&path, 0o755).unwrap();
    assert!(store
        .generation(
            &id,
            &Expected::linux_x86_64("0.1.16").unwrap(),
            &test_verify
        )
        .is_err());
}
