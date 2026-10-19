use super::*;
use crate::store::tests::{test_verify, Fixture as PackageFixture};

fn rebind(package: &mut VerifiedPackage) {
    use std::io::Write as _;
    package.manifest.archive.unpacked_size = package
        .manifest
        .entries
        .values()
        .map(|e| match e {
            Entry::File { size, .. } => *size,
            Entry::Directory { .. } => 0,
        })
        .sum();
    let mut tar = tar::Builder::new(Vec::new());
    for (name, entry) in &package.manifest.entries {
        let data = &package.contents[name];
        let mut header = tar::Header::new_ustar();
        header.set_path(name).unwrap();
        header.set_entry_type(if matches!(entry, Entry::Directory { .. }) {
            tar::EntryType::Directory
        } else {
            tar::EntryType::Regular
        });
        header.set_mode(match entry {
            Entry::File { mode, .. } | Entry::Directory { mode } => *mode,
        });
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        header.set_size(data.len() as u64);
        header.set_cksum();
        tar.append(&header, data.as_slice()).unwrap();
    }
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gzip.write_all(&tar.into_inner().unwrap()).unwrap();
    let archive = gzip.finish().unwrap();
    package.manifest.archive.size = archive.len() as u64;
    package.manifest.archive.sha256 = digest(&archive);
    package.bytes = serde_json::to_vec(&package.manifest).unwrap();
    package.signature = digest(&package.bytes).into_bytes();
}

fn file(package: &mut VerifiedPackage, name: &str, bytes: Vec<u8>, mode: u32) {
    package.manifest.entries.insert(
        name.into(),
        Entry::File {
            size: bytes.len() as u64,
            sha256: digest(&bytes),
            mode,
        },
    );
    package.contents.insert(name.into(), bytes);
}

struct Context {
    _temp: tempfile::TempDir,
    home: PathBuf,
    session: HostSession,
    package: VerifiedPackage,
    image: PathBuf,
    globals: Vec<PathBuf>,
    expected: Expected,
}

impl Context {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        fs::create_dir(home.join("data")).unwrap();
        fs::write(
            home.join("existing-settings"),
            b"keep preferences and runtime routes",
        )
        .unwrap();
        let session = HostSession::from_values([
            ("HOME".into(), home.clone().into_os_string()),
            ("XDG_DATA_HOME".into(), home.join("data").into_os_string()),
        ])
        .unwrap();
        let mut package = PackageFixture::new("0.1.16")
            .with_runner()
            .package()
            .unwrap();
        package
            .manifest
            .entries
            .insert("usr/libexec".into(), Entry::Directory { mode: 0o755 });
        package.contents.insert("usr/libexec".into(), Vec::new());
        let mut selector = vec![0; 64];
        selector[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
        selector[18] = 0x3e;
        file(&mut package, crate::SELECTOR_ENTRYPOINT, selector, 0o755);
        rebind(&mut package);
        let image = home.join("bootstrap-root");
        fs::write(&image, &package.contents[crate::ENTRYPOINT]).unwrap();
        let globals = (0..3).map(|n| home.join(format!("global-{n}"))).collect();
        Self {
            _temp: temp,
            home,
            session,
            package,
            image,
            globals,
            expected: Expected::linux_x86_64("0.1.16").unwrap(),
        }
    }
    fn review(&self) -> Result<BootstrapReview> {
        review_with(
            &self.session,
            &self.package,
            &self.expected,
            File::open(&self.image).unwrap(),
            &self.globals,
            &test_verify,
        )
    }
    fn apply(
        &self,
        review: &BootstrapReview,
        cancelled: &dyn Fn() -> bool,
        checkpoint: &dyn Fn(&str) -> Result<()>,
    ) -> Result<BootstrapOutcome> {
        apply_with(
            &self.session,
            review,
            cancelled,
            &|| File::open(&self.image).map_err(|_| refused("Test image missing")),
            &self.globals,
            &test_verify,
            checkpoint,
        )
    }
    fn data_names(&self) -> Vec<std::ffi::OsString> {
        let mut names: Vec<_> = fs::read_dir(self.home.join("data"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        names.sort();
        names
    }
    fn preserved(&self) {
        assert_eq!(
            fs::read(self.home.join("existing-settings")).unwrap(),
            b"keep preferences and runtime routes"
        );
    }
    #[cfg(target_os = "linux")]
    fn inspect(&self, root: &Path) -> Result<EmptyState> {
        let context = context_with(
            &self.session,
            &self.package,
            &self.expected,
            File::open(&self.image).unwrap(),
            &self.globals,
            &test_verify,
        )?;
        inspect_empty(root, &context)
    }
    fn retained_staging(&self) {
        assert!(!self.session.store_path().exists());
        let names = self.data_names();
        assert_eq!(names.len(), 1);
        assert!(names[0]
            .to_string_lossy()
            .starts_with(".creator-hub-bootstrap-"));
        assert!(self.home.join("data").join(&names[0]).is_dir());
        self.preserved();
    }
}

#[test]
fn review_is_read_only_and_explicit_cancel_never_revalidates_or_writes_after_drift() {
    let ctx = Context::new();
    let review = ctx.review().unwrap();
    assert_eq!(review.store_path(), ctx.session.store_path());
    assert_eq!(review.version(), "0.1.16");
    assert_eq!(review.generation(), ctx.package.generation());
    assert!(ctx.data_names().is_empty());
    fs::create_dir(ctx.session.store_path()).unwrap();
    fs::write(ctx.session.store_path().join("foreign"), b"not adopted").unwrap();
    fs::write(&ctx.image, b"image drift").unwrap();
    assert!(matches!(
        apply_bootstrap(
            &ctx.session,
            &review,
            ReviewedBootstrapChoice::Cancel,
            || panic!("Cancel must not inspect cancellation or native state")
        )
        .unwrap(),
        BootstrapOutcome::Cancelled
    ));
    assert_eq!(
        fs::read(ctx.session.store_path().join("foreign")).unwrap(),
        b"not adopted"
    );
    assert!(!ctx.session.store_path().join("store.id").exists());
    ctx.preserved();
}

#[test]
fn package_signature_exact_version_profile_selector_and_running_image_are_required() {
    for change in 0..8 {
        let mut ctx = Context::new();
        match change {
            0 => ctx.package.signature = b"not signed".to_vec(),
            1 => ctx.expected = Expected::linux_x86_64("0.1.17").unwrap(),
            2 => {
                ctx.package.contents.remove(crate::HOST_PROFILE);
            }
            3 => {
                ctx.package.contents.remove(crate::SELECTOR_ENTRYPOINT);
            }
            4 => {
                let mut bytes = ctx.package.contents[crate::SELECTOR_ENTRYPOINT].clone();
                bytes[18] = 0xb7;
                file(&mut ctx.package, crate::SELECTOR_ENTRYPOINT, bytes, 0o755);
                rebind(&mut ctx.package);
            }
            5 => {
                let bytes = ctx.package.contents[crate::SELECTOR_ENTRYPOINT].clone();
                file(&mut ctx.package, crate::SELECTOR_ENTRYPOINT, bytes, 0o644);
                rebind(&mut ctx.package);
            }
            6 => fs::write(&ctx.image, b"a different native image").unwrap(),
            _ => {
                let mut bytes = ctx.package.contents[crate::ENTRYPOINT].clone();
                bytes[63] ^= 1;
                fs::write(&ctx.image, bytes).unwrap();
            }
        }
        assert!(ctx.review().is_err(), "change {change}");
        assert!(ctx.data_names().is_empty());
        ctx.preserved();
    }
    let ctx = Context::new();
    assert!(review_with(
        &ctx.session,
        &ctx.package,
        &ctx.expected,
        File::open(&ctx.image).unwrap(),
        &ctx.globals,
        &production_verify
    )
    .is_err());
    assert!(ctx.data_names().is_empty());
}

#[test]
fn absent_or_partial_or_complete_existing_store_is_never_silently_adopted() {
    for kind in 0..3 {
        let ctx = Context::new();
        match kind {
            0 => fs::write(ctx.session.store_path(), b"foreign file").unwrap(),
            1 => {
                fs::create_dir(ctx.session.store_path()).unwrap();
                fs::write(
                    ctx.session.store_path().join("partial"),
                    b"preserve partial evidence",
                )
                .unwrap();
            }
            _ => {
                Store::create_inner(ctx.session.store_path()).unwrap();
            }
        }
        assert!(ctx.review().is_err());
        match kind {
            0 => assert_eq!(fs::read(ctx.session.store_path()).unwrap(), b"foreign file"),
            1 => assert_eq!(
                fs::read(ctx.session.store_path().join("partial")).unwrap(),
                b"preserve partial evidence"
            ),
            _ => assert!(Store::open_inner(ctx.session.store_path())
                .unwrap()
                .snapshot_with(&test_verify)
                .unwrap()
                .is_none()),
        }
        ctx.preserved();
    }
}

#[test]
fn missing_native_data_parent_is_refused_without_creating_it() {
    let ctx = Context::new();
    fs::remove_dir(ctx.home.join("data")).unwrap();
    assert!(ctx.review().is_err());
    assert!(!ctx.home.join("data").exists());
    ctx.preserved();
}

#[test]
fn foreign_user_service_and_every_global_conflict_are_kept_even_if_official_looking() {
    for slot in 0..4 {
        let ctx = Context::new();
        let path = if slot == 3 {
            fs::create_dir_all(ctx.home.join("data/dbus-1/services")).unwrap();
            ctx.home
                .join("data/dbus-1/services/com.creatorworks.hub.Host.service")
        } else {
            ctx.globals[slot].clone()
        };
        fs::write(&path, b"[D-BUS Service]\nName=com.creatorworks.hub.Host\n").unwrap();
        assert!(ctx.review().is_err());
        assert_eq!(
            fs::read(path).unwrap(),
            b"[D-BUS Service]\nName=com.creatorworks.hub.Host\n"
        );
        assert!(!ctx.session.store_path().exists());
        ctx.preserved();
    }
}

#[test]
fn approval_checks_session_review_signature_image_and_new_conflicts_before_staging() {
    for drift in 0..5 {
        let ctx = Context::new();
        let mut review = ctx.review().unwrap();
        match drift {
            0 => review.signature = b"changed signature".to_vec(),
            1 => fs::write(&ctx.image, b"changed Root bytes").unwrap(),
            2 => review.pid = review.pid.saturating_add(1),
            3 => review.config = ctx.home.join("another-context"),
            _ => fs::write(&ctx.globals[1], b"new foreign service").unwrap(),
        }
        assert_eq!(
            ctx.apply(&review, &|| false, &|_| panic!(
                "No staging allowed after drift"
            ))
            .err()
            .unwrap()
            .kind,
            ErrorKind::Refused
        );
        assert!(ctx.data_names().is_empty());
        ctx.preserved();
    }
}

#[test]
fn cancelled_approval_before_write_does_not_even_open_running_image() {
    let ctx = Context::new();
    let review = ctx.review().unwrap();
    let result = apply_with(
        &ctx.session,
        &review,
        &|| true,
        &|| panic!("No image read before cancellation"),
        &ctx.globals,
        &test_verify,
        &|_| panic!("No staging before cancellation"),
    );
    let error = result.err().unwrap();
    assert_eq!(error.kind, ErrorKind::Cancelled, "{error:?}");
    assert!(ctx.data_names().is_empty());
    ctx.preserved();
}

#[test]
fn changed_native_session_and_store_appearing_after_review_refuse_without_adoption() {
    let ctx = Context::new();
    let review = ctx.review().unwrap();
    let other = HostSession::from_values([
        ("HOME".into(), ctx.home.clone().into_os_string()),
        (
            "XDG_DATA_HOME".into(),
            ctx.home.join("other-data").into_os_string(),
        ),
    ])
    .unwrap();
    assert!(apply_with(
        &other,
        &review,
        &|| false,
        &|| File::open(&ctx.image).map_err(|_| refused("Test image missing")),
        &ctx.globals,
        &test_verify,
        &|_| panic!("No staging in a changed session")
    )
    .is_err());
    assert!(!ctx.home.join("other-data").exists());
    fs::create_dir(ctx.session.store_path()).unwrap();
    fs::write(
        ctx.session.store_path().join("new-unknown"),
        b"keep this exact file",
    )
    .unwrap();
    assert_eq!(
        ctx.apply(&review, &|| false, &|_| panic!(
            "No staging after store appeared"
        ))
        .err()
        .unwrap()
        .kind,
        ErrorKind::Refused
    );
    assert_eq!(
        fs::read(ctx.session.store_path().join("new-unknown")).unwrap(),
        b"keep this exact file"
    );
    assert_eq!(ctx.data_names().len(), 1);
    ctx.preserved();
}

#[test]
fn interruptions_during_every_initialization_write_never_publish_a_partial_store() {
    for point in [
        "bootstrap-directory-created",
        "bootstrap-marker-written",
        "bootstrap-lock-written",
        "bootstrap-generations-created",
        "bootstrap-history-created",
        "bootstrap-origin-written",
        "bootstrap-store-complete",
        "bootstrap-before-publication",
    ] {
        let ctx = Context::new();
        let review = ctx.review().unwrap();
        let result = ctx.apply(&review, &|| false, &|at| {
            if at == point {
                Err(refused("Test interruption at exact bootstrap checkpoint"))
            } else {
                Ok(())
            }
        });
        assert_eq!(result.err().unwrap().kind, ErrorKind::Refused, "{point}");
        ctx.retained_staging();
        ctx.preserved();
    }
}

#[test]
fn cancellation_after_initialization_keeps_store_absent_and_preserves_private_evidence() {
    let ctx = Context::new();
    let review = ctx.review().unwrap();
    let complete = std::cell::Cell::new(false);
    let result = ctx.apply(&review, &|| complete.get(), &|at| {
        if at == "bootstrap-store-complete" {
            complete.set(true);
        }
        Ok(())
    });
    let error = result.err().unwrap();
    assert_eq!(error.kind, ErrorKind::Cancelled, "{error:?}");
    assert!(complete.get());
    ctx.retained_staging();
    ctx.preserved();
}

#[cfg(unix)]
#[test]
fn links_and_foreign_writable_ancestry_do_not_authorize_bootstrap() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    for slot in 0..3 {
        let ctx = Context::new();
        if slot == 0 {
            symlink(ctx.home.join("missing"), ctx.session.store_path()).unwrap();
        }
        if slot == 1 {
            fs::set_permissions(ctx.home.join("data"), fs::Permissions::from_mode(0o777)).unwrap();
        }
        if slot == 2 {
            fs::rename(ctx.home.join("data"), ctx.home.join("elsewhere")).unwrap();
            symlink(ctx.home.join("elsewhere"), ctx.home.join("data")).unwrap();
        }
        assert!(ctx.review().is_err());
        ctx.preserved();
        if slot == 1 {
            fs::set_permissions(ctx.home.join("data"), fs::Permissions::from_mode(0o700)).unwrap();
        }
    }
}

#[test]
fn cancellation_at_last_publication_checkpoint_never_creates_target() {
    let ctx = Context::new();
    let review = ctx.review().unwrap();
    let cancelled = std::cell::Cell::new(false);
    let result = ctx.apply(&review, &|| cancelled.get(), &|at| {
        if at == "bootstrap-before-publication" {
            cancelled.set(true);
        }
        Ok(())
    });
    assert_eq!(result.err().unwrap().kind, ErrorKind::Cancelled);
    ctx.retained_staging();
}

#[test]
fn cancellation_during_final_image_revalidation_is_checked_before_commit() {
    let ctx = Context::new();
    let review = ctx.review().unwrap();
    let cancelled = std::cell::Cell::new(false);
    let reads = std::cell::Cell::new(0);
    let result = apply_with(
        &ctx.session,
        &review,
        &|| cancelled.get(),
        &|| {
            reads.set(reads.get() + 1);
            if reads.get() == 2 {
                cancelled.set(true);
            }
            File::open(&ctx.image).map_err(|_| refused("Test image missing"))
        },
        &ctx.globals,
        &test_verify,
        &|_| Ok(()),
    );
    assert_eq!(reads.get(), 2);
    assert_eq!(result.err().unwrap().kind, ErrorKind::Cancelled);
    ctx.retained_staging();
}

#[cfg(unix)]
#[test]
fn replaced_staging_name_is_never_recursively_cleaned_and_original_is_preserved() {
    let ctx = Context::new();
    let review = ctx.review().unwrap();
    let replacement = std::cell::RefCell::new(None);
    let renamed = ctx.home.join("data/renamed-bootstrap-evidence");
    let result = ctx.apply(&review, &|| false, &|at| {
        if at == "bootstrap-store-complete" {
            let names = ctx.data_names();
            assert_eq!(names.len(), 1);
            let old_name = ctx.home.join("data").join(&names[0]);
            fs::rename(&old_name, &renamed).unwrap();
            disk::create_dir(&old_name).unwrap();
            fs::write(
                old_name.join("unreviewed"),
                b"do not delete this replacement",
            )
            .unwrap();
            *replacement.borrow_mut() = Some(old_name);
        }
        Ok(())
    });
    assert_eq!(result.err().unwrap().kind, ErrorKind::Refused);
    assert!(!ctx.session.store_path().exists());
    assert_eq!(
        fs::read(replacement.borrow().as_ref().unwrap().join("unreviewed")).unwrap(),
        b"do not delete this replacement"
    );
    assert!(renamed.join("store").join(ORIGIN).is_file());
    Store::open_inner(&renamed.join("store")).unwrap();
    ctx.preserved();
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;

    fn create(ctx: &Context) {
        let review = ctx.review().unwrap();
        assert!(matches!(
            ctx.apply(&review, &|| false, &|_| Ok(())).unwrap(),
            BootstrapOutcome::Created(_)
        ));
    }

    fn recovery(ctx: &Context) -> Result<BootstrapRecoveryReview> {
        recovery_review_with(
            &ctx.session,
            &ctx.package,
            &ctx.expected,
            File::open(&ctx.image).unwrap(),
            &ctx.globals,
            &test_verify,
        )
    }

    fn confirm(
        ctx: &Context,
        review: &BootstrapRecoveryReview,
        checkpoint: &dyn Fn(&str) -> Result<()>,
    ) -> Result<BootstrapRecoveryOutcome> {
        recover_with(
            &ctx.session,
            review,
            &|| File::open(&ctx.image).map_err(|_| refused("Test image missing")),
            &ctx.globals,
            &test_verify,
            checkpoint,
        )
    }

    #[test]
    fn unknown_publish_can_be_explicitly_reviewed_after_old_capability_is_dropped() {
        let ctx = Context::new();
        let initial = ctx.review().unwrap();
        assert_eq!(
            ctx.apply(&initial, &|| false, &|at| {
                if at == "bootstrap-published-before-directory-flush" {
                    Err(refused("Known exact post-publication failure"))
                } else {
                    Ok(())
                }
            })
            .err()
            .unwrap()
            .kind,
            ErrorKind::OutcomeUnknown
        );
        drop(initial);
        // A new context and review represent loss of the original process-only
        // capability. Authority is reverified; no boolean/ErrorKind authorizes it.
        let review = recovery(&ctx).unwrap();
        assert_eq!(review.store_path(), ctx.session.store_path());
        assert_eq!(review.version(), "0.1.16");
        assert_eq!(review.generation(), ctx.package.generation());
        let origin = fs::read(ctx.session.store_path().join(ORIGIN)).unwrap();
        let BootstrapRecoveryOutcome::Recovered(store) =
            confirm(&ctx, &review, &|_| Ok(())).unwrap()
        else {
            panic!("explicit confirmation expected")
        };
        assert!(store.snapshot_with(&test_verify).unwrap().is_none());
        assert!(fs::read_dir(store.root.join("generations"))
            .unwrap()
            .next()
            .is_none());
        assert!(fs::read_dir(store.root.join("history"))
            .unwrap()
            .next()
            .is_none());
        assert_eq!(fs::read(store.root.join(ORIGIN)).unwrap(), origin);
        assert!(!ctx.home.join("data/dbus-1").exists());
        ctx.preserved();
    }

    #[test]
    fn recovery_review_is_read_only_with_writer_lock_held_and_keep_ignores_all_drift() {
        let ctx = Context::new();
        create(&ctx);
        let lock = disk::lock(&ctx.session.store_path().join("transaction.lock")).unwrap();
        let review = recovery(&ctx).unwrap(); // would fail if review took writer lock
        assert_eq!(
            confirm(&ctx, &review, &|_| panic!(
                "No flush while another writer owns lock"
            ))
            .err()
            .unwrap()
            .kind,
            ErrorKind::Refused
        );
        drop(lock);
        fs::write(
            ctx.session.store_path().join(ORIGIN),
            b"origin changed after review",
        )
        .unwrap();
        fs::write(&ctx.image, b"no current image proof").unwrap();
        assert!(matches!(
            recover_bootstrap(&ctx.session, &review, BootstrapRecoveryChoice::Keep).unwrap(),
            BootstrapRecoveryOutcome::Kept
        ));
        assert_eq!(
            fs::read(ctx.session.store_path().join(ORIGIN)).unwrap(),
            b"origin changed after review"
        );
        ctx.preserved();
    }

    #[test]
    fn postpublication_staging_replacement_is_preserved_even_on_success_cleanup() {
        let ctx = Context::new();
        let review = ctx.review().unwrap();
        let replaced = std::cell::RefCell::new(None);
        let saved = ctx.home.join("data/renamed-empty-staging-evidence");
        let result = ctx.apply(&review, &|| false, &|at| {
            if at == "bootstrap-published-before-directory-flush" {
                let name = ctx
                    .data_names()
                    .into_iter()
                    .find(|n| n.to_string_lossy().starts_with(".creator-hub-bootstrap-"))
                    .unwrap();
                let path = ctx.home.join("data").join(name);
                fs::rename(&path, &saved).unwrap();
                disk::create_dir(&path).unwrap();
                fs::write(path.join("unknown"), b"keep postcommit replacement").unwrap();
                *replaced.borrow_mut() = Some(path);
            }
            Ok(())
        });
        assert!(matches!(result.unwrap(), BootstrapOutcome::Created(_)));
        assert!(saved.is_dir());
        assert_eq!(
            fs::read(replaced.borrow().as_ref().unwrap().join("unknown")).unwrap(),
            b"keep postcommit replacement"
        );
        ctx.inspect(ctx.session.store_path()).unwrap();
        ctx.preserved();
    }

    #[test]
    fn recovery_rechecks_real_new_entry_after_lock_before_any_flush() {
        let ctx = Context::new();
        create(&ctx);
        let review = recovery(&ctx).unwrap();
        let result = confirm(&ctx, &review, &|at| {
            if at == "bootstrap-recovery-locked" {
                fs::write(
                    ctx.session.store_path().join("unreviewed"),
                    b"new file during confirmation",
                )
                .unwrap();
            } else {
                panic!("Must refuse before flush checkpoint");
            }
            Ok(())
        });
        assert_eq!(result.err().unwrap().kind, ErrorKind::Refused);
        assert_eq!(
            fs::read(ctx.session.store_path().join("unreviewed")).unwrap(),
            b"new file during confirmation"
        );
        ctx.preserved();
    }

    #[test]
    fn missing_marker_only_changed_and_foreign_origins_are_not_adopted() {
        for change in 0..9 {
            let ctx = Context::new();
            create(&ctx);
            let path = ctx.session.store_path().join(ORIGIN);
            let original = fs::read(&path).unwrap();
            match change {
                0 => fs::remove_file(&path).unwrap(),
                1 => fs::write(&path, b"{\"schemaVersion\":1,\"schemaVersion\":1}").unwrap(),
                _ => {
                    let mut value: serde_json::Value = serde_json::from_slice(&original).unwrap();
                    match change {
                        2 => value["generation"] = "f".repeat(64).into(),
                        3 => value["version"] = "0.1.17".into(),
                        4 => value["purpose"] = "foreign-product".into(),
                        5 => value["directory"]["inode"] = 0.into(),
                        6 => value["nativeParent"]["inode"] = 0.into(),
                        7 => value["executableSha256"] = "f".repeat(64).into(),
                        _ => value["unknown"] = true.into(),
                    }
                    fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
                }
            }
            let retained = fs::read(&path).ok();
            assert!(recovery(&ctx).is_err(), "change {change}");
            assert_eq!(fs::read(&path).ok(), retained);
            ctx.preserved();
        }
        let ctx = Context::new();
        Store::create_inner(ctx.session.store_path()).unwrap();
        assert!(recovery(&ctx).is_err());
        assert!(!ctx.session.store_path().join(ORIGIN).exists());
        ctx.preserved();
    }

    #[test]
    fn copied_origin_and_complete_layout_do_not_bind_a_new_store_directory() {
        let source = Context::new();
        create(&source);
        let copy = Context::new();
        Store::create_inner(copy.session.store_path()).unwrap();
        disk::write_new(
            &copy.session.store_path().join(ORIGIN),
            &fs::read(source.session.store_path().join(ORIGIN)).unwrap(),
            0o600,
        )
        .unwrap();
        Store::open_inner(copy.session.store_path()).unwrap(); // ordinary layout alone is insufficient
        assert!(recovery(&copy).err().unwrap().message.contains("origin"));
        source.preserved();
        copy.preserved();
    }

    #[test]
    fn recovery_refuses_links_permissions_unknown_members_selection_and_pending_work() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        for change in 0..7 {
            let ctx = Context::new();
            create(&ctx);
            let origin = ctx.session.store_path().join(ORIGIN);
            match change {
                0 => {
                    let saved = ctx.home.join("origin-copy");
                    fs::rename(&origin, &saved).unwrap();
                    symlink(saved, &origin).unwrap();
                }
                1 => {
                    fs::hard_link(&origin, ctx.home.join("second-origin-link")).unwrap();
                }
                2 => fs::set_permissions(&origin, fs::Permissions::from_mode(0o644)).unwrap(),
                3 => fs::write(
                    ctx.session.store_path().join("current.json"),
                    b"unreviewed selection",
                )
                .unwrap(),
                4 => fs::write(
                    ctx.session.store_path().join("pending.json"),
                    b"retained deployment journal",
                )
                .unwrap(),
                5 => fs::write(
                    ctx.session.store_path().join("generations/retained"),
                    b"not empty",
                )
                .unwrap(),
                _ => fs::create_dir(ctx.session.store_path().join("activation-v1")).unwrap(),
            }
            assert!(recovery(&ctx).is_err(), "change {change}");
            assert!(ctx.session.store_path().exists());
            ctx.preserved();
        }
    }

    #[test]
    fn recovery_requires_exact_signed_package_selector_version_and_current_image() {
        for change in 0..5 {
            let mut ctx = Context::new();
            create(&ctx);
            match change {
                0 => ctx.package.signature = b"untrusted signature".to_vec(),
                1 => ctx.expected = Expected::linux_x86_64("0.1.17").unwrap(),
                2 => {
                    ctx.package.contents.remove(crate::SELECTOR_ENTRYPOINT);
                }
                3 => fs::write(&ctx.image, b"changed running image").unwrap(),
                _ => fs::write(&ctx.globals[0], b"foreign global install").unwrap(),
            }
            assert!(recovery(&ctx).is_err());
            ctx.preserved();
        }
    }

    #[test]
    fn recovery_confirmation_rechecks_record_context_and_directory_before_flush() {
        for change in 0..4 {
            let ctx = Context::new();
            create(&ctx);
            let review = recovery(&ctx).unwrap();
            match change {
                0 => fs::write(ctx.session.store_path().join(ORIGIN), b"changed origin").unwrap(),
                1 => fs::write(&ctx.image, b"changed image").unwrap(),
                2 => fs::write(&ctx.globals[1], b"new conflict").unwrap(),
                _ => {
                    fs::rename(
                        ctx.session.store_path(),
                        ctx.home.join("retained-old-store"),
                    )
                    .unwrap();
                    Store::create_inner(ctx.session.store_path()).unwrap();
                }
            }
            assert_eq!(
                confirm(&ctx, &review, &|_| panic!("No recovery flush after drift"))
                    .err()
                    .unwrap()
                    .kind,
                ErrorKind::Refused
            );
            ctx.preserved();
        }
    }

    #[test]
    fn interrupted_recovery_retains_origin_and_can_only_resume_after_new_explicit_review() {
        for point in [
            "bootstrap-recovery-locked",
            "bootstrap-recovery-before-flush",
            "bootstrap-recovery-flushed",
        ] {
            let ctx = Context::new();
            create(&ctx);
            let review = recovery(&ctx).unwrap();
            let origin = fs::read(ctx.session.store_path().join(ORIGIN)).unwrap();
            let error = confirm(&ctx, &review, &|at| {
                if at == point {
                    Err(refused("Exact recovery interruption"))
                } else {
                    Ok(())
                }
            })
            .err()
            .unwrap();
            assert_eq!(
                error.kind,
                if point == "bootstrap-recovery-locked" {
                    ErrorKind::Refused
                } else {
                    ErrorKind::OutcomeUnknown
                }
            );
            assert_eq!(
                fs::read(ctx.session.store_path().join(ORIGIN)).unwrap(),
                origin
            );
            let new_review = recovery(&ctx).unwrap();
            assert!(matches!(
                confirm(&ctx, &new_review, &|_| Ok(())).unwrap(),
                BootstrapRecoveryOutcome::Recovered(_)
            ));
            assert!(!ctx.session.store_path().join("current.json").exists());
            assert!(!ctx.home.join("data/dbus-1").exists());
            ctx.preserved();
        }
    }

    #[test]
    fn foreign_owned_native_data_parent_is_not_bootstrap_authority() {
        use std::os::unix::fs::MetadataExt;
        if unsafe { libc::geteuid() } == 0 {
            assert!(disk::admit().is_err());
        } else {
            assert_ne!(fs::metadata("/proc").unwrap().uid(), unsafe {
                libc::geteuid()
            });
            assert!(hold_parent(Path::new("/proc/creator-hub-portable")).is_err());
        }
    }

    #[test]
    fn atomic_publication_returns_complete_empty_store_without_installing_any_package() {
        let ctx = Context::new();
        let review = ctx.review().unwrap();
        let BootstrapOutcome::Created(store) = ctx
            .apply(&review, &|| ctx.session.store_path().exists(), &|_| Ok(()))
            .unwrap()
        else {
            panic!("committed creation is not cancellation")
        };
        ctx.inspect(&store.root).unwrap();
        assert!(store.snapshot_with(&test_verify).unwrap().is_none());
        assert!(!ctx.home.join("data/dbus-1").exists());
        assert_eq!(
            ctx.data_names(),
            [std::ffi::OsString::from("creator-hub-portable")]
        );
        assert!(ctx.review().is_err()); // valid existing stores still require separate explicit handling
        ctx.preserved();
    }

    #[test]
    fn no_replace_publication_keeps_raced_existing_directory_even_when_empty() {
        use std::os::unix::fs::MetadataExt;
        for populated in [false, true] {
            let ctx = Context::new();
            let review = ctx.review().unwrap();
            let identity = std::cell::Cell::new(None);
            let result = ctx.apply(&review, &|| false, &|at| {
                if at == "bootstrap-before-publication" {
                    fs::create_dir(ctx.session.store_path()).unwrap();
                    if populated {
                        fs::write(
                            ctx.session.store_path().join("unknown"),
                            b"do not overwrite",
                        )
                        .unwrap();
                    }
                    let meta = fs::metadata(ctx.session.store_path()).unwrap();
                    identity.set(Some((meta.dev(), meta.ino())));
                }
                Ok(())
            });
            assert_eq!(result.err().unwrap().kind, ErrorKind::Refused);
            let meta = fs::metadata(ctx.session.store_path()).unwrap();
            assert_eq!(identity.get(), Some((meta.dev(), meta.ino())));
            assert!(!ctx.session.store_path().join("store.id").exists());
            if populated {
                assert_eq!(
                    fs::read(ctx.session.store_path().join("unknown")).unwrap(),
                    b"do not overwrite"
                );
            }
            assert_eq!(ctx.data_names().len(), 2); // raced target and retained private evidence
            ctx.preserved();
        }
    }

    #[test]
    fn publication_then_flush_boundary_failure_is_unknown_and_keeps_inspectable_complete_store() {
        for point in [
            "bootstrap-published-before-directory-flush",
            "bootstrap-parent-flushed",
        ] {
            let ctx = Context::new();
            let review = ctx.review().unwrap();
            let result = ctx.apply(&review, &|| false, &|at| {
                if at == point {
                    ctx.inspect(ctx.session.store_path()).unwrap();
                    Err(refused("Exact post-publication interruption"))
                } else {
                    Ok(())
                }
            });
            assert_eq!(result.err().unwrap().kind, ErrorKind::OutcomeUnknown);
            ctx.inspect(ctx.session.store_path()).unwrap();
            assert!(Store::open_inner(ctx.session.store_path())
                .unwrap()
                .snapshot_with(&test_verify)
                .unwrap()
                .is_none());
            assert!(ctx.review().is_err());
            assert_eq!(ctx.data_names().len(), 1);
            ctx.preserved();
        }
    }

    #[test]
    fn changed_native_parent_inode_is_not_followed_or_adopted() {
        let ctx = Context::new();
        let review = ctx.review().unwrap();
        fs::rename(ctx.home.join("data"), ctx.home.join("old-data")).unwrap();
        fs::create_dir(ctx.home.join("data")).unwrap();
        assert_eq!(
            ctx.apply(&review, &|| false, &|_| panic!(
                "Do not stage in replaced parent"
            ))
            .err()
            .unwrap()
            .kind,
            ErrorKind::Refused
        );
        assert!(ctx.data_names().is_empty());
        assert!(!ctx.home.join("old-data/creator-hub-portable").exists());
        ctx.preserved();
    }

    #[test]
    fn running_kernel_image_can_match_same_version_signed_sidecar_without_store_inode_equivalence()
    {
        use std::io::Read as _;
        let mut ctx = Context::new();
        let mut bytes = Vec::new();
        current_image().unwrap().read_to_end(&mut bytes).unwrap();
        let hash = digest(&bytes);
        file(&mut ctx.package, crate::ENTRYPOINT, bytes, 0o755);
        let mut profile: serde_json::Value =
            serde_json::from_slice(&ctx.package.contents[crate::HOST_PROFILE]).unwrap();
        profile["executableSha256"] = hash.into();
        file(
            &mut ctx.package,
            crate::HOST_PROFILE,
            serde_json::to_vec(&profile).unwrap(),
            0o644,
        );
        rebind(&mut ctx.package);
        let review = review_with(
            &ctx.session,
            &ctx.package,
            &ctx.expected,
            current_image().unwrap(),
            &ctx.globals,
            &test_verify,
        )
        .unwrap();
        assert!(ctx.data_names().is_empty());
        let outcome = apply_with(
            &ctx.session,
            &review,
            &|| false,
            &current_image,
            &ctx.globals,
            &test_verify,
            &|_| Ok(()),
        )
        .unwrap();
        assert!(matches!(outcome, BootstrapOutcome::Created(_)));
        ctx.preserved();
        // Test-only signature seam plus real kernel image, NOT production signed
        // AppImage, helper registration, GUI or first-launch acceptance evidence.
    }
}
