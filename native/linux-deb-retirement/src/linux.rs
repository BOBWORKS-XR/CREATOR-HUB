use crate::{
    archive, compatibility_listing, compatibility_state, control, copy_pinned, installed_metadata,
    listing, md5sums, owner, paths, pins, require, retained, sha256, stage_name, state, Action,
    ManualRepair, Result, INSTALL_REFUSAL,
};
use serde_json::json;
use std::{
    ffi::CString,
    fs::{self, DirBuilder, File, Metadata, OpenOptions},
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{
            ffi::OsStrExt,
            fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        },
    },
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const DPKG: &str = "/usr/bin/dpkg";
const QUERY: &str = "/usr/bin/dpkg-query";
const DEB: &str = "/usr/bin/dpkg-deb";
const INFO: &str = "/var/lib/dpkg/info";
const LIMIT: u64 = 128 * 1024;
const ATTEMPT: &str = "transaction-attempted";
const METADATA_FORMAT: &str = "--showformat=${Installed-Size}\n${Maintainer}\n${Priority}\n${Depends}\n${Description}\n${Conffiles}${Triggers-Pending}${Triggers-Awaited}${Multi-Arch}${Pre-Depends}${Breaks}${Conflicts}${Replaces}${Provides}";
mod handoff;
mod metadata;
mod setup;
use crate::metadata::Target;
use handoff::PackageLocks;
#[cfg(feature = "experimental-transaction")]
mod transaction;

fn protected(meta: &Metadata, directory: bool) -> Result<()> {
    require(
        meta.uid() == 0
            && meta.gid() == 0
            && meta.mode() & 0o7022 == 0
            && if directory {
                meta.is_dir()
            } else {
                meta.is_file() && meta.nlink() == 1
            },
        "Root:root, non-writable-by-others, ordinary single-link namespace required",
    )
}

// Walk with directory FDs: no symlink following, including any parent component.
fn open(path: &Path, flags: i32) -> Result<File> {
    require(path.is_absolute(), "Only compiled absolute paths allowed")?;
    let root = CString::new("/")?;
    let fd = unsafe {
        libc::open(
            root.as_ptr(),
            libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    require(fd >= 0, "Cannot open filesystem root")?;
    let mut dir = unsafe { File::from_raw_fd(fd) };
    protected(&dir.metadata()?, true)?;
    let parts = path.components().skip(1).collect::<Vec<_>>();
    if parts.is_empty()
        && path.as_os_str().as_bytes() == b"/"
        && flags == (libc::O_PATH | libc::O_DIRECTORY)
    {
        return Ok(dir);
    }
    require(!parts.is_empty(), "File path required")?;
    for (index, component) in parts.iter().enumerate() {
        let Component::Normal(part) = component else {
            return Err("Noncanonical fixed path".into());
        };
        let last = index == parts.len() - 1;
        let name = CString::new(part.as_bytes())?;
        let access = if last {
            flags
        } else {
            libc::O_PATH | libc::O_DIRECTORY
        };
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                name.as_ptr(),
                access | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            return Err(format!(
                "Cannot open protected path {}: {}",
                path.display(),
                std::io::Error::last_os_error()
            )
            .into());
        }
        let next = unsafe { File::from_raw_fd(fd) };
        protected(&next.metadata()?, !last || flags & libc::O_DIRECTORY != 0)?;
        dir = next;
    }
    Ok(dir)
}

fn directory(path: &Path) -> Result<File> {
    open(path, libc::O_PATH | libc::O_DIRECTORY)
}

fn stamp(m: &Metadata) -> (u64, u64, u64, u32, u32, u32, u64, i64, i64, i64, i64) {
    (
        m.dev(),
        m.ino(),
        m.len(),
        m.mode(),
        m.uid(),
        m.gid(),
        m.nlink(),
        m.mtime(),
        m.mtime_nsec(),
        m.ctime(),
        m.ctime_nsec(),
    )
}

fn resource(pin: &pins::Pin, output: impl Write) -> Result<()> {
    let file = open(&Path::new("/").join(pin.path), libc::O_RDONLY)?;
    let before = file.metadata()?;
    require(
        before.mode() & 0o7777 == pin.mode && before.len() == pin.bytes,
        "Installed resource mode/size changed",
    )?;
    copy_pinned(&file, output, pin)?;
    require(
        stamp(&before) == stamp(&file.metadata()?),
        "Resource changed while reading",
    )
}

fn bounded(mut reader: impl Read, limit: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.by_ref().take(limit + 1).read_to_end(&mut bytes)?;
    require(bytes.len() as u64 <= limit, "Output/read limit exceeded")?;
    Ok(bytes)
}

fn read(path: &str) -> Result<Vec<u8>> {
    let file = open(Path::new(path), libc::O_RDONLY)?;
    let before = file.metadata()?;
    let bytes = bounded(&file, 4 * 1024 * 1024)?;
    require(
        stamp(&before) == stamp(&file.metadata()?),
        "Metadata changed while reading",
    )?;
    Ok(bytes)
}

fn command(tool: &str, private_tmp: Option<&Path>) -> Result<Command> {
    let image = open(Path::new(tool), libc::O_RDONLY)?;
    require(
        image.metadata()?.mode() & 0o111 != 0,
        "System tool is not executable",
    )?;
    let mut cmd = Command::new(tool);
    cmd.env_clear()
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("LC_ALL", "C")
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .env("DPKG_COLORS", "never")
        .env("DPKG_PAGER", "/bin/cat");
    if let Some(tmp) = private_tmp {
        cmd.env("TMPDIR", tmp).env("SOURCE_DATE_EPOCH", "0");
    }
    Ok(cmd)
}

fn parsed<T: Send + 'static>(
    cmd: Command,
    parse: impl FnOnce(std::process::ChildStdout) -> Result<T> + Send + 'static,
) -> Result<T> {
    let (status, result, stderr) = parsed_outcome(cmd, parse)?;
    require(
        status.success() && stderr.is_empty(),
        "System tool failed or emitted diagnostics",
    )?;
    Ok(result)
}

fn parsed_outcome<T: Send + 'static>(
    mut cmd: Command,
    parse: impl FnOnce(std::process::ChildStdout) -> Result<T> + Send + 'static,
) -> Result<(std::process::ExitStatus, T, Vec<u8>)> {
    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take().ok_or("Missing stdout pipe")?;
    let stderr = child.stderr.take().ok_or("Missing stderr pipe")?;
    let reader = thread::spawn(move || parse(stdout));
    let errors = thread::spawn(move || bounded(stderr, LIMIT));
    let deadline = Instant::now() + Duration::from_secs(180);
    let status: Result<std::process::ExitStatus> = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            other => {
                let _ = child.kill();
                let _ = child.wait();
                break match other {
                    Err(e) => Err(e.into()),
                    _ => Err("System tool timed out (child reaped)".into()),
                };
            }
        }
    };
    let result = reader.join().map_err(|_| "Parser thread failed")?;
    let stderr = errors.join().map_err(|_| "Stderr thread failed")??;
    Ok((status?, result?, stderr))
}

fn capture_outcome(
    tool: &str,
    args: &[&str],
) -> Result<(std::process::ExitStatus, Vec<u8>, Vec<u8>)> {
    let mut cmd = command(tool, None)?;
    cmd.args(args);
    parsed_outcome(cmd, |out| bounded(out, LIMIT))
}

fn capture(tool: &str, args: &[&str]) -> Result<Vec<u8>> {
    let mut cmd = command(tool, None)?;
    cmd.args(args);
    parsed(cmd, |out| bounded(out, LIMIT))
}

fn lock(file: &File) -> Result<()> {
    let mut region: libc::flock = unsafe { std::mem::zeroed() };
    region.l_type = libc::F_WRLCK as _;
    region.l_whence = libc::SEEK_SET as _;
    // l_start=0, l_len=0 is the entire file. Never unlink/create/truncate locks.
    let result = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETLK, &region) };
    if result < 0 {
        return Err(format!(
            "Package manager busy/lock unavailable: {}",
            std::io::Error::last_os_error()
        )
        .into());
    }
    Ok(())
}

fn locks() -> Result<PackageLocks> {
    let frontend = open(Path::new("/var/lib/dpkg/lock-frontend"), libc::O_RDWR)?;
    let database = open(Path::new("/var/lib/dpkg/lock"), libc::O_RDWR)?;
    PackageLocks::acquire(frontend, database)
}

fn baseline() -> Result<()> {
    installed(false)
}

fn installed(compatibility: bool) -> Result<()> {
    let status = capture(
        QUERY,
        &[
            "--show",
            "--showformat=${Package}\t${Version}\t${Architecture}\t${Status}\n",
            pins::PACKAGE,
        ],
    )?;
    if compatibility {
        compatibility_state(&status)?;
    } else {
        state(&status)?;
    }
    let metadata = capture(QUERY, &["--show", METADATA_FORMAT, pins::PACKAGE])?;
    installed_metadata(&metadata, compatibility)?;
    let check_list = if compatibility {
        compatibility_listing
    } else {
        listing
    };
    check_list(&capture(QUERY, &["--listfiles", pins::PACKAGE])?)?;
    require(
        capture(DPKG, &["--audit"])?.is_empty(),
        "Unhealthy/pending package database",
    )?;
    require(
        capture(DPKG, &["--verify", pins::PACKAGE])?.is_empty(),
        "Installed package verification differs",
    )?;
    require(
        capture(DPKG, &["--compare-versions", pins::NEW, "gt", pins::OLD])?.is_empty(),
        "Version order refused",
    )?;
    directory(Path::new(INFO))?;
    let mut members = std::collections::BTreeSet::new();
    for entry in fs::read_dir(INFO)? {
        let name = entry?
            .file_name()
            .into_string()
            .map_err(|_| "Non-UTF8 dpkg info member")?;
        if name.starts_with("creator-works-mcp.") || name.starts_with("creator-works-mcp:") {
            members.insert(name);
        }
    }
    require(
        members
            == [
                "creator-works-mcp.list".into(),
                "creator-works-mcp.md5sums".into(),
            ]
            .into(),
        "Unexpected control/script/metadata members",
    )?;
    check_list(&read("/var/lib/dpkg/info/creator-works-mcp.list")?)?;
    require(
        sha256(&read("/var/lib/dpkg/info/creator-works-mcp.md5sums")?)
            == if compatibility {
                sha256(md5sums().as_bytes())
            } else {
                pins::MD5_SHA256.into()
            },
        "Original installed md5sums pin changed",
    )?;
    let selected = if compatibility {
        retained()
    } else {
        pins::FILES.to_vec()
    };
    for name in paths(&selected, true).difference(&paths(&selected, false)) {
        let dir = directory(&Path::new("/").join(name))?;
        require(
            dir.metadata()?.mode() & 0o7777 == 0o755,
            "Installed package directory mode changed",
        )?;
    }
    directory(Path::new("/var/lib/dpkg/updates"))?;
    require(
        fs::read_dir("/var/lib/dpkg/updates")?.next().is_none(),
        "Pending dpkg updates refused",
    )?;
    metadata::Snapshot::capture()?;
    for pin in &selected {
        owner(
            &capture(QUERY, &["--search", &format!("/{}", pin.path)])?,
            pin,
        )?;
        resource(pin, std::io::sink())?;
    }
    if compatibility {
        for pin in pins::FILES.iter().filter(|p| !p.retained) {
            let path = Path::new("/").join(pin.path);
            match fs::symlink_metadata(&path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                _ => {
                    return Err(format!(
                        "Retired path still present/unreadable: {}",
                        path.display()
                    )
                    .into())
                }
            }
            let mut cmd = command(QUERY, None)?;
            cmd.args(["--search", &format!("/{}", pin.path)]);
            // dpkg-query's C-locale no-match diagnostic is fixed and was captured in the prior native proof.
            let result = cmd.output()?;
            require(
                result.status.code() == Some(1)
                    && result.stdout.is_empty()
                    && result.stderr
                        == format!("dpkg-query: no path found matching pattern /{}\n", pin.path)
                            .as_bytes(),
                "Retired path still has package ownership, or ownership query failed",
            )?;
        }
    }
    // Extra unowned files in the private product tree are also a refusal.
    let root = Path::new("/usr/lib/Creator Works MCP");
    let expected = paths(&selected, true);
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        directory(&dir)?;
        for entry in fs::read_dir(&dir)? {
            let path = entry?.path();
            let relative = path
                .strip_prefix("/")?
                .to_str()
                .ok_or("Non-UTF8 product path")?;
            require(
                expected.contains(relative),
                "Extra product-tree file/directory",
            )?;
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.is_dir() {
                pending.push(path);
            } else {
                protected(&metadata, false)?;
            }
        }
    }
    Ok(())
}

fn create_directory(path: &Path, mode: u32) -> Result<()> {
    directory(path.parent().ok_or("Missing protected parent")?)?;
    DirBuilder::new().mode(mode).create(path)?;
    let file = directory(path)?;
    require(
        file.metadata()?.mode() & 0o7777 == mode,
        "Directory permissions differ",
    )?;
    open(
        path.parent().ok_or("Missing directory parent")?,
        libc::O_RDONLY | libc::O_DIRECTORY,
    )?
    .sync_all()?;
    Ok(())
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    directory(path.parent().ok_or("Missing protected parent")?)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o644)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    file.write_all(bytes)?;
    file.set_permissions(fs::Permissions::from_mode(0o644))?;
    file.sync_all()?;
    Ok(())
}

fn privileged_image() -> Result<()> {
    // Only this fixed installed executable may write the protected namespace.
    require(
        unsafe {
            libc::getuid() == 0
                && libc::geteuid() == 0
                && libc::getgid() == 0
                && libc::getegid() == 0
        },
        "Explicit preparation/transaction requires real/effective root:root",
    )?;
    require(
        std::env::current_exe()? == Path::new(pins::HELPER),
        "Helper must be installed at the fixed trusted libexec path",
    )?;
    let image = open(Path::new(pins::HELPER), libc::O_RDONLY)?;
    require(
        image.metadata()?.mode() & 0o7777 == 0o755,
        "Helper must be root:root 0755, not setuid",
    )?;
    Ok(())
}

fn refuse_prior_attempt() -> Result<()> {
    refuse_prior_attempt_for(Target::Mcp)
}

fn refuse_prior_attempt_for(target: Target) -> Result<()> {
    let private = Path::new(target.private());
    match fs::symlink_metadata(private) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
        Ok(_) => {
            directory(private)?;
        }
    }
    match fs::symlink_metadata(private.join(ATTEMPT)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
        Ok(_) => Err(Box::new(ManualRepair {
            reason: "An earlier transaction attempt is recorded; no automatic retry or rollback"
                .into(),
            started: None,
        })),
    }
}

fn new_stage_name() -> Result<String> {
    new_stage_name_for(Target::Mcp)
}

fn new_stage_name_for(target: Target) -> Result<String> {
    let mut random = [0u8; 16];
    let mut filled = 0;
    while filled < random.len() {
        let count = unsafe {
            libc::getrandom(
                random[filled..].as_mut_ptr().cast(),
                random.len() - filled,
                0,
            )
        };
        if count < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error.into());
        }
        require(count > 0, "Cannot generate fresh stage identity")?;
        filled += count as usize;
    }
    let prefix = match target {
        Target::Mcp => "mcp-2.7.7-preparation-",
        Target::Setup => "setup-0.3.7-preparation-",
    };
    Ok(format!(
        "{prefix}{}",
        random
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    ))
}

fn prepare() -> Result<PathBuf> {
    privileged_image()?;
    let held = locks()?;
    let Prepared {
        candidate,
        metadata: _metadata,
    } = prepare_locked(&held)?;
    Ok(candidate)
}

struct Prepared {
    candidate: PathBuf,
    metadata: metadata::Snapshot,
}

fn prepare_locked(_held: &PackageLocks) -> Result<Prepared> {
    refuse_prior_attempt()?;
    let metadata = metadata::Snapshot::capture()?;
    baseline()?;
    let private = Path::new(pins::PRIVATE);
    match fs::symlink_metadata(private) {
        Ok(_) => {
            let dir = directory(private)?;
            require(
                dir.metadata()?.mode() & 0o7777 == 0o700,
                "Private root must be 0700",
            )?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => create_directory(private, 0o700)?,
        Err(e) => return Err(e.into()),
    }
    let mut stages = 0;
    for entry in fs::read_dir(private)? {
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "Unknown private namespace member")?;
        require(
            stage_name(&name),
            "Unknown private namespace member; administrator review required",
        )?;
        let dir = directory(&entry.path())?;
        require(
            dir.metadata()?.mode() & 0o7777 == 0o700,
            "Prior stage must remain root-private",
        )?;
        stages += 1;
    }
    require(
        stages < 4,
        "Private stage limit reached; administrator space review required",
    )?;
    // Old/expired preparations are never selected, overwritten or reused as authority.
    let work = private.join(new_stage_name()?);
    create_directory(&work, 0o700)?;
    let tree = work.join("tree");
    create_directory(&tree, 0o755)?;
    let retained = retained();
    let files = paths(&retained, false);
    for name in paths(&retained, true).difference(&files) {
        create_directory(&tree.join(name), 0o755)?;
    }
    for pin in &retained {
        let target = tree.join(pin.path);
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(pin.mode)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&target)?;
        resource(pin, &file)?;
        file.set_permissions(fs::Permissions::from_mode(pin.mode))?;
        file.sync_all()?;
    }
    create_directory(&tree.join("DEBIAN"), 0o755)?;
    write_new(&tree.join("DEBIAN/control"), control().as_bytes())?;
    write_new(&tree.join("DEBIAN/md5sums"), md5sums().as_bytes())?;
    let candidate = work.join("runtime-only.deb");
    let mut cmd = command(DEB, Some(&work))?;
    cmd.args(["--root-owner-group", "-Zgzip", "-z1", "--build"])
        .arg(&tree)
        .arg(&candidate);
    parsed(cmd, |out| bounded(out, LIMIT))?;
    verify_candidate(&candidate)?;
    baseline()?;
    metadata.unchanged()?;
    Ok(Prepared {
        candidate,
        metadata,
    })
}

fn verify_candidate(candidate: &Path) -> Result<()> {
    let work = candidate
        .parent()
        .ok_or("Missing private candidate parent")?;
    let retained = retained();
    let before = open(candidate, libc::O_RDONLY)?.metadata()?;
    let mut cmd = command(DEB, Some(work))?;
    cmd.arg("--ctrl-tarfile").arg(candidate);
    parsed(cmd, |out| {
        archive::verify_controls(out.take(LIMIT), control().as_bytes(), md5sums().as_bytes())
    })?;
    let mut cmd = command(DEB, Some(work))?;
    cmd.arg("--fsys-tarfile").arg(candidate);
    parsed(cmd, move |out| {
        archive::verify_data(out.take(260 * 1024 * 1024), &retained)
    })?;
    require(
        stamp(&before) == stamp(&open(candidate, libc::O_RDONLY)?.metadata()?),
        "Candidate changed during verification",
    )?;
    open(candidate, libc::O_RDONLY)?.sync_all()?;
    open(work, libc::O_RDONLY | libc::O_DIRECTORY)?.sync_all()?;
    Ok(())
}

pub fn run(action: Action) -> Result<serde_json::Value> {
    require(
        std::env::consts::ARCH == "x86_64",
        "Native Linux x86_64 only",
    )?;
    match action {
        Action::InspectSetup => setup::inspect(false),
        Action::InspectRetainedSetup => setup::inspect(true),
        Action::RetireSetup => {
            #[cfg(feature = "experimental-transaction")]
            {
                transaction::retire_setup()
            }
            #[cfg(not(feature = "experimental-transaction"))]
            {
                Err(INSTALL_REFUSAL.into())
            }
        }
        Action::InspectRetainedMcp => {
            // Re-read the fixed installed state; a retained retry marker is not
            // authority for success and must not block this read-only check.
            installed(true)?;
            Ok(crate::retained_inspection_report())
        }
        Action::Inspect => {
            refuse_prior_attempt()?;
            baseline()?;
            Ok(
                json!({ "status": "inspected-read-only", "baselineMatches": true, "snapshotAuthoritative": false,
                "installationEnabled": false, "packageTransactionStarted": false,
                "experimentalTransactionCompiled": cfg!(feature = "experimental-transaction"), "nativeAcceptance": false,
                "blocker": INSTALL_REFUSAL }),
            )
        }
        Action::Prepare => {
            let candidate = prepare()?;
            Ok(
                json!({ "status": "prepared-not-installed", "candidate": candidate, "installationEnabled": false,
                "packageTransactionStarted": false, "experimentalTransactionCompiled": cfg!(feature = "experimental-transaction"),
                "nativeAcceptance": false, "blocker": INSTALL_REFUSAL }),
            )
        }
        Action::Retire => {
            #[cfg(feature = "experimental-transaction")]
            {
                transaction::retire()
            }
            #[cfg(not(feature = "experimental-transaction"))]
            {
                Err(INSTALL_REFUSAL.into())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_root_directory_is_admitted_but_root_file_or_noncanonical_path_is_not() {
        let file = directory(Path::new("/")).unwrap();
        let opened = file.metadata().unwrap();
        let named = fs::symlink_metadata("/").unwrap();
        assert_eq!((opened.dev(), opened.ino()), (named.dev(), named.ino()));
        protected(&opened, true).unwrap();
        assert!(open(Path::new("/"), libc::O_RDONLY).is_err());
        assert!(open(Path::new("/"), libc::O_PATH).is_err());
        assert!(directory(Path::new("/./")).is_err());
    }

    #[test]
    fn fixed_tool_environment_has_no_user_specific_configuration_home() {
        // dpkg 1.21.1 options.c:194-199 loads HOME/.dpkg.cfg only if HOME is set.
        let cmd = command(DPKG, None).unwrap();
        let environment = cmd.get_envs().collect::<Vec<_>>();
        assert_eq!(environment.len(), 4);
        assert!(!environment.iter().any(|(key, _)| *key == "HOME"));
    }

    #[test]
    #[ignore = "Opt-in exact disposable container audit; reads no user settings or app payload"]
    fn disposable_read_only_audit_proves_root_home_warning_and_clean_fixed_environment() {
        assert_eq!(unsafe { libc::getuid() }, 1001);
        assert_eq!(unsafe { libc::geteuid() }, 1001);
        for (key, value) in [
            ("CREATOR_LINUX_DEB_HELPER_TRANSACTION", "1"),
            ("GITHUB_REPOSITORY", "BOBWORKS-XR/CREATOR-HUB"),
            (
                "GITHUB_REF",
                "refs/heads/validation/linux-deb-helper-transaction-014",
            ),
            ("GITHUB_ACTIONS", "true"),
        ] {
            assert_eq!(std::env::var(key).unwrap(), value);
        }
        assert!(Path::new("/.dockerenv").is_file());
        let mut previous = command(DPKG, None).unwrap();
        previous.env("HOME", "/root").arg("--audit");
        let (status, stdout, stderr) = parsed_outcome(previous, |out| bounded(out, LIMIT)).unwrap();
        eprintln!(
            "original read-only audit: exit={:?}, stdout={}, stderr={}",
            status.code(),
            stdout.len(),
            String::from_utf8_lossy(&stderr)
        );
        assert_eq!(status.code(), Some(0));
        assert!(stdout.is_empty());
        assert!(stderr.starts_with(b"dpkg: warning: failed to open configuration file '/root/.dpkg.cfg' for reading: Permission denied"));
        assert!(capture(DPKG, &["--audit"]).unwrap().is_empty());
    }
    #[test]
    fn posix_locks_conflict_across_processes_without_touching_system_locks() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        lock(temp.as_file()).unwrap();
        let status = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "linux::tests::lock_contender"])
            .env("CREATOR_TEST_LOCK", temp.path())
            .status()
            .unwrap();
        assert!(status.success());
    }
    #[test]
    fn lock_contender() {
        if let Some(path) = std::env::var_os("CREATOR_TEST_LOCK") {
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .open(path)
                .unwrap();
            assert!(lock(&file).is_err());
        }
    }
    #[test]
    fn non_root_and_redirected_namespace_refuse() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file");
        fs::write(&path, b"test").unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(open(&link, libc::O_RDONLY).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o666)).unwrap();
        assert!(protected(&fs::metadata(&path).unwrap(), false).is_err());
        #[cfg(not(feature = "experimental-transaction"))]
        assert!(run(Action::Retire).unwrap_err().to_string().contains("WIP"));
        #[cfg(feature = "experimental-transaction")]
        assert!(
            privileged_image().is_err(),
            "Fixture executable is never installed at the trusted path"
        );
    }

    #[test]
    fn rootless_synthetic_deb_roundtrip_is_not_an_installation() {
        assert_ne!(
            unsafe { libc::geteuid() },
            0,
            "Run native fixtures unprivileged"
        );
        let temp = tempfile::tempdir().unwrap();
        let tree = temp.path().join("tree");
        fs::create_dir_all(tree.join("DEBIAN")).unwrap();
        fs::create_dir_all(tree.join("usr")).unwrap();
        fs::write(tree.join("usr/test"), b"abc").unwrap();
        fs::write(tree.join("DEBIAN/control"), control()).unwrap();
        fs::write(tree.join("DEBIAN/md5sums"), md5sums()).unwrap();
        for path in [&tree, &tree.join("usr"), &tree.join("DEBIAN")] {
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        for name in ["usr/test", "DEBIAN/control", "DEBIAN/md5sums"] {
            fs::set_permissions(tree.join(name), fs::Permissions::from_mode(0o644)).unwrap();
        }
        let package = temp.path().join("fixture.deb");
        let mut cmd = command(DEB, Some(temp.path())).unwrap();
        cmd.args(["--root-owner-group", "-Zgzip", "-z1", "--build"])
            .arg(&tree)
            .arg(&package);
        parsed(cmd, |out| bounded(out, LIMIT)).unwrap();
        let mut cmd = command(DEB, Some(temp.path())).unwrap();
        cmd.arg("--ctrl-tarfile").arg(&package);
        parsed(cmd, |out| {
            archive::verify_controls(out, control().as_bytes(), md5sums().as_bytes())
        })
        .unwrap();
        let mut cmd = command(DEB, Some(temp.path())).unwrap();
        cmd.arg("--fsys-tarfile").arg(&package);
        parsed(cmd, |out| {
            archive::verify_data(
                out,
                &[pins::Pin {
                    path: "usr/test",
                    bytes: 3,
                    mode: 0o644,
                    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
                    md5: "unused",
                    retained: true,
                }],
            )
        })
        .unwrap();
    }
}
