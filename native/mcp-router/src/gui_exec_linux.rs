//! Linux executable admission from an approved byte buffer, including threaded parents.
//! No publisher authority, resource lookup, supervisor, or descendant cleanup is added.
//! A memfd has no canonical executable pathname; Tauri resource lookup needs a separate contract.
use std::{
    ffi::{CString, OsString},
    fs::File,
    io::{self, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, process::CommandExt},
    },
    path::Path,
    process::{Child, Command, Stdio},
};

const SEALS: i32 = libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL;

/// An immutable executable snapshot. The caller supplies the approved metadata hash.
pub struct PreparedExecutable(File);

fn require_seals(file: &File) -> io::Result<()> {
    let seals = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GET_SEALS) };
    if seals < 0 || seals & SEALS != SEALS {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "GUI executable requires complete write/grow/shrink/seal seals",
        ));
    }
    Ok(())
}

/// Verify and seal these exact bytes; never reopen an executable pathname.
pub fn prepare(bytes: &[u8], approved_sha256: &str) -> io::Result<PreparedExecutable> {
    if bytes.len() as u64 > crate::MAX_PAYLOAD
        || bytes.get(..5) != Some(b"\x7fELF\x02")
        || approved_sha256.len() != 64
        || !approved_sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Expected a bounded 64-bit ELF buffer and its approved SHA-256",
        ));
    }
    if crate::digest(bytes) != approved_sha256 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "GUI executable bytes do not match the approved SHA-256",
        ));
    }
    let flags = libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING;
    let mut fd = unsafe { libc::memfd_create(c"creator-hub-gui".as_ptr(), flags | libc::MFD_EXEC) };
    // Only an unknown flag permits the old API, never a policy/pathname fallback.
    if fd < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::EINVAL) {
        fd = unsafe { libc::memfd_create(c"creator-hub-gui".as_ptr(), flags) };
    }
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let initial = unsafe { File::from_raw_fd(fd) };
    // Keep the image clear of stdio remapping performed by Command::spawn.
    let fd = unsafe { libc::fcntl(initial.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 10) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut image = unsafe { File::from_raw_fd(fd) };
    image.write_all(bytes)?;
    if unsafe { libc::fchmod(fd, 0o500) } != 0
        || unsafe { libc::fcntl(fd, libc::F_ADD_SEALS, SEALS) } != 0
    {
        return Err(io::Error::last_os_error());
    }
    require_seals(&image)?;
    Ok(PreparedExecutable(image))
}

struct NativeStrings {
    _strings: Vec<CString>,
    pointers: Vec<*const libc::c_char>,
}

// Pointers refer only to the owned, immutable CString allocations, not thread-local data.
unsafe impl Send for NativeStrings {}
unsafe impl Sync for NativeStrings {}

impl NativeStrings {
    fn new(strings: Vec<CString>) -> Self {
        let pointers = strings
            .iter()
            .map(|value| value.as_ptr())
            .chain(std::iter::once(std::ptr::null()))
            .collect();
        Self {
            _strings: strings,
            pointers,
        }
    }

    fn as_ptr(&self) -> *const *const libc::c_char {
        self.pointers.as_ptr()
    }
}

/// Spawn directly with exact argv (including argv[0]), explicit environment, cwd,
/// and three private pipes. The returned Child owns normal EOF/wait semantics.
/// The caller must choose a safe environment; OS libraries remain outside this binding.
pub fn spawn(
    executable: &PreparedExecutable,
    argv: &[OsString],
    environment: &[(OsString, OsString)],
    cwd: &Path,
) -> io::Result<Child> {
    if argv.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Missing argv[0]",
        ));
    }
    let arguments = NativeStrings::new(
        argv.iter()
            .map(|value| CString::new(value.as_bytes()))
            .collect::<Result<_, _>>()?,
    );
    let mut names = std::collections::BTreeSet::new();
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
    let environment = NativeStrings::new(entries);
    let image = executable.0.try_clone()?;
    require_seals(&image)?;
    // This deliberately unusable path is never executed: the hook cannot return Ok.
    let mut command = Command::new("/proc/self/fd/-1");
    command
        .arg0(&argv[0])
        .args(&argv[1..])
        .env_clear()
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    unsafe {
        command.pre_exec(move || {
            // All storage is prepared in the parent. No allocation, locks, or Rust drops.
            libc::execveat(
                image.as_raw_fd(),
                c"".as_ptr(),
                arguments.as_ptr().cast(),
                environment.as_ptr().cast(),
                libc::AT_EMPTY_PATH,
            );
            Err(io::Error::last_os_error())
        });
    }
    command.spawn()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Read,
        os::unix::{
            ffi::OsStringExt,
            fs::{MetadataExt, PermissionsExt},
        },
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        time::{Duration, Instant},
    };

    fn fixture_argv(arg0: OsString) -> Vec<OsString> {
        [
            arg0,
            "--exact".into(),
            "gui_exec_linux::tests::child_fixture".into(),
            "--ignored".into(),
            "--nocapture".into(),
            "--test-threads=1".into(),
        ]
        .into()
    }

    fn fixture_environment() -> Vec<(OsString, OsString)> {
        vec![
            ("CREATOR_GUI_FIXTURE".into(), "1".into()),
            (
                "EXACT_BYTES".into(),
                OsString::from_vec(b"space = value\xff".to_vec()),
            ),
        ]
    }

    struct OwnedChild(Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            self.0.stdin.take();
            let _ = self.0.kill();
            let _ = self.0.wait();
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
            assert!(Instant::now() < deadline, "EOF child did not exit in time");
            std::thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(status.code(), Some(23));
        assert_eq!(child.0.wait().unwrap(), status);
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
        assert_eq!(actual["imageFdLeaked"], false);
        assert_eq!(actual["canonicalExecutablePath"], false);
        assert!(!Path::new(&format!("/proc/{}", child.0.id())).exists());
        let mut diagnostic = String::new();
        child
            .0
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut diagnostic)
            .unwrap();
        assert_eq!(diagnostic, "GUI_FIXTURE_STDERR\n");
    }

    #[test]
    #[ignore = "disposable subprocess invoked by the native admission tests"]
    fn child_fixture() {
        assert_eq!(std::env::var("CREATOR_GUI_FIXTURE").unwrap(), "1");
        let mut input = Vec::new();
        std::io::stdin().read_to_end(&mut input).unwrap();
        let mut environment: Vec<_> = std::env::vars_os()
            .map(|(name, value)| (name.as_bytes().to_vec(), value.as_bytes().to_vec()))
            .collect();
        environment.sort();
        let image_fd_leaked = std::fs::read_dir("/proc/self/fd")
            .unwrap()
            .filter_map(Result::ok)
            .filter_map(|entry| std::fs::read_link(entry.path()).ok())
            .any(|path| {
                path.as_os_str()
                    .as_bytes()
                    .windows(b"creator-hub-gui".len())
                    .any(|part| part == b"creator-hub-gui")
            });
        println!(
            "\nGUI_FIXTURE:{}",
            serde_json::json!({
                "argv": std::env::args_os().map(|arg| arg.as_bytes().to_vec()).collect::<Vec<_>>(),
                "environment": environment, "cwd": std::env::current_dir().unwrap().as_os_str().as_bytes(),
                "parent": unsafe { libc::getppid() }, "input": input, "imageFdLeaked": image_fd_leaked,
                "canonicalExecutablePath": std::env::current_exe().and_then(|path| path.canonicalize()).is_ok(),
            })
        );
        eprintln!("GUI_FIXTURE_STDERR");
        std::process::exit(23);
    }

    #[test]
    fn approved_buffer_seals_and_refusal() {
        let bytes = b"\x7fELF\x02not-an-executable";
        let image = prepare(bytes, &crate::digest(bytes)).unwrap();
        require_seals(&image.0).unwrap();
        let fd = image.0.as_raw_fd();
        assert_ne!(
            unsafe { libc::fcntl(fd, libc::F_GETFD) } & libc::FD_CLOEXEC,
            0
        );
        assert_eq!(unsafe { libc::pwrite(fd, b"x".as_ptr().cast(), 1, 0) }, -1);
        assert_eq!(unsafe { libc::ftruncate(fd, 0) }, -1);
        assert_eq!(unsafe { libc::ftruncate(fd, 1000) }, -1);
        assert_eq!(
            unsafe {
                libc::mmap(
                    std::ptr::null_mut(),
                    4096,
                    libc::PROT_WRITE,
                    libc::MAP_SHARED,
                    fd,
                    0,
                )
            },
            libc::MAP_FAILED
        );
        assert!(prepare(bytes, &"0".repeat(64)).is_err());
        assert!(prepare(bytes, "").is_err());
        assert!(prepare(b"#!/bin/sh", &crate::digest(b"#!/bin/sh")).is_err());
        let argv = fixture_argv("must not execute a pathname".into());
        assert!(spawn(&image, &argv, &[], Path::new("/")).is_err());
    }

    #[test]
    fn unsealed_and_partial_seals_refuse_before_exec() {
        let fd = unsafe {
            libc::memfd_create(
                c"unsealed-fixture".as_ptr(),
                libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
            )
        };
        assert!(fd >= 0);
        let image = PreparedExecutable(unsafe { File::from_raw_fd(fd) });
        let argv = fixture_argv("unsealed".into());
        for seal in [0, libc::F_SEAL_GROW] {
            assert_eq!(unsafe { libc::fcntl(fd, libc::F_ADD_SEALS, seal) }, 0);
            assert_eq!(
                spawn(&image, &argv, &[], Path::new("/"))
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::PermissionDenied
            );
        }
        let image = PreparedExecutable(tempfile::tempfile().unwrap());
        assert_eq!(
            spawn(&image, &argv, &[], Path::new("/"))
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
    }

    #[test]
    fn foreign_path_replacement_and_in_place_mutation_cannot_change_exec() {
        let bytes = std::fs::read(std::env::current_exe().unwrap()).unwrap();
        let foreign = std::fs::read("/bin/false").unwrap();
        assert_ne!(crate::digest(&bytes), crate::digest(&foreign));
        for replace in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let cwd = temp.path().canonicalize().unwrap();
            let path = cwd.join("approved original path");
            std::fs::write(&path, &bytes).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            let original_inode = std::fs::metadata(&path).unwrap().ino();
            let image = prepare(&std::fs::read(&path).unwrap(), &crate::digest(&bytes)).unwrap();
            if replace {
                let replacement = cwd.join("foreign");
                std::fs::write(&replacement, &foreign).unwrap();
                std::fs::set_permissions(&replacement, std::fs::Permissions::from_mode(0o700))
                    .unwrap();
                std::fs::rename(replacement, &path).unwrap();
            } else {
                std::fs::write(&path, &foreign).unwrap();
            }
            assert_eq!(std::fs::read(&path).unwrap(), foreign);
            assert_eq!(
                std::fs::metadata(&path).unwrap().ino() == original_inode,
                !replace
            );
            assert_eq!(
                Command::new(&path).env_clear().status().unwrap().code(),
                Some(1)
            );
            let argv = fixture_argv(path.into_os_string());
            let environment = fixture_environment();
            finish(
                spawn(&image, &argv, &environment, &cwd).unwrap(),
                b"private stdin\0exact\n",
                &argv,
                &environment,
                &cwd,
            );
        }
    }

    #[test]
    fn multithread_parent_exact_streams_eof_and_wait() {
        let bytes = std::fs::read(std::env::current_exe().unwrap()).unwrap();
        let image = Arc::new(prepare(&bytes, &crate::digest(&bytes)).unwrap());
        let active = Arc::new(AtomicBool::new(true));
        let allocate = Arc::clone(&active);
        let allocator = std::thread::spawn(move || {
            while allocate.load(Ordering::Acquire) {
                std::hint::black_box(vec![String::from("allocator active during fork"); 1024]);
                std::thread::yield_now();
            }
        });
        let workers: Vec<_> = (0..4)
            .map(|worker| {
                let image = Arc::clone(&image);
                std::thread::spawn(move || {
                    let temp = tempfile::tempdir().unwrap();
                    let cwd = temp.path().canonicalize().unwrap();
                    let argv = fixture_argv(format!("exact argv zero {worker}").into());
                    let environment = fixture_environment();
                    for _ in 0..4 {
                        finish(
                            spawn(&image, &argv, &environment, &cwd).unwrap(),
                            b"EOF drained",
                            &argv,
                            &environment,
                            &cwd,
                        );
                    }
                })
            })
            .collect();
        let results: Vec<_> = workers.into_iter().map(|worker| worker.join()).collect();
        active.store(false, Ordering::Release);
        allocator.join().unwrap();
        for result in results {
            result.unwrap();
        }
    }
}
