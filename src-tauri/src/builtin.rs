//! Build-bound internal modules; installed-app presence and remote feeds confer no authority.
use crate::{
    catalog::AppId,
    manager::{AppState, Snapshot},
    platform,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use tauri::Manager as _;

const MANIFEST: &str = include_str!(concat!(env!("OUT_DIR"), "/builtin-manifest.json"));
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    platform: String,
    arch: String,
    modules: BTreeMap<String, Module>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Module {
    executable: String,
    version: String,
    files: BTreeMap<String, String>,
}
#[derive(Debug)]
pub struct Candidate {
    pub path: PathBuf,
    pub hash: String,
    pub version: String,
}
pub fn enabled() -> bool {
    MANIFEST.trim() != "null"
}
pub fn reject_legacy_management() -> Result<(), String> {
    if enabled() {
        Err("MCP and Project Setup are built into this Hub. Update Hub, not a separate app.".into())
    } else {
        Ok(())
    }
}
fn relative_file(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_./-".contains(&b))
        && name.split('/').all(|p| !matches!(p, "" | "." | ".."))
}
fn manifest() -> Result<Manifest, String> {
    let value: Manifest =
        serde_json::from_str(MANIFEST).map_err(|_| "Invalid built-in module descriptor.")?;
    let platform = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    if value.schema_version != 1
        || value.platform != platform
        || value.arch != std::env::consts::ARCH
        || value.modules.keys().map(String::as_str).collect::<Vec<_>>() != ["mcp", "setup"]
    {
        return Err("Built-in modules do not match this Hub platform.".into());
    }
    Ok(value)
}
fn verify(root: &Path, id: &str, entry: Module) -> Result<Candidate, String> {
    let binary = if id == "mcp" {
        "creator-works-mcp-launcher"
    } else {
        "creator-project-setup"
    };
    let expected = format!("{id}/{binary}{}", if cfg!(windows) { ".exe" } else { "" });
    let mut required = vec![expected.clone()];
    if id == "mcp" {
        required.extend([
            "mcp/server/creator-works-mcp.mjs".to_owned(),
            format!(
                "mcp/server/runtime/node{}",
                if cfg!(windows) { ".exe" } else { "" }
            ),
            "mcp/server/runtime/LICENSE".to_owned(),
            "mcp/server/runtime/VERSION".to_owned(),
            "mcp/server/unity-extension/Editor/BanterMCPBridge.cs".to_owned(),
            "mcp/server/unity-extension/Editor/CreatorWorksMCPLogo.png".to_owned(),
            "mcp/server/LICENSE".to_owned(),
            "mcp/server/THIRD_PARTY_NOTICES.md".to_owned(),
        ]);
    }
    required.sort();
    if entry.executable != expected
        || semver::Version::parse(&entry.version).is_err()
        || entry.files.keys().cloned().collect::<Vec<_>>() != required
    {
        return Err("Invalid or incomplete built-in module identity.".into());
    }
    for (name, hash) in &entry.files {
        if !relative_file(name)
            || !name.starts_with(&format!("{id}/"))
            || !crate::catalog::hash_valid(hash)
        {
            return Err("Invalid built-in module file.".into());
        }
        let file = root.join(name);
        platform::reject_links(&file)?;
        if crate::manager::file_hash(&file)? != *hash {
            return Err(format!(
                "Built-in {id} payload changed: {name}. Reinstall this Hub; nothing was opened."
            ));
        }
    }
    Ok(Candidate {
        path: root.join(&entry.executable),
        hash: entry.files[&entry.executable].clone(),
        version: entry.version,
    })
}
pub fn candidate(handle: &tauri::AppHandle, app: AppId) -> Result<Option<Candidate>, String> {
    if !enabled() {
        return Ok(None);
    }
    let id = if app == AppId::Mcp { "mcp" } else { "setup" };
    let entry = manifest()?
        .modules
        .remove(id)
        .ok_or("Missing built-in module.")?;
    let root = handle
        .path()
        .resource_dir()
        .map_err(|_| "Cannot locate Hub resources.")?
        .join("modules");
    verify(&root, id, entry).map(Some)
}

// Only startup stages payloads. Inventory remains read-only, and no generation
// is repaired or deleted: an existing AI connection may still depend on it.
pub fn hosting_candidate(
    handle: &tauri::AppHandle,
    app: AppId,
) -> Result<Option<Candidate>, String> {
    if !enabled() || app != AppId::Mcp {
        return candidate(handle, app);
    }
    let entry = manifest()?
        .modules
        .remove("mcp")
        .ok_or("Missing MCP module.")?;
    let source = handle
        .path()
        .resource_dir()
        .map_err(|_| "Cannot locate Hub resources.")?
        .join("modules");
    let generations = dirs::data_local_dir()
        .ok_or("Local app data is unavailable.")?
        .join("creator-hub")
        .join("runtime-generations")
        .join(format!(
            "{}-{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        ));
    prepare_generation(&source, &generations, entry).map(Some)
}

fn generation_id(entry: &Module) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let bytes = serde_json::to_vec(entry).map_err(|_| "Cannot identify runtime generation.")?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

struct PreparationGuard(std::fs::File);

impl Drop for PreparationGuard {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.0);
    }
}

fn prepare_generation(
    source: &Path,
    generations: &Path,
    entry: Module,
) -> Result<Candidate, String> {
    use fs2::FileExt;
    use std::fs::{self, OpenOptions};
    if !generations.is_absolute() {
        return Err("Runtime storage must be an absolute path.".into());
    }
    verify(source, "mcp", entry.clone())?;
    platform::reject_links(generations)?;
    fs::create_dir_all(generations).map_err(|_| "Cannot create runtime storage.")?;
    platform::reject_links(generations)?;
    let lock_path = generations.join("prepare.lock");
    platform::reject_links(&lock_path)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|_| "Cannot open runtime preparation lock.")?;
    lock.try_lock_exclusive()
        .map_err(|_| "Another Hub is preparing its runtime. Retry after it finishes.")?;
    let _guard = PreparationGuard(lock);
    let target = generations.join(generation_id(&entry)?);
    platform::reject_links(&target)?;
    if target.exists() {
        return verify(&target, "mcp", entry);
    }
    let staging = tempfile::Builder::new()
        .prefix(".staging-")
        .tempdir_in(generations)
        .map_err(|_| "Cannot stage the runtime generation.")?;
    for name in entry.files.keys() {
        let from = source.join(name);
        platform::reject_links(&from)?;
        let to = staging.path().join(name);
        fs::create_dir_all(to.parent().ok_or("Invalid runtime file path.")?)
            .map_err(|_| "Cannot create staged runtime directory.")?;
        fs::copy(&from, &to).map_err(|_| format!("Cannot stage runtime file: {name}"))?;
        OpenOptions::new()
            .write(true)
            .open(&to)
            .and_then(|f| f.sync_all())
            .map_err(|_| "Cannot flush the staged runtime.")?;
    }
    verify(staging.path(), "mcp", entry.clone())?;
    // A partial directory never becomes an executable candidate. Same-volume
    // rename publishes only a complete, byte-verified generation.
    platform::reject_links(&target)?;
    fs::rename(staging.path(), &target).map_err(|_| "Cannot publish runtime generation.")?;
    verify(&target, "mcp", entry)
}
pub fn inventory(handle: &tauri::AppHandle) -> Result<Option<Snapshot>, String> {
    if !enabled() {
        return Ok(None);
    }
    let apps = AppId::ALL
        .into_iter()
        .map(|app| {
            let result = candidate(handle, app);
            let (candidate, issue) = match result {
                Ok(value) => (value, None),
                Err(error) => (None, Some(error)),
            };
            let version = candidate.as_ref().map(|c| c.version.clone());
            AppState {
                app,
                built_in: true,
                installed_version: version.clone(),
                available_version: version.unwrap_or_default(),
                installed: candidate.is_some(),
                trusted: candidate.is_some(),
                running: false,
                update_blockers: Vec::new(),
                update_available: false,
                downloaded: false,
                issue,
                check_warning: None,
                installer_interactive: false,
                install_blocked: None,
                required_hub_version: None,
                installed_path: candidate.map(|c| c.path),
                detected_copies: Vec::new(),
                hosted_preview: crate::hosted::preview_mode(app),
                hosted_compatible: Some(true),
            }
        })
        .collect();
    Ok(Some(Snapshot {
        supported: platform::supported(),
        apps,
    }))
}
#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    fn entry() -> Module {
        let executable = format!(
            "setup/creator-project-setup{}",
            if cfg!(windows) { ".exe" } else { "" }
        );
        Module {
            executable: executable.clone(),
            version: "0.3.7".into(),
            files: BTreeMap::from([(executable, format!("{:x}", Sha256::digest(b"fixture")))]),
        }
    }
    #[test]
    fn only_exact_present_unchanged_module_files_are_accepted() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        std::fs::create_dir(root.join("setup")).unwrap();
        assert!(verify(&root, "setup", entry()).is_err());
        let file = root.join(entry().executable);
        std::fs::write(&file, b"fixture").unwrap();
        assert!(verify(&root, "setup", entry()).is_ok());
        std::fs::write(&file, b"tampered").unwrap();
        assert!(verify(&root, "setup", entry()).is_err());
    }
    #[test]
    fn descriptor_paths_and_identity_cannot_escape_module() {
        for name in [
            "../setup",
            "/setup",
            "C:/setup",
            "setup//file",
            "setup/./file",
            "setup\\file",
        ] {
            assert!(!relative_file(name));
        }
        let root = Path::new("/");
        let mut module = entry();
        module.executable = "setup/other".into();
        assert!(verify(root, "setup", module).is_err());
        let mut module = entry();
        module.version = "invalid".into();
        assert!(verify(root, "setup", module).is_err());
    }

    #[test]
    fn mcp_cannot_be_ready_without_the_server_runtime_and_bridge() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        std::fs::create_dir(root.join("mcp")).unwrap();
        let executable = format!(
            "mcp/creator-works-mcp-launcher{}",
            if cfg!(windows) { ".exe" } else { "" }
        );
        std::fs::write(root.join(&executable), b"fixture").unwrap();
        let module = Module {
            executable: executable.clone(),
            version: "2.7.7".into(),
            files: BTreeMap::from([(executable, format!("{:x}", Sha256::digest(b"fixture")))]),
        };
        assert!(verify(&root, "mcp", module)
            .unwrap_err()
            .contains("incomplete"));
    }

    fn mcp_fixture(root: &Path, bytes: &[u8]) -> Module {
        let extension = if cfg!(windows) { ".exe" } else { "" };
        let executable = format!("mcp/creator-works-mcp-launcher{extension}");
        let names = [
            executable.clone(),
            "mcp/server/creator-works-mcp.mjs".into(),
            format!("mcp/server/runtime/node{extension}"),
            "mcp/server/runtime/LICENSE".into(),
            "mcp/server/runtime/VERSION".into(),
            "mcp/server/unity-extension/Editor/BanterMCPBridge.cs".into(),
            "mcp/server/unity-extension/Editor/CreatorWorksMCPLogo.png".into(),
            "mcp/server/LICENSE".into(),
            "mcp/server/THIRD_PARTY_NOTICES.md".into(),
        ];
        let files = names
            .iter()
            .map(|name| {
                let file = root.join(name);
                std::fs::create_dir_all(file.parent().unwrap()).unwrap();
                std::fs::write(file, bytes).unwrap();
                (name.clone(), format!("{:x}", Sha256::digest(bytes)))
            })
            .collect::<BTreeMap<_, _>>();
        Module {
            executable,
            version: "2.7.7".into(),
            files,
        }
    }

    #[test]
    fn complete_mcp_payload_is_accepted_and_every_component_is_verified() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let entry = mcp_fixture(&root, b"fixture");
        assert!(verify(&root, "mcp", entry.clone()).is_ok());
        for name in entry.files.keys() {
            let file = root.join(&name);
            std::fs::write(&file, b"tampered").unwrap();
            assert!(verify(&root, "mcp", entry.clone()).is_err(), "{name}");
            std::fs::remove_file(&file).unwrap();
            assert!(verify(&root, "mcp", entry.clone()).is_err(), "{name}");
            std::fs::write(file, b"fixture").unwrap();
        }
        assert!(verify(&root, "mcp", entry).is_ok());
    }

    #[test]
    fn runtime_generations_survive_package_replacement_and_are_reused() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let source = root.join("package");
        let storage = root.join("generations");
        let first = mcp_fixture(&source, b"old runtime");
        let candidate = prepare_generation(&source, &storage, first.clone()).unwrap();
        let reused = prepare_generation(&source, &storage, first.clone()).unwrap();
        assert_eq!(candidate.path, reused.path);
        // Same displayed version, different bytes: never replace the old runtime.
        let second = mcp_fixture(&source, b"new runtime");
        let next = prepare_generation(&source, &storage, second.clone()).unwrap();
        assert_ne!(candidate.path, next.path);
        let old_root = candidate.path.parent().unwrap().parent().unwrap();
        assert!(verify(old_root, "mcp", first).is_ok());
        std::fs::remove_dir_all(&source).unwrap();
        assert!(candidate.path.is_file());
        assert!(next.path.is_file());
        assert!(verify(next.path.parent().unwrap().parent().unwrap(), "mcp", second).is_ok());
    }

    #[test]
    fn corrupt_existing_generation_is_not_repaired_or_launched() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let source = root.join("package");
        let storage = root.join("generations");
        let entry = mcp_fixture(&source, b"fixture");
        let candidate = prepare_generation(&source, &storage, entry.clone()).unwrap();
        std::fs::write(&candidate.path, b"changed").unwrap();
        assert!(prepare_generation(&source, &storage, entry.clone()).is_err());
        assert_eq!(std::fs::read(&candidate.path).unwrap(), b"changed");
        std::fs::remove_file(&candidate.path).unwrap();
        assert!(prepare_generation(&source, &storage, entry).is_err());
        assert!(!candidate.path.exists());
    }

    #[test]
    fn abandoned_staging_is_never_selected_and_a_retry_can_succeed() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let source = root.join("package");
        let storage = root.join("generations");
        let entry = mcp_fixture(&source, b"fixture");
        let abandoned = storage.join(".staging-interrupted");
        std::fs::create_dir_all(&abandoned).unwrap();
        std::fs::write(abandoned.join("partial"), b"keep").unwrap();
        let candidate = prepare_generation(&source, &storage, entry).unwrap();
        assert!(!candidate.path.starts_with(&abandoned));
        assert_eq!(std::fs::read(abandoned.join("partial")).unwrap(), b"keep");
    }

    #[test]
    fn invalid_source_publishes_nothing_and_does_not_touch_previous_runtime() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let source = root.join("package");
        let storage = root.join("generations");
        let entry = mcp_fixture(&source, b"fixture");
        let old = prepare_generation(&source, &storage, entry.clone()).unwrap();
        let changed = mcp_fixture(&source, b"new");
        std::fs::remove_file(source.join("mcp/server/creator-works-mcp.mjs")).unwrap();
        assert!(prepare_generation(&source, &storage, changed.clone()).is_err());
        assert!(!storage.join(generation_id(&changed).unwrap()).exists());
        assert!(verify(old.path.parent().unwrap().parent().unwrap(), "mcp", entry).is_ok());
    }

    #[test]
    fn concurrent_runtime_preparation_refuses_without_modifying_files() {
        use fs2::FileExt;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let source = root.join("package");
        let storage = root.join("generations");
        let entry = mcp_fixture(&source, b"fixture");
        std::fs::create_dir(&storage).unwrap();
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(storage.join("prepare.lock"))
            .unwrap();
        lock.lock_exclusive().unwrap();
        let duplicate = lock.try_clone().unwrap();
        let guard = PreparationGuard(lock);
        assert!(prepare_generation(&source, &storage, entry.clone())
            .unwrap_err()
            .contains("Another Hub"));
        assert!(!storage.join(generation_id(&entry).unwrap()).exists());
        drop(guard);
        assert!(prepare_generation(&source, &storage, entry).is_ok());
        drop(duplicate);
    }

    #[cfg(windows)]
    #[test]
    fn runtime_storage_junction_is_rejected_without_writing_through_it() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let source = root.join("package");
        let entry = mcp_fixture(&source, b"fixture");
        let real = root.join("outside");
        std::fs::create_dir(&real).unwrap();
        let link = root.join("generations");
        let result = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&real)
            .output()
            .unwrap();
        assert!(result.status.success());
        assert!(prepare_generation(&source, &link, entry).is_err());
        assert_eq!(std::fs::read_dir(&real).unwrap().count(), 0);
        std::fs::remove_dir(&link).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn even_matching_bytes_behind_a_junction_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let real = root.join("real");
        std::fs::create_dir(&real).unwrap();
        let filename = Path::new(&entry().executable)
            .file_name()
            .unwrap()
            .to_owned();
        std::fs::write(real.join(filename), b"fixture").unwrap();
        let link = root.join("setup");
        let result = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&real)
            .output()
            .unwrap();
        assert!(result.status.success());
        assert!(verify(&root, "setup", entry()).is_err());
        std::fs::remove_dir(link).unwrap();
    }
}
