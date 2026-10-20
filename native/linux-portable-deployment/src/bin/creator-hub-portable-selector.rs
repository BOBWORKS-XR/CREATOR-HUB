fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let operation = operation(std::env::args_os().skip(1))
        .ok_or("Use activate, recover-pending, or recover-pending --acknowledge REVIEW_ID; no changes were made.")?;
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        use creator_hub_linux_portable_deployment::{HostSession, Store};
        let session = HostSession::capture()?;
        let store = Store::open(session.store_path())?;
        if operation != Operation::Activate {
            use creator_hub_linux_portable_deployment::{PendingRecoveryChoice, RecoveryState};
            let review = store.review_pending_deployment(&session)?;
            let retained = review.retained_selection();
            match operation {
                Operation::ReviewPending => {
                    let state = match review.state() {
                        RecoveryState::PreparedOldSelectionRetained => {
                            "previous selection retained"
                        }
                        RecoveryState::SelectionCommitted => "new selection already committed",
                    };
                    println!("Verified pending deployment: {state}.\nRetained selection: {} (generation {}).\nReviewed target generation: {}.\nNo files were changed and no app was launched. Acknowledgement keeps this selection; it does not finish or replay an update, roll back, or prove app success.\n\nTo acknowledge this exact reviewed state explicitly:\n{}\n\nOtherwise do nothing; the pending record stays in place.",
                        retained.version, retained.generation, review.target_generation(), review.acknowledgement_command());
                }
                Operation::AcknowledgePending(id) => {
                    if id != review.review_id() {
                        return Err("Recovery review changed. Run recover-pending again; nothing was acknowledged.".into());
                    }
                    store.recover_pending_deployment(
                        &session,
                        &review,
                        PendingRecoveryChoice::AcknowledgeReviewed,
                    )?;
                    println!("Acknowledged the reviewed pending record. Selection remains {} (generation {}). No app was launched or update replayed. Run the same helper with activate when ready.", retained.version, retained.generation);
                }
                Operation::Activate => unreachable!(),
            }
            return Ok(());
        }
        #[cfg(feature = "experimental-restart")]
        {
            let outcome = store.supervise_registered(&session)?;
            if outcome.exit_code == Some(0) {
                Ok(())
            } else {
                Err("Native Hub did not exit normally with code zero.".into())
            }
        }
        #[cfg(not(feature = "experimental-restart"))]
        {
            // Root owns the bus name; keep activation Exec alive during its startup.
            let status = store.activate_registered(&session)?.wait()?;
            if status.success() {
                Ok(())
            } else {
                Err("Native Hub exited without a successful process result.".into())
            }
        }
    }
    #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
    {
        let _ = operation;
        Err("Native portable activation and recovery are Linux x86_64 only.".into())
    }
}

#[cfg(test)]
fn activation_requested(arguments: impl IntoIterator<Item = std::ffi::OsString>) -> bool {
    let mut arguments = arguments.into_iter();
    arguments.next().is_some_and(|value| value == "activate") && arguments.next().is_none()
}

#[derive(Debug, PartialEq, Eq)]
enum Operation {
    Activate,
    ReviewPending,
    AcknowledgePending(String),
}

fn operation(arguments: impl IntoIterator<Item = std::ffi::OsString>) -> Option<Operation> {
    let args: Vec<_> = arguments.into_iter().take(4).collect();
    match args.as_slice() {
        [one] if one == "activate" => Some(Operation::Activate),
        [one] if one == "recover-pending" => Some(Operation::ReviewPending),
        [one, two, id] if one == "recover-pending" && two == "--acknowledge" => {
            let id = id.to_str()?;
            (id.len() == 64
                && id
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
            .then(|| Operation::AcknowledgePending(id.into()))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pending_recovery_is_reachable_without_activation_and_ack_is_explicit() {
        assert_eq!(operation(["activate".into()]), Some(Operation::Activate));
        assert_eq!(
            operation(["recover-pending".into()]),
            Some(Operation::ReviewPending)
        );
        let id = "a".repeat(64);
        assert_eq!(
            operation([
                "recover-pending".into(),
                "--acknowledge".into(),
                id.clone().into()
            ]),
            Some(Operation::AcknowledgePending(id))
        );
    }

    #[test]
    fn pending_recovery_has_closed_grammar_without_paths_or_commands() {
        for args in [
            vec!["recover-pending", "--acknowledge"],
            vec!["recover-pending", "/tmp/store"],
            vec!["recover-pending", "--acknowledge", "bad"],
            vec!["recover-pending", "sh", "-c"],
            vec!["recover-pending", "--acknowledge", &"A".repeat(64)],
            vec!["recover-pending", "--acknowledge", &"a".repeat(64), "extra"],
        ] {
            assert_eq!(operation(args.into_iter().map(Into::into)), None);
        }
    }
    #[test]
    fn only_fixed_argument_is_accepted_without_any_command_or_data_path() {
        assert!(activation_requested(["activate".into()]));
        for arguments in [
            vec![],
            vec!["install"],
            vec!["--flatpak-activate"],
            vec!["activate", "/tmp/tool"],
            vec!["activate", "--version", "0.1.17"],
            vec!["sh", "-c", "anything"],
        ] {
            assert!(!activation_requested(arguments.into_iter().map(Into::into)));
        }
    }
}
