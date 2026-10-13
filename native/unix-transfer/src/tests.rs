use super::*;
use flate2::{write::GzEncoder, Compression};
use serde_json::{json, Value};

struct Fixture {
    root: tempfile::TempDir,
    receipt: Value,
    members: BTreeMap<String, Vec<u8>>,
}
impl Fixture {
    fn new(platform: &str, arch: &str) -> Self {
        let root = tempfile::tempdir().unwrap();
        let members = NAMES
            .into_iter()
            .map(|name| {
                (
                    name.to_owned(),
                    format!("synthetic never-executed {name}").into_bytes(),
                )
            })
            .collect::<BTreeMap<_, _>>();
        let records = members
            .iter()
            .map(|(name, bytes)| {
                (
                    name.clone(),
                    json!({ "sha256": digest(bytes), "size": bytes.len(), "mode": mode(name) }),
                )
            })
            .collect::<BTreeMap<_, _>>();
        let receipt = json!({ "schemaVersion":1, "product":"com.creatorworks.hub.unix-managed-preparation", "hubVersion":"0.1.14",
            "platform":platform, "arch":arch, "rustTarget":format!("{arch}-{}", if platform == "macos" { "apple-darwin" } else { "unknown-linux-gnu" }),
            "mcpMode":"writable", "compiledFlags":{"internalModule":true,"experimentalUnixHosting":true,"hostWritable":true,"readOnlyEvents":true},
            "source":{"repository":"BOBWORKS-XR/CREATOR-HUB","repositoryId":1364807512,"workflow":".github/workflows/unix-managed-payload.yml",
                "event":"push","sourceCommit":"a".repeat(40),"buildCommit":"a".repeat(40),"sourceTree":"b".repeat(40),"runId":123,"runAttempt":1},
            "files":records,"unsigned":true,"privateKeyIncluded":false,"nativeGuiTested":false,"nativeConsentTested":false,"releaseReady":false });
        let f = Self {
            root,
            receipt,
            members,
        };
        fs::create_dir(f.raw()).unwrap();
        for (name, bytes) in &f.members {
            let file = f.raw().join(name);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(&file, bytes).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(file, fs::Permissions::from_mode(mode(name))).unwrap();
            }
        }
        f.write_receipt();
        f.refresh();
        f
    }
    fn raw(&self) -> PathBuf {
        self.root.path().join("raw")
    }
    fn receipt_path(&self) -> PathBuf {
        self.raw().join("prepared-unix.json")
    }
    fn archive_path(&self) -> PathBuf {
        self.root.path().join("modules.tar.gz")
    }
    fn binding_path(&self) -> PathBuf {
        self.root.path().join("transfer-binding.json")
    }
    fn p(&self) -> Prepared {
        serde_json::from_value(self.receipt.clone()).unwrap()
    }
    fn write_receipt(&self) {
        fs::write(self.receipt_path(), self.receipt.to_string()).unwrap();
    }
    fn refresh(&self) {
        let (bytes, binding) = encode(&self.p(), &self.members).unwrap();
        fs::write(self.archive_path(), bytes).unwrap();
        fs::write(self.binding_path(), serde_json::to_vec(&binding).unwrap()).unwrap();
    }
    fn verify(&self) -> Result<(archive::Snapshot, Vec<u8>, Prepared)> {
        verify(
            &self.archive_path(),
            &self.receipt_path(),
            &self.binding_path(),
        )
    }
    fn rebound(&self, bytes: &[u8]) {
        let mut binding: Value =
            serde_json::from_slice(&fs::read(self.binding_path()).unwrap()).unwrap();
        binding["sha256"] = json!(digest(bytes));
        binding["size"] = json!(bytes.len());
        fs::write(self.archive_path(), bytes).unwrap();
        fs::write(self.binding_path(), binding.to_string()).unwrap();
    }
}
fn compressed(bytes: &[u8]) -> Vec<u8> {
    let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
    gzip.write_all(bytes).unwrap();
    gzip.finish().unwrap()
}
fn tar_bytes(f: &Fixture, change: &str) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    let mut entries = f
        .members
        .iter()
        .map(|(n, b)| (n.clone(), b.clone()))
        .collect::<Vec<_>>();
    if change == "duplicate" {
        entries.push(entries[0].clone());
    }
    if change == "extra" {
        entries.push(("orphan".into(), b"extra".to_vec()));
    }
    if change == "missing" {
        entries.pop();
    }
    for (index, (name, mut bytes)) in entries.into_iter().enumerate() {
        let mut h = tar::Header::new_ustar();
        h.set_path(&name).unwrap();
        h.set_uid(0);
        h.set_gid(0);
        h.set_mtime(0);
        h.set_mode(mode(&name));
        h.set_entry_type(tar::EntryType::Regular);
        if index == 0 {
            match change {
                "traversal" => {
                    h.as_mut_bytes()[..100].fill(0);
                    h.as_mut_bytes()[..9].copy_from_slice(b"../escape");
                }
                "symlink" => {
                    h.set_entry_type(tar::EntryType::Symlink);
                    h.set_link_name("foreign").unwrap();
                }
                "hardlink" => {
                    h.set_entry_type(tar::EntryType::Link);
                    h.set_link_name("foreign").unwrap();
                }
                "mode" => h.set_mode(0o755),
                "size" => bytes.push(b'x'),
                "hash" => bytes[0] ^= 1,
                _ => (),
            }
        }
        h.set_size(bytes.len() as u64);
        h.set_cksum();
        builder.append(&h, bytes.as_slice()).unwrap();
    }
    builder.into_inner().unwrap()
}

#[test]
fn linux_and_both_mac_targets_verify_extract_without_relabelling() {
    for (platform, arch) in [
        ("linux", "x86_64"),
        ("macos", "x86_64"),
        ("macos", "aarch64"),
    ] {
        let f = Fixture::new(platform, arch);
        let (_, receipt, p) = f.verify().unwrap();
        assert_eq!(p.platform, platform);
        assert_eq!(p.arch, arch);
        assert!(p.unsigned);
        assert!(!p.release_ready);
        assert_eq!(receipt, fs::read(f.receipt_path()).unwrap());
        let output = f.root.path().join("extracted");
        extract(
            &f.archive_path(),
            &f.receipt_path(),
            &f.binding_path(),
            &output,
        )
        .unwrap();
        for (name, bytes) in &f.members {
            assert_eq!(fs::read(output.join(name)).unwrap(), *bytes);
        }
        assert_eq!(
            fs::read(output.join("prepared-unix.json")).unwrap(),
            receipt
        );
        assert_eq!(inventory(&output).unwrap().len(), 14);
        assert!(extract(
            &f.archive_path(),
            &f.receipt_path(),
            &f.binding_path(),
            &output
        )
        .is_err());
        assert_eq!(
            fs::read(output.join(NAMES[0])).unwrap(),
            f.members[NAMES[0]]
        );
    }
}
#[test]
fn packing_bytes_are_deterministic_and_writer_bound_is_enforced() {
    let f = Fixture::new("macos", "aarch64");
    assert_eq!(
        encode(&f.p(), &f.members).unwrap().0,
        encode(&f.p(), &f.members).unwrap().0
    );
    let mut limited = Limited {
        bytes: Vec::new(),
        limit: 8,
    };
    limited.write_all(b"12345678").unwrap();
    assert!(limited.write_all(b"x").is_err());
    assert_eq!(limited.bytes, b"12345678");
}
#[test]
fn strict_receipt_refuses_future_schema_fields_wrong_target_flags_and_claims() {
    let f = Fixture::new("macos", "aarch64");
    for (pointer, value) in [
        ("/schemaVersion", json!(2)),
        ("/platform", json!("windows")),
        ("/rustTarget", json!("x86_64-apple-darwin")),
        ("/compiledFlags/hostWritable", json!(false)),
        ("/mcpMode", json!("read-only")),
        ("/unsigned", json!(false)),
        ("/privateKeyIncluded", json!(true)),
        ("/releaseReady", json!(true)),
        ("/nativeGuiTested", json!(true)),
        ("/nativeConsentTested", json!(true)),
        ("/source/buildCommit", json!("c".repeat(40))),
        ("/source/event", json!("pull_request")),
        ("/source/runId", json!(9007199254740992u64)),
        ("/hubVersion", json!("0.1.14+unreviewed")),
    ] {
        let mut changed = f.receipt.clone();
        *changed.pointer_mut(pointer).unwrap() = value;
        let p: Prepared = serde_json::from_value(changed).unwrap();
        assert!(p.expected().is_err(), "{pointer}");
    }
    for pointer in [
        "",
        "/compiledFlags",
        "/source",
        "/files/builtin-manifest.json",
    ] {
        let mut changed = f.receipt.clone();
        changed
            .pointer_mut(pointer)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("futureField".into(), json!(1));
        assert!(serde_json::from_value::<Prepared>(changed).is_err());
    }
}
#[test]
fn exact_file_records_and_declared_sizes_modes_hashes_are_required() {
    let f = Fixture::new("linux", "x86_64");
    for value in [json!(0), json!(MAX_FILE + 1), json!(u64::MAX)] {
        let mut changed = f.receipt.clone();
        changed["files"][NAMES[0]]["size"] = value;
        assert!(serde_json::from_value::<Prepared>(changed)
            .unwrap()
            .expected()
            .is_err());
    }
    for (field, value) in [
        ("mode", json!(0o755)),
        ("mode", json!(0o4755)),
        ("sha256", json!("g".repeat(64))),
    ] {
        let mut changed = f.receipt.clone();
        changed["files"][NAMES[0]][field] = value;
        assert!(serde_json::from_value::<Prepared>(changed)
            .unwrap()
            .expected()
            .is_err());
    }
    let mut missing = f.receipt.clone();
    missing["files"].as_object_mut().unwrap().remove(NAMES[0]);
    assert!(serde_json::from_value::<Prepared>(missing)
        .unwrap()
        .expected()
        .is_err());
    let mut extra = f.receipt.clone();
    extra["files"]["../escape"] = extra["files"][NAMES[0]].clone();
    assert!(serde_json::from_value::<Prepared>(extra)
        .unwrap()
        .expected()
        .is_err());
    let mut total = f.receipt.clone();
    for name in NAMES {
        total["files"][name]["size"] = json!(MAX_FILE);
    }
    assert!(serde_json::from_value::<Prepared>(total)
        .unwrap()
        .expected()
        .is_err());
}
#[test]
fn duplicate_json_file_records_and_unknown_binding_fields_refuse() {
    let f = Fixture::new("linux", "x86_64");
    let duplicate = f.receipt.to_string().replace(
        "\"files\":{",
        &format!(
            "\"files\":{{\"{}\":{},",
            NAMES[0], f.receipt["files"][NAMES[0]]
        ),
    );
    assert!(serde_json::from_str::<Prepared>(&duplicate).is_err());
    let binding: Value = serde_json::from_slice(&fs::read(f.binding_path()).unwrap()).unwrap();
    let duplicate = binding.to_string().replace(
        "\"files\":{",
        &format!(
            "\"files\":{{\"{}\":{},",
            NAMES[0], binding["files"][NAMES[0]]
        ),
    );
    assert!(serde_json::from_str::<Binding>(&duplicate).is_err());
    let mut future = binding;
    future["future"] = json!(true);
    assert!(serde_json::from_value::<Binding>(future).is_err());
}
#[test]
fn rebound_archive_cannot_hide_extra_duplicate_missing_traversal_link_hash_mode_or_size() {
    let f = Fixture::new("macos", "aarch64");
    for change in [
        "extra",
        "duplicate",
        "missing",
        "traversal",
        "symlink",
        "hardlink",
        "hash",
        "mode",
        "size",
    ] {
        f.rebound(&compressed(&tar_bytes(&f, change)));
        assert!(f.verify().is_err(), "{change}");
        let output = f.root.path().join("must-not-extract");
        assert!(extract(
            &f.archive_path(),
            &f.receipt_path(),
            &f.binding_path(),
            &output
        )
        .is_err());
        assert!(!output.exists());
    }
}
#[test]
fn gzip_and_tar_trailing_bytes_and_binding_drift_refuse() {
    let f = Fixture::new("linux", "x86_64");
    let tar = tar_bytes(&f, "valid");
    let good = compressed(&tar);
    for bytes in [
        [good.clone(), vec![0]].concat(),
        [good.clone(), compressed(b"orphan")].concat(),
        compressed(&[tar.clone(), tar].concat()),
        good[..good.len() - 1].to_vec(),
    ] {
        f.rebound(&bytes);
        assert!(f.verify().is_err());
    }
    f.refresh();
    for (field, value) in [
        ("sha256", json!("a".repeat(64))),
        ("size", json!(MAX_FILE + 1)),
        ("unpackedSize", json!(MAX_TOTAL + 1)),
    ] {
        let mut b: Value = serde_json::from_slice(&fs::read(f.binding_path()).unwrap()).unwrap();
        b[field] = value;
        fs::write(f.binding_path(), b.to_string()).unwrap();
        assert!(f.verify().is_err());
        f.refresh();
    }
    let mut b: Value = serde_json::from_slice(&fs::read(f.binding_path()).unwrap()).unwrap();
    b["files"][NAMES[0]]["size"] = json!(1);
    fs::write(f.binding_path(), b.to_string()).unwrap();
    assert!(f.verify().is_err());
}
#[test]
fn raw_inventory_refuses_orphans_without_reading_them_and_existing_outputs_are_immutable() {
    let f = Fixture::new("linux", "x86_64");
    assert_eq!(inventory(&f.raw()).unwrap().len(), 14);
    fs::write(f.raw().join("unlisted-file"), b"never read").unwrap();
    assert!(inventory(&f.raw()).is_err());
    let existing = f.root.path().join("immutable");
    fs::write(&existing, b"beforeimage").unwrap();
    assert!(write_new(&existing, b"replacement").is_err());
    assert_eq!(fs::read(existing).unwrap(), b"beforeimage");
}
#[test]
fn metadata_and_archive_hardlinks_nonregular_and_oversized_inputs_refuse() {
    let f = Fixture::new("linux", "x86_64");
    assert!(Held::open(f.root.path(), MAX_METADATA, None).is_err());
    let huge = f.root.path().join("huge-json");
    fs::write(&huge, vec![0; MAX_METADATA as usize + 1]).unwrap();
    assert!(metadata::<Prepared>(&huge).is_err());
    for file in [f.receipt_path(), f.binding_path(), f.archive_path()] {
        let link = f.root.path().join("hard-link");
        fs::hard_link(&file, &link).unwrap();
        assert!(f.verify().is_err());
        fs::remove_file(link).unwrap();
    }
}
fn directory_link(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let result = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
}
#[test]
fn redirected_input_and_output_ancestors_refuse_without_foreign_writes() {
    let f = Fixture::new("macos", "x86_64");
    let foreign = f.root.path().join("foreign");
    fs::create_dir(&foreign).unwrap();
    let redirect = f.root.path().join("redirect");
    directory_link(&foreign, &redirect);
    let output = redirect.join("child");
    assert!(extract(
        &f.archive_path(),
        &f.receipt_path(),
        &f.binding_path(),
        &output
    )
    .is_err());
    assert_eq!(fs::read_dir(&foreign).unwrap().count(), 0);
    let input = f.root.path().join("input-alias");
    directory_link(&f.raw(), &input);
    assert!(metadata::<Prepared>(&input.join("prepared-unix.json")).is_err());
}
#[test]
fn opened_metadata_is_reserved_or_identity_drift_is_refused() {
    let f = Fixture::new("linux", "x86_64");
    let held = Held::open(&f.receipt_path(), MAX_METADATA, None).unwrap();
    #[cfg(windows)]
    {
        assert!(fs::OpenOptions::new()
            .write(true)
            .open(f.receipt_path())
            .is_err());
        assert!(fs::rename(f.receipt_path(), f.root.path().join("moved")).is_err());
    }
    #[cfg(unix)]
    {
        fs::rename(f.receipt_path(), f.root.path().join("moved")).unwrap();
        fs::write(f.receipt_path(), b"replacement").unwrap();
        assert!(held.recheck().is_err());
    }
    #[cfg(windows)]
    held.recheck().unwrap();
}
#[cfg(windows)]
#[test]
fn windows_native_pack_refuses_before_any_output_or_input_inspection() {
    let f = Fixture::new("macos", "aarch64");
    let output = f.root.path().join("must-not-pack");
    assert!(pack(&f.root.path().join("absent"), &output)
        .unwrap_err()
        .contains("native Unix mode"));
    assert!(!output.exists());
}
#[cfg(unix)]
#[test]
fn native_pack_checks_actual_modes_and_output_immutability() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new("macos", "aarch64");
    let output = f.root.path().join("packed");
    pack(&f.raw(), &output).unwrap();
    verify(
        &output.join("modules.tar.gz"),
        &output.join("prepared-unix.json"),
        &output.join("transfer-binding.json"),
    )
    .unwrap();
    let before = fs::read(output.join("modules.tar.gz")).unwrap();
    assert!(pack(&f.raw(), &output).is_err());
    assert_eq!(fs::read(output.join("modules.tar.gz")).unwrap(), before);
    fs::set_permissions(
        f.raw().join("router-for-package"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert!(pack(&f.raw(), &f.root.path().join("wrong-mode")).is_err());
}
