//! Removal is limited to exact published Windows payloads. The caller separately
//! owns native approval, retained-data and effective client-dependency checks.
use crate::{catalog::AppId, platform};
use sha2::{Digest, Sha256};
#[cfg(windows)]
use std::time::{Duration, Instant};
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::Read,
    path::{Component, Path, PathBuf},
    time::SystemTime,
};

struct Pin {
    app: AppId,
    version: &'static str,
    files: &'static [(&'static str, u64, &'static str)],
}

#[cfg(windows)]
fn uninstall_command(path: &Path) -> Result<std::process::Command, String> {
    let system = PathBuf::from(
        std::env::var_os("SystemRoot").ok_or("Windows system directory unavailable.")?,
    );
    let mut command = platform::command(path);
    command.current_dir(system.join("System32")).env_clear();
    for name in [
        "SystemRoot",
        "windir",
        "SystemDrive",
        "ComSpec",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "HOMEDRIVE",
        "HOMEPATH",
        "USERNAME",
        "USERDOMAIN",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "PROCESSOR_ARCHITECTURE",
        "TEMP",
        "TMP",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command.env("PATH", system.join("System32"));
    Ok(command)
}

// Captured after fresh installation of the immutable public installers, run
// 38487590987. No runtime manifest or registry value can replace these pins.
const MCP: Pin = Pin {
    app: AppId::Mcp,
    version: "2.7.7",
    files: &[
        (
            "creator-works-mcp-launcher.exe",
            17_763_840,
            "765ad40681c9ad69f2748ce5e9873b59971488acdd3f826e90946af835e36af9",
        ),
        (
            "server/creator-works-mcp.mjs",
            1_221_209,
            "8d7cbe21d3b3691d6b1aa052846d6ee36f4274c18bd4228c6d4a73583be74149",
        ),
        (
            "server/LICENSE",
            1089,
            "7e1bc8fb937a3324de67fb2439b8e943dda3efc6b62684da2697e1bfcfe7414e",
        ),
        (
            "server/runtime/LICENSE",
            159_872,
            "8efdacdc1cfa3460aeb7fe98e3c54337b971d5da70e6eee292b73b981acb220c",
        ),
        (
            "server/runtime/node",
            92_299_080,
            "c6335d08331c23d68b9f2b18adb102002d76ef150b47248e954c507e0d033664",
        ),
        (
            "server/runtime/node.exe",
            92_299_080,
            "c6335d08331c23d68b9f2b18adb102002d76ef150b47248e954c507e0d033664",
        ),
        (
            "server/runtime/VERSION",
            8,
            "98182b41c9ce3357797985cf12dc3b0124490ef88bc918a905373e7688e6aec9",
        ),
        (
            "server/THIRD_PARTY_NOTICES.md",
            7510,
            "e3f3e45a54b2d67fa1cc108ca38c320534c5cc09cd11fb23e1b6c55ead7879fb",
        ),
        (
            "server/unity-extension/Editor/BanterMCPBridge.cs",
            366_125,
            "0fbae419bb9e1a88d6d86404708d0e84414796bbb4fdbb95874ca88a4f93d1c2",
        ),
        (
            "server/unity-extension/Editor/CreatorWorksMCPLogo.png",
            52_329,
            "f3f68baa0d887de92e6cf7aba8beae7ff8ea5c44b13444f018413041ade19ea7",
        ),
        (
            "uninstall.exe",
            70_977,
            "8ab62d3fac6dffd9234e5f54bbc19b7388fe84a341aceae086d9dca87afb8114",
        ),
    ],
};
const SETUP: Pin = Pin {
    app: AppId::Setup,
    version: "0.3.7",
    files: &[
        (
            "creator-project-setup.exe",
            13_095_936,
            "74653db61681e29a18a308c393e1b8790a86a7ed674ca6abe73f35da0a0f4ed6",
        ),
        (
            "uninstall.exe",
            67_714,
            "f8070d8e017032bcca3f91b3b0aa451780583dc7ab7503c16f7f7a3dee1e82b5",
        ),
    ],
};

#[derive(PartialEq, Eq)]
struct FileIdentity {
    created: Option<SystemTime>,
    modified: SystemTime,
    bytes: u64,
}
fn identity(file: &File) -> Result<FileIdentity, String> {
    let meta = file
        .metadata()
        .map_err(|_| "Cannot inspect the old app file.")?;
    if !meta.is_file() {
        return Err("The old app payload is not a regular file.".into());
    }
    Ok(FileIdentity {
        created: {
            let created = meta.created().ok();
            if cfg!(windows) && created.is_none() {
                return Err("Cannot verify old app file identity.".into());
            }
            created
        },
        modified: meta
            .modified()
            .map_err(|_| "Cannot verify old app file identity.")?,
        bytes: meta.len(),
    })
}
fn protected_file(path: &Path) -> Result<File, String> {
    platform::reject_links(path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1);
    }
    options
        .open(path)
        .map_err(|_| "Cannot reserve the exact old app file; it was kept.".into())
}
fn verify_file(path: &Path, bytes: u64, expected: &str) -> Result<FileIdentity, String> {
    let mut file = protected_file(path)?;
    let before = identity(&file)?;
    if before.bytes != bytes {
        return Err("An old app payload differs from the accepted release; it was kept.".into());
    }
    let mut hash = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| "Cannot hash the old app payload.")?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    if before != identity(&file)? || format!("{:x}", hash.finalize()) != expected {
        return Err("The old app payload is changed or unverified; it was kept.".into());
    }
    Ok(before)
}

fn inventory(root: &Path, files: &[(&str, u64, &str)]) -> Result<(), String> {
    platform::reject_links(root)?;
    let expected: BTreeSet<PathBuf> = files.iter().map(|(name, _, _)| root.join(name)).collect();
    let mut directories = BTreeSet::new();
    for path in &expected {
        let mut parent = path.parent();
        while let Some(path) = parent.filter(|path| *path != root) {
            if !path.starts_with(root) {
                return Err("Invalid legacy payload pin.".into());
            }
            directories.insert(path.to_path_buf());
            parent = path.parent();
        }
    }
    let mut seen = BTreeSet::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory).map_err(|_| "Cannot inspect old app contents.")? {
            let entry = entry.map_err(|_| "Cannot inspect an old app entry.")?;
            let path = entry.path();
            platform::reject_links(&path)?;
            let meta =
                fs::symlink_metadata(&path).map_err(|_| "Cannot inspect an old app entry.")?;
            if meta.is_dir() && directories.contains(&path) {
                pending.push(path);
            } else if meta.is_file() && expected.contains(&path) {
                seen.insert(path);
            } else {
                return Err(
                    "Old app contents include custom or unexpected files; removal was refused."
                        .into(),
                );
            }
        }
    }
    if seen != expected {
        return Err("The old app payload is incomplete; it was kept.".into());
    }
    for (name, bytes, hash) in files {
        verify_file(&root.join(name), *bytes, hash)?;
    }
    Ok(())
}

fn uninstall_arguments(root: &Path) -> Result<String, String> {
    let text = root
        .to_str()
        .ok_or("Uninstall path cannot be represented.")?;
    if !root.is_absolute() || root.components().any(|part| part == Component::ParentDir)
        || text.starts_with("\\\\") || text.starts_with("//")
        || text.chars().any(|c| c.is_control() || matches!(c, '"' | '<' | '>' | '|' | '?' | '*'))
        || text.get(2..).is_some_and(|rest| rest.contains(':'))
        || root.components().any(|part| matches!(part, Component::Normal(name) if name.to_string_lossy().ends_with(['.', ' '])))
    {
        return Err("An exact ordinary local uninstall path is required.".into());
    }
    Ok(format!("/S _?={text}"))
}

pub(super) struct Plan {
    pin: &'static Pin,
    root: PathBuf,
    root_created: SystemTime,
    uninstaller: FileIdentity,
}
impl Plan {
    pub(super) fn app(&self) -> AppId {
        self.pin.app
    }
    pub(super) fn root(&self) -> &Path {
        &self.root
    }
    pub(super) fn recheck(&self) -> Result<(), String> {
        if registration(self.pin)?.as_deref() != Some(&self.root) {
            return Err("The old app registration changed; removal was refused.".into());
        }
        platform::reject_links(&self.root)?;
        if fs::metadata(&self.root)
            .and_then(|m| m.created())
            .map_err(|_| "Cannot recheck old app directory.")?
            != self.root_created
        {
            return Err("The old app directory identity changed; removal was refused.".into());
        }
        inventory(&self.root, self.pin.files)?;
        let (_, bytes, hash) = self
            .pin
            .files
            .iter()
            .find(|(name, _, _)| *name == "uninstall.exe")
            .unwrap();
        if verify_file(&self.root.join("uninstall.exe"), *bytes, hash)? != self.uninstaller {
            return Err("The exact uninstaller changed; removal was refused.".into());
        }
        Ok(())
    }

    #[cfg(windows)]
    pub(super) fn remove_after_native_review(
        &self,
        mut preflight: impl FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        use std::os::windows::process::CommandExt;
        self.recheck()?;
        preflight()?;
        let running = platform::running(self.pin.app, &self.root.join(self.pin.app.exe()))?;
        if !running.gui.is_empty() || running.server || running.other_copy {
            return Err(
                "An old app or MCP connection is still active. No process was stopped.".into(),
            );
        }
        let uninstaller = self.root.join("uninstall.exe");
        let reserved = protected_file(&uninstaller)?;
        if identity(&reserved)? != self.uninstaller {
            return Err("Uninstaller identity changed; removal was refused.".into());
        }
        self.recheck()?;
        preflight()?;
        let mut command = uninstall_command(&uninstaller)?;
        command.raw_arg(uninstall_arguments(&self.root)?);
        let mut child = command
            .spawn()
            .map_err(|_| "The exact old-app uninstaller could not start.")?;
        let deadline = Instant::now() + Duration::from_secs(180);
        let status = loop {
            if let Some(status) = child
                .try_wait()
                .map_err(|_| "Uninstaller exit could not be observed; inspect before retrying.")?
            {
                break status;
            }
            if Instant::now() >= deadline {
                return Err("Uninstaller is still running. It was not killed; inspect its outcome before retrying.".into());
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        let still_registered = registration(self.pin)?.is_some();
        if !status.success() || still_registered {
            return Err(format!("Old-app removal did not complete (exit {:?}, registration remains: {still_registered}). Keep retained backups and inspect the installation.", status.code()));
        }
        for (name, _, _) in self
            .pin
            .files
            .iter()
            .filter(|(name, _, _)| *name != "uninstall.exe")
        {
            if self
                .root
                .join(name)
                .try_exists()
                .map_err(|_| "Cannot verify old payload absence.")?
            {
                return Err(
                    "An old payload survived uninstall. No cleanup deletion was attempted.".into(),
                );
            }
        }
        // _?= intentionally leaves the generated uninstaller. Remove only this
        // exact residual file, then a truly empty directory, never a tree.
        drop(reserved);
        platform::reject_links(&self.root)?;
        if fs::metadata(&self.root)
            .and_then(|m| m.created())
            .map_err(|_| "Cannot verify uninstall directory identity.")?
            != self.root_created
        {
            return Err("Uninstall directory identity changed; residual file was kept.".into());
        }
        let (_, bytes, hash) = self
            .pin
            .files
            .iter()
            .find(|(name, _, _)| *name == "uninstall.exe")
            .unwrap();
        if verify_file(&uninstaller, *bytes, hash)? != self.uninstaller {
            return Err("Residual uninstaller identity changed; it was kept.".into());
        }
        if fs::read_dir(&self.root)
            .map_err(|_| "Cannot inspect residual uninstall directory.")?
            .count()
            != 1
        {
            return Err(
                "Unexpected residual app contents were kept; no cleanup deletion was attempted."
                    .into(),
            );
        }
        fs::remove_file(&uninstaller)
            .map_err(|_| "Exact residual uninstaller could not be removed.")?;
        fs::remove_dir(&self.root).map_err(|_| "Empty old app directory could not be removed.")?;
        preflight()?;
        Ok(())
    }
}

#[cfg(windows)]
fn registration(pin: &Pin) -> Result<Option<PathBuf>, String> {
    use winreg::{enums::*, RegKey};
    let root = platform::default_exe(pin.app)?
        .parent()
        .ok_or("Invalid old app directory.")?
        .to_path_buf();
    uninstall_arguments(&root)?;
    let expected_location = format!("\"{}\"", root.display());
    let expected_uninstall = format!("\"{}\"", root.join("uninstall.exe").display());
    let mut found = false;
    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
            let key = format!(
                "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{}",
                pin.app.name()
            );
            let key = match RegKey::predef(hive).open_subkey_with_flags(key, KEY_READ | view) {
                Ok(key) => key,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => {
                    return Err("Cannot inspect old app registration; removal refused.".into())
                }
            };
            let value = |name| {
                key.get_value::<String, _>(name)
                    .map_err(|_| "Old app registration is incomplete.")
            };
            if hive != HKEY_CURRENT_USER
                || value("DisplayName")? != pin.app.name()
                || value("DisplayVersion")? != pin.version
                || value("Publisher")? != "Creator Works"
                || value("InstallLocation")? != expected_location
                || value("UninstallString")? != expected_uninstall
                || key.get_raw_value("QuietUninstallString").is_ok()
            {
                return Err("Old app registration is custom or unverified; it was kept.".into());
            }
            found = true;
        }
    }
    Ok(found.then_some(root))
}
#[cfg(not(windows))]
fn registration(_: &Pin) -> Result<Option<PathBuf>, String> {
    Err("This removal adapter accepts Windows only.".into())
}

pub(super) fn inspect() -> Result<Vec<Plan>, String> {
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return Err("Native old-app removal is not accepted on this platform yet.".into());
    }
    let mut plans = Vec::new();
    for pin in [&MCP, &SETUP] {
        let registered = platform::registered(pin.app)?;
        let Some(root) = registration(pin)? else {
            if !registered.is_empty()
                || platform::default_exe(pin.app)?
                    .try_exists()
                    .map_err(|_| "Cannot inspect old app presence.")?
            {
                return Err(
                    "An unverified old app was kept; automatic removal was refused.".into(),
                );
            }
            continue;
        };
        if registered.len() != 1 || !platform::same_path(&registered[0], &root.join(pin.app.exe()))
        {
            return Err("Multiple or custom old app locations were kept.".into());
        }
        inventory(&root, pin.files)?;
        let root_created = fs::metadata(&root)
            .and_then(|m| m.created())
            .map_err(|_| "Cannot capture old app directory identity.")?;
        let (_, bytes, hash) = pin
            .files
            .iter()
            .find(|(name, _, _)| *name == "uninstall.exe")
            .unwrap();
        let uninstaller = verify_file(&root.join("uninstall.exe"), *bytes, hash)?;
        plans.push(Plan {
            pin,
            root,
            root_created,
            uninstaller,
        });
    }
    Ok(plans)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nsis_final_directory_argument_is_unquoted_and_rejects_aliases() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("App With Spaces");
        assert_eq!(
            uninstall_arguments(&root).unwrap(),
            format!("/S _?={}", root.display())
        );
        for bad in [
            root.join(".."),
            root.join("quoted\"app"),
            root.join("trailing."),
            root.join("trailing "),
        ] {
            assert!(uninstall_arguments(&bad).is_err());
        }
        assert!(uninstall_arguments(Path::new("relative/app")).is_err());
    }
    #[test]
    fn inventory_requires_exact_bounded_files_and_refuses_extra_content() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("legacy");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("owned.exe"), b"exact").unwrap();
        let hash = format!("{:x}", Sha256::digest(b"exact"));
        let pins = [("owned.exe", 5, hash.as_str())];
        inventory(&root, &pins).unwrap();
        fs::write(root.join("custom.txt"), b"kept").unwrap();
        assert!(inventory(&root, &pins).is_err());
        assert_eq!(fs::read(root.join("custom.txt")).unwrap(), b"kept");
        fs::remove_file(root.join("custom.txt")).unwrap();
        fs::write(root.join("owned.exe"), b"other").unwrap();
        assert!(inventory(&root, &pins).is_err());
    }
    #[test]
    fn payload_pins_have_unique_paths_and_exact_hashes() {
        for pin in [&MCP, &SETUP] {
            let paths: BTreeSet<_> = pin.files.iter().map(|(name, _, _)| *name).collect();
            assert_eq!(paths.len(), pin.files.len());
            assert!(paths.contains("uninstall.exe"));
            assert!(paths.contains(pin.app.exe()));
            for (name, bytes, hash) in pin.files {
                assert!(
                    !name.starts_with('/')
                        && !name.contains("..")
                        && *bytes > 0
                        && *bytes <= 128 * 1024 * 1024
                );
                assert_eq!(hash.len(), 64);
                assert!(hash.bytes().all(|c| c.is_ascii_hexdigit()));
            }
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "Removes only pinned synthetic installations on the explicitly fenced disposable retention runner"]
    fn native_windows_pinned_removal() {
        for (name, expected) in [
            ("GITHUB_ACTIONS", "true"),
            ("RUNNER_ENVIRONMENT", "github-hosted"),
            ("RUNNER_OS", "Windows"),
            ("RUNNER_ARCH", "X64"),
            ("GITHUB_REPOSITORY", "BOBWORKS-XR/CREATOR-HUB"),
            ("GITHUB_REF", "refs/heads/validation/legacy-retention-014"),
            ("CREATOR_LEGACY_RETENTION_EXPERIMENT", "1"),
        ] {
            assert_eq!(
                std::env::var(name).as_deref(),
                Ok(expected),
                "disposable runner required before inspection"
            );
        }
        let expected = match std::env::var("CREATOR_LEGACY_RETENTION_PRODUCT").as_deref() {
            Ok("mcp") => AppId::Mcp,
            Ok("setup") => AppId::Setup,
            _ => panic!("exact fixture product required before inspection"),
        };
        let plans = inspect().unwrap();
        assert_eq!(plans.len(), 1, "only the isolated fixture may be installed");
        assert_eq!(plans[0].app(), expected);
        if expected == AppId::Mcp {
            // Read-only diagnostic using the exact public preflight source.
            // This is not a substitute for the uninstaller's own guard.
            let source = include_bytes!(
                "../../modules/mcp/launcher/src-tauri/windows/installer-preflight.ps1"
            );
            let temp = tempfile::tempdir().unwrap();
            let script = temp.path().join("public-preflight.ps1");
            fs::write(&script, source).unwrap();
            let powershell = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
                .join("System32/WindowsPowerShell/v1.0/powershell.exe");
            let mut command = uninstall_command(&powershell).unwrap();
            let output = command
                .args([
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                ])
                .arg(&script)
                .arg("-InstallDir")
                .arg(plans[0].root())
                .output()
                .unwrap();
            assert!(output.stdout.len() <= 65536 && output.stderr.len() <= 65536);
            println!(
                "Read-only MCP preflight: exit {:?}; stdout {:?}; stderr {:?}",
                output.status.code(),
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(
                output.status.success(),
                "read-only preflight refused; no uninstaller was started"
            );
        }
        // The outer native harness independently captures and compares every
        // synthetic retained-data directory before and after this exact adapter.
        plans[0].remove_after_native_review(|| Ok(())).unwrap();
        assert!(inspect().unwrap().is_empty());
    }
}
