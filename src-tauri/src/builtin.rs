//! Build-bound internal modules; installed-app presence and remote feeds confer no authority.
use crate::{
    catalog::AppId,
    manager::{AppState, Snapshot},
    platform,
};
use serde::Deserialize;
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
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Module {
    executable: String,
    version: String,
    files: BTreeMap<String, String>,
}
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
    if entry.executable != expected
        || semver::Version::parse(&entry.version).is_err()
        || !entry.files.contains_key(&entry.executable)
        || entry.files.len() > 32
    {
        return Err("Invalid built-in module identity.".into());
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
