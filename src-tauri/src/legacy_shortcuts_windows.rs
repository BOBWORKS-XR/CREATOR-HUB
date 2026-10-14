//! Read-only routing/byte snapshots, not installer provenance or removal approval.
//! The caller owns reviewed retirement, journaling and handle-based mutation.
use crate::{catalog::AppId, platform};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::SystemTime,
};

const MAX_LINK_BYTES: u64 = 64 * 1024;
const MAX_OUTPUT: usize = 16 * 1024;
const MAX_ERROR: usize = 4096;
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const LINK_HEADER: [u8; 20] = [
    0x4c, 0, 0, 0, 1, 0x14, 2, 0, 0, 0, 0, 0, 0xc0, 0, 0, 0, 0, 0, 0, 0x46,
];

// Only a native-derived literal path enters through the cleared child environment.
// CreateShortcut loads an existing .lnk; there is deliberately no Save or Resolve.
const READ_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$path = $env:CREATOR_HUB_SHORTCUT_READ_PATH
if (-not [IO.File]::Exists($path)) { throw 'Shortcut is absent' }
$shell = $null
$link = $null
try {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($path)
    $result = [ordered]@{
        target = [string]$link.TargetPath
        arguments = [string]$link.Arguments
        workingDirectory = [string]$link.WorkingDirectory
    }
    foreach ($value in $result.Values) {
        if ($value.Length -gt 4096) { throw 'Shortcut metadata exceeds bound' }
    }
    [Console]::Write(($result | ConvertTo-Json -Compress))
} finally {
    if ($null -ne $link) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) }
    if ($null -ne $shell) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
}
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum ShortcutState {
    Verified,
    Missing,
    Refused,
}

#[derive(Debug)]
pub(super) struct Shortcut {
    app: AppId,
    logical_id: &'static str,
    path: PathBuf,
    expected: Option<PathBuf>,
    pub(super) state: ShortcutState,
    pub(super) blocker: Option<String>,
    proof: Option<Proof>,
}

impl Shortcut {
    pub(super) fn logical_id(&self) -> &'static str {
        self.logical_id
    }

    pub(super) fn native_path(&self) -> &Path {
        &self.path
    }

    pub(super) fn bytes(&self) -> Option<&[u8]> {
        self.proof.as_ref().map(|proof| proof.bytes.as_slice())
    }

    pub(super) fn sha256(&self) -> Option<&str> {
        self.proof.as_ref().map(|proof| proof.sha256.as_str())
    }

    /// Re-derives the namespace and rechecks even a missing candidate. This is
    /// not a reservation for subsequent mutation: the caller must reserve its handle.
    pub(super) fn recheck(&self) -> Result<(), String> {
        let candidates = native_candidates(self.app)?;
        if !candidates
            .iter()
            .any(|(id, path)| *id == self.logical_id && *path == self.path)
        {
            return Err("Native shortcut namespace changed; preserve shortcuts.".into());
        }
        if self
            .expected
            .as_ref()
            .is_some_and(|expected| platform::default_exe(self.app).as_ref() != Ok(expected))
        {
            return Err("Native default executable changed; preserve shortcuts.".into());
        }
        self.recheck_file()
    }

    fn recheck_file(&self) -> Result<(), String> {
        match self.state {
            ShortcutState::Refused => Err(self.blocker.clone().unwrap_or_else(|| {
                "Shortcut inspection was refused; preserve the shortcut.".into()
            })),
            ShortcutState::Missing => match capture(&self.path)? {
                None => Ok(()),
                Some(_) => Err("A shortcut appeared after inspection; preserve it.".into()),
            },
            ShortcutState::Verified => {
                let (_, current) = capture(&self.path)?
                    .ok_or("A reviewed shortcut disappeared; refuse this retirement plan.")?;
                if self.proof.as_ref() != Some(&current) {
                    return Err("Shortcut bytes or identity changed; preserve it.".into());
                }
                Ok(())
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Identity {
    length: u64,
    created: Option<SystemTime>,
    modified: SystemTime,
    #[cfg(windows)]
    volume: u32,
    #[cfg(windows)]
    index: u64,
}

#[derive(Debug, PartialEq, Eq)]
struct Proof {
    identity: Identity,
    bytes: Vec<u8>,
    sha256: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Routing {
    target: String,
    arguments: String,
    working_directory: String,
}

fn reject_redirects(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Shortcut path is not native absolute; preserve it.".into());
    }
    #[cfg(windows)]
    ordinary_local_path(path)?;
    for ancestor in path.ancestors() {
        let metadata = match fs::symlink_metadata(ancestor) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("Shortcut ancestry is unreadable; preserve it.".into()),
        };
        let mut redirected = metadata.file_type().is_symlink();
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            redirected |= metadata.file_attributes() & 0x400 != 0;
        }
        if redirected || (ancestor != path && !metadata.is_dir()) {
            return Err("Shortcut path is redirected or ambiguous; preserve it.".into());
        }
    }
    Ok(())
}

#[cfg(windows)]
fn ordinary_local_path(path: &Path) -> Result<(), String> {
    let text = path.to_str().ok_or("Windows path is unrepresentable.")?;
    if text.len() < 3
        || !text.as_bytes()[0].is_ascii_alphabetic()
        || text.as_bytes()[1] != b':'
        || text.as_bytes()[2] != b'\\'
        || text[3..].split('\\').any(|part| {
            part.is_empty()
                || part == "."
                || part == ".."
                || part.ends_with(['.', ' '])
                || part
                    .chars()
                    .any(|c| c.is_control() || ":/\"<>|?*".contains(c))
        })
    {
        return Err("Windows path is not an ordinary exact local path; preserve it.".into());
    }
    Ok(())
}

fn identity(file: &File) -> Result<Identity, String> {
    let metadata = file
        .metadata()
        .map_err(|_| "Shortcut identity is unreadable.")?;
    if !metadata.is_file() || metadata.len() < 76 || metadata.len() > MAX_LINK_BYTES {
        return Err("Shortcut is not a bounded regular Shell Link; preserve it.".into());
    }
    #[cfg(windows)]
    let info = {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0
            || info.dwFileAttributes & 0x400 != 0
            || info.nNumberOfLinks != 1
        {
            return Err("Shortcut handle identity is ambiguous; preserve it.".into());
        }
        info
    };
    let created = metadata.created().ok();
    if cfg!(windows) && created.is_none() {
        return Err("Shortcut creation identity is unavailable; preserve it.".into());
    }
    Ok(Identity {
        length: metadata.len(),
        created,
        modified: metadata
            .modified()
            .map_err(|_| "Shortcut timestamp is unreadable.")?,
        #[cfg(windows)]
        volume: info.dwVolumeSerialNumber,
        #[cfg(windows)]
        index: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
    })
}

fn proof(file: &mut File) -> Result<Proof, String> {
    let before = identity(file)?;
    file.seek(SeekFrom::Start(0))
        .map_err(|_| "Cannot read shortcut bytes.")?;
    let mut bytes = Vec::new();
    (&mut *file)
        .take(MAX_LINK_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read shortcut bytes.")?;
    if before != identity(file)?
        || bytes.len() as u64 != before.length
        || !bytes.starts_with(&LINK_HEADER)
    {
        return Err("Shortcut bytes changed or Shell Link header is invalid; preserve it.".into());
    }
    Ok(Proof {
        identity: before,
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        bytes,
    })
}

// Denying write/delete sharing keeps the original file stable across the COM read.
fn capture(path: &Path) -> Result<Option<(File, Proof)>, String> {
    reject_redirects(path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1).custom_flags(0x00200000); // OPEN_REPARSE_POINT
    }
    let mut file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot reserve shortcut read-only; preserve it.".into()),
    };
    let snapshot = proof(&mut file)?;
    reject_redirects(path)?;
    Ok(Some((file, snapshot)))
}

fn routing_matches(routing: &Routing, expected: &Path) -> Result<(), String> {
    #[cfg(windows)]
    ordinary_local_path(expected)?;
    let expected = expected
        .to_str()
        .ok_or("Default executable path is unrepresentable.")?;
    let workdir = Path::new(expected)
        .parent()
        .and_then(Path::to_str)
        .ok_or("Default executable has no parent directory.")?;
    if !routing.target.eq_ignore_ascii_case(expected)
        || !routing.arguments.is_empty()
        || (!routing.working_directory.is_empty()
            && !routing.working_directory.eq_ignore_ascii_case(workdir))
    {
        return Err(
            "Shortcut has a foreign target, arguments or working directory; preserve it.".into(),
        );
    }
    Ok(())
}

fn parse_routing(output: &[u8], error: &[u8], successful: bool) -> Result<Routing, String> {
    if !successful || !error.is_empty() || output.len() > MAX_OUTPUT || error.len() > MAX_ERROR {
        return Err(
            "Read-only shortcut probe failed or exceeded its output bound; preserve it.".into(),
        );
    }
    let routing: Routing = serde_json::from_slice(output)
        .map_err(|_| "Shortcut probe returned invalid metadata; preserve it.")?;
    if [
        &routing.target,
        &routing.arguments,
        &routing.working_directory,
    ]
    .iter()
    .any(|value| value.len() > 4096 || value.chars().any(char::is_control))
    {
        return Err("Shortcut metadata is oversized or ambiguous; preserve it.".into());
    }
    Ok(routing)
}

fn inspect_candidate(
    app: AppId,
    id: &'static str,
    path: PathBuf,
    expected: &Path,
    read: impl FnOnce(&Path) -> Result<Routing, String>,
) -> Shortcut {
    let mut shortcut = Shortcut {
        app,
        logical_id: id,
        path,
        expected: Some(expected.to_path_buf()),
        state: ShortcutState::Refused,
        blocker: None,
        proof: None,
    };
    let checked = (|| {
        let Some((mut file, before)) = capture(&shortcut.path)? else {
            shortcut.state = ShortcutState::Missing;
            return Ok(());
        };
        let routing = read(&shortcut.path)?;
        routing_matches(&routing, expected)?;
        if before != proof(&mut file)? {
            return Err("Shortcut changed during metadata inspection; preserve it.".into());
        }
        let (_, after) = capture(&shortcut.path)?
            .ok_or("Shortcut disappeared during metadata inspection; preserve it.")?;
        if before != after {
            return Err(
                "Shortcut path identity changed during metadata inspection; preserve it.".into(),
            );
        }
        shortcut.proof = Some(before);
        shortcut.state = ShortcutState::Verified;
        Ok(())
    })();
    if let Err(error) = checked {
        shortcut.blocker = Some(error);
    }
    shortcut
}

// Both pinned configs omit startMenuFolder. CLI 2.9.6 / 2.11.4 installer.nsi
// CreateOrUpdateStartMenuShortcut then uses direct $SMPROGRAMS\${PRODUCTNAME}.lnk.
// Product-folder and renamed shortcuts are not proven defaults and are not scanned.
fn candidates(app: AppId, desktop: &Path, programs: &Path) -> Vec<(&'static str, PathBuf)> {
    let name = format!("{}.lnk", app.name());
    vec![
        ("desktop", desktop.join(&name)),
        ("start-menu", programs.join(name)),
    ]
}

pub(super) fn native_candidates(app: AppId) -> Result<Vec<(&'static str, PathBuf)>, String> {
    #[cfg(windows)]
    {
        let desktop = native::folder(0x10)?; // current-user DesktopDirectory
        let programs = native::folder(0x02)?; // current-user Programs, not common Programs
                                              // Redirected/custom shell namespaces are outside this exact-default adapter.
        let home = native::folder(0x28)?;
        let roaming = native::folder(0x1a)?;
        if desktop != home.join("Desktop")
            || programs != roaming.join("Microsoft/Windows/Start Menu/Programs")
        {
            return Err("Desktop or Programs is redirected/custom; preserve all shortcuts.".into());
        }
        reject_redirects(&desktop)?;
        reject_redirects(&programs)?;
        Ok(candidates(app, &desktop, &programs))
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("Legacy shortcut inspection supports Windows only.".into())
    }
}

pub(super) fn inspect(app: AppId) -> Vec<Shortcut> {
    let paths = match native_candidates(app) {
        Ok(paths) => paths,
        Err(error) => {
            return vec![Shortcut {
                app,
                logical_id: "namespace",
                path: PathBuf::new(),
                expected: None,
                state: ShortcutState::Refused,
                blocker: Some(error),
                proof: None,
            }]
        }
    };
    let expected = platform::default_exe(app);
    paths
        .into_iter()
        .map(|(id, path)| match &expected {
            Ok(expected) => inspect_candidate(app, id, path, expected, native_read),
            Err(error) => Shortcut {
                app,
                logical_id: id,
                path,
                expected: None,
                state: ShortcutState::Refused,
                blocker: Some(error.clone()),
                proof: None,
            },
        })
        .collect()
}

fn native_read(path: &Path) -> Result<Routing, String> {
    #[cfg(windows)]
    {
        native::read(path)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("Native shortcut metadata requires Windows.".into())
    }
}

/// Internal resume probe only. Matching routing does not authenticate an archive;
/// the caller must independently bind its before-image, path and reserved handle.
pub(super) fn verify_archived_routing(app: AppId, path: &Path) -> Result<(), String> {
    archived_routing_with(app, path, &platform::default_exe(app)?, native_read)
}

fn archived_routing_with(
    app: AppId,
    path: &Path,
    expected: &Path,
    read: impl FnOnce(&Path) -> Result<Routing, String>,
) -> Result<(), String> {
    if !path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("lnk"))
    {
        return Err(
            "Read-only COM archive inspection requires a .lnk filename; preserve it.".into(),
        );
    }
    let snapshot = inspect_candidate(app, "archive", path.to_path_buf(), expected, read);
    match snapshot.state {
        ShortcutState::Verified => Ok(()),
        ShortcutState::Missing => Err("Archived shortcut is missing; refuse resume.".into()),
        ShortcutState::Refused => Err(snapshot
            .blocker
            .unwrap_or_else(|| "Archived shortcut routing is unverified; preserve it.".into())),
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use base64::Engine;
    use std::{
        ffi::{c_void, OsString},
        os::windows::{ffi::OsStringExt, io::AsRawHandle},
        process::{Command, Stdio},
        time::Instant,
    };

    #[link(name = "shell32")]
    extern "system" {
        fn SHGetFolderPathW(
            window: *mut c_void,
            folder: i32,
            token: *mut c_void,
            flags: u32,
            path: *mut u16,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemDirectoryW(path: *mut u16, size: u32) -> u32;
        fn GetWindowsDirectoryW(path: *mut u16, size: u32) -> u32;
        fn PeekNamedPipe(
            pipe: *mut c_void,
            buffer: *mut c_void,
            size: u32,
            read: *mut u32,
            available: *mut u32,
            left: *mut u32,
        ) -> i32;
    }

    pub(super) fn folder(id: i32) -> Result<PathBuf, String> {
        let mut buffer = [0u16; 260];
        // DONT_VERIFY never creates a missing shell directory; flags=0 is current path.
        let status = unsafe {
            SHGetFolderPathW(
                std::ptr::null_mut(),
                id | 0x4000,
                std::ptr::null_mut(),
                0,
                buffer.as_mut_ptr(),
            )
        };
        if status < 0 {
            return Err("Native current-user shortcut folder is unavailable.".into());
        }
        native_path(&buffer)
    }

    fn native_path(buffer: &[u16]) -> Result<PathBuf, String> {
        let end = buffer
            .iter()
            .position(|value| *value == 0)
            .ok_or("Native Windows path is truncated.")?;
        let path = PathBuf::from(OsString::from_wide(&buffer[..end]));
        ordinary_local_path(&path)?;
        Ok(path)
    }

    fn system_path(windows: bool) -> Result<PathBuf, String> {
        let mut buffer = [0u16; 32768];
        let length = unsafe {
            if windows {
                GetWindowsDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32)
            } else {
                GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32)
            }
        };
        if length == 0 || length as usize >= buffer.len() {
            return Err("Native Windows system directory is unavailable.".into());
        }
        native_path(&buffer)
    }

    fn command(path: &Path) -> Result<Command, String> {
        let system = system_path(false)?;
        let windows = system_path(true)?;
        let home = folder(0x28)?;
        let local = folder(0x1c)?;
        let roaming = folder(0x1a)?;
        let command = command_with_folders(path, &system, &windows, &home, &local, &roaming)?;
        reject_redirects(Path::new(command.get_program()))?;
        Ok(command)
    }

    // Pure construction lets fixtures check exact OS spellings without inspection/spawn.
    pub(super) fn command_with_folders(
        path: &Path,
        system: &Path,
        windows: &Path,
        home: &Path,
        local: &Path,
        roaming: &Path,
    ) -> Result<Command, String> {
        let powershell = system.join("WindowsPowerShell").join("v1.0");
        let executable = powershell.join("powershell.exe");
        let mut command = platform::command(&executable);
        command
            .env_clear()
            .current_dir(system)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("SystemRoot", windows)
            .env("windir", windows)
            .env("ComSpec", system.join("cmd.exe"))
            .env("USERPROFILE", home)
            .env("APPDATA", roaming)
            .env("LOCALAPPDATA", local)
            .env("TEMP", local.join("Temp"))
            .env("TMP", local.join("Temp"))
            .env(
                "PATH",
                std::env::join_paths([
                    system.to_path_buf(),
                    windows.to_path_buf(),
                    powershell.clone(),
                ])
                .map_err(|_| "Cannot sanitize system PATH.")?,
            )
            .env("PSModulePath", powershell.join("Modules"))
            .env("CREATOR_HUB_SHORTCUT_READ_PATH", path);
        let utf16: Vec<_> = READ_SCRIPT
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        command
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
            ])
            .arg(base64::engine::general_purpose::STANDARD.encode(utf16));
        Ok(command)
    }

    // Peek before reading: no blocking drain or reader thread can outlive the deadline.
    fn drain(
        pipe: &mut (impl Read + AsRawHandle),
        output: &mut Vec<u8>,
        limit: usize,
    ) -> Result<bool, String> {
        let mut available = 0;
        let ok = unsafe {
            PeekNamedPipe(
                pipe.as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return if std::io::Error::last_os_error().raw_os_error() == Some(109) {
                Ok(true) // ERROR_BROKEN_PIPE: fully drained
            } else {
                Err("Cannot read bounded shortcut probe output.".into())
            };
        }
        if available > 0 {
            let mut buffer = [0; 4096];
            let count = pipe
                .read(&mut buffer[..(available as usize).min(4096)])
                .map_err(|_| "Cannot read shortcut probe output.")?;
            if count > limit.saturating_sub(output.len()) {
                return Err("Shortcut probe output bound exceeded; preserve it.".into());
            }
            output.extend_from_slice(&buffer[..count]);
        }
        Ok(false)
    }

    pub(super) fn read(path: &Path) -> Result<Routing, String> {
        let mut child = command(path)?
            .spawn()
            .map_err(|_| "Cannot start read-only shortcut probe.")?;
        let deadline = Instant::now() + PROBE_TIMEOUT;
        let mut output = Vec::new();
        let mut error = Vec::new();
        let result = (|| {
            let mut stdout = child.stdout.take().ok_or("Shortcut probe has no stdout.")?;
            let mut stderr = child.stderr.take().ok_or("Shortcut probe has no stderr.")?;
            loop {
                if Instant::now() >= deadline {
                    return Err("Read-only shortcut probe timed out; preserve it.".into());
                }
                let out_done = drain(&mut stdout, &mut output, MAX_OUTPUT)?;
                let err_done = drain(&mut stderr, &mut error, MAX_ERROR)?;
                let exit = child
                    .try_wait()
                    .map_err(|_| "Cannot wait for shortcut probe.")?;
                if let Some(exit) = exit.filter(|_| out_done && err_done) {
                    return parse_routing(&output, &error, exit.success());
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        })();
        if let Err(original) = &result {
            // Terminate only this owned metadata probe, never a product or user process.
            if !matches!(child.try_wait(), Ok(Some(_))) {
                child.kill().map_err(|_| {
                    format!(
                        "{original} Owned metadata probe PID {} cleanup failed.",
                        child.id()
                    )
                })?;
                let cleanup_deadline = Instant::now() + std::time::Duration::from_secs(2);
                loop {
                    match child.try_wait() {
                        Ok(Some(_)) => break,
                        Ok(None) if Instant::now() < cleanup_deadline => {
                            std::thread::sleep(std::time::Duration::from_millis(10))
                        }
                        _ => {
                            return Err(format!(
                                "{original} Owned metadata probe PID {} exit is unverified.",
                                child.id()
                            ))
                        }
                    }
                }
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("known.lnk");
        let expected = directory.path().join("default.exe");
        let mut bytes = vec![0; 80];
        bytes[..LINK_HEADER.len()].copy_from_slice(&LINK_HEADER);
        fs::write(&path, bytes).unwrap();
        (directory, path, expected)
    }

    fn route(expected: &Path) -> Routing {
        Routing {
            target: expected.to_str().unwrap().into(),
            arguments: String::new(),
            working_directory: expected.parent().unwrap().to_str().unwrap().into(),
        }
    }

    #[test]
    fn candidates_are_only_the_two_source_proven_literal_names() {
        for app in [AppId::Mcp, AppId::Setup] {
            let paths = candidates(app, Path::new("Desktop"), Path::new("Programs"));
            assert_eq!(
                paths,
                vec![
                    (
                        "desktop",
                        PathBuf::from("Desktop").join(format!("{}.lnk", app.name()))
                    ),
                    (
                        "start-menu",
                        PathBuf::from("Programs").join(format!("{}.lnk", app.name()))
                    ),
                ]
            );
        }
    }

    #[test]
    fn capture_preserves_exact_bytes_hash_and_routing_without_com() {
        let (_directory, path, expected) = fixture();
        let before = fs::read(&path).unwrap();
        let shortcut = inspect_candidate(AppId::Mcp, "desktop", path.clone(), &expected, |_| {
            Ok(route(&expected))
        });
        assert_eq!(shortcut.state, ShortcutState::Verified);
        assert_eq!(shortcut.logical_id(), "desktop");
        assert_eq!(shortcut.native_path(), path);
        assert_eq!(shortcut.bytes(), Some(before.as_slice()));
        assert_eq!(
            shortcut.sha256(),
            Some(format!("{:x}", Sha256::digest(&before)).as_str())
        );
        assert!(shortcut.recheck_file().is_ok());
        assert_eq!(fs::read(path).unwrap(), before);
    }

    #[test]
    fn missing_is_reported_without_probe_and_appearance_refuses() {
        let (_directory, path, expected) = fixture();
        let bytes = fs::read(&path).unwrap();
        fs::remove_file(&path).unwrap();
        let shortcut = inspect_candidate(AppId::Mcp, "desktop", path.clone(), &expected, |_| {
            panic!("Missing file must never reach COM")
        });
        assert_eq!(shortcut.state, ShortcutState::Missing);
        assert_eq!(shortcut.bytes(), None);
        assert_eq!(shortcut.sha256(), None);
        assert!(shortcut.recheck_file().is_ok());
        fs::write(&path, bytes).unwrap();
        assert!(shortcut.recheck_file().unwrap_err().contains("appeared"));
    }

    #[test]
    fn changed_bytes_and_disappearance_refuse_after_inspection() {
        let (_directory, path, expected) = fixture();
        let shortcut =
            inspect_candidate(AppId::Setup, "start-menu", path.clone(), &expected, |_| {
                Ok(route(&expected))
            });
        let mut bytes = fs::read(&path).unwrap();
        bytes[79] = 1;
        fs::write(&path, &bytes).unwrap();
        assert!(shortcut.recheck_file().is_err());
        fs::remove_file(&path).unwrap();
        assert!(shortcut.recheck_file().is_err());
    }

    #[test]
    fn foreign_target_arguments_and_custom_workdir_preserve_bytes() {
        let (_directory, path, expected) = fixture();
        let bytes = fs::read(&path).unwrap();
        for variant in 0..3 {
            let mut routing = route(&expected);
            match variant {
                0 => routing.target = "custom.exe".into(),
                1 => routing.arguments = " ".into(),
                _ => routing.working_directory = "custom".into(),
            }
            let shortcut =
                inspect_candidate(AppId::Mcp, "desktop", path.clone(), &expected, |_| {
                    Ok(routing)
                });
            assert_eq!(shortcut.state, ShortcutState::Refused);
            assert!(shortcut.blocker.is_some());
            assert!(shortcut.recheck_file().is_err());
            assert_eq!(shortcut.bytes(), None);
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
    }

    #[test]
    fn empty_workdir_is_not_custom_but_target_aliases_are_refused() {
        let (_directory, _path, expected) = fixture();
        let mut routing = route(&expected);
        routing.working_directory.clear();
        assert!(routing_matches(&routing, &expected).is_ok());
        routing.target = format!("\"{}\"", expected.display());
        assert!(routing_matches(&routing, &expected).is_err());
        routing.target = expected
            .parent()
            .unwrap()
            .join("nested/../default.exe")
            .to_str()
            .unwrap()
            .into();
        assert!(routing_matches(&routing, &expected).is_err());
    }

    #[test]
    fn directories_malformed_and_oversized_links_never_reach_probe() {
        let (directory, path, expected) = fixture();
        let cases = [
            directory.path().to_path_buf(),
            path.clone(),
            directory.path().join("large.lnk"),
        ];
        fs::write(&path, b"not a shell link").unwrap();
        fs::write(&cases[2], vec![0; MAX_LINK_BYTES as usize + 1]).unwrap();
        for path in cases {
            let shortcut = inspect_candidate(AppId::Mcp, "desktop", path, &expected, |_| {
                panic!("Invalid input must never reach COM")
            });
            assert_eq!(shortcut.state, ShortcutState::Refused);
        }
    }

    #[test]
    fn probe_failure_preserves_original_and_does_not_issue_proof() {
        let (_directory, path, expected) = fixture();
        let bytes = fs::read(&path).unwrap();
        let shortcut = inspect_candidate(AppId::Mcp, "desktop", path.clone(), &expected, |_| {
            Err("timeout fixture".into())
        });
        assert_eq!(shortcut.state, ShortcutState::Refused);
        assert_eq!(shortcut.blocker.as_deref(), Some("timeout fixture"));
        assert_eq!(shortcut.bytes(), None);
        assert_eq!(fs::read(path).unwrap(), bytes);
    }

    #[test]
    fn parser_rejects_errors_extra_fields_duplicates_and_output_overflow() {
        let valid = br#"{"target":"x","arguments":"","workingDirectory":""}"#;
        assert!(parse_routing(valid, b"", true).is_ok());
        assert!(parse_routing(valid, b"warning", true).is_err());
        assert!(parse_routing(valid, b"", false).is_err());
        assert!(parse_routing(&vec![b' '; MAX_OUTPUT + 1], b"", true).is_err());
        for invalid in [
            br#"{"target":"x","arguments":""}"#.as_slice(),
            br#"{"target":"x","target":"x","arguments":"","workingDirectory":""}"#,
            br#"{"target":"x","arguments":"","workingDirectory":"","extra":1}"#,
            br#"{"target":"x\u0000","arguments":"","workingDirectory":""}"#,
        ] {
            assert!(parse_routing(invalid, b"", true).is_err());
        }
    }

    #[test]
    fn archived_known_target_is_accepted_when_old_gui_is_absent() {
        let (_directory, path, expected) = fixture();
        assert!(!expected.exists());
        assert!(
            archived_routing_with(AppId::Mcp, &path, &expected, |_| Ok(route(&expected))).is_ok()
        );
        assert!(!expected.exists());
    }

    #[test]
    fn archived_foreign_target_is_refused_without_mutation() {
        let (_directory, path, expected) = fixture();
        let before = fs::read(&path).unwrap();
        let mut routing = route(&expected);
        routing.target = expected
            .with_file_name("foreign.exe")
            .to_str()
            .unwrap()
            .into();
        assert!(archived_routing_with(AppId::Setup, &path, &expected, |_| Ok(routing)).is_err());
        assert_eq!(fs::read(path).unwrap(), before);
    }

    #[test]
    fn archives_require_lnk_extension_and_missing_archives_refuse() {
        let (_directory, path, expected) = fixture();
        assert!(archived_routing_with(
            AppId::Mcp,
            &path.with_extension("retired"),
            &expected,
            |_| panic!("Non-lnk archive must not reach COM")
        )
        .unwrap_err()
        .contains(".lnk"));
        fs::remove_file(&path).unwrap();
        assert!(
            archived_routing_with(AppId::Mcp, &path, &expected, |_| panic!(
                "Missing archive must not reach COM"
            ))
            .is_err()
        );
    }

    #[test]
    fn replaced_identical_bytes_are_not_the_same_snapshot() {
        let (_directory, path, expected) = fixture();
        let shortcut = inspect_candidate(AppId::Mcp, "desktop", path.clone(), &expected, |_| {
            Ok(route(&expected))
        });
        let replacement = path.with_file_name("replacement.lnk");
        fs::write(&replacement, shortcut.bytes().unwrap()).unwrap();
        fs::remove_file(&path).unwrap();
        fs::rename(replacement, path).unwrap();
        assert!(shortcut.recheck_file().is_err());
    }

    #[cfg(windows)]
    #[test]
    fn lexical_paths_refuse_namespace_aliases_and_streams() {
        assert!(
            ordinary_local_path(Path::new(r"C:\Users\Example Name\archive.retired.lnk")).is_ok()
        );
        for path in [
            r"\\host\share\a.lnk",
            r"\\?\C:\a.lnk",
            r"C:a.lnk",
            r"C:\a\..\b.lnk",
            r"C:\a\.\b.lnk",
            r"C:\a.lnk:stream",
            r"C:\a \b.lnk",
            r"C:\a.\b.lnk",
            r"C:\\a.lnk",
            "C:/a.lnk",
        ] {
            assert!(ordinary_local_path(Path::new(path)).is_err(), "{path}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn command_program_and_environment_have_ordinary_spellings_without_spawning() {
        let system = Path::new(r"C:\Windows\System32");
        let windows = Path::new(r"C:\Windows");
        let home = Path::new(r"C:\Users\Fixture User");
        let local = home.join("AppData").join("Local");
        let roaming = home.join("AppData").join("Roaming");
        let shortcut = Path::new(r"C:\Fixtures\Space Name\shortcut.retired.lnk");
        let command =
            native::command_with_folders(shortcut, system, windows, home, &local, &roaming)
                .unwrap();
        ordinary_local_path(Path::new(command.get_program())).unwrap_or_else(|error| {
            panic!("{error} Generated program: {:?}", command.get_program())
        });
        assert_eq!(
            command.get_program().to_str().unwrap(),
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
        );
        ordinary_local_path(command.get_current_dir().unwrap()).unwrap();
        for (key, value) in command.get_envs() {
            let value = value.expect("The cleared environment uses explicit finite values");
            if key.eq_ignore_ascii_case("PATH") {
                let entries: Vec<_> = std::env::split_paths(value).collect();
                assert_eq!(entries.len(), 3);
                for entry in entries {
                    ordinary_local_path(&entry).unwrap();
                }
            } else {
                ordinary_local_path(Path::new(value))
                    .unwrap_or_else(|error| panic!("{error} Environment {key:?}: {value:?}"));
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn hardlinked_owned_fixture_is_ambiguous_and_preserved() {
        let (_directory, path, expected) = fixture();
        let alias = path.with_file_name("alias.lnk");
        fs::hard_link(&path, &alias).unwrap();
        let shortcut = inspect_candidate(AppId::Mcp, "desktop", path.clone(), &expected, |_| {
            panic!("Hardlinked file must not reach COM")
        });
        assert_eq!(shortcut.state, ShortcutState::Refused);
        assert!(path.exists() && alias.exists());
    }

    #[test]
    fn source_guards_keep_com_read_only_and_process_bounded() {
        assert_eq!(READ_SCRIPT.matches(".CreateShortcut(").count(), 1);
        assert!(READ_SCRIPT.contains("[IO.File]::Exists($path)"));
        for forbidden in [
            ".Save",
            ".Resolve",
            "Invoke-",
            "Start-Process",
            "Remove-Item",
            "Set-Content",
            "WriteAll",
            "ShellExecute",
            "ExpandEnvironmentStrings",
        ] {
            assert!(!READ_SCRIPT.contains(forbidden), "{forbidden}");
        }
        let source = include_str!("legacy_shortcuts_windows.rs");
        let implementation = source.split("#[cfg(test)]").next().unwrap();
        assert!(implementation.contains(".env_clear()"));
        assert!(implementation.contains("-NoProfile"));
        assert!(implementation.contains("-NonInteractive"));
        assert!(implementation.contains("PeekNamedPipe"));
        assert!(implementation.contains("Instant::now() >= deadline"));
        assert!(!implementation.contains("std::env::var"));
        assert!(!implementation.contains("remove_file("));
        assert!(!implementation.contains("remove_dir("));
        assert!(!implementation.contains(".wait()"));
        assert_eq!(PROBE_TIMEOUT.as_secs(), 10);
    }

    #[cfg(windows)]
    #[test]
    fn owned_fixture_write_is_blocked_during_com_read_window() {
        let (_directory, path, expected) = fixture();
        let shortcut = inspect_candidate(AppId::Mcp, "desktop", path.clone(), &expected, |_| {
            assert!(OpenOptions::new().write(true).open(&path).is_err());
            assert!(fs::rename(&path, path.with_extension("moved")).is_err());
            Ok(route(&expected))
        });
        assert_eq!(shortcut.state, ShortcutState::Verified);
    }
}
