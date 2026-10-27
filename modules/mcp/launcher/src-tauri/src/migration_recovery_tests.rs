use super::*;
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[path = "migration_recovery_unix_tests.rs"]
mod unix_tests;
#[cfg(windows)]
use std::io::Write;

struct Fixture {
    _temporary: tempfile::TempDir,
    root: PathBuf,
    journal: PathBuf,
    paths: Vec<PathBuf>,
}
impl Fixture {
    fn new(count: usize) -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let paths = (0..count)
            .map(|i| {
                let path = root.join(format!("client-{i}.json"));
                fs::write(&path, Self::before(i)).unwrap();
                path
            })
            .collect();
        Self {
            _temporary: temporary,
            journal: root.join("journal"),
            root,
            paths,
        }
    }
    fn before(i: usize) -> Vec<u8> {
        format!("{{\r\n \"before\":{i}, \"disabled\":true\r\n}}\r\n").into_bytes()
    }
    fn after(i: usize) -> Vec<u8> {
        format!("{{\r\n \"after\":{i}, \"disabled\":true\r\n}}\r\n").into_bytes()
    }
    fn writes(&self) -> Vec<ReviewedWrite> {
        self.paths
            .iter()
            .enumerate()
            .map(|(i, p)| {
                ReviewedWrite::new(&format!("Client {i}"), p, &Self::before(i), &Self::after(i))
            })
            .collect()
    }
    fn prepare(&self) -> Transaction {
        Transaction::prepare(&self.journal, self.writes()).unwrap()
    }
    fn open(&self, t: &Transaction) -> Transaction {
        Transaction::open(&t.directory, &self.paths).unwrap()
    }
    fn originals(&self) {
        for (i, p) in self.paths.iter().enumerate() {
            assert_eq!(fs::read(p).unwrap(), Self::before(i));
        }
    }
    fn images(&self, t: &Transaction) {
        for i in 0..self.paths.len() {
            assert_eq!(fs::read(t.image(i, "before")).unwrap(), Self::before(i));
            assert_eq!(fs::read(t.image(i, "after")).unwrap(), Self::after(i));
        }
    }
}

#[test]
fn recovery_scope_resolves_the_existing_file_not_its_unredirected_parent() {
    let f = Fixture::new(1);
    let redirected_parent = f.root.join("virtualized-roaming");
    fs::create_dir(&redirected_parent).unwrap();
    let redirected = redirected_parent.join(f.paths[0].file_name().unwrap());
    fs::hard_link(&f.paths[0], &redirected).unwrap();
    let resolved = canonical_scope_target_with(&f.paths[0], |path| {
        if path == f.paths[0] {
            Ok(redirected.clone())
        } else {
            assert_eq!(path, f.root);
            Ok(f.root.clone())
        }
    })
    .unwrap();
    assert_eq!(resolved, redirected);
    assert_eq!(resolved, canonical_target(&redirected).unwrap());
    assert_ne!(
        resolved,
        fs::canonicalize(f.paths[0].parent().unwrap())
            .unwrap()
            .join(f.paths[0].file_name().unwrap())
    );
    assert_eq!(fs::read(&resolved).unwrap(), Fixture::before(0));
    f.originals();
    assert!(!f.journal.exists());
}

#[test]
fn recovery_scope_missing_leaf_resolves_only_the_parent_without_creation() {
    let f = Fixture::new(0);
    let missing = f.root.join("missing.json");
    let redirected_parent = f.root.join("resolved-parent");
    fs::create_dir(&redirected_parent).unwrap();
    let resolved = canonical_scope_target_with(&missing, |path| {
        assert_eq!(path, f.root);
        Ok(redirected_parent.clone())
    })
    .unwrap();
    assert_eq!(resolved, redirected_parent.join("missing.json"));
    assert_eq!(canonical_scope_target(&missing).unwrap(), missing);
    assert!(!missing.exists());
    assert!(!resolved.exists());
    let absent_parent = f.root.join("absent-parent");
    assert!(canonical_scope_target(&absent_parent.join("missing.json")).is_err());
    assert!(!absent_parent.exists());
    assert!(!f.journal.exists());
}

#[test]
fn recovery_scope_rejects_directories_and_traversal_before_resolution() {
    let f = Fixture::new(1);
    // PathBuf::push normalizes verbatim Windows paths; preserve literal traversal.
    let mut traversal = f.root.as_os_str().to_os_string();
    traversal.push(std::path::MAIN_SEPARATOR.to_string());
    traversal.push("..");
    traversal.push(std::path::MAIN_SEPARATOR.to_string());
    traversal.push("outside.json");
    for path in [
        f.root.clone(),
        PathBuf::from(traversal),
        PathBuf::from("relative.json"),
    ] {
        assert!(canonical_target(&path).is_err());
        assert!(canonical_scope_target_with(&path, |_| {
            panic!("Invalid scope must be refused before resolving a destination")
        })
        .is_err());
    }
    assert!(canonical_scope_target_with(&f.paths[0], |_| Ok(f.root.clone())).is_err());
    f.originals();
    assert!(!f.journal.exists());
}

#[test]
fn recovery_scope_existing_resolution_failure_does_not_fall_back_to_parent() {
    let f = Fixture::new(1);
    assert!(canonical_scope_target_with(&f.paths[0], |path| {
        assert_eq!(path, f.paths[0]);
        Err(std::io::Error::from(std::io::ErrorKind::NotFound))
    })
    .is_err());
    f.originals();
    assert!(!f.journal.exists());
}

#[test]
fn declined_resume_is_read_only_and_inspection_is_scoped() {
    let f = Fixture::new(2);
    let t = f.prepare();
    let report = t.resume(|_| false).unwrap();
    assert!(!report.completed);
    assert!(report.files.iter().all(|file| file.status == Status::Ready));
    assert!(Transaction::open(&t.directory, &[f.paths[0].clone()]).is_err());
    assert!(Transaction::open(
        &t.directory,
        &[f.root.join("foreign.json"), f.paths[1].clone()]
    )
    .is_err());
    assert!(!t.evidence(0, "intent").exists());
    f.originals();
    f.images(&t);
}

#[test]
fn central_recovery_accepts_only_a_subset_of_independently_allowlisted_paths() {
    let f = Fixture::new(2);
    let transaction = f.prepare();
    let mut allowed = f.paths.clone();
    allowed.push(f.root.join("not-selected.json"));
    allowed.push(f.root.join("absent-client/settings.json"));
    assert!(Transaction::open_allowlisted(&transaction.directory, &allowed).is_ok());
    assert!(Transaction::open(&transaction.directory, &allowed[..3]).is_err());
    assert!(Transaction::open_allowlisted(&transaction.directory, &f.paths[..1]).is_err());
    assert!(Transaction::open_allowlisted(
        &transaction.directory,
        &[f.paths[0].clone(), f.paths[0].clone()]
    )
    .is_err());
    let foreign = f.root.join("foreign.json");
    fs::write(&foreign, Fixture::before(1)).unwrap();
    assert!(Transaction::open_allowlisted(
        &transaction.directory,
        &[f.paths[0].clone(), foreign.clone()]
    )
    .is_err());
    assert!(
        Transaction::open_allowlisted(&transaction.directory, std::slice::from_ref(&foreign))
            .is_err()
    );
    assert!(Transaction::open_allowlisted(&transaction.directory, &[]).is_err());
    assert_eq!(fs::read(&foreign).unwrap(), Fixture::before(1));
    f.originals();
    f.images(&transaction);
    assert!(!transaction.evidence(0, "intent").exists());
}

#[test]
fn missing_scope_leaf_remains_inspectable_by_both_recovery_entry_points() {
    let f = Fixture::new(1);
    let transaction = f.prepare();
    let pending_path = transaction.directory.join("pending.json");
    let pending = fs::read(&pending_path).unwrap();
    fs::remove_file(&f.paths[0]).unwrap();
    for opened in [
        Transaction::open(&transaction.directory, &f.paths).unwrap(),
        Transaction::open_allowlisted(&transaction.directory, &f.paths).unwrap(),
    ] {
        let report = opened.inspect().unwrap();
        assert_eq!(report.files[0].status, Status::ExternalChange);
        assert!(!report.completed);
        assert!(!f.paths[0].exists());
    }
    assert_eq!(fs::read(&pending_path).unwrap(), pending);
    assert!(!transaction.evidence(0, "intent").exists());
    assert!(!transaction.directory.join("completed.json").exists());
    f.images(&transaction);
}

#[test]
fn preparation_faults_retain_originals_and_exact_images_without_publishing() {
    for boundary in [
        Boundary::BeforeImage(0),
        Boundary::AfterImage(0),
        Boundary::BeforeImage(1),
        Boundary::AfterImage(1),
        Boundary::Pending,
    ] {
        let f = Fixture::new(2);
        assert!(
            Transaction::prepare_with(&f.journal, f.writes(), &mut |at| {
                if at == boundary {
                    Err("injected stop".into())
                } else {
                    Ok(())
                }
            })
            .is_err()
        );
        f.originals();
        // Same reviewed operation can finish incomplete PREPARATION; no intent exists yet.
        let t = f.prepare();
        f.images(&t);
        assert!(t
            .inspect()
            .unwrap()
            .files
            .iter()
            .all(|file| file.status == Status::Ready));
        assert!(!t.evidence(0, "intent").exists());
    }
}

#[test]
fn all_members_are_checked_before_preparation_and_duplicate_targets_refuse() {
    let f = Fixture::new(2);
    fs::write(&f.paths[1], b"external edit").unwrap();
    assert!(Transaction::prepare(&f.journal, f.writes()).is_err());
    assert!(!f.journal.exists());
    fs::write(&f.paths[1], Fixture::before(1)).unwrap();
    let mut writes = f.writes();
    writes.push(ReviewedWrite::new(
        "duplicate",
        &f.paths[0],
        &Fixture::before(0),
        &Fixture::after(0),
    ));
    assert!(Transaction::prepare(&f.journal, writes).is_err());
    assert!(!f.journal.exists());
}

#[test]
fn changed_missing_and_identical_after_without_intent_are_not_adopted() {
    for bytes in [
        None,
        Some(b"external edit".to_vec()),
        Some(Fixture::after(0)),
    ] {
        let f = Fixture::new(1);
        let t = f.prepare();
        match &bytes {
            Some(b) => fs::write(&f.paths[0], b).unwrap(),
            None => fs::remove_file(&f.paths[0]).unwrap(),
        }
        let t = f.open(&t);
        assert_eq!(t.inspect().unwrap().files[0].status, Status::ExternalChange);
        assert_eq!(
            t.resume(|_| true).unwrap().files[0].status,
            Status::ExternalChange
        );
        assert_eq!(storage::read_bytes(&f.paths[0]).unwrap(), bytes);
        assert!(!t.evidence(0, "intent").exists());
        assert!(!t.directory.join("completed.json").exists());
        f.images(&t);
    }
}

#[test]
fn corrupt_images_intent_and_completion_refuse_without_changes() {
    for kind in ["before", "after", "intent", "completed", "pending"] {
        let f = Fixture::new(1);
        let t = f.prepare();
        let path = match kind {
            "before" | "after" => t.image(0, kind),
            "intent" => t.evidence(0, kind),
            _ => t.directory.join(format!("{kind}.json")),
        };
        fs::write(&path, b"corrupt evidence").unwrap();
        let result = Transaction::open(&t.directory, &f.paths).and_then(|t| t.resume(|_| true));
        assert!(result.is_err(), "{kind}");
        assert_eq!(fs::read(path).unwrap(), b"corrupt evidence");
        f.originals();
    }
}

#[test]
fn unresolved_operation_blocks_a_new_overlapping_review() {
    let f = Fixture::new(1);
    let _t = f.prepare();
    let writes = vec![ReviewedWrite::new(
        "new review",
        &f.paths[0],
        &Fixture::before(0),
        b"different target",
    )];
    assert!(Transaction::prepare(&f.journal, writes).is_err());
    f.originals();
}

#[test]
fn cooperative_lock_refuses_competing_hub_writer_without_claiming_cas() {
    let f = Fixture::new(1);
    let t = f.prepare();
    let held = lock(&f.journal).unwrap();
    assert!(t.resume(|_| true).is_err());
    assert!(Transaction::prepare(&f.journal, f.writes()).is_err());
    drop(held);
    assert_eq!(t.inspect().unwrap().files[0].status, Status::Ready);
    f.originals();
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
#[test]
fn unverified_platform_publication_fails_closed() {
    let f = Fixture::new(1);
    let t = f.prepare();
    let result = t.resume(|_| true).unwrap();
    assert_eq!(result.files[0].status, Status::Unsupported);
    assert!(!result.completed);
    assert!(!t.evidence(0, "intent").exists());
    f.originals();
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
#[test]
fn publication_faults_recover_only_from_proven_evidence_and_preserve_every_image() {
    for boundary in [
        Boundary::Stage(0),
        Boundary::Intent(0),
        Boundary::BeforePublish(0),
        Boundary::Published(0),
        Boundary::NativeRecorded(0),
        Boundary::DisplacedSealed(0),
        Boundary::Captured(0),
        Boundary::Outcome(0),
        Boundary::Completed,
    ] {
        let f = Fixture::new(1);
        let t = f.prepare();
        assert!(t
            .resume_with(|_| true, &mut |at| {
                if at == boundary {
                    Err("injected process stop".into())
                } else {
                    Ok(())
                }
            })
            .is_err());
        let t = f.open(&t);
        let expected = match boundary {
            Boundary::Stage(_) => Status::Ready,
            Boundary::Intent(_) | Boundary::BeforePublish(_) => Status::Unknown,
            _ => Status::Applied,
        };
        assert_eq!(
            t.inspect().unwrap().files[0].status,
            expected,
            "{boundary:?}"
        );
        let result = t.resume(|_| true).unwrap();
        assert_eq!(
            result.completed,
            expected != Status::Unknown,
            "{boundary:?}"
        );
        if expected == Status::Unknown {
            f.originals();
        } else {
            assert_eq!(fs::read(&f.paths[0]).unwrap(), Fixture::after(0));
            assert_eq!(
                fs::read(&result.files[0].displaced).unwrap(),
                Fixture::before(0)
            );
        }
        f.images(&t);
        // Repeated recovery has no additional publication and never loses the originals.
        let again = f.open(&t).resume(|_| true).unwrap();
        assert_eq!(again.completed, result.completed);
    }
}

#[cfg(windows)]
fn external_replace(path: &Path, bytes: &[u8]) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
    let stage = path.with_extension("external.tmp");
    fs::write(&stage, bytes).unwrap();
    let wide = |p: &Path| {
        p.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    let (source, destination) = (wide(&stage), wide(path));
    assert_ne!(
        unsafe {
            ReplaceFileW(
                destination.as_ptr(),
                source.as_ptr(),
                std::ptr::null(),
                0,
                std::ptr::null(),
                std::ptr::null(),
            )
        },
        0,
        "{}",
        io::Error::last_os_error()
    );
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn external_replace(path: &Path, bytes: &[u8]) {
    let replacement = path.with_extension("external");
    fs::write(&replacement, bytes).unwrap();
    fs::rename(replacement, path).unwrap();
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
#[test]
fn real_concurrent_path_replacement_at_publication_is_retained_and_quarantined() {
    use std::sync::mpsc;
    let f = Fixture::new(2);
    let t = f.prepare();
    let path = f.paths[0].clone();
    let (go, wait) = mpsc::channel();
    let (done, joined) = mpsc::channel();
    let writer = std::thread::spawn(move || {
        wait.recv().unwrap();
        external_replace(
            &path,
            b"external concurrent replacement, including all unknown bytes\xff",
        );
        done.send(()).unwrap();
    });
    let result = t
        .resume_with(|_| true, &mut |at| {
            if at == Boundary::BeforePublish(0) {
                go.send(()).unwrap();
                joined
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
            }
            Ok(())
        })
        .unwrap();
    writer.join().unwrap();
    assert_eq!(result.files[0].status, Status::PublicationConflict);
    assert!(!result.completed);
    assert_eq!(
        fs::read(&result.files[0].displaced).unwrap(),
        b"external concurrent replacement, including all unknown bytes\xff"
    );
    assert_eq!(fs::read(&f.paths[0]).unwrap(), Fixture::after(0));
    assert_eq!(fs::read(&f.paths[1]).unwrap(), Fixture::before(1));
    f.images(&t);
    let again = f.open(&t).resume(|_| true).unwrap();
    assert_eq!(again.files[0].status, Status::PublicationConflict);
    assert_eq!(fs::read(&f.paths[0]).unwrap(), Fixture::after(0));
    assert!(!t.evidence(1, "intent").exists());
}

#[cfg(windows)]
#[test]
fn real_concurrent_in_place_writer_is_denied_on_the_guarded_object() {
    let f = Fixture::new(1);
    let t = f.prepare();
    let path = f.paths[0].clone();
    let result = t
        .resume_with(|_| true, &mut |at| {
            if at == Boundary::BeforePublish(0) {
                let path = path.clone();
                std::thread::spawn(move || {
                    assert!(OpenOptions::new()
                        .write(true)
                        .truncate(true)
                        .open(path)
                        .is_err());
                })
                .join()
                .unwrap();
            }
            Ok(())
        })
        .unwrap();
    assert!(result.completed);
    assert_eq!(
        fs::read(&result.files[0].displaced).unwrap(),
        Fixture::before(0)
    );
}

#[cfg(windows)]
#[test]
fn active_writer_and_native_failure_never_fallback_to_an_overwriting_rename() {
    let f = Fixture::new(1);
    let t = f.prepare();
    let mut held = OpenOptions::new().write(true).open(&f.paths[0]).unwrap();
    assert_eq!(t.resume(|_| true).unwrap().files[0].status, Status::Unknown);
    assert!(!t.evidence(0, "intent").exists());
    held.write_all(b"external in-place writer").unwrap();
    drop(held);
    let changed = fs::read(&f.paths[0]).unwrap();
    assert!(!t.resume(|_| true).unwrap().completed);
    assert_eq!(fs::read(&f.paths[0]).unwrap(), changed);

    let f = Fixture::new(1);
    let t = f.prepare();
    let _deny_delete = storage::protected_options().open(&f.paths[0]).unwrap();
    let result = t.resume(|_| true).unwrap();
    assert_eq!(result.files[0].status, Status::Unknown);
    assert!(!result.completed);
    f.originals();
    f.images(&t);
    assert!(!t.capture(0).join("displaced.bin").exists());
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
#[test]
fn partially_applied_batch_resumes_without_rewriting_completed_members() {
    let f = Fixture::new(3);
    let t = f.prepare();
    assert!(t
        .resume_with(|_| true, &mut |at| {
            if at == Boundary::Outcome(0) {
                Err("injected stop".into())
            } else {
                Ok(())
            }
        })
        .is_err());
    assert_eq!(fs::read(&f.paths[0]).unwrap(), Fixture::after(0));
    assert_eq!(fs::read(&f.paths[1]).unwrap(), Fixture::before(1));
    let t = f.open(&t);
    let result = t
        .resume_with(|_| true, &mut |at| {
            assert_ne!(at, Boundary::BeforePublish(0));
            Ok(())
        })
        .unwrap();
    assert!(result.completed);
    f.images(&t);
    for (i, file) in result.files.iter().enumerate() {
        assert_eq!(fs::read(&file.path).unwrap(), Fixture::after(i));
        assert_eq!(fs::read(&file.displaced).unwrap(), Fixture::before(i));
    }
    let repeated = f.prepare().resume(|_| true).unwrap();
    assert!(repeated.completed);
    assert_eq!(repeated.journal, result.journal);
}

#[cfg(windows)]
#[test]
fn declining_partially_applied_batch_preserves_all_retained_bytes() {
    fn files(root: &Path) -> std::collections::BTreeMap<PathBuf, Vec<u8>> {
        let mut result = std::collections::BTreeMap::new();
        let mut directories = vec![root.to_path_buf()];
        while let Some(directory) = directories.pop() {
            for entry in fs::read_dir(directory).unwrap() {
                let entry = entry.unwrap();
                let kind = entry.file_type().unwrap();
                assert!(!kind.is_symlink());
                if kind.is_dir() {
                    directories.push(entry.path());
                } else {
                    result.insert(
                        entry.path().strip_prefix(root).unwrap().to_path_buf(),
                        fs::read(entry.path()).unwrap(),
                    );
                }
            }
        }
        result
    }

    // Coverage extension, not a known bug: decline after one real publication.
    let f = Fixture::new(2);
    let t = f.prepare();
    assert!(t
        .resume_with(|_| true, &mut |at| {
            if at == Boundary::Outcome(0) {
                Err("injected stop after first member".into())
            } else {
                Ok(())
            }
        })
        .is_err());
    assert_eq!(fs::read(&f.paths[0]).unwrap(), Fixture::after(0));
    assert_eq!(fs::read(&f.paths[1]).unwrap(), Fixture::before(1));
    let t = f.open(&t);
    let before = files(&f.root);
    let mut prompts = 0;
    let declined = t
        .resume(|_| {
            prompts += 1;
            false
        })
        .unwrap();
    assert_eq!(prompts, 1);
    assert!(!declined.completed);
    assert_eq!(declined.files[0].status, Status::Applied);
    assert_eq!(declined.files[1].status, Status::Ready);
    assert_eq!(files(&f.root), before);
    assert!(!t.directory.join("completed.json").exists());
    f.images(&t);
    assert!(t
        .resume_with(|_| true, &mut |at| {
            assert_ne!(at, Boundary::BeforePublish(0));
            Ok(())
        })
        .unwrap()
        .completed);
    for (index, target) in f.paths.iter().enumerate() {
        assert_eq!(fs::read(target).unwrap(), Fixture::after(index));
    }
    f.images(&t);
}

#[test]
fn identical_after_images_without_any_journal_are_refused() {
    let f = Fixture::new(1);
    fs::write(&f.paths[0], Fixture::after(0)).unwrap();
    assert!(Transaction::prepare(&f.journal, f.writes()).is_err());
    assert_eq!(fs::read(&f.paths[0]).unwrap(), Fixture::after(0));
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
#[test]
fn external_edit_after_first_member_or_after_completion_never_rolls_back_or_republishes() {
    let f = Fixture::new(2);
    let t = f.prepare();
    t.resume_with(|_| true, &mut |at| {
        if at == Boundary::Outcome(0) {
            external_replace(&f.paths[0], b"post-publication edit");
        }
        Ok(())
    })
    .unwrap();
    let result = f.open(&t).resume(|_| true).unwrap();
    assert_eq!(result.files[0].status, Status::ExternalChange);
    assert!(!result.completed);
    assert_eq!(fs::read(&f.paths[0]).unwrap(), b"post-publication edit");
    assert_eq!(fs::read(&f.paths[1]).unwrap(), Fixture::before(1));

    let f = Fixture::new(1);
    let t = f.prepare();
    assert!(t.resume(|_| true).unwrap().completed);
    external_replace(&f.paths[0], b"edit after completion");
    let result = f.open(&t).resume(|_| true).unwrap();
    assert_eq!(result.files[0].status, Status::ExternalChange);
    assert!(!result.completed);
    assert_eq!(fs::read(&f.paths[0]).unwrap(), b"edit after completion");
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
#[test]
fn native_partial_failure_shape_missing_target_keeps_displaced_and_refuses_recreation() {
    let f = Fixture::new(1);
    let t = f.prepare();
    storage::private_directory(&t.capture(0)).unwrap();
    fs::rename(&f.paths[0], t.capture(0).join("displaced.bin")).unwrap();
    storage::durable_image(&t.capture(0).join("stage.bin"), &Fixture::after(0)).unwrap();
    put(&t.evidence(0, "intent"), &t.intent(0)).unwrap();
    let result = f.open(&t).resume(|_| true).unwrap();
    assert_eq!(result.files[0].status, Status::Unknown);
    assert!(!f.paths[0].exists());
    assert_eq!(
        fs::read(&result.files[0].displaced).unwrap(),
        Fixture::before(0)
    );
    assert_eq!(
        fs::read(t.capture(0).join("stage.bin")).unwrap(),
        Fixture::after(0)
    );
}

#[cfg(windows)]
#[test]
fn real_replacement_with_an_active_writer_keeps_actual_object_and_refuses_completion() {
    use std::{os::windows::fs::OpenOptionsExt, sync::mpsc};
    let f = Fixture::new(1);
    let t = f.prepare();
    let path = f.paths[0].clone();
    let (go, wait) = mpsc::channel();
    let (ready, observed) = mpsc::channel();
    let (release, finish) = mpsc::channel();
    let writer = std::thread::spawn(move || {
        wait.recv().unwrap();
        external_replace(&path, b"replacement with a writable handle");
        let mut held = OpenOptions::new()
            .write(true)
            .share_mode(1 | 2 | 4)
            .open(&path)
            .unwrap();
        ready.send(()).unwrap();
        finish.recv().unwrap();
        // This handle now addresses the displaced object, not the published config.
        held.write_all(b"later edit to displaced object").unwrap();
        held.sync_all().unwrap();
    });
    let result = t.resume_with(|_| true, &mut |at| {
        if at == Boundary::BeforePublish(0) {
            go.send(()).unwrap();
            observed
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
        }
        Ok(())
    });
    release.send(()).unwrap();
    writer.join().unwrap();
    assert!(result.is_err());
    assert!(!t.directory.join("completed.json").exists());
    assert_eq!(fs::read(&f.paths[0]).unwrap(), Fixture::after(0));
    let report = f.open(&t).inspect().unwrap();
    assert_eq!(report.files[0].status, Status::PublicationConflict);
    assert!(fs::read(&report.files[0].displaced)
        .unwrap()
        .starts_with(b"later edit to displaced object"));
    f.images(&t);
}

#[cfg(windows)]
#[test]
fn later_member_changed_during_batch_is_not_published() {
    let f = Fixture::new(2);
    let t = f.prepare();
    let report = t
        .resume_with(|_| true, &mut |at| {
            if at == Boundary::Outcome(0) {
                external_replace(&f.paths[1], b"unrelated client edit while first published");
            }
            Ok(())
        })
        .unwrap();
    assert!(!report.completed);
    assert_eq!(report.files[0].status, Status::Applied);
    assert_eq!(report.files[1].status, Status::ExternalChange);
    assert_eq!(
        fs::read(&f.paths[1]).unwrap(),
        b"unrelated client edit while first published"
    );
    assert!(!t.evidence(1, "intent").exists());
    f.images(&t);
}

#[cfg(windows)]
#[test]
fn missing_intent_or_displaced_evidence_never_trusts_the_completion_marker_alone() {
    for intent in [true, false] {
        let f = Fixture::new(1);
        let t = f.prepare();
        let report = t.resume(|_| true).unwrap();
        assert!(report.completed);
        fs::remove_file(if intent {
            t.evidence(0, "intent")
        } else {
            report.files[0].displaced.clone()
        })
        .unwrap();
        let result = f.open(&t).resume(|_| true).unwrap();
        assert!(!result.completed);
        assert_eq!(result.files[0].status, Status::Unknown);
        assert_eq!(fs::read(&f.paths[0]).unwrap(), Fixture::after(0));
        f.images(&t);
    }
}
