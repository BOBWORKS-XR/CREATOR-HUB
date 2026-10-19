fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    if !activation_requested(std::env::args_os().skip(1)) {
        return Err("Only the fixed activate operation is supported; no changes were made.".into());
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        use creator_hub_linux_portable_deployment::{HostSession, Store};
        let session = HostSession::capture()?;
        let store = Store::open(session.store_path())?;
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
    Err("Native portable activation is Linux x86_64 only.".into())
}

fn activation_requested(arguments: impl IntoIterator<Item = std::ffi::OsString>) -> bool {
    let mut arguments = arguments.into_iter();
    arguments.next().is_some_and(|value| value == "activate") && arguments.next().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;
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
