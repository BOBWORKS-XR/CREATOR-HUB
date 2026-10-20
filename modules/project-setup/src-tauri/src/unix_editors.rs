//! Read-only Editor process checks. Never signals a process or trusts its PID alone.
use std::{fs, path::Path};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

pub fn require_closed(executable: &Path) -> Result<(), String> {
    let target = fs::canonicalize(executable)
        .map_err(|_| "The selected Unity executable is unavailable. Nothing was installed.")?;
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::Always),
    );
    // An empty/failed enumeration must never authorize a write into an Editor.
    let own = system.process(sysinfo::Pid::from_u32(std::process::id()));
    if own.and_then(|p| p.exe()).is_none() {
        return Err("Cannot inspect running Editors. Nothing was installed.".into());
    }
    for process in system.processes().values() {
        let unity_name = process.name() == "Unity" || process.name() == "Unity.exe";
        let actual = process.exe().and_then(|path| fs::canonicalize(path).ok());
        if actual.as_ref() == Some(&target) {
            return Err("The selected Unity Editor is running. Save your work and close its windows before adding modules. Nothing was force-closed.".into());
        }
        if unity_name && actual.is_none() {
            return Err("A Unity Editor is running but its location cannot be verified. Close Unity normally before installing modules. Nothing was installed.".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        process::{Child, Command, Stdio},
        time::{Duration, Instant},
    };

    struct TestProcess(Child);
    impl Drop for TestProcess {
        fn drop(&mut self) {
            // Only the child created by this test; never a discovered user process.
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn selected_live_executable_is_blocked_and_unrelated_copy_is_allowed() {
        let temp = tempfile::tempdir().unwrap();
        let selected = temp.path().join("Unity");
        let unrelated = temp.path().join("OtherUnity");
        fs::copy("/bin/sleep", &selected).unwrap();
        fs::copy("/bin/sleep", &unrelated).unwrap();
        let mut child = TestProcess(
            Command::new(&selected)
                .arg("60")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if require_closed(&selected).is_err() {
                break;
            }
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "Fixture exited early"
            );
            assert!(Instant::now() < deadline, "Did not detect selected process");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(require_closed(&unrelated).is_ok());
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "Inspection must not stop the Editor"
        );
        drop(child);
        assert!(require_closed(&selected).is_ok());
    }

    #[test]
    fn missing_selected_executable_cannot_authorize_installation() {
        let temp = tempfile::tempdir().unwrap();
        assert!(require_closed(&temp.path().join("missing")).is_err());
    }
}
