use super::*;
use crate::store::tests::{test_verify, Fixture};

fn setup() -> (tempfile::TempDir, Store, VerifiedPackage, SelectionSnapshot) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap().join("restart-test");
    let store = Store::create_inner(&root).unwrap();
    let old = Fixture::new("0.1.16").with_runner().package().unwrap();
    let id = store
        .stage_with(&old, &|| false, &|_| Ok(()), &test_verify)
        .unwrap();
    store
        .activate_with(
            &id,
            &Expected::linux_x86_64("0.1.16").unwrap(),
            None,
            &|| false,
            &|_| Ok(()),
            &test_verify,
        )
        .unwrap();
    let before = store.snapshot_with(&test_verify).unwrap().unwrap();
    let new = Fixture::new("0.1.17").with_runner().package().unwrap();
    (temp, store, new, before)
}

#[test]
fn restart_is_reviewed_stage_only_and_decline_never_changes_selection() {
    let (_temp, store, package, before) = setup();
    let review = store.review_restart_with(&package, &test_verify).unwrap();
    assert_eq!(review.before(), before.selection());
    assert_eq!(review.version(), "0.1.17");
    assert_eq!(review.generation(), package.generation());
    assert!(matches!(
        store
            .stage_restart(&review, &package, RestartChoice::KeepCurrent, || panic!(
                "decline must not inspect cancellation"
            ))
            .unwrap(),
        RestartStageOutcome::Declined
    ));
    assert!(!store
        .root
        .join("generations")
        .join(package.generation())
        .exists());
    let RestartStageOutcome::Staged(staged) = store
        .stage_restart_with(&review, &package, &|| false, &test_verify)
        .unwrap()
    else {
        panic!("stage")
    };
    assert_eq!(staged.generation(), package.generation());
    assert_eq!(staged.version(), "0.1.17");
    assert_eq!(staged.before, before);
    assert_eq!(store.snapshot_with(&test_verify).unwrap(), Some(before));
    assert!(store.recovery_with(&test_verify).unwrap().is_none());
    store
        .check_restart_target(&staged.before, &staged.target, &test_verify)
        .unwrap();
}

#[test]
fn cancel_before_and_after_staging_never_select_or_request_restart() {
    for after_stage in [false, true] {
        let (_temp, store, package, before) = setup();
        let review = store.review_restart_with(&package, &test_verify).unwrap();
        let target = store.root.join("generations").join(package.generation());
        let result = store.stage_restart_with(
            &review,
            &package,
            &|| !after_stage || target.exists(),
            &test_verify,
        );
        assert!(matches!(
            result,
            Err(Error {
                kind: ErrorKind::Cancelled,
                ..
            })
        ));
        assert_eq!(target.exists(), after_stage);
        assert_eq!(store.snapshot_with(&test_verify).unwrap(), Some(before));
        assert!(store.recovery_with(&test_verify).unwrap().is_none());
    }
}

#[test]
fn restart_requires_strict_upgrade_signed_host_profile_and_exact_review() {
    let (_temp, store, package, before) = setup();
    assert!(store
        .review_restart_with(
            &Fixture::new("0.1.16").with_runner().package().unwrap(),
            &test_verify
        )
        .is_err());
    assert!(store
        .review_restart_with(
            &Fixture::new("0.1.15").with_runner().package().unwrap(),
            &test_verify
        )
        .is_err());
    assert!(store
        .review_restart_with(&Fixture::new("0.1.17").package().unwrap(), &test_verify)
        .is_err());
    assert!(store
        .review_restart_with(&package, &production_verify)
        .is_err());
    let review = store.review_restart_with(&package, &test_verify).unwrap();
    let other = Fixture::new("0.1.18").with_runner().package().unwrap();
    assert!(store
        .stage_restart_with(&review, &other, &|| false, &test_verify)
        .is_err());
    let id = store
        .stage_with(&other, &|| false, &|_| Ok(()), &test_verify)
        .unwrap();
    store
        .activate_with(
            &id,
            &Expected::linux_x86_64("0.1.18").unwrap(),
            Some(&before),
            &|| false,
            &|_| Ok(()),
            &test_verify,
        )
        .unwrap();
    assert!(store
        .stage_restart_with(&review, &package, &|| false, &test_verify)
        .is_err());
    assert!(!store
        .root
        .join("generations")
        .join(package.generation())
        .exists());
    assert!(store
        .check_restart_target(&before, &review.target, &test_verify)
        .is_err());
}

#[test]
fn both_pending_recoveries_block_stage_and_readiness_without_acknowledgement() {
    for registration in [false, true] {
        let (_temp, store, package, before) = setup();
        let review = store.review_restart_with(&package, &test_verify).unwrap();
        let pending = if registration {
            let directory = store.root.join("activation-v1");
            disk::create_dir(&directory).unwrap();
            directory.join("pending.json")
        } else {
            store.root.join("pending.json")
        };
        disk::write_new(&pending, b"retained pending evidence", 0o600).unwrap();
        assert!(store
            .stage_restart_with(&review, &package, &|| false, &test_verify)
            .is_err());
        assert!(store
            .check_restart_target(&before, &review.target, &test_verify)
            .is_err());
        assert_eq!(fs::read(pending).unwrap(), b"retained pending evidence");
        assert_eq!(store.snapshot_with(&test_verify).unwrap(), Some(before));
    }
}

fn identities() -> (Target, Target) {
    (
        Target {
            generation: "a".repeat(64),
            version: "0.1.16".into(),
        },
        Target {
            generation: "b".repeat(64),
            version: "0.1.17".into(),
        },
    )
}
fn offered() -> (Machine, Target, Target) {
    let (old, target) = identities();
    let mut machine = Machine::new();
    machine
        .accept(Kind::HelloAck, old.clone(), &old, Duration::ZERO)
        .unwrap();
    assert_eq!(
        machine
            .accept(Kind::Prepare, target.clone(), &old, Duration::from_secs(1))
            .unwrap(),
        Some(Kind::Ready)
    );
    (machine, old, target)
}

#[test]
fn ready_arm_and_eof_never_authorize_selection_without_explicit_exit_intent() {
    let (mut machine, _, _) = offered();
    assert!(machine.exited(Some(0), Duration::from_secs(2)).is_none());
    // EOF does not transition the machine or synthesize an exit event.
    let (mut machine, old, target) = offered();
    machine
        .accept(Kind::Arm, target.clone(), &old, Duration::from_secs(2))
        .unwrap();
    assert!(matches!(machine.phase, Phase::Prepared(_, _)));
    assert!(machine.exited(Some(0), Duration::from_secs(3)).is_none());
}

fn exit_authorized() -> (Machine, Target, Target) {
    let (mut machine, old, target) = offered();
    machine
        .accept(Kind::Arm, target.clone(), &old, Duration::from_secs(2))
        .unwrap();
    assert_eq!(
        machine
            .accept(
                Kind::ExitIntent,
                target.clone(),
                &old,
                Duration::from_secs(3)
            )
            .unwrap(),
        Some(Kind::ExitGranted)
    );
    (machine, old, target)
}

#[test]
fn explicit_exit_authorization_still_requires_owned_zero_code_exit() {
    let (mut machine, _, target) = exit_authorized();
    assert!(matches!(machine.phase, Phase::Exiting(_, _)));
    assert_eq!(
        machine.exited(Some(0), Duration::from_secs(3)),
        Some(target)
    );
    assert!(machine.exited(Some(0), Duration::from_secs(3)).is_none());
}

#[test]
fn crash_nonzero_timeout_cancel_and_bad_order_never_select_or_rearm() {
    for code in [None, Some(1), Some(127), Some(-1)] {
        let (mut machine, _, _) = exit_authorized();
        assert!(machine.exited(code, Duration::from_secs(3)).is_none());
    }
    for elapsed in [Duration::from_secs(61), Duration::from_secs(600)] {
        let (mut machine, _, _) = exit_authorized();
        assert!(machine.exited(Some(0), elapsed).is_none());
    }
    for phase in 0..3 {
        let (mut machine, old, target) = offered();
        if phase > 0 {
            machine
                .accept(Kind::Arm, target.clone(), &old, Duration::from_secs(2))
                .unwrap();
        }
        if phase == 2 {
            machine
                .accept(
                    Kind::ExitIntent,
                    target.clone(),
                    &old,
                    Duration::from_secs(2),
                )
                .unwrap();
        }
        assert_eq!(
            machine
                .accept(Kind::Cancel, target.clone(), &old, Duration::from_secs(3))
                .unwrap(),
            Some(Kind::Cancelled)
        );
        assert!(machine.exited(Some(0), Duration::from_secs(4)).is_none());
        assert!(machine
            .accept(Kind::Prepare, target, &old, Duration::from_secs(5))
            .is_err());
    }
    for kind in [
        Kind::Hello,
        Kind::HelloAck,
        Kind::Prepare,
        Kind::Ready,
        Kind::Armed,
        Kind::Cancelled,
        Kind::ExitIntent,
        Kind::ExitGranted,
    ] {
        let (mut machine, old, target) = offered();
        assert!(machine
            .accept(kind, target, &old, Duration::from_secs(2))
            .is_err());
        assert!(machine.exited(Some(0), Duration::from_secs(3)).is_none());
    }
}

#[test]
fn disarm_after_exit_authorization_prevents_later_exit_zero_and_rearm() {
    let (mut machine, old, target) = exit_authorized();
    machine.disarm();
    assert!(machine.exited(Some(0), Duration::from_secs(4)).is_none());
    assert!(machine
        .accept(Kind::ExitIntent, target, &old, Duration::from_secs(5))
        .is_err());
}

#[test]
fn admission_deadline_and_wrong_target_receipt_fail_closed() {
    let (old, target) = identities();
    let mut machine = Machine::new();
    assert!(machine
        .accept(Kind::HelloAck, old.clone(), &old, ADMISSION_TIMEOUT)
        .is_err());
    let (mut machine, old, _) = offered();
    assert!(machine
        .accept(Kind::Arm, old.clone(), &old, Duration::from_secs(2))
        .is_err());
    assert!(machine.exited(Some(0), Duration::from_secs(3)).is_none());
    let mut machine = Machine::new();
    assert!(machine
        .accept(Kind::HelloAck, target, &old, Duration::ZERO)
        .is_err());
}
