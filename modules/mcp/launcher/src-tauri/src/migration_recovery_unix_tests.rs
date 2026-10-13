use super::*;
use std::io::Write;

#[test]
fn swap_before_capture_interruption_is_unknown_and_keeps_the_actual_old_object() {
    let f = Fixture::new(2);
    let t = f.prepare();
    assert!(t
        .resume_with(|_| true, &mut |at| {
            if at == Boundary::Swapped(0) {
                Err("injected interruption between paired native operations".into())
            } else {
                Ok(())
            }
        })
        .is_err());
    let report = f.open(&t).inspect().unwrap();
    assert_eq!(report.files[0].status, Status::Unknown);
    assert_eq!(report.files[1].status, Status::Ready);
    assert_eq!(
        fs::read(&report.files[0].stage).unwrap(),
        Fixture::before(0)
    );
    assert_eq!(fs::read(&f.paths[0]).unwrap(), Fixture::after(0));
    assert!(!report.completed);
    let again = f.open(&t).resume(|_| true).unwrap();
    assert_eq!(again.files[0].status, Status::Unknown);
    assert_eq!(fs::read(&again.files[0].stage).unwrap(), Fixture::before(0));
    assert_eq!(fs::read(&f.paths[1]).unwrap(), Fixture::before(1));
    assert!(!t.evidence(1, "intent").exists());
    f.images(&t);
}

#[test]
fn in_place_external_writer_is_not_locked_out_and_actual_changed_bytes_are_quarantined() {
    let f = Fixture::new(2);
    let t = f.prepare();
    let path = f.paths[0].clone();
    let external = b"actual concurrent in-place bytes\xff";
    let result = t
        .resume_with(|_| true, &mut |at| {
            if at == Boundary::BeforePublish(0) {
                let path = path.clone();
                std::thread::spawn(move || fs::write(path, external).unwrap())
                    .join()
                    .unwrap();
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(result.files[0].status, Status::PublicationConflict);
    assert_eq!(fs::read(&result.files[0].displaced).unwrap(), external);
    assert_eq!(fs::read(&f.paths[0]).unwrap(), Fixture::after(0));
    assert_eq!(fs::read(&f.paths[1]).unwrap(), Fixture::before(1));
    assert!(!f.open(&t).resume(|_| true).unwrap().completed);
    f.images(&t);
}

#[test]
fn active_writer_can_change_displaced_file_after_swap_but_never_proves_completion() {
    let f = Fixture::new(1);
    let t = f.prepare();
    let mut writer = OpenOptions::new().write(true).open(&f.paths[0]).unwrap();
    let report = t
        .resume_with(|_| true, &mut |at| {
            if at == Boundary::NativeRecorded(0) {
                writer.write_all(b"external held-handle mutation").unwrap();
                writer.sync_all().unwrap();
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(report.files[0].status, Status::PublicationConflict);
    assert!(!report.completed);
    assert!(fs::read(&report.files[0].displaced)
        .unwrap()
        .starts_with(b"external held-handle mutation"));
    assert_eq!(fs::read(&f.paths[0]).unwrap(), Fixture::after(0));
    f.images(&t);
}

#[test]
fn missing_target_after_intent_never_gets_recreated_or_retried() {
    let f = Fixture::new(1);
    let t = f.prepare();
    let report = t
        .resume_with(|_| true, &mut |at| {
            if at == Boundary::BeforePublish(0) {
                fs::remove_file(&f.paths[0]).unwrap();
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(report.files[0].status, Status::Unknown);
    assert!(!f.paths[0].exists());
    assert_eq!(fs::read(&report.files[0].stage).unwrap(), Fixture::after(0));
    assert!(!f.open(&t).resume(|_| true).unwrap().completed);
    assert!(!f.paths[0].exists());
    f.images(&t);
}

#[test]
fn failed_paired_capture_keeps_both_actual_displaced_and_foreign_capture_files() {
    let f = Fixture::new(1);
    let t = f.prepare();
    let raw = t.capture(0).join("displaced.bin");
    let report = t
        .resume_with(|_| true, &mut |at| {
            if at == Boundary::Swapped(0) {
                fs::write(&raw, b"foreign capture\xff").unwrap();
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(report.files[0].status, Status::Unknown);
    assert_eq!(
        fs::read(&report.files[0].stage).unwrap(),
        Fixture::before(0)
    );
    assert_eq!(
        fs::read(&report.files[0].displaced).unwrap(),
        b"foreign capture\xff"
    );
    assert_eq!(fs::read(&f.paths[0]).unwrap(), Fixture::after(0));
    assert!(!f.open(&t).resume(|_| true).unwrap().completed);
    f.images(&t);
}

#[test]
fn staged_replacement_after_intent_is_not_published_or_adopted() {
    let f = Fixture::new(1);
    let t = f.prepare();
    let stage = t.capture(0).join("stage.bin");
    let report = t
        .resume_with(|_| true, &mut |at| {
            if at == Boundary::BeforePublish(0) {
                external_replace(&stage, &Fixture::after(0));
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(report.files[0].status, Status::Unknown);
    f.originals();
    assert!(!f.open(&t).resume(|_| true).unwrap().completed);
    f.originals();
}
