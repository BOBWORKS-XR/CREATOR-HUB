use std::process::{Command, Output, Stdio};
use std::time::Duration;
use wait_timeout::ChildExt;

fn run_metadata(arguments: &[&str]) -> Output {
    let directory = tempfile::tempdir().unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_creator-project-setup"));
    command
        .args(arguments)
        .current_dir(directory.path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for name in [
        "APPDATA",
        "LOCALAPPDATA",
        "HOME",
        "USERPROFILE",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "TEMP",
        "TMP",
    ] {
        command.env(name, directory.path());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().unwrap();
    if child
        .wait_timeout(Duration::from_secs(5))
        .unwrap()
        .is_none()
    {
        let _ = child.kill();
        let _ = child.wait();
        panic!("Metadata invocation started a GUI or failed to exit in five seconds");
    }
    let output = child.wait_with_output().unwrap();
    assert!(output.stdout.len() + output.stderr.len() < 4096);
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    output
}

#[test]
fn packaged_binary_metadata_does_not_start_gui_or_create_settings() {
    let output = run_metadata(&["--creator-hub-info"]);
    assert!(output.status.success(), "{:?}", output.stderr);
    assert!(output.stderr.is_empty());
    let info: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(info["schemaVersion"], 1);
    assert_eq!(info["appId"], "creator-project-setup");
    assert_eq!(info["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(info["platform"], std::env::consts::OS);
    assert_eq!(info["architecture"], std::env::consts::ARCH);
    assert!(info["capabilities"]
        .as_array()
        .unwrap()
        .contains(&serde_json::json!("launch.standalone")));
}

#[test]
fn malformed_metadata_invocations_exit_without_gui_or_writes() {
    for arguments in [
        vec!["--creator-hub-info", "--output", "forbidden.json"],
        vec!["--creator-hub-info", "--creator-hub-info"],
        vec!["--creator-hub-info=true"],
        vec!["--creator-hub-install"],
        vec!["--creator-hub"],
        vec!["--CREATOR-HUB-INFO"],
        vec!["--Creator-Hub-Info"],
        vec!["--CREATOR-HUB-UNKNOWN"],
        vec!["anything", "--creator-hub-info"],
    ] {
        let output = run_metadata(&arguments);
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
    }
}
