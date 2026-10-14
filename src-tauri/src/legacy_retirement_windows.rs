//! GUI retirement never runs the legacy uninstaller: its server paths may still
//! be used by custom clients. All targets are native-derived and resumable only
//! after a new native review, not by replaying paths from a journal.
use crate::{catalog::AppId, legacy_removal_windows as legacy, manager, platform};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle},
    path::{Path, PathBuf},
    time::SystemTime,
};
use windows_sys::Win32::{
    Foundation::GENERIC_READ,
    Storage::FileSystem::{
        FileRenameInfo, GetFileInformationByHandle, SetFileInformationByHandle,
        BY_HANDLE_FILE_INFORMATION, DELETE, FILE_FLAG_BACKUP_SEMANTICS, FILE_RENAME_INFO,
    },
};
use winreg::{enums::*, types::FromRegValue, RegKey, RegValue};

const POLICY: u32 = 1;
const MAX_JOURNAL: u64 = 128 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Identity {
    volume: u32,
    index: u64,
    created: SystemTime,
    modified: SystemTime,
    bytes: u64,
}

fn identity(file: &File) -> Result<Identity, String> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // The handle is held through verification and the mutation, so a replaced
    // pathname cannot substitute a different file for the reviewed file.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err("Cannot verify retirement file identity.".into());
    }
    if info.dwFileAttributes & 0x400 != 0 || info.nNumberOfLinks != 1 {
        return Err("Linked or redirected retirement files were kept.".into());
    }
    let meta = file
        .metadata()
        .map_err(|_| "Cannot inspect retirement file.")?;
    Ok(Identity {
        volume: info.dwVolumeSerialNumber,
        index: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
        created: meta
            .created()
            .map_err(|_| "File creation identity unavailable.")?,
        modified: meta
            .modified()
            .map_err(|_| "File modification identity unavailable.")?,
        bytes: meta.len(),
    })
}

fn open(path: &Path, exclusive: bool, directory: bool) -> Result<File, String> {
    platform::reject_links(path)?;
    let mut options = OpenOptions::new();
    options.read(true).share_mode(if directory {
        3
    } else if exclusive {
        0
    } else {
        1
    });
    if exclusive && !directory {
        options.access_mode(GENERIC_READ | DELETE);
    }
    if directory {
        options.custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
    }
    options.open(path).map_err(|_| {
        "Cannot reserve the exact old app file or directory. Close its GUI and retry; no process was stopped.".into()
    })
}

fn proof(file: &mut File, bytes: u64, expected: &str) -> Result<Identity, String> {
    let before = identity(file)?;
    if !file
        .metadata()
        .map_err(|_| "Cannot inspect retirement file.")?
        .is_file()
        || before.bytes != bytes
        || bytes > 128 * 1024 * 1024
    {
        return Err("Retirement file differs from the exact accepted payload.".into());
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|_| "Cannot verify retirement file.")?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let n = file
            .read(&mut buffer)
            .map_err(|_| "Cannot hash retirement file.")?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    if before != identity(file)? || format!("{:x}", hash.finalize()) != expected {
        return Err("Retirement file changed; the existing data were kept.".into());
    }
    Ok(before)
}

fn rename_held(file: &File, destination: &Path) -> Result<(), String> {
    platform::reject_links(destination)?;
    if !destination.is_absolute()
        || destination
            .try_exists()
            .map_err(|_| "Cannot inspect retirement destination.")?
    {
        return Err("Retirement destination must be a new native-derived path.".into());
    }
    let mut name: Vec<u16> = destination.as_os_str().encode_wide().collect();
    if name.len() > 32760 || name.contains(&0) {
        return Err("Invalid retirement destination.".into());
    }
    let name_bytes = name.len() * 2;
    name.push(0);
    let size = std::mem::offset_of!(FILE_RENAME_INFO, FileName) + name.len() * 2;
    // u64 storage supplies the alignment required by FILE_RENAME_INFO on x64.
    let mut storage = vec![0u64; size.div_ceil(8)];
    let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    unsafe {
        (*info).Anonymous.ReplaceIfExists = false;
        (*info).RootDirectory = std::ptr::null_mut();
        (*info).FileNameLength = name_bytes as u32;
        std::ptr::copy_nonoverlapping(name.as_ptr(), (*info).FileName.as_mut_ptr(), name.len());
        if SetFileInformationByHandle(
            file.as_raw_handle(),
            FileRenameInfo,
            info.cast(),
            size as u32,
        ) == 0
        {
            return Err(format!("Exact file retirement could not complete ({}). Its journal and original data were kept.", std::io::Error::last_os_error()));
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct RegistryValue {
    kind: u32,
    bytes: Vec<u8>,
}
type Values = BTreeMap<String, RegistryValue>;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Registration {
    uninstall: Values,
    product: Values,
}

fn registry_path(app: AppId, uninstall: bool) -> String {
    if uninstall {
        format!(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{}",
            app.name()
        )
    } else {
        format!("Software\\Creator Works\\{}", app.name())
    }
}

fn read_registry(path: &str, view: u32) -> Result<Option<Values>, String> {
    let key = match RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(path, KEY_READ | view)
    {
        Ok(key) => key,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot inspect the old app registration.".into()),
    };
    if key.enum_keys().next().is_some() {
        return Err("Custom registration subkeys were kept.".into());
    }
    let mut result = Values::new();
    let mut total = 0;
    for row in key.enum_values() {
        let (name, value) = row.map_err(|_| "Cannot read old registration before-image.")?;
        total += name.len() + value.bytes.len();
        if result.len() >= 32 || total > 16384 {
            return Err("Old app registration exceeds the reviewed bound.".into());
        }
        result.insert(
            name,
            RegistryValue {
                kind: value.vtype as u32,
                bytes: value.bytes,
            },
        );
    }
    Ok(Some(result))
}

fn registration_values(app: AppId, uninstall: bool) -> Result<Option<Values>, String> {
    let path = registry_path(app, uninstall);
    let a = read_registry(&path, KEY_WOW64_64KEY)?;
    let b = read_registry(&path, KEY_WOW64_32KEY)?;
    if a != b {
        return Err("Distinct old app registry views were kept for manual review.".into());
    }
    Ok(a)
}

fn text(values: &Values, name: &str) -> Result<String, String> {
    let value = values
        .get(name)
        .ok_or("The old registration is incomplete.")?;
    if value.kind != REG_SZ as u32 {
        return Err("The old registration has an unexpected value type.".into());
    }
    String::from_reg_value(&RegValue {
        vtype: REG_SZ,
        bytes: value.bytes.clone(),
    })
    .map_err(|_| "Cannot interpret the old registration.".into())
}

fn validate_registration(app: AppId, root: &Path, saved: &Registration) -> Result<(), String> {
    if text(&saved.uninstall, "DisplayName")? != app.name()
        || text(&saved.uninstall, "DisplayVersion")? != legacy::accepted_version(app)
        || text(&saved.uninstall, "Publisher")? != "Creator Works"
        || text(&saved.uninstall, "InstallLocation")? != format!("\"{}\"", root.display())
        || text(&saved.uninstall, "UninstallString")?
            != format!("\"{}\"", root.join("uninstall.exe").display())
        || saved.uninstall.contains_key("QuietUninstallString")
        || saved.product.len() != 1
        || text(&saved.product, "")? != root.to_string_lossy()
    {
        return Err("Custom or unverified registration was kept.".into());
    }
    Ok(())
}

fn remove_registration(app: AppId, uninstall: bool, before: &Values) -> Result<(), String> {
    match registration_values(app, uninstall)? {
        None => return Ok(()),
        Some(current) if current == *before => {}
        _ => return Err("Registration changed during retirement; it was kept.".into()),
    }
    let path = registry_path(app, uninstall);
    RegKey::predef(HKEY_CURRENT_USER)
        .delete_subkey_with_flags(path, KEY_WOW64_64KEY)
        .map_err(|_| "Exact old registration could not be retired.")?;
    if registration_values(app, uninstall)?.is_some() {
        return Err("Old app registration still exists; inspect before retrying.".into());
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct SavedFile {
    name: String,
    identity: Identity,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ShortcutProof {
    identity: Identity,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct SavedShortcut {
    id: String,
    proof: Option<ShortcutProof>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Record {
    policy: u32,
    app: String,
    version: String,
    root: Identity,
    registration: Registration,
    files: Vec<SavedFile>,
    shortcuts: Vec<SavedShortcut>,
    // This receipt never authorizes deleting the retained compatibility server.
    gui_retired_compatibility_retained: bool,
}

fn gui_files(app: AppId) -> Vec<(&'static str, u64, &'static str)> {
    // Reserve/retire the destructive uninstaller first, before removing the GUI.
    let pins = legacy::accepted_files(app);
    ["uninstall.exe", app.exe()]
        .into_iter()
        .map(|name| *pins.iter().find(|(path, _, _)| *path == name).unwrap())
        .collect()
}

fn validate_record(app: AppId, root: &Path, saved: &Record) -> Result<(), String> {
    let names: Vec<_> = gui_files(app)
        .iter()
        .map(|(name, _, _)| name.to_string())
        .collect();
    if saved.policy != POLICY
        || saved.app != app.id()
        || saved.version != legacy::accepted_version(app)
        || saved.gui_retired_compatibility_retained
        || saved
            .files
            .iter()
            .map(|row| row.name.clone())
            .collect::<Vec<_>>()
            != names
    {
        return Err("Unknown retirement journal was kept; no operation was replayed.".into());
    }
    let candidates = crate::legacy_shortcuts_windows::native_candidates(app)?;
    if saved
        .shortcuts
        .iter()
        .map(|row| row.id.as_str())
        .collect::<Vec<_>>()
        != candidates.iter().map(|(id, _)| *id).collect::<Vec<_>>()
        || saved
            .shortcuts
            .iter()
            .filter_map(|row| row.proof.as_ref())
            .any(|proof| {
                proof.identity.bytes < 76
                    || proof.identity.bytes > 65536
                    || proof.sha256.len() != 64
                    || !proof.sha256.bytes().all(|c| c.is_ascii_hexdigit())
            })
    {
        return Err("Unknown shortcut retirement before-images were kept.".into());
    }
    validate_registration(app, root, &saved.registration)
}

fn save_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    platform::reject_links(path)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .share_mode(0)
        .open(path)
        .map_err(|_| "Retirement journal already exists or cannot be reserved.")?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot durably retain the retirement before-images.".into())
}

pub(super) struct RetirementPlan {
    app: AppId,
    root: PathBuf,
    archive: PathBuf,
    saved: Record,
}

impl RetirementPlan {
    pub(super) fn inspect(app: AppId) -> Result<Self, String> {
        let root = platform::default_exe(app)?
            .parent()
            .ok_or("Old app directory unavailable.")?
            .to_path_buf();
        let archive = manager::child_dir("convergence")?
            .join("legacy-retirement")
            .join(format!("{}-{}", app.id(), legacy::accepted_version(app)));
        platform::reject_links(&archive)?;
        let journal = archive.join("before.json");
        if journal
            .try_exists()
            .map_err(|_| "Cannot inspect retirement journal.")?
        {
            let saved: Record =
                serde_json::from_slice(&manager::bounded_read(&journal, MAX_JOURNAL)?).map_err(
                    |_| "Retirement before-images need review; no operation was replayed.",
                )?;
            validate_record(app, &root, &saved)?;
            let plan = Self {
                app,
                root,
                archive,
                saved,
            };
            plan.recheck()?;
            return Ok(plan);
        }
        let plans = legacy::inspect()?;
        let source = plans
            .iter()
            .find(|plan| plan.app() == app)
            .ok_or("No accepted old app was found.")?;
        source.recheck()?;
        if source.root() != root {
            return Err("Old app identity differs.".into());
        }
        let registration = Registration {
            uninstall: registration_values(app, true)?
                .ok_or("Missing old app uninstall record.")?,
            product: registration_values(app, false)?.ok_or("Missing old app product record.")?,
        };
        validate_registration(app, &root, &registration)?;
        let root_file = open(&root, false, true)?;
        let mut files = Vec::new();
        for (name, bytes, hash) in gui_files(app) {
            files.push(SavedFile {
                name: name.into(),
                identity: proof(&mut open(&root.join(name), false, false)?, bytes, hash)?,
            });
        }
        let mut shortcuts = Vec::new();
        for shortcut in crate::legacy_shortcuts_windows::inspect(app) {
            shortcut.recheck()?;
            let saved = match shortcut.state {
                crate::legacy_shortcuts_windows::ShortcutState::Missing => None,
                crate::legacy_shortcuts_windows::ShortcutState::Verified => {
                    let bytes = shortcut
                        .bytes()
                        .ok_or("Missing shortcut before-image.")?
                        .len() as u64;
                    let hash = shortcut.sha256().ok_or("Missing shortcut digest.")?;
                    let identity = proof(
                        &mut open(shortcut.native_path(), false, false)?,
                        bytes,
                        hash,
                    )?;
                    Some(ShortcutProof {
                        identity,
                        sha256: hash.into(),
                    })
                }
                _ => return Err("A custom or unverified shortcut was kept.".into()),
            };
            shortcuts.push(SavedShortcut {
                id: shortcut.logical_id().into(),
                proof: saved,
            });
        }
        Ok(Self {
            app,
            root,
            archive,
            saved: Record {
                policy: POLICY,
                app: app.id().into(),
                version: legacy::accepted_version(app).into(),
                root: identity(&root_file)?,
                registration,
                files,
                shortcuts,
                gui_retired_compatibility_retained: false,
            },
        })
    }

    fn check_root(&self, held: &File) -> Result<(), String> {
        let now = identity(held)?;
        if now.volume != self.saved.root.volume
            || now.index != self.saved.root.index
            || now.created != self.saved.root.created
        {
            return Err("The original install directory was replaced; retirement paused.".into());
        }
        Ok(())
    }

    fn recheck(&self) -> Result<(), String> {
        self.check_root(&open(&self.root, false, true)?)?;
        for (name, bytes, hash) in legacy::accepted_files(self.app)
            .iter()
            .filter(|(name, _, _)| name.starts_with("server/"))
        {
            proof(
                &mut open(&self.root.join(name), false, false)?,
                *bytes,
                hash,
            )?;
        }
        for (i, (name, bytes, hash)) in gui_files(self.app).iter().enumerate() {
            let source = self.root.join(name);
            let destination = self.archive.join(format!("{i}.retired"));
            match (source.try_exists(), destination.try_exists()) {
                (Ok(true), Ok(false)) => {
                    if proof(&mut open(&source, false, false)?, *bytes, hash)?
                        != self.saved.files[i].identity
                    {
                        return Err("Old GUI file was replaced.".into());
                    }
                }
                (Ok(false), Ok(true)) => {
                    if proof(&mut open(&destination, false, false)?, *bytes, hash)?
                        != self.saved.files[i].identity
                    {
                        return Err("Retirement before-image was replaced.".into());
                    }
                }
                _ => {
                    return Err(
                        "Ambiguous retirement file state. Both copies were kept for review.".into(),
                    )
                }
            }
        }
        for (uninstall, before) in [
            (false, &self.saved.registration.product),
            (true, &self.saved.registration.uninstall),
        ] {
            if let Some(current) = registration_values(self.app, uninstall)? {
                if current != *before {
                    return Err("Old registration changed; retirement paused.".into());
                }
            }
        }
        for (i, (_, source)) in crate::legacy_shortcuts_windows::native_candidates(self.app)?
            .iter()
            .enumerate()
        {
            let destination = self.archive.join(format!("shortcut-{i}.lnk"));
            match &self.saved.shortcuts[i].proof {
                None => {
                    if source
                        .try_exists()
                        .map_err(|_| "Cannot inspect missing shortcut.")?
                        || destination
                            .try_exists()
                            .map_err(|_| "Cannot inspect shortcut before-images.")?
                    {
                        return Err("A shortcut appeared after review; it was kept.".into());
                    }
                }
                Some(saved) => {
                    let at = match (source.try_exists(), destination.try_exists()) {
                        (Ok(true), Ok(false)) => source,
                        (Ok(false), Ok(true)) => &destination,
                        _ => {
                            return Err(
                                "Ambiguous shortcut retirement state; both copies were kept."
                                    .into(),
                            )
                        }
                    };
                    crate::legacy_shortcuts_windows::verify_archived_routing(self.app, at)?;
                    if proof(
                        &mut open(at, false, false)?,
                        saved.identity.bytes,
                        &saved.sha256,
                    )? != saved.identity
                    {
                        return Err(
                            "Reviewed shortcut or its before-image changed; retirement paused."
                                .into(),
                        );
                    }
                }
            }
        }
        Ok(())
    }

    fn require_gui_absent(&self) -> Result<(), String> {
        for (name, _, _) in gui_files(self.app) {
            if self
                .root
                .join(name)
                .try_exists()
                .map_err(|_| "Cannot inspect retired GUI path.")?
            {
                return Err("An old app file appeared during retirement. Registration cleanup paused; no replacement was removed.".into());
            }
        }
        Ok(())
    }

    /// The coordinator must supply native consent and settings/client checks.
    /// This leaf is not exposed as a Tauri command or installer CLI flag.
    pub(super) fn retire_after_native_review(
        &self,
        mut preflight: impl FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        self.recheck()?;
        preflight()?;
        let root_guard = open(&self.root, false, true)?;
        self.check_root(&root_guard)?;
        platform::reject_links(&self.archive)?;
        fs::create_dir_all(&self.archive)
            .map_err(|_| "Cannot create retirement before-image directory.")?;
        let archive_guard = open(&self.archive, false, true)?;
        let mut server_guards = Vec::new();
        for (name, bytes, hash) in legacy::accepted_files(self.app)
            .iter()
            .filter(|(name, _, _)| name.starts_with("server/"))
        {
            let mut held = open(&self.root.join(name), false, false)?;
            proof(&mut held, *bytes, hash)?;
            server_guards.push(held);
        }
        let mut held_files = Vec::new();
        for (i, (name, bytes, hash)) in gui_files(self.app).iter().enumerate() {
            let source = self.root.join(name);
            let destination = self.archive.join(format!("{i}.retired"));
            let moved = !source
                .try_exists()
                .map_err(|_| "Cannot inspect old GUI file.")?;
            let mut file = open(if moved { &destination } else { &source }, true, false)?;
            if proof(&mut file, *bytes, hash)? != self.saved.files[i].identity {
                return Err("The reviewed GUI file changed; retirement paused.".into());
            }
            held_files.push((file, moved));
        }
        let mut held_shortcuts = Vec::new();
        let shortcut_paths = crate::legacy_shortcuts_windows::native_candidates(self.app)?;
        for (i, (_, source)) in shortcut_paths.iter().enumerate() {
            let Some(saved) = &self.saved.shortcuts[i].proof else {
                if source
                    .try_exists()
                    .map_err(|_| "Cannot recheck missing shortcut.")?
                {
                    return Err("A new shortcut was kept; retirement paused.".into());
                }
                continue;
            };
            let destination = self.archive.join(format!("shortcut-{i}.lnk"));
            let moved = !source
                .try_exists()
                .map_err(|_| "Cannot inspect reviewed shortcut.")?;
            let mut file = open(if moved { &destination } else { source }, true, false)?;
            if proof(&mut file, saved.identity.bytes, &saved.sha256)? != saved.identity {
                return Err("Reviewed shortcut identity changed; retirement paused.".into());
            }
            held_shortcuts.push((i, file, moved));
        }
        preflight()?;
        let journal = self.archive.join("before.json");
        if !journal
            .try_exists()
            .map_err(|_| "Cannot inspect before-images.")?
        {
            save_new(
                &journal,
                &serde_json::to_vec(&self.saved).map_err(|_| "Cannot retain retirement record.")?,
            )?;
        } else {
            let bytes = manager::bounded_read(&journal, MAX_JOURNAL)?;
            let current: Record =
                serde_json::from_slice(&bytes).map_err(|_| "Unknown retirement before-images.")?;
            if serde_json::to_vec(&current).ok() != serde_json::to_vec(&self.saved).ok() {
                return Err("Retirement journal changed; retirement paused.".into());
            }
        }
        let journal_guard = open(&journal, false, false)?;
        for (i, (file, moved)) in held_files.iter().enumerate() {
            if !moved {
                rename_held(file, &self.archive.join(format!("{i}.retired")))?;
            }
            preflight()?;
        }
        for (i, file, moved) in &held_shortcuts {
            if !moved {
                rename_held(file, &self.archive.join(format!("shortcut-{i}.lnk")))?;
            }
            preflight()?;
        }
        self.require_gui_absent()?;
        remove_registration(self.app, false, &self.saved.registration.product)?;
        preflight()?;
        self.require_gui_absent()?;
        remove_registration(self.app, true, &self.saved.registration.uninstall)?;
        preflight()?;
        self.require_gui_absent()?;
        drop(held_files);
        drop(held_shortcuts);
        drop(server_guards);
        drop(archive_guard);
        self.recheck()?;
        let mut completed = self.saved.clone();
        completed.gui_retired_compatibility_retained = true;
        let receipt = self.archive.join("completed.json");
        let bytes =
            serde_json::to_vec(&completed).map_err(|_| "Cannot retain retirement result.")?;
        if receipt
            .try_exists()
            .map_err(|_| "Cannot inspect retirement result.")?
        {
            if manager::bounded_read(&receipt, MAX_JOURNAL)? != bytes {
                return Err("Retirement result changed; its before-images were kept.".into());
            }
        } else {
            save_new(&receipt, &bytes)?;
        }
        drop(journal_guard);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct LegacySession {
        child: std::process::Child,
        input: Option<std::process::ChildStdin>,
        replies: std::sync::mpsc::Receiver<serde_json::Value>,
    }

    impl LegacySession {
        fn start(root: &Path) -> Self {
            use std::{io::BufRead, process::Stdio};
            let mut command = platform::command(&root.join("server/runtime/node.exe"));
            command
                .arg(root.join("server/creator-works-mcp.mjs"))
                .current_dir(root)
                .env_clear()
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            for name in [
                "SystemRoot",
                "windir",
                "USERPROFILE",
                "APPDATA",
                "LOCALAPPDATA",
                "TEMP",
                "TMP",
            ] {
                if let Some(value) = std::env::var_os(name) {
                    command.env(name, value);
                }
            }
            let mut child = command.spawn().unwrap();
            let input = child.stdin.take();
            let output = child.stdout.take().unwrap();
            let (send, replies) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let mut reader = std::io::BufReader::new(output);
                loop {
                    let mut line = Vec::new();
                    let mut bounded = reader.take(4 * 1024 * 1024);
                    let read = bounded.read_until(b'\n', &mut line);
                    reader = bounded.into_inner();
                    if read.is_err() || line.is_empty() || !line.ends_with(b"\n") {
                        break;
                    }
                    let Ok(value) = serde_json::from_slice(&line) else {
                        break;
                    };
                    if send.send(value).is_err() {
                        break;
                    }
                }
            });
            let mut session = Self {
                child,
                input,
                replies,
            };
            session.send(serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
                "protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"legacy-retirement-fixture","version":"1"}
            }}));
            let reply = session.reply(1);
            assert_eq!(reply["result"]["serverInfo"]["version"], "2.7.7");
            session.send(serde_json::json!({"jsonrpc":"2.0","method":"notifications/initialized"}));
            session
        }

        fn send(&mut self, value: serde_json::Value) {
            let input = self.input.as_mut().unwrap();
            serde_json::to_writer(&mut *input, &value).unwrap();
            input.write_all(b"\n").unwrap();
            input.flush().unwrap();
        }

        fn reply(&self, id: u64) -> serde_json::Value {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
            loop {
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                let value = self
                    .replies
                    .recv_timeout(remaining)
                    .expect("legacy stdio response before deadline");
                if value["id"].as_u64() == Some(id) {
                    return value;
                }
            }
        }

        fn tools(&mut self, id: u64) {
            assert!(
                self.child.try_wait().unwrap().is_none(),
                "existing Node connection must stay running"
            );
            self.send(
                serde_json::json!({"jsonrpc":"2.0","id":id,"method":"tools/list","params":{}}),
            );
            assert!(!self.reply(id)["result"]["tools"]
                .as_array()
                .unwrap()
                .is_empty());
        }

        fn close(mut self) {
            drop(self.input.take());
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                if let Some(status) = self.child.try_wait().unwrap() {
                    assert!(
                        status.success(),
                        "legacy Node must exit normally on stdin close"
                    );
                    return;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "legacy Node failed normal EOF shutdown"
                );
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }

    impl Drop for LegacySession {
        fn drop(&mut self) {
            drop(self.input.take());
            // Failure cleanup is restricted to this exact fixture-created child,
            // never process names or a user/client runtime.
            if matches!(self.child.try_wait(), Ok(None)) {
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
        }
    }

    #[test]
    fn exact_handle_rename_keeps_bytes_identity_and_refuses_overwrite() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("old GUI.exe");
        let destination = temp.path().join("0.retired");
        fs::write(&source, b"accepted fixture").unwrap();
        let mut file = open(&source, true, false).unwrap();
        let hash = format!("{:x}", Sha256::digest(b"accepted fixture"));
        let before = proof(&mut file, 16, &hash).unwrap();
        assert!(OpenOptions::new().read(true).open(&source).is_err());
        rename_held(&file, &destination).unwrap();
        assert!(!source.exists());
        assert_eq!(identity(&file).unwrap(), before);
        assert!(rename_held(&file, &destination).is_err());
        drop(file);
        assert_eq!(fs::read(&destination).unwrap(), b"accepted fixture");
        assert_eq!(
            proof(&mut open(&destination, false, false).unwrap(), 16, &hash).unwrap(),
            before
        );
    }

    #[test]
    fn changed_and_busy_files_are_not_retired() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("owned.exe");
        fs::write(&source, b"changed").unwrap();
        let held = File::open(&source).unwrap();
        assert!(open(&source, true, false).is_err());
        drop(held);
        let hash = format!("{:x}", Sha256::digest(b"expected"));
        assert!(proof(&mut open(&source, true, false).unwrap(), 8, &hash).is_err());
        assert_eq!(fs::read(&source).unwrap(), b"changed");
    }

    #[test]
    fn server_resources_are_never_in_gui_retirement_targets() {
        for app in [AppId::Mcp, AppId::Setup] {
            let files = gui_files(app);
            assert_eq!(files.len(), 2);
            assert_eq!(files[0].0, "uninstall.exe");
            assert_eq!(files[1].0, app.exe());
            assert!(files
                .iter()
                .all(|(name, _, _)| !name.starts_with("server/")));
        }
        assert_eq!(
            legacy::accepted_files(AppId::Mcp)
                .iter()
                .filter(|(name, _, _)| name.starts_with("server/"))
                .count(),
            9
        );
    }

    #[test]
    fn held_directory_guards_allow_native_move_without_releasing_file_identity() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("original app");
        let archive = temp.path().join("retained before-images");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&archive).unwrap();
        let source = root.join("uninstall.exe");
        fs::write(&source, b"fixture").unwrap();
        let root_guard = open(&root, false, true).unwrap();
        let archive_guard = open(&archive, false, true).unwrap();
        let file = open(&source, true, false).unwrap();
        save_new(&archive.join("before.json"), b"retained").unwrap();
        rename_held(&file, &archive.join("0.retired")).unwrap();
        assert!(!source.exists());
        assert!(fs::rename(&root, temp.path().join("replacement")).is_err());
        drop((file, root_guard, archive_guard));
        assert_eq!(fs::read(archive.join("0.retired")).unwrap(), b"fixture");
    }

    #[test]
    fn journal_is_create_new_never_overwrites_existing_evidence() {
        let temp = tempfile::tempdir().unwrap();
        let journal = temp.path().join("before.json");
        save_new(&journal, b"original").unwrap();
        assert!(save_new(&journal, b"different").is_err());
        assert_eq!(fs::read(journal).unwrap(), b"original");
    }

    #[test]
    #[ignore = "Retires only pinned synthetic installations on the fenced disposable retention runner"]
    fn native_windows_pinned_retirement() {
        for (name, expected) in [
            ("GITHUB_ACTIONS", "true"),
            ("RUNNER_ENVIRONMENT", "github-hosted"),
            ("RUNNER_OS", "Windows"),
            ("RUNNER_ARCH", "X64"),
            ("GITHUB_REPOSITORY", "BOBWORKS-XR/CREATOR-HUB"),
            ("GITHUB_REF", "refs/heads/validation/legacy-retention-014"),
            ("CREATOR_LEGACY_RETENTION_EXPERIMENT", "1"),
            ("CREATOR_LEGACY_RETIREMENT_EXPERIMENT", "1"),
        ] {
            assert_eq!(
                std::env::var(name).as_deref(),
                Ok(expected),
                "disposable runner required before inspection"
            );
        }
        let app = match std::env::var("CREATOR_LEGACY_RETENTION_PRODUCT").as_deref() {
            Ok("mcp") => AppId::Mcp,
            Ok("setup") => AppId::Setup,
            _ => panic!("exact isolated fixture product required before inspection"),
        };
        let installed = legacy::inspect().unwrap();
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].app(), app);
        let plan = RetirementPlan::inspect(app).unwrap();
        assert!(plan
            .retire_after_native_review(|| Err("synthetic cancelled native review".into()))
            .is_err());
        assert!(plan.root.join("uninstall.exe").exists());
        assert!(plan.root.join(app.exe()).exists());
        assert!(!plan.archive.join("before.json").exists());
        let mut existing = (app == AppId::Mcp).then(|| LegacySession::start(&plan.root));
        if let Some(session) = &mut existing {
            session.tools(2);
        }
        // Simulate interruption immediately after the destructive uninstaller
        // is moved. There is never a server removal/restore interval.
        let mut checks = 0;
        let interrupted = plan.retire_after_native_review(|| {
            checks += 1;
            if checks == 3 {
                Err("synthetic interruption after first durable move".into())
            } else {
                Ok(())
            }
        });
        assert!(interrupted.is_err());
        assert!(plan.archive.join("before.json").exists());
        assert!(plan.archive.join("0.retired").exists());
        assert!(!plan.root.join("uninstall.exe").exists());
        let journal = plan.archive.join("before.json");
        let original = fs::read(&journal).unwrap();
        fs::write(&journal, b"{\"policy\":999}").unwrap();
        assert!(
            RetirementPlan::inspect(app).is_err(),
            "unknown journal must never replay a cleanup"
        );
        assert_eq!(fs::read(&journal).unwrap(), b"{\"policy\":999}");
        assert!(plan.root.join(app.exe()).exists());
        // Restore only the evidence this synthetic fixture deliberately changed.
        fs::write(&journal, original).unwrap();
        if let Some(session) = &mut existing {
            session.tools(3);
        }
        let resumed = RetirementPlan::inspect(app).unwrap();
        resumed.retire_after_native_review(|| Ok(())).unwrap();
        assert!(platform::registered(app).unwrap().is_empty());
        assert!(!plan.root.join(app.exe()).exists());
        resumed.recheck().unwrap();
        let repeated = RetirementPlan::inspect(app).unwrap();
        repeated.retire_after_native_review(|| Ok(())).unwrap();
        if let Some(mut session) = existing {
            session.tools(4);
            session.close();
            let mut reconnected = LegacySession::start(&plan.root);
            reconnected.tools(2);
            reconnected.close();
            println!("Existing legacy stdio survived retirement and interrupted retry; same-path Node reconnection and normal EOF shutdown passed.");
        }
        println!("Pinned GUI retirement, durable interruption/resume and idempotent retry passed; compatibility resources retained in place.");
    }
}
