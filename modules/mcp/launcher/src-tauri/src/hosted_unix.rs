//! Unix admission only; neither advisory ownership nor a pathname grants payload authority.
pub(super) fn require_managed_route(writable: bool, managed: bool) -> Result<(), String> {
    if writable && !managed {
        return Err("Unix writable hosting requires the signed managed route. Direct mutable Node client targets are not authorized.".into());
    }
    Ok(())
}

pub(super) fn ensure_owner(writable: bool, current: bool) -> Result<(), String> {
    if writable && !current {
        return Err("MCP settings ownership changed or is unavailable. Close this view before trying again. No new command was started.".into());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn private_streams(input: libc::c_int, output: libc::c_int) -> Result<(), String> {
    for fd in [input, output] {
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(fd, &mut stat) } != 0 {
            return Err("Cannot inspect hosted streams.".into());
        }
        if stat.st_mode & libc::S_IFMT != libc::S_IFIFO {
            return Err("Hosted mode requires private inherited input and output pipes.".into());
        }
    }
    for fd in [input, output] {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
            return Err("Cannot prevent hosted pipe inheritance into child processes.".into());
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub(super) fn parent_host() -> Result<String, String> {
    private_streams(libc::STDIN_FILENO, libc::STDOUT_FILENO)?;
    let parent = unsafe { libc::getppid() };
    if parent <= 1 {
        return Err("Cannot verify the parent process.".into());
    }
    let path = std::fs::read_link(format!("/proc/{parent}/exe"))
        .map_err(|_| "Cannot verify Creator Hub's process.")?;
    let valid_name = path.file_name().is_some_and(|name| {
        let name = name.to_string_lossy();
        name.eq_ignore_ascii_case("creator-hub") || name.eq_ignore_ascii_case("creator-hub.exe")
    });
    if unsafe { libc::getppid() } != parent || !valid_name {
        return Err("Hosted mode must be launched directly by Creator Hub.".into());
    }
    path.into_os_string()
        .into_string()
        .map_err(|_| "Invalid host path.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writable_requires_managed_routing_but_read_only_needs_no_owner() {
        assert!(require_managed_route(true, false).is_err());
        assert!(require_managed_route(true, true).is_ok());
        assert!(require_managed_route(false, false).is_ok());
        assert!(ensure_owner(false, false).is_ok());
        assert!(ensure_owner(true, false).is_err());
        assert!(ensure_owner(true, true).is_ok());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn native_pipes_are_cloexec_and_files_sockets_or_invalid_fds_refuse() {
        use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
        let mut raw = [0; 2];
        assert_eq!(unsafe { libc::pipe(raw.as_mut_ptr()) }, 0);
        let input = unsafe { OwnedFd::from_raw_fd(raw[0]) };
        let output = unsafe { OwnedFd::from_raw_fd(raw[1]) };
        private_streams(input.as_raw_fd(), output.as_raw_fd()).unwrap();
        for fd in [input.as_raw_fd(), output.as_raw_fd()] {
            assert_ne!(
                unsafe { libc::fcntl(fd, libc::F_GETFD) } & libc::FD_CLOEXEC,
                0
            );
        }
        let file = tempfile::tempfile().unwrap();
        assert!(private_streams(file.as_raw_fd(), output.as_raw_fd()).is_err());
        let (socket, _) = std::os::unix::net::UnixStream::pair().unwrap();
        assert!(private_streams(input.as_raw_fd(), socket.as_raw_fd()).is_err());
        assert!(private_streams(-1, output.as_raw_fd()).is_err());
    }

    #[cfg(target_os = "linux")]
    fn fixture_name(name: &str) -> String {
        format!("{}::{name}", module_path!().split_once("::").unwrap().1)
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "subprocess fixture invoked by native_direct_parent_and_pipe_admission"]
    fn child_fixture() {
        std::process::exit(if parent_host().is_ok() { 0 } else { 10 });
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "subprocess fixture invoked by native_direct_parent_and_pipe_admission"]
    fn host_fixture() {
        use std::process::{Command, Stdio};
        let Some(child) = std::env::var_os("CREATOR_UNIX_PARENT_TEST_CHILD") else {
            return;
        };
        let status = Command::new(child)
            .args(["--exact", &fixture_name("child_fixture"), "--ignored"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .status()
            .unwrap();
        std::process::exit(status.code().unwrap_or(11));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn native_direct_parent_and_pipe_admission() {
        let temporary = tempfile::tempdir().unwrap();
        let current = std::env::current_exe().unwrap();
        for (name, expected) in [("creator-hub", 0), ("other-host", 10)] {
            let host = temporary.path().join(name);
            std::fs::copy(&current, &host).unwrap();
            let status = std::process::Command::new(host)
                .args(["--exact", &fixture_name("host_fixture"), "--ignored"])
                .env("CREATOR_UNIX_PARENT_TEST_CHILD", &current)
                .status()
                .unwrap();
            assert_eq!(status.code(), Some(expected), "{name}");
        }
        // This test executable is not launched by a Hub, even with private pipes.
        let status = std::process::Command::new(current)
            .args(["--exact", &fixture_name("child_fixture"), "--ignored"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(10));
    }

    #[test]
    fn installed_client_formats_native_publication_preserves_source_and_exact_displaced_bytes() {
        use crate::client_migration::{recovery, Format, Plan};
        use serde_json::json;
        use std::fs;
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let router = root.join("creator-hub-mcp-router");
        fs::write(&router, b"fixture never executed").unwrap();
        let old = json!({"command":root.join("legacy/node"),
            "args":[root.join("legacy/creator-works-mcp.mjs")],
            "env":{"CUSTOM":"keep", "UNITY_PROJECT_PATH":"keep project"},
            "disabled":true,"timeout":37});
        let sources = [
            ("Codex", Format::Codex, format!("# keep comment\r\nmodel='keep'\r\n[mcp_servers.banter]\r\ncommand='{}' # command comment\r\nargs=['{}'] # args comment\r\nenabled=false\r\n[mcp_servers.banter.env]\r\nCUSTOM='keep' # custom comment\r\nUNITY_PROJECT_PATH='keep project'\r\n[mcp_servers.other]\r\ncommand='keep'\r\n", old["command"].as_str().unwrap(), old["args"][0].as_str().unwrap())),
            ("Claude Code", Format::Json, format!("{{\r\n \"mcpServers\":{{\"banter\":{old},\"other\":{{ \"command\":\"keep\" }}}},\r\n \"custom\":{{ \"keep\":true }}\r\n}}\r\n")),
            ("Claude Desktop", Format::Json, format!("{{\r\n \"mcpServers\":{{\"creator-works\":{old},\"other\":{{ \"command\":\"keep\" }}}},\r\n \"preferences\":{{ \"keep\":true }}\r\n}}\r\n")),
        ];
        let mut paths = Vec::new();
        let mut plans = Vec::new();
        for (name, format, source) in &sources {
            let path = root.join(format!("{name}.config"));
            fs::write(&path, source).unwrap();
            plans.push(
                Plan::review_router(name, &path, *format, &router)
                    .unwrap()
                    .unwrap(),
            );
            paths.push(path);
        }
        let journals = root.join("journals");
        assert!(Plan::apply_reviewed(&plans, &journals, |_| false)
            .unwrap()
            .is_none());
        assert!(!journals.exists());
        for (path, (_, _, source)) in paths.iter().zip(&sources) {
            assert_eq!(fs::read(path).unwrap(), source.as_bytes());
        }
        let report = Plan::apply_reviewed(&plans, &journals, |_| true)
            .unwrap()
            .unwrap();
        assert!(report.completed);
        assert_eq!(report.files.len(), 3); // Missing clients are not synthesized.
        for ((_, format, source), file) in sources.iter().zip(&report.files) {
            assert_eq!(file.status, recovery::Status::Applied);
            assert_eq!(fs::read(&file.before_image).unwrap(), source.as_bytes());
            assert_eq!(fs::read(&file.before_backup).unwrap(), source.as_bytes());
            assert_eq!(fs::read(&file.displaced).unwrap(), source.as_bytes());
            let after = fs::read_to_string(&file.after_image).unwrap();
            assert_eq!(fs::read(&file.path).unwrap(), after.as_bytes());
            assert!(after.contains("keep"));
            match format {
                Format::Codex => {
                    for comment in [
                        "# keep comment",
                        "# command comment",
                        "# args comment",
                        "# custom comment",
                    ] {
                        assert!(after.contains(comment));
                    }
                    let doc = after.parse::<toml_edit::Document>().unwrap();
                    assert!(doc["mcp_servers"]["banter"]["args"]
                        .as_array()
                        .unwrap()
                        .is_empty());
                    assert_eq!(
                        doc["mcp_servers"]["other"]["command"].as_str(),
                        Some("keep")
                    );
                }
                Format::Json => {
                    assert!(after.contains("\"other\":{ \"command\":\"keep\" }"));
                    let value: serde_json::Value = serde_json::from_str(&after).unwrap();
                    let entries = value["mcpServers"].as_object().unwrap();
                    let entry = entries
                        .get("banter")
                        .or_else(|| entries.get("creator-works"))
                        .unwrap();
                    assert_eq!(entry["args"], json!([]));
                    assert_eq!(entry["disabled"], true);
                    assert_eq!(entry["timeout"], 37);
                    assert_eq!(entry["env"]["CUSTOM"], "keep");
                    assert_eq!(entry["env"]["UNITY_PROJECT_PATH"], "keep project");
                }
                Format::OpenCode => unreachable!(),
            }
        }
        let transaction = recovery::Transaction::open(&report.journal, &paths).unwrap();
        assert!(transaction.resume(|_| true).unwrap().completed);
        assert!(report.journal.join("completed.json").exists());
        for (path, file) in paths.iter().zip(&report.files) {
            assert_eq!(
                fs::read(path).unwrap(),
                fs::read(&file.after_image).unwrap()
            );
        }
    }
}
