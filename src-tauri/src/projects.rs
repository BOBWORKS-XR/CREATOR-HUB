use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Mutex,
    time::{Duration, Instant, UNIX_EPOCH},
};
use tauri::Manager as _;
use tauri_plugin_dialog::DialogExt;

const MAX_JSON: u64 = 2 * 1024 * 1024;
const MAX_PROJECTS: usize = 200;
const CREATOR: &str = "com.sidequest.creator-sdk";
const BANTER: &str = "com.sidequest.banter";
const HELPER_RELATIVE: &str = "CreatorProjectSetup/tools/unity-cli/1.0.0-beta.9/unity.exe";
#[cfg(any(test, not(target_os = "linux")))]
const HELPER_BYTES: u64 = 20_835_248;
#[cfg(any(test, not(target_os = "linux")))]
const HELPER_SHA256: &str = "325c5f4d0a241121034e0c066b3d6169ef776cd33b73b1489d5c151440c77876";
const LINUX_HELPER_RELATIVE: &str = "CreatorProjectSetup/tools/unity-cli/1.0.0-beta.9/unity";
#[cfg(any(test, target_os = "linux"))]
const LINUX_HELPER_BYTES: u64 = 23_515_432;
#[cfg(any(test, target_os = "linux"))]
const LINUX_HELPER_SHA256: &str =
    "8c0d6e2435449c8be7f0e6b2ce6330bfc5f17a98aec4b659c859940455dd0fe5";

fn linux_registry_supported() -> bool {
    cfg!(all(
        target_os = "linux",
        target_arch = "x86_64",
        feature = "integrated-features"
    ))
}

#[derive(Default)]
pub struct Projects(Mutex<Vec<Project>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    id: String,
    name: String,
    path: String,
    sdk: String,
    sdk_label: String,
    unity_version: String,
    source: String,
    added: bool,
    selected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    bridge: Option<Bridge>,
    issue: Option<String>,
    modified_at_ms: Option<u64>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Bridge {
    installed: bool,
    current: bool,
}

#[derive(Serialize)]
pub struct Snapshot {
    projects: Vec<Project>,
    warnings: Vec<String>,
    #[serde(
        rename = "registryHelperPreparationAvailable",
        skip_serializing_if = "Option::is_none"
    )]
    registry_helper_preparation_available: Option<bool>,
}

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    paths: Vec<PathBuf>,
}

fn local_path(path: &Path) -> bool {
    let text = path.to_string_lossy();
    path.is_absolute()
        && !text.starts_with("\\\\")
        && !text.starts_with("//")
        && !path
            .components()
            .any(|part| part == std::path::Component::ParentDir)
}

fn read(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    crate::platform::reject_links(path)?;
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| "File is unavailable.")?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "File cannot be read.")?;
    if bytes.len() as u64 > limit {
        return Err("File exceeds the read limit.".into());
    }
    Ok(bytes)
}

fn json(path: &Path) -> Result<Value, String> {
    serde_json::from_slice(&read(path, MAX_JSON)?).map_err(|_| "Invalid JSON.".into())
}

fn saved_path() -> Result<PathBuf, String> {
    Ok(dirs::data_local_dir()
        .ok_or("Local app data is unavailable.")?
        .join("CreatorHub/projects.json"))
}

fn saved(path: &Path) -> Result<Saved, String> {
    if !path.exists() {
        return Ok(Saved::default());
    }
    let result: Saved = serde_json::from_slice(&read(path, MAX_JSON)?)
        .map_err(|_| "Saved project list is invalid; it has not been overwritten.")?;
    if result.paths.len() > MAX_PROJECTS {
        return Err("Saved project list exceeds 200 entries.".into());
    }
    Ok(result)
}

fn save(path: &Path, value: &Saved) -> Result<(), String> {
    use std::io::Write;
    crate::platform::reject_links(path)?;
    let parent = path.parent().ok_or("Invalid project-list location.")?;
    fs::create_dir_all(parent).map_err(|_| "Cannot create Hub settings folder.")?;
    let mut staged =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| "Cannot stage project list.")?;
    staged
        .write_all(&serde_json::to_vec(value).map_err(|_| "Cannot serialize project list.")?)
        .and_then(|_| staged.as_file().sync_all())
        .map_err(|_| "Cannot save project list.")?;
    staged
        .persist(path)
        .map_err(|_| "Cannot replace project list. Previous list retained.")?;
    Ok(())
}

pub(crate) fn key(path: &Path) -> String {
    let normalized: PathBuf = path.components().collect();
    let path = normalized.to_string_lossy();
    let value = if cfg!(windows) {
        path.replace('/', "\\").to_lowercase()
    } else {
        path.into_owned()
    };
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn version(root: &Path) -> Result<String, String> {
    let bytes = read(&root.join("ProjectSettings/ProjectVersion.txt"), 8192)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| "Project version is invalid.")?;
    text.lines()
        .find_map(|line| line.strip_prefix("m_EditorVersion: "))
        .filter(|v| {
            !v.is_empty()
                && v.len() < 64
                && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.')
        })
        .map(str::to_owned)
        .ok_or("Project Unity version is missing or invalid.".into())
}

fn dependency(root: &Path, deps: &Value, name: &str) -> bool {
    deps.get(name).is_some_and(Value::is_string)
        || json(&root.join("Packages").join(name).join("package.json"))
            .is_ok_and(|v| v["name"] == name)
}

// Inspect saved source metadata only, never Library, Temp, logs or MCP state.
// A partial scan must not be advertised as the project's last modified date.
fn modified_at(root: &Path, remaining: &mut usize, deadline: Instant) -> Option<u64> {
    crate::platform::reject_links(root).ok()?;
    let mut pending = Vec::new();
    for name in ["Assets", "Packages", "ProjectSettings"] {
        let path = root.join(name);
        let metadata = fs::symlink_metadata(&path).ok()?;
        pending.push((path, metadata));
    }
    let mut latest = None;
    while let Some((path, metadata)) = pending.pop() {
        if Instant::now() >= deadline {
            return None;
        }
        *remaining = remaining.checked_sub(1)?;
        #[allow(unused_mut)]
        let mut linked = metadata.file_type().is_symlink();
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            linked |= metadata.file_attributes() & 0x400 != 0;
        }
        if linked {
            continue;
        }
        let timestamp = u64::try_from(
            metadata
                .modified()
                .ok()?
                .duration_since(UNIX_EPOCH)
                .ok()?
                .as_millis(),
        )
        .ok()?;
        latest = Some(latest.map_or(timestamp, |previous: u64| previous.max(timestamp)));
        if metadata.is_dir() {
            for entry in fs::read_dir(&path).ok()? {
                if pending.len() >= *remaining || Instant::now() >= deadline {
                    return None;
                }
                let entry = entry.ok()?;
                // Windows directory enumeration already supplies this metadata;
                // avoid another filesystem query for every asset.
                let metadata = entry.metadata().ok()?;
                pending.push((entry.path(), metadata));
            }
        }
    }
    (Instant::now() < deadline).then_some(latest).flatten()
}

fn collect_modified_dates(projects: &mut [Project]) {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut remaining = 2_000_000;
    for project in projects {
        if project.issue.is_some() || remaining == 0 || Instant::now() >= deadline {
            continue;
        }
        let mut allowance = remaining.min(200_000);
        let before = allowance;
        project.modified_at_ms = modified_at(
            Path::new(&project.path),
            &mut allowance,
            deadline.min(Instant::now() + Duration::from_millis(500)),
        );
        remaining -= before - allowance;
    }
}

fn inspect(path: &Path, source: &str, added: bool) -> Project {
    let mut result = Project {
        id: key(path),
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        path: path.to_string_lossy().into_owned(),
        sdk: "unknown".into(),
        sdk_label: "SDK unknown".into(),
        unity_version: String::new(),
        source: source.into(),
        added,
        selected: false,
        bridge: None,
        issue: None,
        modified_at_ms: None,
    };
    let checked = (|| {
        if !local_path(path) {
            return Err("Only absolute local project folders are supported.".into());
        }
        crate::platform::reject_links(path)?;
        if !path.join("Assets").is_dir() {
            return Err("Project folder is missing or unavailable.".into());
        }
        result.unity_version = version(path)?;
        let manifest = json(&path.join("Packages/manifest.json"))?;
        if !manifest["dependencies"].is_object() {
            return Err("Package dependencies are missing or invalid.".into());
        }
        let creator = dependency(path, &manifest["dependencies"], CREATOR);
        let banter = dependency(path, &manifest["dependencies"], BANTER);
        let (sdk, label) = match (creator, banter) {
            (true, true) => ("mixed", "Creator SDK + Banter"),
            (true, false) => ("creator", "Creator SDK / Altspace"),
            (false, true) => ("banter", "Banter SDK"),
            _ => ("unity", "Unity / no SDK detected"),
        };
        result.sdk = sdk.into();
        result.sdk_label = label.into();
        Ok::<(), String>(())
    })();
    result.issue = checked.err();
    result
}

#[cfg(any(test, feature = "integrated-features"))]
fn prepare_missing_helper(
    path: &Path,
    approve: impl FnOnce() -> bool,
    prepare: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<(), String> {
    crate::platform::reject_links(path)?;
    if !path
        .try_exists()
        .map_err(|_| "Cannot inspect Unity helper cache.")?
    {
        if !approve() {
            return Err("Unity registry helper download was declined. No helper, AI configuration or project files were changed.".into());
        }
        crate::platform::reject_links(path)?;
        // The native dialog may remain open while another operation fills the cache.
        if !path
            .try_exists()
            .map_err(|_| "Cannot inspect Unity helper cache.")?
            && prepare()? != path
        {
            return Err("Prepared Unity helper is outside the approved cache location.".into());
        }
    }
    crate::platform::reject_links(path)
}

fn project_helper_path() -> Result<PathBuf, String> {
    Ok(dirs::data_local_dir()
        .ok_or("Local app data unavailable.")?
        .join(if linux_registry_supported() {
            LINUX_HELPER_RELATIVE
        } else {
            HELPER_RELATIVE
        }))
}

#[cfg(feature = "integrated-features")]
fn prepare_helper_for_open(handle: &tauri::AppHandle) -> Result<(), String> {
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return Ok(());
    }
    use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};
    // Same pinned executable as Setup; this approval does not enable its separate
    // experimental AI integration, write client settings, or install Unity Pipeline.
    prepare_missing_helper(
        &project_helper_path()?,
        || {
            handle.dialog()
            .message("Download Unity's verified registry helper to find installed Editors and projects?\n\nUnity CLI 1.0.0-beta.9, 20,835,248 bytes, from public-cdn.cloud.unity3d.com. Its fixed size and SHA-256 are checked before use. It is cached once and used here only for read-only Unity Hub registry lookups.\n\nThis does not enable the optional experimental AI Unity CLI integration, change AI-client configuration, install Unity Hub, an Editor or Unity Pipeline, or write project files. That AI integration remains a separate consent decision.\n\nDownload the helper and continue opening this project?")
            .title("Download verified Unity registry helper")
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom("Download helper".into(), "Not now".into()))
            .blocking_show()
        },
        creator_project_setup::service::prepare_project_helper,
    )
}

#[cfg(any(test, not(target_os = "linux")))]
fn pin_helper(path: &Path, expected_bytes: u64, expected_sha256: &str) -> Result<File, String> {
    crate::platform::reject_links(path)?;
    let mut options = File::options();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1);
    }
    let mut pin = options.open(path).map_err(|_| {
        if cfg!(feature = "integrated-features") {
            "The verified Unity registry helper is not cached. Open a listed project to review its one-time download. No project files were changed."
        } else {
            "The verified Unity registry helper is not cached. Prepare it in Project Setup, then refresh Projects. No project files were changed."
        }
    })?;
    if pin
        .metadata()
        .map_err(|_| "Cannot inspect Unity helper.")?
        .len()
        != expected_bytes
    {
        return Err("Unity helper differs from the approved version; it was not executed.".into());
    }
    let mut digest = Sha256::new();
    std::io::copy(&mut pin, &mut digest).map_err(|_| "Cannot verify Unity helper.")?;
    if format!("{:x}", digest.finalize()) != expected_sha256 {
        return Err("Unity helper failed integrity verification; it was not executed.".into());
    }
    Ok(pin)
}

#[cfg(target_os = "linux")]
mod linux_registry_image {
    use super::*;
    use std::{
        ffi::CString,
        io::{Seek, SeekFrom, Write},
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{
                ffi::OsStrExt,
                fs::{MetadataExt, OpenOptionsExt},
            },
        },
        path::Component,
    };

    type DirectoryIdentity = (u64, u64, u32, u32, u32);
    type ImageIdentity = (DirectoryIdentity, u64, u64, i64, i64, i64, i64);

    fn directory_identity(info: &fs::Metadata) -> DirectoryIdentity {
        (info.dev(), info.ino(), info.mode(), info.uid(), info.gid())
    }

    fn image_identity(info: &fs::Metadata) -> ImageIdentity {
        (
            directory_identity(info),
            info.len(),
            info.nlink(),
            info.mtime(),
            info.mtime_nsec(),
            info.ctime(),
            info.ctime_nsec(),
        )
    }

    struct Cache {
        file: File,
        identity: ImageIdentity,
        directories: Vec<(File, DirectoryIdentity)>,
    }

    fn input_directory(file: File) -> Result<(File, DirectoryIdentity), String> {
        let info = file
            .metadata()
            .map_err(|_| "Cannot inspect the Unity helper directory.")?;
        let uid = unsafe { libc::geteuid() };
        // Cache ancestry is input, not execution authority. Retain its mode and
        // identity, but authenticate and seal the helper bytes before execution.
        if !info.is_dir() || ![0, uid].contains(&info.uid()) {
            return Err(
                "The Unity helper cache directory has an unexpected owner or type. Nothing was executed.".into(),
            );
        }
        let identity = directory_identity(&info);
        Ok((file, identity))
    }

    fn open(path: &Path) -> Result<Option<Cache>, String> {
        if !path.is_absolute()
            || path
                .components()
                .any(|part| !matches!(part, Component::RootDir | Component::Normal(_)))
        {
            return Err("The Unity helper cache path is invalid.".into());
        }
        let names = path
            .components()
            .filter_map(|part| match part {
                Component::Normal(name) => Some(name),
                _ => None,
            })
            .collect::<Vec<_>>();
        if names.is_empty() {
            return Err("The Unity helper cache path is invalid.".into());
        }
        let flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK;
        let root = File::options()
            .read(true)
            .custom_flags(flags | libc::O_DIRECTORY)
            .open("/")
            .map_err(|_| "Cannot open the Unity helper cache ancestry.")?;
        let mut directories = vec![input_directory(root)?];
        for (index, name) in names.iter().enumerate() {
            let name = CString::new(name.as_bytes()).map_err(|_| "Invalid Unity helper path.")?;
            let last = index + 1 == names.len();
            let fd = unsafe {
                libc::openat(
                    directories.last().unwrap().0.as_raw_fd(),
                    name.as_ptr(),
                    flags | if last { 0 } else { libc::O_DIRECTORY },
                )
            };
            if fd < 0 {
                let error = std::io::Error::last_os_error();
                return if error.kind() == std::io::ErrorKind::NotFound {
                    Ok(None)
                } else {
                    Err("Cannot safely open the Unity helper cache. Nothing was replaced or executed.".into())
                };
            }
            let file = unsafe { File::from_raw_fd(fd) };
            if !last {
                directories.push(input_directory(file)?);
                continue;
            }
            let info = file
                .metadata()
                .map_err(|_| "Cannot inspect the Unity helper.")?;
            if !info.is_file()
                || info.uid() != unsafe { libc::geteuid() }
                || info.nlink() != 1
                || info.mode() & 0o100 == 0
                || info.mode() & 0o7022 != 0
            {
                return Err("The Unity helper must be an owned, protected regular executable. It was not replaced or executed.".into());
            }
            return Ok(Some(Cache {
                file,
                identity: image_identity(&info),
                directories,
            }));
        }
        unreachable!()
    }

    impl Cache {
        fn recheck(&self, path: &Path) -> Result<(), String> {
            let current = open(path)?.ok_or("The Unity helper disappeared during verification.")?;
            if current.identity != self.identity
                || image_identity(
                    &self
                        .file
                        .metadata()
                        .map_err(|_| "Cannot recheck the Unity helper.")?,
                ) != self.identity
                || current.directories.len() != self.directories.len()
            {
                return Err("The Unity helper cache changed during verification.".into());
            }
            for ((held, identity), (_, current)) in
                self.directories.iter().zip(&current.directories)
            {
                if identity != current
                    || directory_identity(
                        &held
                            .metadata()
                            .map_err(|_| "Cannot recheck the Unity helper ancestry.")?,
                    ) != *identity
                {
                    return Err("The Unity helper cache ancestry changed.".into());
                }
            }
            Ok(())
        }
    }

    #[cfg(any(test, all(target_arch = "x86_64", feature = "integrated-features")))]
    pub(super) fn missing(path: &Path) -> Result<bool, String> {
        open(path).map(|cache| cache.is_none())
    }

    pub(super) struct Image {
        source: Cache,
        sealed: File,
        path: PathBuf,
    }

    impl Image {
        pub(super) fn capture(path: &Path, length: u64, hash: &str) -> Result<Self, String> {
            let mut source = open(path)?.ok_or("The verified Unity registry helper is not cached. Use Download verified Unity helper in Projects.")?;
            if source.identity.1 != length || length == 0 || length > LINUX_HELPER_BYTES {
                return Err(
                    "Unity helper differs from the approved version; it was not executed.".into(),
                );
            }
            let mut bytes = Vec::new();
            (&mut source.file)
                .take(length + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "Cannot capture Unity helper bytes.")?;
            source.recheck(path)?;
            if bytes.len() as u64 != length
                || format!("{:x}", Sha256::digest(&bytes)) != hash
                || !linux_helper_elf(&bytes)
            {
                return Err("Unity helper failed integrity or native image verification; it was not executed.".into());
            }
            let fd = unsafe {
                libc::memfd_create(
                    c"creator-unity-registry".as_ptr(),
                    libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
                )
            };
            if fd < 0 {
                return Err(
                    "Linux cannot hold the verified Unity helper bytes. Nothing was executed."
                        .into(),
                );
            }
            let mut sealed = unsafe { File::from_raw_fd(fd) };
            sealed
                .write_all(&bytes)
                .and_then(|_| sealed.seek(SeekFrom::Start(0)))
                .map_err(|_| "Cannot capture the verified Unity helper image.")?;
            let seals =
                libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL;
            if unsafe { libc::fchmod(sealed.as_raw_fd(), 0o700) } != 0
                || unsafe { libc::fcntl(sealed.as_raw_fd(), libc::F_ADD_SEALS, seals) } != 0
                || unsafe { libc::fcntl(sealed.as_raw_fd(), libc::F_GET_SEALS) } != seals
            {
                return Err(
                    "Linux cannot seal the verified Unity helper image. Nothing was executed."
                        .into(),
                );
            }
            source.recheck(path)?;
            Ok(Self {
                source,
                sealed,
                path: path.to_owned(),
            })
        }

        pub(super) fn executable(&self) -> PathBuf {
            PathBuf::from(format!("/proc/self/fd/{}", self.sealed.as_raw_fd()))
        }
        pub(super) fn recheck(&self) -> Result<(), String> {
            self.source.recheck(&self.path)
        }
    }
}

#[cfg(any(test, target_os = "linux"))]
fn linux_helper_elf(bytes: &[u8]) -> bool {
    bytes.len() >= 64
        && bytes[..7] == [127, b'E', b'L', b'F', 2, 1, 1]
        && [2, 3].contains(&u16::from_le_bytes([bytes[16], bytes[17]]))
        && u16::from_le_bytes([bytes[18], bytes[19]]) == 62
}

fn registry_args_allowed(args: &[&str], linux: bool) -> bool {
    matches!(args, ["projects", "list"] | ["editors", "--installed"])
        && (!linux || args == ["projects", "list"])
}

// Inventory is cache-only. Windows retains its deny-write/delete handle; Linux
// executes only a sealed capture while retaining and rechecking the source FDs.
fn cli(args: &[&str]) -> Result<Value, String> {
    if !cfg!(all(windows, target_arch = "x86_64")) && !linux_registry_supported() {
        return Err("Current Unity Hub discovery is not yet supported on this platform.".into());
    }
    if !registry_args_allowed(args, linux_registry_supported()) {
        return Err("Unsupported Unity registry lookup.".into());
    }
    let path = project_helper_path()?;
    #[cfg(not(target_os = "linux"))]
    let _pin = pin_helper(&path, HELPER_BYTES, HELPER_SHA256)?;
    #[cfg(target_os = "linux")]
    let image =
        linux_registry_image::Image::capture(&path, LINUX_HELPER_BYTES, LINUX_HELPER_SHA256)?;
    #[cfg(target_os = "linux")]
    let executable = image.executable();
    #[cfg(not(target_os = "linux"))]
    let executable = path;
    let mut child = crate::platform::command(&executable)
        .args(args)
        .args(["--json", "--non-interactive", "--no-banner", "--no-pager"])
        .env("UNITY_NO_CONSENT_PROMPT", "1")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|_| "Cannot read Unity's project registry.")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Unity helper has no output pipe.")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take(MAX_JSON + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if started.elapsed() < Duration::from_secs(10) => {
                std::thread::sleep(Duration::from_millis(25))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break Err("Unity registry lookup timed out or failed.");
            }
        }
    };
    let bytes = reader
        .join()
        .map_err(|_| "Unity registry reader failed.")?
        .map_err(|_| "Cannot read Unity registry response.")?;
    #[cfg(target_os = "linux")]
    image.recheck()?;
    if !status?.success() || bytes.len() as u64 > MAX_JSON {
        return Err("Unity registry returned an unsuccessful or oversized response.".into());
    }
    let result: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Unity registry returned invalid JSON.")?;
    if result["success"] != true {
        return Err("Unity registry lookup was unsuccessful.".into());
    }
    Ok(result)
}

fn entries(value: &Value) -> Vec<&Value> {
    match &value["data"] {
        Value::Array(values) => values.iter().take(MAX_PROJECTS + 1).collect(),
        Value::Object(values) => values.values().take(MAX_PROJECTS + 1).collect(),
        _ => Vec::new(),
    }
}

fn selected_project(config: &Path) -> Result<Option<String>, String> {
    let current = config.join("creator-works-mcp/launcher-config.json");
    let path = match fs::symlink_metadata(&current) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            config.join("banter-mcp/launcher-config.json")
        }
        _ => current,
    };
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        _ => {}
    }
    let value = json(&path)?;
    let channels = value["channels"]
        .as_array()
        .ok_or("MCP project list is invalid.")?;
    if channels.len() > 256 {
        return Err("MCP project list exceeds the existing 256-channel limit.".into());
    }
    let active = match value.get("active_channel_id") {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::String(id)) if !id.is_empty() => id,
        _ => return Err("MCP active project ID is invalid.".into()),
    };
    let matches: Vec<_> = channels
        .iter()
        .filter(|channel| channel["id"] == *active)
        .collect();
    if matches.len() != 1 {
        return Err("MCP active project ID does not identify one saved project.".into());
    }
    let path = matches[0]["unity_project_path"]
        .as_str()
        .ok_or("MCP active project path is invalid.")?;
    if path.len() > 4096 || !local_path(Path::new(path)) {
        return Err("MCP active project path must be an absolute local folder.".into());
    }
    Ok(Some(key(Path::new(path))))
}

fn discover(config: &Path, saved_file: &Path, current_hub: Result<Value, String>) -> Snapshot {
    let mut projects: BTreeMap<String, Project> = BTreeMap::new();
    let mut warnings = Vec::new();
    let mut insert = |path: &str, source: &str, added: bool| {
        let root = Path::new(path);
        if !local_path(root) || path.len() > 4096 {
            return;
        }
        let id = key(root);
        if let Some(existing) = projects.get_mut(&id) {
            existing.added |= added;
            return;
        }
        if projects.len() >= MAX_PROJECTS {
            return;
        }
        projects.insert(id, inspect(root, source, added));
    };
    match saved(saved_file) {
        Ok(list) => {
            for path in list.paths {
                insert(&path.to_string_lossy(), "Added to Creator Hub", true);
            }
        }
        Err(error) => warnings.push(error),
    }
    match current_hub {
        Ok(value) if value["data"].is_array() => {
            for entry in entries(&value) {
                if let Some(path) = entry["path"].as_str() {
                    insert(path, "Unity Hub", false);
                }
            }
        }
        Ok(_) => warnings.push("Unity Hub returned an unrecognized project list.".into()),
        Err(error) => warnings.push(error),
    }
    for (relative, source, mcp) in [
        (
            "UnityHub/projects-v1.json",
            "Unity Hub (legacy list)",
            false,
        ),
        (
            "creator-works-mcp/launcher-config.json",
            "Creator Works MCP",
            true,
        ),
        ("banter-mcp/launcher-config.json", "Legacy MCP", true),
    ] {
        let path = config.join(relative);
        if !path.exists() {
            continue;
        }
        match json(&path) {
            Ok(value) => {
                let rows = if mcp {
                    value["channels"]
                        .as_array()
                        .map(|a| a.iter().take(MAX_PROJECTS).collect())
                        .unwrap_or_default()
                } else {
                    entries(&value)
                };
                for row in rows {
                    if let Some(path) =
                        row[if mcp { "unity_project_path" } else { "path" }].as_str()
                    {
                        insert(path, source, false);
                    }
                }
            }
            Err(_) => warnings.push(format!(
                "{source} project list could not be read. Other sources are still shown."
            )),
        }
    }
    if projects.len() >= MAX_PROJECTS {
        warnings.push(
            "Showing at most 200 known projects. Narrow your saved project lists to see others."
                .into(),
        );
    }
    let mut projects: Vec<_> = projects.into_values().collect();
    match selected_project(config) {
        Ok(selected) => {
            for project in &mut projects {
                project.selected = selected.as_deref() == Some(&project.id);
            }
        }
        Err(error) => warnings.push(format!("MCP active project could not be read: {error}")),
    }
    projects.sort_by_key(|p| p.name.to_lowercase());
    collect_modified_dates(&mut projects);
    Snapshot {
        projects,
        warnings,
        registry_helper_preparation_available: None,
    }
}

#[cfg(any(test, feature = "integrated-features"))]
fn collect_bridges(
    projects: &mut [Project],
    fetch: impl FnOnce(&[PathBuf]) -> Result<Vec<Value>, String>,
) -> Result<(), String> {
    for project in projects.iter_mut() {
        project.bridge = None;
    }
    if projects.len() > MAX_PROJECTS {
        return Err("Project bridge inventory exceeds 200 entries.".into());
    }
    let mut indices = Vec::new();
    let mut paths = Vec::new();
    for (index, project) in projects.iter().enumerate() {
        if project.issue.is_some() {
            continue;
        }
        let path = Path::new(&project.path);
        if !local_path(path) || project.path.len() > 4096 || key(path) != project.id {
            return Err(
                "Project path identity changed. Refresh Projects before checking its bridge."
                    .into(),
            );
        }
        crate::platform::reject_links(path)?;
        indices.push(index);
        paths.push(path.to_owned());
    }
    if paths.is_empty() {
        return Ok(());
    }
    let values = fetch(&paths)?;
    if values.len() != paths.len() {
        return Err("MCP returned an incomplete project bridge inventory.".into());
    }
    // Validate the whole batch before publishing any badge, never a partial result.
    let bridges = values
        .into_iter()
        .map(|value| {
            let bridge: Bridge = serde_json::from_value(value)
                .map_err(|_| "MCP returned an invalid project bridge status.")?;
            if bridge.current && !bridge.installed {
                return Err("MCP returned an inconsistent project bridge status.");
            }
            Ok(bridge)
        })
        .collect::<Result<Vec<_>, _>>()?;
    for (index, bridge) in indices.into_iter().zip(bridges) {
        projects[index].bridge = Some(bridge);
    }
    Ok(())
}

#[cfg(feature = "integrated-features")]
fn read_project_bridges(handle: &tauri::AppHandle, projects: &mut [Project]) -> Result<(), String> {
    collect_bridges(projects, |paths| {
        let candidate = crate::builtin::hosting_candidate(handle, crate::catalog::AppId::Mcp)?
            .ok_or("This Hub has no verified built-in MCP resources for bridge status.")?;
        let server_root = candidate
            .path
            .parent()
            .ok_or("Invalid built-in MCP resource location.")?
            .join("server");
        creator_works_mcp_launcher::service::project_bridge_statuses(server_root, paths)
    })
}

fn refresh(handle: &tauri::AppHandle) -> Result<Snapshot, String> {
    #[allow(unused_mut)]
    let mut result = discover(
        &dirs::config_dir().ok_or("Config directory unavailable.")?,
        &saved_path()?,
        cli(&["projects", "list"]),
    );
    #[cfg(all(
        target_os = "linux",
        target_arch = "x86_64",
        feature = "integrated-features"
    ))]
    {
        result.registry_helper_preparation_available = Some(
            project_helper_path()
                .and_then(|path| linux_registry_image::missing(&path))
                .unwrap_or(false),
        );
    }
    #[cfg(feature = "integrated-features")]
    if let Err(error) = read_project_bridges(handle, &mut result.projects) {
        result.warnings.push(format!(
            "Unity bridge status could not be verified: {error}"
        ));
    }
    *handle
        .state::<Projects>()
        .0
        .lock()
        .map_err(|_| "Project list is busy.")? = result.projects.clone();
    Ok(result)
}

pub fn community_paths(handle: &tauri::AppHandle) -> Result<Vec<PathBuf>, String> {
    Ok(refresh(handle)?
        .projects
        .into_iter()
        .filter(|p| p.issue.is_none())
        .map(|p| PathBuf::from(p.path))
        .collect())
}

#[tauri::command]
pub async fn project_inventory(handle: tauri::AppHandle) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let manager = handle.state::<crate::manager::Manager>();
        let _guard = manager.begin()?;
        refresh(&handle)
    })
    .await
    .map_err(|_| "Project discovery worker failed.")?
}

#[tauri::command]
pub async fn prepare_project_registry(handle: tauri::AppHandle) -> Result<Snapshot, String> {
    #[cfg(not(all(
        target_os = "linux",
        target_arch = "x86_64",
        feature = "integrated-features"
    )))]
    {
        let _ = handle;
        Err("Unity registry helper preparation from Projects is available only in native Linux Hub.".into())
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64", feature = "integrated-features"))]
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};
        let manager = handle.state::<crate::manager::Manager>();
        let _guard = manager.begin()?;
        let path = project_helper_path()?;
        if linux_registry_image::missing(&path)? {
            prepare_missing_helper(&path, || handle.dialog()
                .message("Download Unity's verified registry helper to discover projects already registered in Unity Hub?\n\nUnity CLI 1.0.0-beta.9 for Linux x64, 23,515,432 bytes, from public-cdn.cloud.unity3d.com. Its fixed size and SHA-256 are checked before use.\n\nThis does not enable the optional AI Unity CLI integration, change AI-client settings, install Unity Hub, an Editor or Unity Pipeline, register projects, or write project files.")
                .title("Download verified Unity registry helper")
                .kind(MessageDialogKind::Info)
                .buttons(MessageDialogButtons::OkCancelCustom("Download helper".into(), "Not now".into()))
                .blocking_show(), creator_project_setup::service::prepare_project_helper)?;
        }
        let verified = linux_registry_image::Image::capture(&path, LINUX_HELPER_BYTES, LINUX_HELPER_SHA256)?;
        let result = refresh(&handle)?;
        verified.recheck()?;
        Ok(result)
    }).await.map_err(|_| "Unity registry helper preparation worker failed.")?
}

#[tauri::command]
pub async fn add_project_folder(handle: tauri::AppHandle) -> Result<Option<Snapshot>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let manager = handle.state::<crate::manager::Manager>();
        let _guard = manager.begin()?;
        let Some(path) = handle.dialog().file().blocking_pick_folder() else {
            return Ok(None);
        };
        let path = path
            .into_path()
            .map_err(|_| "Choose a local project folder.")?;
        let project = inspect(&path, "Added to Creator Hub", true);
        if let Some(issue) = project.issue {
            return Err(issue);
        }
        let file = saved_path()?;
        let mut list = saved(&file)?;
        if !list.paths.iter().any(|p| key(p) == project.id) {
            if list.paths.len() >= MAX_PROJECTS {
                return Err("Remove a saved project before adding another (limit 200).".into());
            }
            list.paths.push(path);
            save(&file, &list)?;
        }
        refresh(&handle).map(Some)
    })
    .await
    .map_err(|_| "Project selection worker failed.")?
}

fn known(handle: &tauri::AppHandle, id: &str) -> Result<Project, String> {
    handle
        .state::<Projects>()
        .0
        .lock()
        .map_err(|_| "Project list is busy.")?
        .iter()
        .find(|p| p.id == id)
        .cloned()
        .ok_or("Project is no longer listed. Refresh Projects.".into())
}

#[tauri::command]
pub async fn remove_project_folder(
    handle: tauri::AppHandle,
    id: String,
) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let manager = handle.state::<crate::manager::Manager>();
        let _guard = manager.begin()?;
        let project = known(&handle, &id)?;
        if !project.added {
            return Err("This project belongs to another app's list.".into());
        }
        let file = saved_path()?;
        let mut list = saved(&file)?;
        list.paths.retain(|p| key(p) != id);
        save(&file, &list)?;
        refresh(&handle)
    })
    .await
    .map_err(|_| "Project-list worker failed.")?
}

#[cfg(any(not(all(target_os = "linux", feature = "integrated-features")), test))]
fn editor_from(value: &Value, version: &str) -> Option<PathBuf> {
    entries(value)
        .into_iter()
        .filter(|v| v["version"] == version)
        .filter_map(|v| v["location"].as_str())
        .map(PathBuf::from)
        .find(|p| {
            local_path(p)
                && p.file_name()
                    .is_some_and(|s| s.eq_ignore_ascii_case("Unity.exe"))
                && p.is_file()
                && crate::platform::reject_links(p).is_ok()
        })
}

#[cfg(all(target_os = "linux", any(feature = "integrated-features", test)))]
fn linux_editor_from(value: &Value, version: &str) -> Option<PathBuf> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    let editors = value.get("editors")?.as_array()?;
    if editors.len() > MAX_PROJECTS {
        return None;
    }
    editors
        .iter()
        .filter(|editor| editor["version"] == version)
        .filter_map(|editor| editor["executable"].as_str())
        .map(PathBuf::from)
        .find(|path| {
            if !local_path(path)
                || path.file_name() != Some(std::ffi::OsStr::new("Unity"))
                || crate::platform::reject_links(path).is_err()
            {
                return false;
            }
            let Ok(mut file) = File::options()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(path)
            else {
                return false;
            };
            let Ok(metadata) = file.metadata() else {
                return false;
            };
            if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
                return false;
            }
            let mut header = [0_u8; 20];
            if file.read_exact(&mut header).is_err() {
                return false;
            }
            let native_machine = if cfg!(target_arch = "x86_64") {
                62
            } else if cfg!(target_arch = "aarch64") {
                183
            } else {
                return false;
            };
            let native = &header[..7] == b"\x7fELF\x02\x01\x01"
                && matches!(u16::from_le_bytes([header[16], header[17]]), 2 | 3)
                && u16::from_le_bytes([header[18], header[19]]) == native_machine;
            native
                && fs::symlink_metadata(path).is_ok_and(|named| {
                    named.file_type().is_file()
                        && named.dev() == metadata.dev()
                        && named.ino() == metadata.ino()
                })
                && crate::platform::reject_links(path).is_ok()
        })
}

fn check_open_project(project: &Project) -> Result<(), String> {
    let root = Path::new(&project.path);
    let fresh = inspect(root, &project.source, project.added);
    if let Some(issue) = fresh.issue {
        return Err(issue);
    }
    if fresh.unity_version != project.unity_version || fresh.sdk != project.sdk {
        return Err(
            "Project SDK or Unity version changed. Refresh Projects before opening.".into(),
        );
    }
    if root.join("Temp/UnityLockfile").exists() {
        return Err("Unity has a lock file for this project. Use the existing Editor or check it in Unity Hub; no lock was removed.".into());
    }
    Ok(())
}

fn open_command(project: &Project, editor: &Path) -> Result<std::process::Command, String> {
    check_open_project(project)?;
    let mut command = crate::platform::command(editor);
    command
        .arg("-projectPath")
        .arg(&project.path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    Ok(command)
}

#[tauri::command]
pub async fn open_unity_project(handle: tauri::AppHandle, id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let manager = handle.state::<crate::manager::Manager>(); let _guard = manager.begin()?;
        let project = known(&handle, &id)?;
        check_open_project(&project)?;
        #[cfg(feature = "integrated-features")]
        prepare_helper_for_open(&handle)?;
        #[cfg(all(target_os = "linux", feature = "integrated-features"))]
        let editor = linux_editor_from(
            &creator_project_setup::service::call(&handle, "probe_environment", serde_json::json!({}))?,
            &project.unity_version,
        );
        #[cfg(not(all(target_os = "linux", feature = "integrated-features")))]
        let editor = editor_from(&cli(&["editors", "--installed"] )?, &project.unity_version);
        let editor = editor
            .ok_or_else(|| format!("Unity {} is not available. Install this exact version in Unity Hub, then retry. No project upgrade was attempted.", project.unity_version))?;
        open_command(&project, &editor)?.spawn().map_err(|_| "Unity could not be started.")?;
        Ok(format!("Unity {} launch requested for {}.", project.unity_version, project.name))
    }).await.map_err(|_| "Unity launch worker failed.")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(root: &Path, deps: Value) {
        fs::create_dir_all(root.join("Assets")).unwrap();
        fs::create_dir_all(root.join("Packages")).unwrap();
        fs::create_dir_all(root.join("ProjectSettings")).unwrap();
        fs::write(
            root.join("ProjectSettings/ProjectVersion.txt"),
            "m_EditorVersion: 6000.3.21f1\n",
        )
        .unwrap();
        fs::write(
            root.join("Packages/manifest.json"),
            json!({"dependencies": deps}).to_string(),
        )
        .unwrap();
    }

    #[test]
    fn helper_identity_matches_integrated_setups_pinned_manifest() {
        let release: Value = serde_json::from_str(include_str!(
            "../../modules/project-setup/src-tauri/src/unity-cli-release.json"
        ))
        .unwrap();
        assert!(HELPER_RELATIVE.contains(release["version"].as_str().unwrap()));
        assert_eq!(release["binaries"]["win32-x64"]["size"], HELPER_BYTES);
        assert_eq!(release["binaries"]["win32-x64"]["sha256"], HELPER_SHA256);
        assert!(LINUX_HELPER_RELATIVE.contains(release["version"].as_str().unwrap()));
        assert_eq!(
            release["binaries"]["linux-x64"]["filename"],
            "unity-linux-x64"
        );
        assert_eq!(release["binaries"]["linux-x64"]["size"], LINUX_HELPER_BYTES);
        assert_eq!(
            release["binaries"]["linux-x64"]["sha256"],
            LINUX_HELPER_SHA256
        );
    }

    #[test]
    fn registry_commands_are_finite_read_only_and_linux_never_uses_editor_or_ai_commands() {
        assert!(registry_args_allowed(&["projects", "list"], true));
        assert!(registry_args_allowed(&["projects", "list"], false));
        assert!(registry_args_allowed(&["editors", "--installed"], false));
        assert!(!registry_args_allowed(&["editors", "--installed"], true));
        for args in [
            vec![],
            vec!["projects", "add", "/home/project"],
            vec!["projects", "list", "/home/project"],
            vec!["install"],
            vec!["config", "set"],
            vec!["projects", "list", "--json"],
        ] {
            assert!(!registry_args_allowed(&args, true));
            assert!(!registry_args_allowed(&args, false));
        }
    }

    fn registry_elf_fixture() -> Vec<u8> {
        let mut bytes = vec![0; 64];
        bytes[..7].copy_from_slice(&[127, b'E', b'L', b'F', 2, 1, 1]);
        bytes[16] = 3;
        bytes[18] = 62;
        bytes
    }

    #[test]
    fn linux_registry_requires_a_native_x64_elf_image() {
        let bytes = registry_elf_fixture();
        assert!(linux_helper_elf(&bytes));
        for index in [0, 4, 5, 6, 16, 18, 19] {
            let mut wrong = bytes.clone();
            wrong[index] ^= 0xff;
            assert!(!linux_helper_elf(&wrong));
        }
        assert!(!linux_helper_elf(&bytes[..63]));
    }

    #[test]
    fn discovery_snapshot_omits_linux_preparation_capability_until_native_refresh_sets_it() {
        let root = tempfile::tempdir().unwrap();
        let result = discover(
            root.path(),
            &root.path().join("saved.json"),
            Ok(json!({"success": true, "data": []})),
        );
        let value = serde_json::to_value(result).unwrap();
        assert_eq!(value, json!({"projects": [], "warnings": []}));
    }

    #[test]
    fn linux_preparation_owns_one_worker_lease_and_never_calls_inventory_recursively() {
        let source = include_str!("projects.rs");
        let body = source
            .split("pub async fn prepare_project_registry(")
            .nth(1)
            .unwrap()
            .split("#[tauri::command]")
            .next()
            .unwrap();
        assert!(body.trim_start().starts_with("handle: tauri::AppHandle"));
        let compact = body.split_whitespace().collect::<String>();
        assert!(compact.contains(
            "target_os=\"linux\",target_arch=\"x86_64\",feature=\"integrated-features\""
        ));
        let worker = body.find("spawn_blocking(move ||").unwrap();
        let lease = body.find("manager.begin()?").unwrap();
        let missing = body.find("linux_registry_image::missing").unwrap();
        let consent = body.find("prepare_missing_helper").unwrap();
        let service = body
            .find("creator_project_setup::service::prepare_project_helper")
            .unwrap();
        let verify = body.find("Image::capture").unwrap();
        let refresh = body.find("refresh(&handle)").unwrap();
        assert!(
            worker < lease
                && lease < missing
                && missing < consent
                && consent < service
                && service < verify
                && verify < refresh
        );
        assert_eq!(body.matches("manager.begin()").count(), 1);
        assert!(!body.contains("project_inventory("));
        assert!(!crate::native_support::command_allowed(
            true,
            "prepare_project_registry"
        ));
        assert!(crate::native_support::command_allowed(
            false,
            "prepare_project_registry"
        ));
    }

    #[cfg(target_os = "linux")]
    fn linux_registry_cache(root: &Path) -> (PathBuf, Vec<u8>, String) {
        use std::os::unix::fs::PermissionsExt;
        let path = root.join("unity");
        let bytes = registry_elf_fixture();
        fs::write(&path, &bytes).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        (path, bytes, hash)
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_registry_capture_is_sealed_and_replacement_never_changes_executed_bytes() {
        use std::io::Write;
        let root = tempfile::tempdir().unwrap();
        let (path, bytes, hash) = linux_registry_cache(root.path());
        let image = linux_registry_image::Image::capture(&path, bytes.len() as u64, &hash).unwrap();
        assert_eq!(fs::read(image.executable()).unwrap(), bytes);
        let mut writer = File::options()
            .write(true)
            .open(image.executable())
            .unwrap();
        assert!(writer.write_all(b"changed").is_err());
        fs::rename(&path, root.path().join("original")).unwrap();
        fs::write(&path, b"replacement").unwrap();
        assert!(image.recheck().is_err());
        assert_eq!(fs::read(image.executable()).unwrap(), bytes);
        assert_eq!(fs::read(root.path().join("original")).unwrap(), bytes);
        assert_eq!(fs::read(path).unwrap(), b"replacement");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_registry_refuses_links_special_files_modes_hashes_and_changed_ancestry() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let cache = root.path().join("cache");
        fs::create_dir(&cache).unwrap();
        let (path, bytes, hash) = linux_registry_cache(&cache);
        assert!(!linux_registry_image::missing(&path).unwrap());
        assert!(
            linux_registry_image::Image::capture(&path, bytes.len() as u64 + 1, &hash).is_err()
        );
        assert!(
            linux_registry_image::Image::capture(&path, bytes.len() as u64, &"0".repeat(64))
                .is_err()
        );
        for mode in [0o600, 0o722, 0o4700] {
            fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
            assert!(linux_registry_image::missing(&path).is_err());
        }
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let alias = cache.join("alias");
        fs::hard_link(&path, &alias).unwrap();
        assert!(linux_registry_image::missing(&path).is_err());
        fs::remove_file(&alias).unwrap();
        symlink(&path, &alias).unwrap();
        assert!(linux_registry_image::missing(&alias).is_err());
        fs::remove_file(&alias).unwrap();
        symlink(&cache, root.path().join("linked")).unwrap();
        assert!(linux_registry_image::missing(&root.path().join("linked/unity")).is_err());
        assert!(linux_registry_image::missing(&cache).is_err());
        let fifo =
            std::ffi::CString::new(cache.join("fifo").as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert!(linux_registry_image::missing(&cache.join("fifo")).is_err());
        let image = linux_registry_image::Image::capture(&path, bytes.len() as u64, &hash).unwrap();
        fs::rename(&cache, root.path().join("retained")).unwrap();
        fs::create_dir(&cache).unwrap();
        linux_registry_cache(&cache);
        assert!(image.recheck().is_err());
        assert_eq!(fs::read(image.executable()).unwrap(), bytes);
        assert_eq!(fs::read(root.path().join("retained/unity")).unwrap(), bytes);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_registry_decline_is_zero_cache_writes_and_existing_malformed_cache_is_preserved() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("missing/cache/unity");
        assert!(linux_registry_image::missing(&path).unwrap());
        assert!(prepare_missing_helper(
            &path,
            || false,
            || panic!("Decline cannot prepare or download")
        )
        .is_err());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
        let (path, bytes, _) = linux_registry_cache(root.path());
        let before = fs::read(&path).unwrap();
        prepare_missing_helper(
            &path,
            || panic!("Existing cache cannot prompt"),
            || panic!("Existing cache cannot be replaced"),
        )
        .unwrap();
        assert!(
            linux_registry_image::Image::capture(&path, bytes.len() as u64, &"0".repeat(64))
                .is_err()
        );
        assert_eq!(fs::read(path).unwrap(), before);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_registry_accepts_authenticated_input_under_group_writable_cache_without_normalizing_it(
    ) {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let cache = root.path().join("cache");
        fs::create_dir(&cache).unwrap();
        fs::set_permissions(&cache, fs::Permissions::from_mode(0o775)).unwrap();
        let (path, bytes, hash) = linux_registry_cache(&cache);
        let before = fs::symlink_metadata(&cache).unwrap();
        let image = linux_registry_image::Image::capture(&path, bytes.len() as u64, &hash).unwrap();
        assert_eq!(fs::read(image.executable()).unwrap(), bytes);
        image.recheck().unwrap();
        assert_eq!(fs::symlink_metadata(&cache).unwrap().mode(), before.mode());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        fs::set_permissions(&cache, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            image.recheck().is_err(),
            "Directory mode remains part of the held identity"
        );
        assert_eq!(fs::symlink_metadata(&cache).unwrap().mode() & 0o7777, 0o755);
    }

    #[cfg(all(
        target_os = "linux",
        target_arch = "x86_64",
        feature = "integrated-features"
    ))]
    fn live_linux_helper_preparation(test_name: &str, default_acl: bool) {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        const CHILD: &str = "CREATOR_TEST_REGISTRY_PREPARATION_ROOT";
        let Some(root) = std::env::var_os(CHILD).map(PathBuf::from) else {
            let root = tempfile::Builder::new()
                .prefix("creator-hub-registry-preparation-")
                .permissions(fs::Permissions::from_mode(0o700))
                .tempdir()
                .unwrap();
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    test_name,
                    "--ignored",
                    "--test-threads=1",
                    "--nocapture",
                ])
                .env(CHILD, root.path())
                .env("XDG_DATA_HOME", root.path().join("data"))
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "Owned preparation child failed: {}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        };
        let data = root.join("data");
        assert_eq!(dirs::data_local_dir().unwrap(), data);
        assert_eq!(fs::symlink_metadata(&root).unwrap().uid(), unsafe {
            libc::geteuid()
        });
        assert_eq!(fs::symlink_metadata(&root).unwrap().mode() & 0o777, 0o700);
        assert!(!data.exists());
        // The umask is changed only in an owned --exact, single-test child.
        unsafe {
            libc::umask(0o002);
        }
        let acl = |args: &[&str], path: &Path| {
            let output = std::process::Command::new("/usr/bin/setfacl")
                .args(args)
                .arg(path)
                .output()
                .unwrap();
            assert!(output.status.success(), "Fixture ACL setup failed");
        };
        acl(&["-k"], &root);
        if default_acl {
            fs::create_dir(&data).unwrap();
            acl(&["-m", "d:u::rwx,d:g::rwx,d:m::rwx,d:o::r-x"], &data);
        }
        let read_acl = || {
            let output = std::process::Command::new("/usr/bin/getfacl")
                .args(["--absolute-names", "--numeric", "--omit-header"])
                .arg(&data)
                .output()
                .unwrap();
            assert!(output.status.success(), "Fixture ACL inspection failed");
            output.stdout
        };
        let original_acl = if default_acl { Some(read_acl()) } else { None };
        let path = project_helper_path().unwrap();
        assert_eq!(path, data.join(LINUX_HELPER_RELATIVE));
        prepare_missing_helper(
            &path,
            || true,
            creator_project_setup::service::prepare_project_helper,
        )
        .unwrap();
        let cache = data.join("CreatorProjectSetup/tools/unity-cli/1.0.0-beta.9");
        let folders = [
            data.join("CreatorProjectSetup"),
            data.join("CreatorProjectSetup/tools"),
            data.join("CreatorProjectSetup/tools/unity-cli"),
            cache.clone(),
        ];
        let before = folders
            .iter()
            .map(|folder| {
                let info = fs::symlink_metadata(folder).unwrap();
                assert_eq!(info.mode() & 0o777, 0o775);
                (info.dev(), info.ino(), info.mode(), info.uid(), info.gid())
            })
            .collect::<Vec<_>>();
        assert_eq!(fs::symlink_metadata(&path).unwrap().mode() & 0o7777, 0o700);
        let image =
            linux_registry_image::Image::capture(&path, LINUX_HELPER_BYTES, LINUX_HELPER_SHA256)
                .unwrap();
        image.recheck().unwrap();
        assert_eq!(
            creator_project_setup::service::prepare_project_helper().unwrap(),
            path
        );
        for (folder, expected) in folders.iter().zip(before) {
            let info = fs::symlink_metadata(folder).unwrap();
            assert_eq!(
                (info.dev(), info.ino(), info.mode(), info.uid(), info.gid()),
                expected
            );
        }
        if let Some(original) = original_acl {
            assert_eq!(read_acl(), original);
        }
        assert_eq!(fs::read_dir(cache).unwrap().count(), 1);
        println!("Existing Setup preparation verified: Linux beta9, umask 002, default ACL={default_acl}, unchanged cache permissions, exact sealed input. No helper execution or registry acceptance.");
    }

    #[cfg(all(
        target_os = "linux",
        target_arch = "x86_64",
        feature = "integrated-features"
    ))]
    #[test]
    #[ignore = "Explicit native test: downloads the pinned helper into an owned temp fixture; requires setfacl/getfacl"]
    fn live_linux_helper_preparation_umask_002() {
        live_linux_helper_preparation(
            "projects::tests::live_linux_helper_preparation_umask_002",
            false,
        );
    }

    #[cfg(all(
        target_os = "linux",
        target_arch = "x86_64",
        feature = "integrated-features"
    ))]
    #[test]
    #[ignore = "Explicit native test: downloads the pinned helper into an owned default-ACL temp fixture; requires setfacl/getfacl"]
    fn live_linux_helper_preparation_default_acl() {
        live_linux_helper_preparation(
            "projects::tests::live_linux_helper_preparation_default_acl",
            true,
        );
    }

    #[test]
    fn missing_helper_uses_internal_preparation_but_existing_files_are_never_replaced() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("unity.exe");
        prepare_missing_helper(
            &path,
            || true,
            || {
                fs::write(&path, b"fixture").unwrap();
                Ok(path.clone())
            },
        )
        .unwrap();
        prepare_missing_helper(
            &path,
            || panic!("Cached helper needs no download approval"),
            || panic!("Existing helpers must be verified, not replaced"),
        )
        .unwrap();
        let digest = format!("{:x}", Sha256::digest(b"fixture"));
        let pin = pin_helper(&path, 7, &digest).unwrap();
        #[cfg(windows)]
        assert!(
            fs::write(&path, b"changed").is_err(),
            "Verified image must remain deny-write locked"
        );
        drop(pin);
        fs::write(&path, b"changed").unwrap();
        assert!(pin_helper(&path, 7, &digest)
            .unwrap_err()
            .contains("integrity"));
        assert!(pin_helper(&path, 8, &digest)
            .unwrap_err()
            .contains("approved version"));
        assert_eq!(fs::read(&path).unwrap(), b"changed");
    }

    #[test]
    fn helper_preparation_failure_or_unexpected_path_never_authorizes_a_helper() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("unity.exe");
        assert_eq!(
            prepare_missing_helper(&path, || true, || Err("offline".into())).unwrap_err(),
            "offline"
        );
        assert!(
            prepare_missing_helper(&path, || true, || Ok(root.path().join("other.exe")))
                .unwrap_err()
                .contains("approved cache")
        );
        assert!(!path.exists());
        assert!(pin_helper(&path, HELPER_BYTES, HELPER_SHA256).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn helper_junction_is_refused_before_preparation_and_after_it() {
        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("real");
        fs::create_dir(&real).unwrap();
        fs::write(real.join("unity.exe"), b"fixture").unwrap();
        let link = root.path().join("linked");
        let junction = || {
            assert!(std::process::Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(&link)
                .arg(&real)
                .output()
                .unwrap()
                .status
                .success());
        };
        let path = link.join("unity.exe");
        junction();
        assert!(prepare_missing_helper(
            &path,
            || panic!("Linked cache cannot be approved"),
            || panic!("Linked cache cannot be prepared")
        )
        .is_err());
        assert!(pin_helper(&path, 7, &format!("{:x}", Sha256::digest(b"fixture"))).is_err());
        fs::remove_dir(&link).unwrap();
        assert!(prepare_missing_helper(
            &path,
            || true,
            || {
                junction();
                Ok(path.clone())
            }
        )
        .is_err());
        fs::remove_dir(&link).unwrap();
        assert_eq!(fs::read(real.join("unity.exe")).unwrap(), b"fixture");
    }

    #[test]
    fn missing_helper_download_requires_approval_and_rechecks_the_cache_afterwards() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("unity.exe");
        let error = prepare_missing_helper(&path, || false, || panic!("Decline cannot download"))
            .unwrap_err();
        assert!(error.contains("declined"));
        assert!(!path.exists());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
        prepare_missing_helper(
            &path,
            || {
                fs::write(&path, b"unverified existing helper").unwrap();
                true
            },
            || panic!("A helper appearing during consent must not be replaced"),
        )
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"unverified existing helper");
        assert!(pin_helper(&path, HELPER_BYTES, HELPER_SHA256).is_err());
    }

    #[test]
    fn background_registry_lookup_never_prepares_or_enables_optional_ai_cli() {
        let source = include_str!("projects.rs");
        let cli_body = source
            .split("fn cli(args:")
            .nth(1)
            .unwrap()
            .split("fn entries(")
            .next()
            .unwrap();
        assert!(cli_body.contains("pin_helper(&path, HELPER_BYTES, HELPER_SHA256)"));
        for forbidden in [
            "prepare_helper_for_open",
            "prepare_project_helper",
            "prepare_missing_helper",
            ".dialog()",
            "reqwest",
        ] {
            assert!(
                !cli_body.contains(forbidden),
                "Background registry lookup contains {forbidden}"
            );
        }
        let open_body = source
            .split("pub async fn open_unity_project(")
            .nth(1)
            .unwrap()
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        assert!(
            open_body.find("check_open_project").unwrap()
                < open_body.find("prepare_helper_for_open").unwrap()
        );
        assert!(
            open_body.find("prepare_helper_for_open").unwrap()
                < open_body.find("cli(&[\"editors\"").unwrap()
        );
        let production = source.split("#[cfg(test)]").next().unwrap();
        for forbidden in [
            "unity_cli_enabled",
            "unity_cli_consent_version",
            "configureUnityCli",
            "mcp configure",
            "com.unity.pipeline",
        ] {
            assert!(
                !production.contains(forbidden),
                "Project discovery must not configure {forbidden}"
            );
        }
    }

    #[test]
    fn bridge_inventory_batches_known_valid_paths_and_preserves_selection() {
        let root = tempfile::tempdir().unwrap();
        let first = root.path().join("first");
        let second = root.path().join("second");
        fixture(&first, json!({}));
        fixture(&second, json!({}));
        let mut rows = vec![
            inspect(&first, "saved", true),
            inspect(&second, "Unity Hub", false),
            inspect(&root.path().join("unavailable"), "saved", true),
        ];
        rows[0].selected = true;
        collect_bridges(&mut rows, |paths| {
            assert_eq!(paths, &[first.clone(), second.clone()]);
            Ok(vec![
                json!({"installed":true,"current":true}),
                json!({"installed":true,"current":false}),
            ])
        })
        .unwrap();
        let value = serde_json::to_value(&rows).unwrap();
        assert_eq!(value[0]["bridge"], json!({"installed":true,"current":true}));
        assert_eq!(
            value[1]["bridge"],
            json!({"installed":true,"current":false})
        );
        assert_eq!(value[0]["selected"], true);
        assert_eq!(value[1]["selected"], false);
        assert!(value[2].get("bridge").is_none());
        assert_eq!(
            fs::read_to_string(first.join("ProjectSettings/ProjectVersion.txt")).unwrap(),
            "m_EditorVersion: 6000.3.21f1\n"
        );
    }

    #[test]
    fn bridge_shape_length_and_resource_failures_leave_the_entire_batch_unknown() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path(), json!({}));
        let project = inspect(root.path(), "saved", true);
        for values in [
            vec![],
            vec![json!({"installed":false,"current":false}); 3],
            vec![json!({"installed":true,"current":true}), Value::Null],
            vec![
                json!({"installed":true,"current":true}),
                json!({"installed":false,"current":true}),
            ],
            vec![
                json!({"installed":true,"current":true}),
                json!({"installed":false}),
            ],
            vec![
                json!({"installed":true,"current":true}),
                json!({"installed":"false","current":false}),
            ],
            vec![
                json!({"installed":true,"current":true}),
                json!({"installed":false,"current":false,"path":"foreign"}),
            ],
        ] {
            let mut rows = vec![project.clone(), project.clone()];
            rows[0].selected = true;
            for row in &mut rows {
                row.bridge = Some(Bridge {
                    installed: true,
                    current: true,
                });
            }
            assert!(collect_bridges(&mut rows, |_| Ok(values)).is_err());
            assert!(rows.iter().all(|row| row.bridge.is_none()));
            assert!(rows[0].selected);
        }
        let mut rows = vec![project];
        rows[0].bridge = Some(Bridge {
            installed: true,
            current: true,
        });
        assert_eq!(
            collect_bridges(&mut rows, |_| Err("Payload verification failed".into())).unwrap_err(),
            "Payload verification failed"
        );
        assert!(rows[0].bridge.is_none());
        collect_bridges(&mut rows, |_| {
            Ok(vec![json!({"installed":false,"current":false})])
        })
        .unwrap();
        assert_eq!(
            serde_json::to_value(&rows[0]).unwrap()["bridge"],
            json!({"installed":false,"current":false})
        );
    }

    #[test]
    fn bridge_lookup_refuses_unknown_identity_network_relative_and_traversal_paths() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path(), json!({}));
        let project = inspect(root.path(), "saved", true);
        let mut foreign = project.clone();
        foreign.id = "not-the-known-project".into();
        assert!(collect_bridges(&mut [foreign], |_| panic!(
            "Unknown identity cannot query MCP"
        ))
        .is_err());
        for path in [
            PathBuf::from("relative/project"),
            PathBuf::from("//server/share/project"),
            root.path().join("../project"),
        ] {
            let mut row = project.clone();
            row.path = path.to_string_lossy().into_owned();
            row.id = key(&path);
            assert!(
                collect_bridges(&mut [row], |_| panic!("Untrusted path cannot query MCP")).is_err()
            );
        }
        let mut rows = vec![project; MAX_PROJECTS + 1];
        assert!(collect_bridges(&mut rows, |_| panic!(
            "Oversized inventory cannot query MCP"
        ))
        .is_err());
        collect_bridges(&mut [], |_| {
            panic!("Empty inventories do not verify or initialize MCP")
        })
        .unwrap();
        let mut invalid = [inspect(&root.path().join("unavailable"), "saved", true)];
        collect_bridges(&mut invalid, |_| {
            panic!("Unavailable projects cannot query MCP")
        })
        .unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn bridge_lookup_refuses_a_known_project_path_replaced_by_a_junction() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        fixture(&project, json!({}));
        let mut row = inspect(&project, "saved", true);
        let moved = root.path().join("moved");
        fs::rename(&project, &moved).unwrap();
        assert!(std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&project)
            .arg(&moved)
            .output()
            .unwrap()
            .status
            .success());
        assert!(collect_bridges(std::slice::from_mut(&mut row), |_| panic!(
            "Replaced project path cannot query MCP"
        ))
        .is_err());
        assert!(row.bridge.is_none());
        fs::remove_dir(&project).unwrap();
        assert!(moved.join("Packages/manifest.json").is_file());
    }

    #[test]
    fn home_bridge_inventory_uses_only_the_verified_native_batch_api() {
        let source = include_str!("projects.rs");
        let body = source
            .split("fn read_project_bridges(")
            .nth(1)
            .unwrap()
            .split("fn refresh(")
            .next()
            .unwrap();
        assert!(body.contains("crate::builtin::hosting_candidate"));
        assert!(body.contains(
            "creator_works_mcp_launcher::service::project_bridge_statuses(server_root, paths)"
        ));
        assert!(body.contains(".join(\"server\")"));
        for forbidden in [
            "features::call_mcp",
            "initialize_mcp",
            "service::initialize",
            "managed_route",
            "extension_status_bytes",
            "read_verified",
            "sha256",
        ] {
            assert!(
                !body.contains(forbidden),
                "Home bridge inventory cannot use {forbidden}"
            );
        }
        let refresh = source
            .split("fn refresh(")
            .nth(1)
            .unwrap()
            .split("pub fn community_paths(")
            .next()
            .unwrap();
        assert!(
            refresh.find("read_project_bridges").unwrap()
                < refresh.find("result.projects.clone()").unwrap()
        );
    }

    fn selection(path: &Path, project: &Path, active: Value) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            path,
            json!({"channels": [{"id":"chosen", "unity_project_path":project}],
            "active_channel_id":active, "unknown":"keep"})
            .to_string(),
        )
        .unwrap();
    }

    #[test]
    fn selected_project_uses_current_id_and_only_falls_back_when_current_is_absent() {
        let root = tempfile::tempdir().unwrap();
        let first = root.path().join("first");
        let second = root.path().join("second");
        fixture(&first, json!({}));
        fixture(&second, json!({}));
        let current = root.path().join("creator-works-mcp/launcher-config.json");
        let legacy = root.path().join("banter-mcp/launcher-config.json");
        selection(&legacy, &second, json!("chosen"));
        assert_eq!(selected_project(root.path()).unwrap(), Some(key(&second)));
        selection(&current, &first, json!("chosen"));
        let original = fs::read(&current).unwrap();
        let result = discover(
            root.path(),
            &root.path().join("saved.json"),
            Ok(json!({"data":[]})),
        );
        assert_eq!(result.projects.iter().filter(|p| p.selected).count(), 1);
        assert!(
            result
                .projects
                .iter()
                .find(|p| p.id == key(&first))
                .unwrap()
                .selected
        );
        assert!(
            !result
                .projects
                .iter()
                .find(|p| p.id == key(&second))
                .unwrap()
                .selected
        );
        assert_eq!(fs::read(&current).unwrap(), original);
        let row = serde_json::to_value(&result.projects[0]).unwrap();
        assert!(row["selected"].is_boolean());
        assert!(
            row.get("bridge").is_none(),
            "Unavailable bridge status must not be guessed"
        );
        selection(&current, &first, Value::Null);
        assert_eq!(selected_project(root.path()).unwrap(), None);
    }

    #[test]
    fn invalid_or_unreadable_current_selection_never_resurrects_legacy_selection() {
        let root = tempfile::tempdir().unwrap();
        let current = root.path().join("creator-works-mcp/launcher-config.json");
        let legacy = root.path().join("banter-mcp/launcher-config.json");
        selection(&legacy, root.path(), json!("chosen"));
        fs::create_dir_all(current.parent().unwrap()).unwrap();
        for invalid in [
            "{",
            "null",
            r#"{"channels":{},"active_channel_id":"chosen"}"#,
            r#"{"channels":[],"active_channel_id":true}"#,
            r#"{"channels":[],"active_channel_id":"missing"}"#,
        ] {
            fs::write(&current, invalid).unwrap();
            assert!(selected_project(root.path()).is_err());
            let result = discover(
                root.path(),
                &root.path().join("saved.json"),
                Ok(json!({"data":[]})),
            );
            assert!(result.projects.iter().all(|p| !p.selected));
            assert_eq!(fs::read_to_string(&current).unwrap(), invalid);
        }
        fs::remove_file(&current).unwrap();
        fs::create_dir(&current).unwrap();
        assert!(selected_project(root.path()).is_err());
    }

    #[test]
    fn active_selection_requires_one_exact_channel_and_a_local_path() {
        let root = tempfile::tempdir().unwrap();
        let current = root.path().join("creator-works-mcp/launcher-config.json");
        for active in [json!("CHOSEN"), json!(""), json!(false)] {
            selection(&current, root.path(), active);
            assert!(selected_project(root.path()).is_err());
        }
        selection(&current, Path::new("relative/project"), json!("chosen"));
        assert!(selected_project(root.path()).is_err());
        selection(&current, root.path(), json!("chosen"));
        let mut value: Value = serde_json::from_slice(&fs::read(&current).unwrap()).unwrap();
        let duplicate = value["channels"][0].clone();
        value["channels"].as_array_mut().unwrap().push(duplicate);
        fs::write(&current, value.to_string()).unwrap();
        assert!(selected_project(root.path()).is_err());
    }

    fn set_modified(path: &Path, seconds: u64) {
        File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(seconds)))
            .unwrap();
    }

    fn modification(root: &Path) -> Option<u64> {
        modified_at(root, &mut 10_000, Instant::now() + Duration::from_secs(10))
    }

    #[test]
    fn modified_date_tracks_nested_sources_not_generated_unity_or_mcp_files() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path(), json!({}));
        let scene = root.path().join("Assets/Scenes/Nested/World.unity");
        fs::create_dir_all(scene.parent().unwrap()).unwrap();
        fs::write(&scene, "test scene").unwrap();
        let stamp = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 86_400;
        set_modified(&scene, stamp);
        for name in ["Library", "Temp", "Logs", ".mcp", ".git"] {
            let file = root.path().join(name).join("generated.txt");
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(&file, "not an authored project edit").unwrap();
            set_modified(&file, stamp + 100);
        }
        assert_eq!(modification(root.path()), Some(stamp * 1000));
        assert_eq!(fs::read_to_string(&scene).unwrap(), "test scene");
        set_modified(&scene, stamp + 200);
        assert_eq!(modification(root.path()), Some((stamp + 200) * 1000));
        for name in [
            "Packages/manifest.json",
            "ProjectSettings/ProjectVersion.txt",
        ] {
            set_modified(&root.path().join(name), stamp + 300);
            assert_eq!(modification(root.path()), Some((stamp + 300) * 1000));
        }
        let record = inspect(root.path(), "test", false);
        let mut records = vec![record];
        collect_modified_dates(&mut records);
        assert_eq!(
            serde_json::to_value(&records[0]).unwrap()["modifiedAtMs"],
            (stamp + 300) * 1000
        );
    }

    #[test]
    fn incomplete_or_unavailable_modified_dates_remain_unknown() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path(), json!({}));
        assert!(modification(root.path()).is_some());
        assert_eq!(
            modified_at(
                root.path(),
                &mut 1,
                Instant::now() + Duration::from_secs(10)
            ),
            None
        );
        assert_eq!(modified_at(root.path(), &mut 10_000, Instant::now()), None);
        fs::remove_file(root.path().join("Packages/manifest.json")).unwrap();
        fs::remove_dir(root.path().join("Packages")).unwrap();
        assert_eq!(modification(root.path()), None);
        let mut records = vec![inspect(root.path(), "test", false)];
        collect_modified_dates(&mut records);
        assert!(records[0].modified_at_ms.is_none());
    }

    #[test]
    fn sdk_profiles_do_not_guess_from_project_name() {
        let root = tempfile::tempdir().unwrap();
        for (deps, expected) in [
            (json!({CREATOR: "4.0.14"}), "creator"),
            (json!({BANTER: "3.1.2"}), "banter"),
            (json!({CREATOR: "git-reference", BANTER: "3.1.2"}), "mixed"),
            (json!({"unrelated.banter.plugin": "1.0.0"}), "unity"),
        ] {
            fixture(root.path(), deps);
            assert_eq!(inspect(root.path(), "fixture", false).sdk, expected);
        }
        let embedded = root.path().join("Packages").join(CREATOR);
        fs::create_dir_all(&embedded).unwrap();
        fs::write(
            embedded.join("package.json"),
            json!({"name": CREATOR}).to_string(),
        )
        .unwrap();
        assert_eq!(inspect(root.path(), "fixture", false).sdk, "creator");
    }

    #[test]
    fn corrupt_missing_oversized_and_network_projects_are_not_openable() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path(), json!({}));
        fs::write(root.path().join("Packages/manifest.json"), "{").unwrap();
        assert!(inspect(root.path(), "fixture", false).issue.is_some());
        assert!(inspect(&root.path().join("missing"), "fixture", false)
            .issue
            .is_some());
        assert!(!local_path(Path::new("//server/share/project")));
        assert!(!local_path(Path::new("relative/project")));
        assert!(read(&root.path().join("ProjectSettings/ProjectVersion.txt"), 1).is_err());
    }

    #[test]
    fn combines_current_legacy_and_saved_without_rewriting_sources() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("A project");
        fixture(&project, json!({CREATOR: "4.0.14"}));
        let config = root.path().join("config");
        fs::create_dir_all(config.join("creator-works-mcp")).unwrap();
        let config_file = config.join("creator-works-mcp/launcher-config.json");
        let bytes =
            json!({"channels": [{"unity_project_path": project}], "auto_start": true}).to_string();
        fs::write(&config_file, &bytes).unwrap();
        let saved_file = root.path().join("hub/projects.json");
        save(
            &saved_file,
            &Saved {
                paths: vec![project.clone()],
            },
        )
        .unwrap();
        let result = discover(
            &config,
            &saved_file,
            Ok(json!({"data": [{"path": project}]})),
        );
        assert_eq!(result.projects.len(), 1);
        assert!(result.projects[0].added);
        assert_eq!(fs::read_to_string(config_file).unwrap(), bytes);
        save(&saved_file, &Saved::default()).unwrap();
        assert!(saved(&saved_file).unwrap().paths.is_empty());
        assert!(project.join("Assets").is_dir());
    }

    #[test]
    fn cli_failure_preserves_other_sources_and_corrupt_saved_list() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("projects.json");
        fs::write(&path, "broken").unwrap();
        let result = discover(root.path(), &path, Err("offline".into()));
        assert_eq!(result.warnings.len(), 2);
        assert_eq!(fs::read_to_string(path).unwrap(), "broken");
    }

    #[test]
    fn registry_size_is_bounded_and_equivalent_path_spellings_deduplicate() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(key(root.path()), key(&root.path().join(".")));
        assert!(!local_path(&root.path().join("..")));
        let rows: Vec<_> = (0..250)
            .map(|i| json!({"path": root.path().join(format!("project-{i}"))}))
            .collect();
        let result = discover(
            root.path(),
            &root.path().join("saved.json"),
            Ok(json!({"data": rows})),
        );
        assert_eq!(result.projects.len(), MAX_PROJECTS);
        assert!(result.warnings.iter().any(|w| w.contains("200")));
    }

    #[test]
    fn opening_is_literal_and_refuses_stale_version_or_lock() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("Space & name");
        fixture(&path, json!({CREATOR: "4.0.14"}));
        let project = inspect(&path, "fixture", false);
        let command = open_command(&project, Path::new("Unity.exe")).unwrap();
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![std::ffi::OsStr::new("-projectPath"), path.as_os_str()]
        );
        fs::create_dir(path.join("Temp")).unwrap();
        fs::write(path.join("Temp/UnityLockfile"), "").unwrap();
        assert!(open_command(&project, Path::new("Unity.exe"))
            .unwrap_err()
            .contains("lock file"));
        fs::remove_file(path.join("Temp/UnityLockfile")).unwrap();
        fs::write(
            path.join("ProjectSettings/ProjectVersion.txt"),
            "m_EditorVersion: 6000.3.10f1",
        )
        .unwrap();
        assert!(open_command(&project, Path::new("Unity.exe"))
            .unwrap_err()
            .contains("changed"));
    }

    #[test]
    fn editor_selection_requires_exact_version_and_real_unity_filename() {
        let root = tempfile::tempdir().unwrap();
        let exe = root.path().join("Unity.exe");
        fs::write(&exe, "fixture only").unwrap();
        let data = json!({"data": [{"version": "6000.3.21f1", "location": exe}]});
        assert!(editor_from(&data, "6000.3.21f1").is_some());
        assert!(editor_from(&data, "6000.3.10f1").is_none());
        assert!(editor_from(
            &json!({"data": [{"version": "6000.3.21f1", "location": "relative.exe"}]}),
            "6000.3.21f1"
        )
        .is_none());
    }

    #[cfg(target_os = "linux")]
    fn linux_editor_fixture(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut header = [0_u8; 20];
        header[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
        header[16] = 3;
        header[18] = if cfg!(target_arch = "x86_64") {
            62
        } else {
            183
        };
        fs::write(path, header).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_editor_selection_uses_exact_version_without_unrelated_module_readiness() {
        let root = tempfile::tempdir().unwrap();
        let editor = root.path().join("Unity installs/6000.3.21f1/Editor/Unity");
        linux_editor_fixture(&editor, 0o755);
        let report = json!({"ready": false, "editors": [{
            "version": "6000.3.21f1", "executable": editor, "ready": false,
            "androidPlayer": false, "windowsStandalone": false
        }]});
        assert_eq!(linux_editor_from(&report, "6000.3.21f1"), Some(editor));
        assert!(linux_editor_from(&report, "6000.3.10f1").is_none());
        assert!(linux_editor_from(&json!({"editors": null}), "6000.3.21f1").is_none());
        let oversized = json!({"editors": vec![report["editors"][0].clone(); MAX_PROJECTS + 1]});
        assert!(linux_editor_from(&oversized, "6000.3.21f1").is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_editor_selection_refuses_unexecutable_linked_foreign_or_missing_files() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let editor = root.path().join("Editor/Unity");
        let report = json!({"editors": [{"version": "6000.3.21f1", "executable": editor}]});
        assert!(linux_editor_from(&report, "6000.3.21f1").is_none());
        linux_editor_fixture(&editor, 0o644);
        assert!(linux_editor_from(&report, "6000.3.21f1").is_none());
        fs::set_permissions(&editor, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(&editor, b"#!/bin/sh\nexit 0\n").unwrap();
        assert!(linux_editor_from(&report, "6000.3.21f1").is_none());
        linux_editor_fixture(&editor, 0o755);
        let mut header = fs::read(&editor).unwrap();
        header[18] = 0;
        fs::write(&editor, header).unwrap();
        assert!(linux_editor_from(&report, "6000.3.21f1").is_none());
        linux_editor_fixture(&editor, 0o755);
        fs::rename(&editor, root.path().join("actual-unity")).unwrap();
        symlink(root.path().join("actual-unity"), &editor).unwrap();
        assert!(linux_editor_from(&report, "6000.3.21f1").is_none());
        fs::remove_file(&editor).unwrap();
        fs::remove_dir(editor.parent().unwrap()).unwrap();
        let target = root.path().join("real-editor");
        linux_editor_fixture(&target.join("Unity"), 0o755);
        symlink(&target, editor.parent().unwrap()).unwrap();
        assert!(linux_editor_from(&report, "6000.3.21f1").is_none());
    }

    #[test]
    #[ignore = "Read-only inventory of this machine; no Unity launch or project writes"]
    fn live_project_inventory() {
        let started = Instant::now();
        let result = discover(
            &dirs::config_dir().unwrap(),
            &saved_path().unwrap(),
            cli(&["projects", "list"]),
        );
        let count = result
            .projects
            .iter()
            .filter(|p| matches!(p.sdk.as_str(), "creator" | "banter" | "mixed"))
            .count();
        println!(
            "Known projects: {}; SDK projects: {}; source warnings: {}; valid projects: {}; modified dates: {}; unavailable dates: {}; elapsed: {:?}",
            result.projects.len(),
            count,
            result.warnings.len(),
            result.projects.iter().filter(|p| p.issue.is_none()).count(),
            result.projects.iter().filter(|p| p.modified_at_ms.is_some()).count(),
            result.projects.iter().filter(|p| p.modified_at_ms.is_none()).count(),
            started.elapsed()
        );
        assert!(count > 0);
    }
}
