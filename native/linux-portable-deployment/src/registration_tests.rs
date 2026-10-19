use super::*;
use crate::store::tests::{test_verify, Fixture};

fn package(version: &str, marker: u8) -> VerifiedPackage {
    let mut package = Fixture::new(version).with_runner().package().unwrap();
    let mut binary = vec![0; 64];
    binary[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
    binary[18] = 0x3e;
    binary[63] = marker;
    package
        .manifest
        .entries
        .insert("usr/libexec".into(), Entry::Directory { mode: 0o755 });
    package.manifest.entries.insert(
        SELECTOR_ENTRYPOINT.into(),
        Entry::File {
            size: binary.len() as u64,
            sha256: digest(&binary),
            mode: 0o755,
        },
    );
    package.manifest.archive.unpacked_size += binary.len() as u64;
    package.contents.insert("usr/libexec".into(), Vec::new());
    package.contents.insert(SELECTOR_ENTRYPOINT.into(), binary);
    rebind(&mut package);
    package
}

fn rebind(package: &mut VerifiedPackage) {
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
    let raw = gzip.finish().unwrap();
    package.manifest.archive.size = raw.len() as u64;
    package.manifest.archive.sha256 = digest(&raw);
    package.bytes = encode(&package.manifest).unwrap();
    package.signature = digest(&package.bytes).into_bytes();
}

#[test]
fn signed_selector_binding_has_no_arbitrary_source_path_or_hash_authority() {
    let valid = package("0.1.16", 1);
    assert!(package_owner(&valid, &test_verify).is_ok());
    assert!(package_owner(&valid, &production_verify).is_err());
    assert!(package_owner(
        &Fixture::new("0.1.16").with_runner().package().unwrap(),
        &test_verify
    )
    .is_err());
    for change in [0, 1, 2, 3] {
        let mut invalid = package("0.1.16", 1);
        match change {
            0 => {
                invalid.contents.get_mut(SELECTOR_ENTRYPOINT).unwrap()[0] = 0;
            }
            1 => {
                invalid.contents.get_mut(SELECTOR_ENTRYPOINT).unwrap()[18] = 0xb7;
                let sha = digest(&invalid.contents[SELECTOR_ENTRYPOINT]);
                if let Entry::File { sha256, .. } = invalid
                    .manifest
                    .entries
                    .get_mut(SELECTOR_ENTRYPOINT)
                    .unwrap()
                {
                    *sha256 = sha;
                }
                rebind(&mut invalid);
            }
            2 => {
                if let Entry::File { mode, .. } = invalid
                    .manifest
                    .entries
                    .get_mut(SELECTOR_ENTRYPOINT)
                    .unwrap()
                {
                    *mode = 0o644;
                }
                rebind(&mut invalid);
            }
            _ => {
                invalid.signature = b"unknown".to_vec();
            }
        }
        assert!(package_owner(&invalid, &test_verify).is_err());
    }
}

#[test]
fn service_has_only_fixed_activation_and_refuses_ambiguous_exec_paths() {
    let bytes = service_bytes(Path::new(
        "/home/deck/.local/share/creator-hub-portable/activation-v1/creator-hub-portable-selector",
    ))
    .unwrap();
    let text = String::from_utf8(bytes).unwrap();
    assert!(text.ends_with("creator-hub-portable-selector activate\n"));
    assert_eq!(text.lines().count(), 3);
    assert!(!text.contains("sh -c"));
    for path in [
        "relative",
        "/home/a b/selector",
        "/home/a%u/selector",
        "/home/a\nExec=evil/selector",
        "/home/\"quoted\"/selector",
        "/home/$USER/selector",
        "/home/a\\b/selector",
        "/home/a/../selector",
        "/home/a/./selector",
        "/home//selector",
    ] {
        assert!(service_bytes(Path::new(path)).is_err(), "{path:?}");
    }
}

#[test]
fn recovery_accepts_only_exact_before_or_after_images() {
    let empty = Images {
        tool: None,
        service: None,
        owner: None,
    };
    let target = Images {
        tool: Some(vec![1]),
        service: Some(vec![2]),
        owner: Some(vec![3]),
    };
    for mask in 0..8 {
        let actual = Images {
            tool: if mask & 1 == 0 {
                None
            } else {
                target.tool.clone()
            },
            service: if mask & 2 == 0 {
                None
            } else {
                target.service.clone()
            },
            owner: if mask & 4 == 0 {
                None
            } else {
                target.owner.clone()
            },
        };
        known_intermediate(&actual, &empty, &target).unwrap();
    }
    let foreign = Images {
        tool: Some(vec![99]),
        service: target.service.clone(),
        owner: target.owner.clone(),
    };
    assert!(known_intermediate(&foreign, &empty, &target).is_err());
}

#[test]
fn owner_and_transition_reject_unknown_duplicate_and_missing_fields() {
    for bytes in [b"{}".as_slice(), br#"{"schemaVersion":1,"generation":"a","version":"0.1.16","selectorSha256":"b","selectorSize":64,"unknown":true}"#, br#"{"schemaVersion":1,"schemaVersion":1,"generation":"a","version":"0.1.16","selectorSha256":"b","selectorSize":64}"#] {
        assert!(decode::<Owner>(bytes).is_err());
    }
    assert!(decode::<Transition>(
        br#"{"schemaVersion":1,"before":null,"after":null,"path":"/usr/bin/creator-hub"}"#
    )
    .is_err());
    assert!(transition(br#"{"schemaVersion":2,"before":null,"after":null}"#).is_err());
    assert!(transition(br#"{"schemaVersion":1}"#).is_err());
    assert!(transition(br#"{ "schemaVersion":1,"before":null,"after":null}"#).is_err());
}

#[test]
fn decline_does_not_admit_or_touch_any_files_even_after_review_becomes_stale() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap().join("not-created");
    let session = HostSession::from_values([(
        std::ffi::OsString::from("HOME"),
        temp.path().as_os_str().to_owned(),
    )])
    .unwrap();
    let store = Store { root: root.clone() };
    let review = RegistrationReview {
        root: root.clone(),
        service: root.join("foreign"),
        transition: Transition {
            schema_version: 1,
            before: None,
            after: None,
        },
        before: Images {
            tool: None,
            service: None,
            owner: None,
        },
    };
    assert_eq!(
        store
            .apply_registration(
                &session,
                &review,
                RegistrationChoice::KeepCurrent,
                || panic!("decline must not inspect cancellation")
            )
            .unwrap(),
        RegistrationOutcome::Declined
    );
    assert!(!root.exists());
}

// Real filesystem success cases require Unix path/mode semantics; Windows pure
// checks above are not Linux registration, process or service acceptance.
#[cfg(unix)]
mod unix {
    use super::*;
    use std::{cell::Cell, ffi::OsString};

    struct Context {
        _temp: tempfile::TempDir,
        session: HostSession,
        store: Store,
    }

    impl Context {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let data = temp.path().canonicalize().unwrap();
            let session = HostSession::from_values([
                (OsString::from("HOME"), data.as_os_str().to_owned()),
                (OsString::from("XDG_DATA_HOME"), data.as_os_str().to_owned()),
            ])
            .unwrap();
            let store = Store::create_inner(session.store_path()).unwrap();
            Self {
                _temp: temp,
                session,
                store,
            }
        }
        fn install(&self, package: &VerifiedPackage) {
            let review = self
                .store
                .review_install_with(package, &test_verify)
                .unwrap();
            self.store
                .install_reviewed_with(
                    &review,
                    package,
                    crate::InstallChoice::InstallReviewed,
                    &|| false,
                    &test_verify,
                )
                .unwrap();
        }
        fn review(&self, package: &VerifiedPackage) -> RegistrationReview {
            self.store
                .review_registration_with(&self.session, Some(package), &test_verify)
                .unwrap()
        }
        fn apply(&self, review: &RegistrationReview) -> Result<RegistrationOutcome> {
            self.store.apply_registration_with(
                &self.session,
                review,
                &|| false,
                &|_| Ok(()),
                &test_verify,
            )
        }
        fn registered(&self) -> RegistrationReview {
            let package = package("0.1.16", 1);
            self.install(&package);
            let review = self.review(&package);
            assert_eq!(self.apply(&review).unwrap(), RegistrationOutcome::Applied);
            review
        }
    }

    fn interrupt(at: &'static str) -> impl Fn(&str) -> Result<()> {
        move |site| {
            if site == at {
                Err(refused("simulated interruption"))
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn install_is_separate_from_registration_and_current_selected_version_is_not_pinned() {
        let cx = Context::new();
        let old = cx.registered();
        assert_eq!(
            cx.apply(&cx.review(&package("0.1.16", 1))).unwrap(),
            RegistrationOutcome::Unchanged
        );
        let next = package("0.1.17", 2);
        cx.install(&next);
        let lease = cx
            .store
            .selected_activation_with(&cx.session, &test_verify)
            .unwrap();
        assert_eq!(lease.selection().version, "0.1.17");
        let command = lease.command(&cx.session);
        assert!(command.get_program().to_string_lossy().ends_with("AppRun"));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            ["--flatpak-activate"]
        );
        drop(lease);
        // Original signed selector remains valid across Root version updates.
        assert_eq!(
            fs::read(old.selector_path()).unwrap(),
            package("0.1.16", 1).contents[SELECTOR_ENTRYPOINT]
        );
        assert!(cx
            .store
            .owned_registration(
                old.service_path(),
                &cx.store.registration_images(old.service_path()).unwrap(),
                &test_verify
            )
            .unwrap()
            .is_some());
    }

    #[test]
    fn registration_requires_retained_signed_tool_generation_and_preserves_unknown_files() {
        let cx = Context::new();
        let package = package("0.1.16", 1);
        let review = cx.review(&package);
        assert!(cx.apply(&review).is_err());
        assert!(!review.selector_path().exists());
        cx.install(&package);
        let sentinel = cx.store.root.parent().unwrap().join("unrelated-settings");
        fs::write(&sentinel, b"keep me").unwrap();
        cx.apply(&review).unwrap();
        assert_eq!(fs::read(sentinel).unwrap(), b"keep me");
        assert_eq!(
            fs::read(review.service_path()).unwrap(),
            service_bytes(&review.selector_path()).unwrap()
        );
    }

    #[test]
    fn unknown_existing_service_even_identical_bytes_is_not_adopted() {
        let cx = Context::new();
        let package = package("0.1.16", 1);
        cx.install(&package);
        let review = cx.review(&package);
        fs::create_dir_all(review.service_path().parent().unwrap()).unwrap();
        disk::write_new(
            review.service_path(),
            &service_bytes(&review.selector_path()).unwrap(),
            0o644,
        )
        .unwrap();
        assert!(cx
            .store
            .review_registration_with(&cx.session, Some(&package), &test_verify)
            .is_err());
        assert!(cx
            .store
            .review_registration_with(&cx.session, None, &test_verify)
            .is_err());
        assert!(cx.apply(&review).is_err());
        assert!(review.service_path().is_file());
    }

    #[test]
    fn stale_review_cancel_and_unknown_tool_never_overwrite() {
        let cx = Context::new();
        let package = package("0.1.16", 1);
        cx.install(&package);
        let review = cx.review(&package);
        assert_eq!(
            cx.store
                .apply_registration_with(&cx.session, &review, &|| true, &|_| Ok(()), &test_verify)
                .unwrap_err()
                .kind,
            ErrorKind::Cancelled
        );
        assert!(!cx.store.root.join(DIRECTORY).exists());
        disk::create_dir(&cx.store.root.join(DIRECTORY)).unwrap();
        disk::write_new(&review.selector_path(), b"unknown", 0o555).unwrap();
        assert!(cx.apply(&review).is_err());
        assert_eq!(fs::read(review.selector_path()).unwrap(), b"unknown");
    }

    #[test]
    fn register_interruption_at_every_checkpoint_is_recoverable_without_selection_rollback() {
        for site in [
            "registration-journaled",
            "registration-tool",
            "registration-service",
            "registration-owner",
            "registration-verified",
        ] {
            let cx = Context::new();
            let package = package("0.1.16", 1);
            cx.install(&package);
            let before_selection = cx.store.snapshot_with(&test_verify).unwrap();
            let review = cx.review(&package);
            let error = cx
                .store
                .apply_registration_with(
                    &cx.session,
                    &review,
                    &|| false,
                    &interrupt(site),
                    &test_verify,
                )
                .unwrap_err();
            assert_eq!(error.kind, ErrorKind::OutcomeUnknown);
            assert!(cx
                .store
                .selected_activation_with(&cx.session, &test_verify)
                .is_err());
            let recovery = cx
                .store
                .registration_recovery_with(&cx.session, &test_verify)
                .unwrap()
                .unwrap();
            cx.store
                .recover_registration_with(&cx.session, &recovery, &|_| Ok(()), &test_verify)
                .unwrap();
            assert!(!review.service_path().exists());
            assert!(!review.selector_path().exists());
            assert_eq!(
                cx.store.snapshot_with(&test_verify).unwrap(),
                before_selection
            );
            assert!(cx.store.registration_journal().unwrap().is_none());
        }
    }

    #[test]
    fn journal_directory_flush_failure_after_publication_keeps_images_and_recovers_for_install_and_remove(
    ) {
        for removal in [false, true] {
            let cx = Context::new();
            let package = package("0.1.16", 1);
            cx.install(&package);
            if removal {
                cx.registered();
            }
            let review = cx
                .store
                .review_registration_with(
                    &cx.session,
                    if removal { None } else { Some(&package) },
                    &test_verify,
                )
                .unwrap();
            let images = cx.store.registration_images(review.service_path()).unwrap();
            let selection = cx.store.snapshot_with(&test_verify).unwrap();
            let expected_journal = encode(&review.transition).unwrap();
            let publication_seen = Cell::new(false);
            let error = cx.store.apply_registration_with(&cx.session, &review, &|| false, &|site| {
                assert_eq!(site, "registration-journal-published-before-directory-flush");
                // This is specifically the real publication/flush boundary, not
                // a generic failure before the journal exists or after writes.
                assert_eq!(cx.store.registration_journal().unwrap(), Some(expected_journal.clone()));
                assert_eq!(cx.store.registration_images(review.service_path()).unwrap(), images);
                publication_seen.set(true);
                Err(refused("Injected registration parent-directory flush failure after journal publication"))
            }, &test_verify).unwrap_err();
            assert!(publication_seen.get());
            assert_eq!(error.kind, ErrorKind::OutcomeUnknown);
            assert_eq!(
                cx.store.registration_journal().unwrap(),
                Some(expected_journal)
            );
            assert_eq!(
                cx.store.registration_images(review.service_path()).unwrap(),
                images
            );
            assert_eq!(cx.store.snapshot_with(&test_verify).unwrap(), selection);
            assert!(cx
                .store
                .selected_activation_with(&cx.session, &test_verify)
                .is_err());

            let recovery = cx
                .store
                .registration_recovery_with(&cx.session, &test_verify)
                .unwrap()
                .unwrap();
            cx.store
                .recover_registration_with(&cx.session, &recovery, &|_| Ok(()), &test_verify)
                .unwrap();
            assert!(cx.store.registration_journal().unwrap().is_none());
            assert_eq!(
                cx.store.registration_images(review.service_path()).unwrap(),
                images
            );
            assert_eq!(cx.store.snapshot_with(&test_verify).unwrap(), selection);
        }
    }

    #[test]
    fn owned_replacement_has_exact_before_images_and_rollback_restores_old_signed_bytes() {
        let cx = Context::new();
        let old = cx.registered();
        let old_bytes = fs::read(old.selector_path()).unwrap();
        let next = package("0.1.17", 2);
        cx.install(&next);
        let review = cx.review(&next);
        cx.store
            .apply_registration_with(
                &cx.session,
                &review,
                &|| false,
                &interrupt("registration-owner"),
                &test_verify,
            )
            .unwrap_err();
        let recovery = cx
            .store
            .registration_recovery_with(&cx.session, &test_verify)
            .unwrap()
            .unwrap();
        cx.store
            .recover_registration_with(&cx.session, &recovery, &|_| Ok(()), &test_verify)
            .unwrap();
        assert_eq!(fs::read(old.selector_path()).unwrap(), old_bytes);
        assert_eq!(
            cx.store
                .snapshot_with(&test_verify)
                .unwrap()
                .unwrap()
                .selection()
                .version,
            "0.1.17"
        );
    }

    #[test]
    fn removal_and_interrupted_removal_keep_generations_settings_and_runtime_paths() {
        for site in [
            None,
            Some("registration-service"),
            Some("registration-tool"),
            Some("registration-owner"),
        ] {
            let cx = Context::new();
            let registered = cx.registered();
            let sentinel = cx
                .store
                .root
                .parent()
                .unwrap()
                .join("runtime-and-settings-sentinel");
            fs::write(&sentinel, b"keep original paths").unwrap();
            let selected = cx.store.snapshot_with(&test_verify).unwrap();
            let review = cx
                .store
                .review_registration_with(&cx.session, None, &test_verify)
                .unwrap();
            if let Some(site) = site {
                cx.store
                    .apply_registration_with(
                        &cx.session,
                        &review,
                        &|| false,
                        &interrupt(site),
                        &test_verify,
                    )
                    .unwrap_err();
                let recovery = cx
                    .store
                    .registration_recovery_with(&cx.session, &test_verify)
                    .unwrap()
                    .unwrap();
                cx.store
                    .recover_registration_with(&cx.session, &recovery, &|_| Ok(()), &test_verify)
                    .unwrap();
                assert!(registered.selector_path().is_file());
                assert!(registered.service_path().is_file());
            } else {
                cx.apply(&review).unwrap();
                assert!(!registered.selector_path().exists());
                assert!(!registered.service_path().exists());
            }
            assert_eq!(cx.store.snapshot_with(&test_verify).unwrap(), selected);
            assert_eq!(fs::read(sentinel).unwrap(), b"keep original paths");
        }
    }

    #[test]
    fn recovery_refuses_changed_journal_or_any_unknown_file_without_overwriting() {
        let cx = Context::new();
        let package = package("0.1.16", 1);
        cx.install(&package);
        let review = cx.review(&package);
        cx.store
            .apply_registration_with(
                &cx.session,
                &review,
                &|| false,
                &interrupt("registration-tool"),
                &test_verify,
            )
            .unwrap_err();
        let recovery = cx
            .store
            .registration_recovery_with(&cx.session, &test_verify)
            .unwrap()
            .unwrap();
        disk::set_mode(&review.selector_path(), 0o755).unwrap();
        fs::write(review.selector_path(), b"foreign bytes").unwrap();
        disk::set_mode(&review.selector_path(), 0o555).unwrap();
        assert!(cx
            .store
            .recover_registration_with(&cx.session, &recovery, &|_| Ok(()), &test_verify)
            .is_err());
        assert!(cx
            .store
            .registration_recovery_with(&cx.session, &test_verify)
            .is_err());
        assert_eq!(fs::read(review.selector_path()).unwrap(), b"foreign bytes");
    }

    #[test]
    fn changed_journal_and_permissions_refuse_without_repair_and_rollback_can_resume() {
        let cx = Context::new();
        let package = package("0.1.16", 1);
        cx.install(&package);
        let review = cx.review(&package);
        cx.store
            .apply_registration_with(
                &cx.session,
                &review,
                &|| false,
                &interrupt("registration-owner"),
                &test_verify,
            )
            .unwrap_err();
        let recovery = cx
            .store
            .registration_recovery_with(&cx.session, &test_verify)
            .unwrap()
            .unwrap();
        let pending = cx.store.root.join(DIRECTORY).join(PENDING);
        let journal = fs::read(&pending).unwrap();
        fs::write(&pending, b"{}").unwrap();
        assert!(cx
            .store
            .recover_registration_with(&cx.session, &recovery, &|_| Ok(()), &test_verify)
            .is_err());
        assert!(cx
            .store
            .registration_recovery_with(&cx.session, &test_verify)
            .is_err());
        assert_eq!(fs::read(&pending).unwrap(), b"{}");
        fs::write(&pending, journal).unwrap();
        disk::set_mode(review.service_path(), 0o666).unwrap();
        assert!(cx
            .store
            .recover_registration_with(&cx.session, &recovery, &|_| Ok(()), &test_verify)
            .is_err());
        disk::set_mode(review.service_path(), 0o644).unwrap();
        let recovery = cx
            .store
            .registration_recovery_with(&cx.session, &test_verify)
            .unwrap()
            .unwrap();
        assert_eq!(
            cx.store
                .recover_registration_with(
                    &cx.session,
                    &recovery,
                    &interrupt("registration-service"),
                    &test_verify
                )
                .unwrap_err()
                .kind,
            ErrorKind::OutcomeUnknown
        );
        let recovery = cx
            .store
            .registration_recovery_with(&cx.session, &test_verify)
            .unwrap()
            .unwrap();
        cx.store
            .recover_registration_with(&cx.session, &recovery, &|_| Ok(()), &test_verify)
            .unwrap();
        assert!(!review.selector_path().exists());
        assert!(!review.service_path().exists());
    }

    #[test]
    fn locks_sessions_links_modes_and_registration_recovery_block_writes() {
        let cx = Context::new();
        let package = package("0.1.16", 1);
        cx.install(&package);
        let review = cx.review(&package);
        let lock = disk::lock(&cx.store.root.join("transaction.lock")).unwrap();
        assert!(cx.apply(&review).is_err());
        drop(lock);
        let other = Context::new();
        assert!(cx
            .store
            .apply_registration_with(
                &other.session,
                &review,
                &|| false,
                &|_| Ok(()),
                &test_verify
            )
            .is_err());
        disk::create_dir(&cx.store.root.join(DIRECTORY)).unwrap();
        std::os::unix::fs::symlink("/usr/bin/creator-hub", review.selector_path()).unwrap();
        assert!(cx.apply(&review).is_err());
        assert!(fs::symlink_metadata(review.selector_path())
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn post_journal_cancellation_never_claims_clean_cancel_and_rollback_can_resume() {
        let cx = Context::new();
        let package = package("0.1.16", 1);
        cx.install(&package);
        let review = cx.review(&package);
        let cancelled = Cell::new(false);
        assert_eq!(
            cx.store
                .apply_registration_with(
                    &cx.session,
                    &review,
                    &|| cancelled.get(),
                    &|_| {
                        cancelled.set(true);
                        Ok(())
                    },
                    &test_verify
                )
                .unwrap_err()
                .kind,
            ErrorKind::OutcomeUnknown
        );
        let recovery = cx
            .store
            .registration_recovery_with(&cx.session, &test_verify)
            .unwrap()
            .unwrap();
        cx.store
            .recover_registration_with(&cx.session, &recovery, &|_| Ok(()), &test_verify)
            .unwrap();
        assert!(cx.store.registration_journal().unwrap().is_none());
    }
}
