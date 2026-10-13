//! Direct-parent Mach-O admission for threaded GUI callers, not a supervisor.
//! The approved image must already have signed HARD/KILL flags. No parent flags
//! are changed. Resources, dylibs, publisher trust, and descendants are not bound.
//! Same-user signal/ptrace interference and process-memory compromise are outside
//! this admission boundary. The caller must use exclusive direct-child waiting.
use std::{
    collections::BTreeSet,
    ffi::{CString, OsString},
    fs::File,
    io,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, process::ExitStatusExt},
    },
    path::Path,
    process::ExitStatus,
};

const CS_VALID: u32 = 0x1;
const CS_HARD: u32 = 0x100;
const CS_KILL: u32 = 0x200;
const CS_DEBUGGED: u32 = 0x10000000;
const CS_OPS_STATUS: u32 = 0;
const CS_OPS_CDHASH: u32 = 5;

extern "C" {
    // The supported macOS SDK exports this, but older consumer libc locks omit it.
    fn posix_spawn_file_actions_addchdir_np(
        actions: *mut libc::posix_spawn_file_actions_t,
        path: *const libc::c_char,
    ) -> libc::c_int;
    fn csops(
        pid: libc::pid_t,
        operation: u32,
        address: *mut libc::c_void,
        size: usize,
    ) -> libc::c_int;
}

#[derive(Debug)]
pub struct PreparedExecutable {
    hashes: Vec<[u8; 20]>,
}

/// Derive identities only from a bounded snapshot matching the approved SHA-256.
/// Signed HARD/KILL is mandatory even if the caller happens to have exec flags.
pub fn prepare(bytes: &[u8], approved_sha256: &str) -> io::Result<PreparedExecutable> {
    if bytes.len() as u64 > crate::MAX_PAYLOAD
        || approved_sha256.len() != 64
        || !approved_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Expected a bounded Mach-O snapshot and its approved SHA-256",
        ));
    }
    if !crate::digest(bytes).eq_ignore_ascii_case(approved_sha256) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "GUI executable bytes do not match the approved SHA-256",
        ));
    }
    let identities = crate::macho_identity::code_directories(bytes)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if identities
        .iter()
        .any(|identity| identity.flags & (CS_HARD | CS_KILL) != CS_HARD | CS_KILL)
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "GUI executable requires HARD and KILL in its approved CodeDirectory",
        ));
    }
    Ok(PreparedExecutable {
        hashes: identities
            .into_iter()
            .map(|identity| identity.cdhash)
            .collect(),
    })
}

/// File-backed private stdio and direct-child lifecycle, equivalent to Child for
/// id/kill/try_wait/wait. wait closes owned stdin; try_wait does not. After
/// admission, dropping this value does not kill or reap, just like std's Child.
/// The caller must retain it and wait; it must not independently reap this PID.
#[derive(Debug)]
pub struct Child {
    pub stdin: Option<File>,
    pub stdout: Option<File>,
    pub stderr: Option<File>,
    pid: libc::pid_t,
    status: Option<ExitStatus>,
}

impl Child {
    pub fn id(&self) -> u32 {
        self.pid as u32
    }

    pub fn kill(&mut self) -> io::Result<()> {
        if self.status.is_some() || unsafe { libc::kill(self.pid, libc::SIGKILL) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.wait_impl(libc::WNOHANG)
    }

    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        self.stdin.take();
        Ok(self
            .wait_impl(0)?
            .expect("Blocking waitpid returned no status"))
    }

    fn wait_impl(&mut self, options: i32) -> io::Result<Option<ExitStatus>> {
        if self.status.is_some() {
            return Ok(self.status);
        }
        loop {
            let mut status = 0;
            let result = unsafe { libc::waitpid(self.pid, &mut status, options) };
            if result == self.pid {
                self.status = Some(ExitStatus::from_raw(status));
                return Ok(self.status);
            }
            if result == 0 {
                return Ok(None);
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
}

struct SuspendedChild(Option<Child>);

impl SuspendedChild {
    fn admit(mut self, executable: &PreparedExecutable) -> io::Result<Child> {
        let child = self.0.as_mut().unwrap();
        let checked = verify_child(child.pid, &executable.hashes).and_then(|()| {
            if unsafe { libc::kill(child.pid, libc::SIGCONT) } == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        });
        if let Err(error) = checked {
            let mut child = self.0.take().unwrap();
            terminate_and_wait(&mut child).map_err(|cleanup| {
                io::Error::other(format!(
                    "GUI admission refused ({error}); child cleanup failed: {cleanup}"
                ))
            })?;
            return Err(error);
        }
        Ok(self.0.take().unwrap())
    }
}

fn terminate_and_wait(child: &mut Child) -> io::Result<()> {
    match child.kill() {
        Ok(()) => {}
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => {}
        Err(error) => return Err(error),
    }
    child.wait().map(|_| ())
}

impl Drop for SuspendedChild {
    fn drop(&mut self) {
        if let Some(child) = &mut self.0 {
            let _ = terminate_and_wait(child);
        }
    }
}

fn child_status(pid: libc::pid_t) -> io::Result<u32> {
    let mut flags = 0u32;
    if unsafe {
        csops(
            pid,
            CS_OPS_STATUS,
            (&mut flags as *mut u32).cast(),
            std::mem::size_of_val(&flags),
        )
    } == 0
    {
        Ok(flags)
    } else {
        Err(io::Error::last_os_error())
    }
}

fn enforced(flags: u32) -> bool {
    flags & (CS_VALID | CS_HARD | CS_KILL) == CS_VALID | CS_HARD | CS_KILL
        && flags & CS_DEBUGGED == 0
}

fn verify_child(pid: libc::pid_t, approved_hashes: &[[u8; 20]]) -> io::Result<()> {
    let flags = child_status(pid)?;
    let mut hash = [0u8; 20];
    if unsafe { csops(pid, CS_OPS_CDHASH, hash.as_mut_ptr().cast(), hash.len()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // START_SUSPENDED prevents user-space execution. The direct child cannot
    // recycle its PID while we own its wait; csops queries its loaded text vnode.
    if !enforced(flags) || !approved_hashes.contains(&hash) || !enforced(child_status(pid)?) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Suspended GUI image does not match the approved CodeDirectory/enforcement flags",
        ));
    }
    Ok(())
}

struct Attributes(libc::posix_spawnattr_t);
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe {
            libc::posix_spawnattr_destroy(&mut self.0);
        }
    }
}

struct Actions(libc::posix_spawn_file_actions_t);
impl Drop for Actions {
    fn drop(&mut self) {
        unsafe {
            libc::posix_spawn_file_actions_destroy(&mut self.0);
        }
    }
}

fn spawn_result(result: libc::c_int) -> io::Result<()> {
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(result))
    }
}

fn private_pipe() -> io::Result<(File, File)> {
    let mut descriptors = [-1; 2];
    if unsafe { libc::pipe(descriptors.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let read = unsafe { File::from_raw_fd(descriptors[0]) };
    let write = unsafe { File::from_raw_fd(descriptors[1]) };
    let duplicate = |file: &File| {
        let fd = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
        if fd < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(unsafe { File::from_raw_fd(fd) })
        }
    };
    // Keep every source above stdio even when the parent has a closed 0/1/2.
    // CLOEXEC_DEFAULT, not Darwin's non-atomic pipe(), restricts child inheritance.
    Ok((duplicate(&read)?, duplicate(&write)?))
}

/// Direct posix_spawn, never a fork callback or headless supervisor. path is only
/// a launch candidate: loaded identity is checked before SIGCONT. Exact argv
/// (including argv[0]), explicit environment, and absolute cwd are prepared here.
/// Callers choose a safe environment; resource paths and OS libraries are separate.
pub fn spawn(
    executable: &PreparedExecutable,
    path: &Path,
    argv: &[OsString],
    environment: &[(OsString, OsString)],
    cwd: &Path,
) -> io::Result<Child> {
    spawn_suspended(path, argv, environment, cwd)?.admit(executable)
}

fn spawn_suspended(
    path: &Path,
    argv: &[OsString],
    environment: &[(OsString, OsString)],
    cwd: &Path,
) -> io::Result<SuspendedChild> {
    if argv.is_empty() || !path.is_absolute() || !cwd.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "GUI spawn requires argv[0] and absolute executable/cwd paths",
        ));
    }
    let path = CString::new(path.as_os_str().as_bytes())?;
    let cwd = CString::new(cwd.as_os_str().as_bytes())?;
    let arguments = argv
        .iter()
        .map(|value| CString::new(value.as_bytes()))
        .collect::<Result<Vec<_>, _>>()?;
    let mut names = BTreeSet::new();
    let mut entries = Vec::with_capacity(environment.len());
    for (name, value) in environment {
        if name.is_empty() || name.as_bytes().contains(&b'=') || !names.insert(name) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid or duplicate environment name",
            ));
        }
        let mut entry = name.as_bytes().to_vec();
        entry.push(b'=');
        entry.extend_from_slice(value.as_bytes());
        entries.push(CString::new(entry)?);
    }
    let pointers = |strings: &[CString]| {
        strings
            .iter()
            .map(|value| value.as_ptr().cast_mut())
            .chain(std::iter::once(std::ptr::null_mut()))
            .collect::<Vec<_>>()
    };
    let argv = pointers(&arguments);
    let envp = pointers(&entries);
    let (stdin_read, stdin_write) = private_pipe()?;
    let (stdout_read, stdout_write) = private_pipe()?;
    let (stderr_read, stderr_write) = private_pipe()?;
    let mut attributes = unsafe { std::mem::zeroed() };
    spawn_result(unsafe { libc::posix_spawnattr_init(&mut attributes) })?;
    let mut attributes = Attributes(attributes);
    let mut actions = unsafe { std::mem::zeroed() };
    spawn_result(unsafe { libc::posix_spawn_file_actions_init(&mut actions) })?;
    let mut actions = Actions(actions);
    let flags = libc::POSIX_SPAWN_START_SUSPENDED
        | libc::POSIX_SPAWN_CLOEXEC_DEFAULT
        | libc::POSIX_SPAWN_SETSIGMASK
        | libc::POSIX_SPAWN_SETSIGDEF;
    let mut mask = unsafe { std::mem::zeroed() };
    let mut defaults = unsafe { std::mem::zeroed() };
    if unsafe { libc::sigemptyset(&mut mask) } != 0
        || unsafe { libc::sigemptyset(&mut defaults) } != 0
        || unsafe { libc::sigaddset(&mut defaults, libc::SIGPIPE) } != 0
    {
        return Err(io::Error::last_os_error());
    }
    spawn_result(unsafe { libc::posix_spawnattr_setflags(&mut attributes.0, flags as i16) })?;
    spawn_result(unsafe { libc::posix_spawnattr_setsigmask(&mut attributes.0, &mask) })?;
    spawn_result(unsafe { libc::posix_spawnattr_setsigdefault(&mut attributes.0, &defaults) })?;
    spawn_result(unsafe { posix_spawn_file_actions_addchdir_np(&mut actions.0, cwd.as_ptr()) })?;
    for (source, destination) in [
        (stdin_read.as_raw_fd(), 0),
        (stdout_write.as_raw_fd(), 1),
        (stderr_write.as_raw_fd(), 2),
    ] {
        spawn_result(unsafe {
            libc::posix_spawn_file_actions_adddup2(&mut actions.0, source, destination)
        })?;
    }
    let mut pid = 0;
    spawn_result(unsafe {
        libc::posix_spawn(
            &mut pid,
            path.as_ptr(),
            &actions.0,
            &attributes.0,
            argv.as_ptr(),
            envp.as_ptr(),
        )
    })?;
    Ok(SuspendedChild(Some(Child {
        stdin: Some(stdin_write),
        stdout: Some(stdout_read),
        stderr: Some(stderr_read),
        pid,
        status: None,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        os::unix::{ffi::OsStringExt, fs::MetadataExt},
        process::Command,
        sync::Arc,
        time::{Duration, Instant},
    };

    fn signed_copy(directory: &Path, name: &str, options: Option<&str>) -> std::path::PathBuf {
        let path = directory.join(name);
        std::fs::copy(std::env::current_exe().unwrap(), &path).unwrap();
        let mut command = Command::new("/usr/bin/codesign");
        command.args(["--force", "--sign", "-", "--identifier", name]);
        if let Some(options) = options {
            command.args(["--options", options]);
        }
        let output = command.arg(&path).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        path
    }

    fn approved(path: &Path) -> PreparedExecutable {
        let bytes = std::fs::read(path).unwrap();
        prepare(&bytes, &crate::digest(&bytes)).unwrap()
    }

    fn argv() -> Vec<OsString> {
        vec![
            "exact argv0 with spaces".into(),
            "--exact".into(),
            "gui_exec_macos::tests::child_fixture".into(),
            "--ignored".into(),
            "--nocapture".into(),
            "--test-threads=1".into(),
        ]
    }

    fn environment(directory: &Path) -> Vec<(OsString, OsString)> {
        vec![
            ("CREATOR_GUI_FIXTURE".into(), "1".into()),
            (
                "EXACT_BYTES".into(),
                OsString::from_vec(b"space = value\xff".to_vec()),
            ),
            ("GUI_STARTED".into(), directory.join("started").into()),
        ]
    }

    struct OwnedChild(Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = terminate_and_wait(&mut self.0);
        }
    }

    fn finish(
        child: Child,
        input: &[u8],
        argv: &[OsString],
        environment: &[(OsString, OsString)],
        cwd: &Path,
    ) {
        let mut child = OwnedChild(child);
        assert!(child.0.try_wait().unwrap().is_none());
        child.0.stdin.take().unwrap().write_all(input).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let status = loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < deadline, "EOF child did not exit");
            std::thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(status.code(), Some(23));
        assert_eq!(child.0.wait().unwrap(), status);
        assert_eq!(child.0.try_wait().unwrap(), Some(status));
        let mut output = String::new();
        child
            .0
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut output)
            .unwrap();
        let line = output
            .lines()
            .find_map(|line| line.strip_prefix("GUI_FIXTURE:"))
            .expect(&output);
        let actual: serde_json::Value = serde_json::from_str(line).unwrap();
        let mut expected_environment: Vec<_> = environment
            .iter()
            .map(|(name, value)| (name.as_bytes().to_vec(), value.as_bytes().to_vec()))
            .collect();
        expected_environment.sort();
        assert_eq!(
            actual["argv"],
            serde_json::json!(argv
                .iter()
                .map(|arg| arg.as_bytes().to_vec())
                .collect::<Vec<_>>())
        );
        assert_eq!(
            actual["environment"],
            serde_json::json!(expected_environment)
        );
        assert_eq!(actual["cwd"], serde_json::json!(cwd.as_os_str().as_bytes()));
        assert_eq!(actual["parent"], std::process::id());
        assert_eq!(actual["input"], serde_json::json!(input));
        assert_eq!(actual["enforced"], true);
        assert_eq!(actual["unrelatedFdLeaked"], false);
        let mut diagnostic = String::new();
        child
            .0
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut diagnostic)
            .unwrap();
        assert_eq!(diagnostic, "GUI_FIXTURE_STDERR\n");
        let mut raw = 0;
        assert_eq!(
            unsafe { libc::waitpid(child.0.pid, &mut raw, libc::WNOHANG) },
            -1
        );
        assert_eq!(
            io::Error::last_os_error().raw_os_error(),
            Some(libc::ECHILD)
        );
    }

    #[test]
    #[ignore = "disposable signed subprocess invoked by native admission tests"]
    fn child_fixture() {
        assert_eq!(std::env::var("CREATOR_GUI_FIXTURE").unwrap(), "1");
        std::fs::write(std::env::var_os("GUI_STARTED").unwrap(), b"started").unwrap();
        let mut input = Vec::new();
        io::stdin().read_to_end(&mut input).unwrap();
        let mut environment: Vec<_> = std::env::vars_os()
            .map(|(name, value)| (name.as_bytes().to_vec(), value.as_bytes().to_vec()))
            .collect();
        environment.sort();
        let unrelated_fd_leaked = std::env::var("GUI_LEAK_FD").ok().is_some_and(|fd| {
            let fd = fd.parse::<i32>().unwrap();
            let device = std::env::var("GUI_LEAK_DEVICE")
                .unwrap()
                .parse::<libc::dev_t>()
                .unwrap();
            let inode = std::env::var("GUI_LEAK_INODE")
                .unwrap()
                .parse::<libc::ino_t>()
                .unwrap();
            let mut metadata = unsafe { std::mem::zeroed::<libc::stat>() };
            (unsafe { libc::fstat(fd, &mut metadata) } == 0)
                && metadata.st_dev == device
                && metadata.st_ino == inode
        });
        println!(
            "\nGUI_FIXTURE:{}",
            serde_json::json!({
                "argv": std::env::args_os().map(|arg| arg.as_bytes().to_vec()).collect::<Vec<_>>(),
                "environment": environment,
                "cwd": std::env::current_dir().unwrap().as_os_str().as_bytes(),
                "parent": unsafe { libc::getppid() },
                "input": input,
                "enforced": enforced(child_status(0).unwrap()),
                "unrelatedFdLeaked": unrelated_fd_leaked,
            })
        );
        eprintln!("GUI_FIXTURE_STDERR");
        std::process::exit(23);
    }

    #[test]
    fn native_threaded_private_stdio_exact_arguments_and_eof_wait() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().canonicalize().unwrap();
        let path = signed_copy(&directory, "approved", Some("hard,kill"));
        let executable = Arc::new(approved(&path));
        let unrelated_file = File::create(directory.join("not-inherited")).unwrap();
        let unrelated_metadata = unrelated_file.metadata().unwrap();
        assert_eq!(
            unsafe { libc::fcntl(unrelated_file.as_raw_fd(), libc::F_SETFD, 0) },
            0
        );
        let parent_flags = child_status(0).unwrap();
        let threads: Vec<_> = (0..4)
            .map(|index| {
                let executable = Arc::clone(&executable);
                let path = path.clone();
                let cwd = directory.join(format!("thread {index}"));
                std::fs::create_dir(&cwd).unwrap();
                let unrelated_fd = unrelated_file.as_raw_fd();
                let unrelated_device = unrelated_metadata.dev();
                let unrelated_inode = unrelated_metadata.ino();
                std::thread::spawn(move || {
                    let arguments = argv();
                    let mut environment = environment(&cwd);
                    for (name, value) in [
                        ("GUI_LEAK_FD", unrelated_fd.to_string()),
                        ("GUI_LEAK_DEVICE", unrelated_device.to_string()),
                        ("GUI_LEAK_INODE", unrelated_inode.to_string()),
                    ] {
                        environment.push((name.into(), value.into()));
                    }
                    let child = spawn(&executable, &path, &arguments, &environment, &cwd).unwrap();
                    finish(
                        child,
                        format!("private input {index}").as_bytes(),
                        &arguments,
                        &environment,
                        &cwd,
                    );
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(
            child_status(0).unwrap(),
            parent_flags,
            "Parent signing flags changed"
        );
    }

    #[test]
    fn signed_hard_and_kill_are_required_in_the_approved_snapshot() {
        let temporary = tempfile::tempdir().unwrap();
        for options in [None, Some("hard"), Some("kill")] {
            let path = signed_copy(temporary.path(), "weak", options);
            let bytes = std::fs::read(path).unwrap();
            let error = prepare(&bytes, &crate::digest(&bytes)).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
            assert!(error.to_string().contains("HARD and KILL"));
        }
    }

    #[test]
    fn changed_path_and_in_place_foreign_image_refuse_before_user_code() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().canonicalize().unwrap();
        let foreign = signed_copy(&directory, "foreign", Some("hard,kill"));
        let foreign_bytes = std::fs::read(&foreign).unwrap();
        for replace in [false, true] {
            let path = signed_copy(&directory, "approved", Some("hard,kill"));
            let executable = approved(&path);
            if replace {
                let replacement = directory.join("replacement");
                std::fs::copy(&foreign, &replacement).unwrap();
                std::fs::rename(replacement, &path).unwrap();
            } else {
                std::fs::write(&path, &foreign_bytes).unwrap();
            }
            assert!(spawn(
                &executable,
                &path,
                &argv(),
                &environment(&directory),
                &directory
            )
            .is_err());
            assert!(
                !directory.join("started").exists(),
                "Foreign code ran before admission"
            );
        }
    }

    #[test]
    fn rejected_kernel_flags_and_identity_kill_and_reap_the_suspended_child() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().canonicalize().unwrap();
        let path = signed_copy(&directory, "approved", Some("hard,kill"));
        let executable = approved(&path);
        for options in [None, Some("hard,kill")] {
            let foreign = signed_copy(&directory, "foreign", options);
            let pending =
                spawn_suspended(&foreign, &argv(), &environment(&directory), &directory).unwrap();
            let pid = pending.0.as_ref().unwrap().pid;
            if options.is_none() {
                assert!(!enforced(child_status(pid).unwrap()));
            }
            assert!(pending.admit(&executable).is_err());
            assert!(!directory.join("started").exists());
            let mut status = 0;
            assert_eq!(
                unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) },
                -1
            );
            assert_eq!(
                io::Error::last_os_error().raw_os_error(),
                Some(libc::ECHILD)
            );
            assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
            assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
        }
    }

    #[test]
    fn wait_closes_stdin_and_kill_reports_the_real_signal() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().canonicalize().unwrap();
        let path = signed_copy(&directory, "approved", Some("hard,kill"));
        let executable = approved(&path);
        let mut child = OwnedChild(
            spawn(
                &executable,
                &path,
                &argv(),
                &environment(&directory),
                &directory,
            )
            .unwrap(),
        );
        assert_eq!(child.0.wait().unwrap().code(), Some(23));
        assert!(child.0.stdin.is_none());
        let mut child = OwnedChild(
            spawn(
                &executable,
                &path,
                &argv(),
                &environment(&directory),
                &directory,
            )
            .unwrap(),
        );
        child.0.kill().unwrap();
        let status = child.0.wait().unwrap();
        assert_eq!(status.signal(), Some(libc::SIGKILL));
        assert_eq!(child.0.try_wait().unwrap(), Some(status));
        child.0.kill().unwrap();
    }

    #[test]
    fn admission_mask_refuses_missing_flags_and_debugged_code() {
        let required = CS_VALID | CS_HARD | CS_KILL;
        assert!(enforced(required));
        for missing in [CS_VALID, CS_HARD, CS_KILL] {
            assert!(!enforced(required & !missing));
        }
        assert!(!enforced(required | CS_DEBUGGED));
    }

    #[test]
    fn malformed_hash_arguments_environment_and_cwd_refuse() {
        assert!(prepare(b"not Mach-O", "bad").is_err());
        assert_eq!(
            prepare(b"not Mach-O", &"0".repeat(64)).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        let executable = PreparedExecutable { hashes: vec![] };
        let root = Path::new("/");
        for environment in [
            vec![("".into(), "v".into())],
            vec![("bad=name".into(), "v".into())],
            vec![("same".into(), "a".into()), ("same".into(), "b".into())],
            vec![("n".into(), OsString::from_vec(b"nul\0value".to_vec()))],
        ] {
            assert!(spawn(&executable, root, &argv(), &environment, root).is_err());
        }
        assert!(spawn(&executable, root, &[], &[], root).is_err());
        assert!(spawn(&executable, Path::new("relative"), &argv(), &[], root).is_err());
        assert!(spawn(&executable, root, &argv(), &[], Path::new("relative")).is_err());
        assert!(spawn(
            &executable,
            root,
            &[OsString::from_vec(b"nul\0arg".to_vec())],
            &[],
            root
        )
        .is_err());
    }
}
