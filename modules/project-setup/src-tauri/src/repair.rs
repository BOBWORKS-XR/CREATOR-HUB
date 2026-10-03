use crate::hub::{sha256, unique_id};
use crate::logic::{self, SetupProgress};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const VALIDATOR: &str = "Assets/Editor/CreatorProjectSetupValidator.cs";
const VS_SETTINGS: &str = "ProjectSettings/VisualScriptingSettings.asset";
const VS_GENERATED: &str = "Assets/Unity.VisualScripting.Generated";
const VS_DATABASE: &str =
    "Assets/Unity.VisualScripting.Generated/VisualScripting.Flow/UnitOptions.db";
const REGISTRY_SCOPES: &[&str] = &[
    "com.sidequest.creator-sdk",
    "com.basis.bundlemanagement",
    "com.basis.common",
    "com.basis.sdk",
    "com.sidequest.ora",
    "com.sidequest.thirdparty.bouncycastle",
];
const REVIEW_FILES: &[&str] = &[
    "ProjectSettings/ProjectVersion.txt",
    "Packages/manifest.json",
    "Packages/packages-lock.json",
    "ProjectSettings/GraphicsSettings.asset",
    "ProjectSettings/QualitySettings.asset",
    "ProjectSettings/ProjectSettings.asset",
    VS_SETTINGS,
    VS_DATABASE,
];

#[derive(Debug, Clone, Serialize)]
pub struct Finding {
    pub status: String,
    pub title: String,
    pub detail: String,
}
fn finding(status: &str, title: &str, detail: impl Into<String>) -> Finding {
    Finding {
        status: status.into(),
        title: title.into(),
        detail: detail.into(),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub project_path: String,
    pub fingerprint: String,
    pub editor_version: String,
    pub findings: Vec<Finding>,
    pub proposed_changes: Vec<String>,
    pub can_repair: bool,
    pub can_validate: bool,
    pub locked: bool,
    #[serde(skip)]
    manifest: Value,
    #[serde(skip)]
    manifest_changed: bool,
    #[serde(skip)]
    configure_vs: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingRequest {
    pub project_path: String,
    pub fingerprint: String,
    pub repair: bool,
    pub approved: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingResult {
    pub success: bool,
    pub project_path: String,
    pub backup_path: String,
    pub report_path: String,
    pub message: String,
    pub validation: Option<Value>,
}

pub(crate) fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(unc) = text.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{unc}")
    } else {
        text.trim_start_matches("\\\\?\\").to_owned()
    }
}

fn is_link(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    meta.file_type().is_symlink()
}

fn checked_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let mut path = root.to_path_buf();
    for part in Path::new(relative).components() {
        if !matches!(part, std::path::Component::Normal(_)) {
            return Err("Unsafe project path.".into());
        }
        path.push(part);
        match fs::symlink_metadata(&path) {
            Ok(meta) if is_link(&meta) => {
                return Err(format!(
                    "Linked files or folders need manual review: {}",
                    display_path(&path)
                ))
            }
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
            _ => {}
        }
    }
    Ok(path)
}

fn read(root: &Path, relative: &str) -> Result<Option<Vec<u8>>, String> {
    let path = checked_path(root, relative)?;
    match File::open(&path) {
        Ok(file) => {
            if file.metadata().map_err(|e| e.to_string())?.len() > 16 * 1024 * 1024 {
                return Err(format!("Configuration file is too large: {relative}"));
            }
            let mut bytes = Vec::new();
            file.take(16 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            Ok(Some(bytes))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Cannot read {relative}: {e}")),
    }
}

fn fingerprint(root: &Path) -> Result<String, String> {
    let mut digest = Sha256::new();
    digest.update(root.to_string_lossy().as_bytes());
    for relative in REVIEW_FILES {
        digest.update(relative.as_bytes());
        let path = checked_path(root, relative)?;
        match File::open(path) {
            Ok(mut file) => {
                digest.update(b"present");
                let mut bytes = [0u8; 32768];
                loop {
                    let n = file.read(&mut bytes).map_err(|e| e.to_string())?;
                    if n == 0 {
                        break;
                    }
                    digest.update(&bytes[..n]);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => digest.update(b"missing"),
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn package_plan(manifest: &Value) -> Result<(Value, Vec<String>, Vec<Finding>), String> {
    let mut updated = manifest.clone();
    let dependencies = updated
        .get_mut("dependencies")
        .and_then(Value::as_object_mut)
        .ok_or("Manifest has no dependencies object.")?;
    let mut changes = Vec::new();
    let mut findings = Vec::new();
    for name in dependencies.keys() {
        if name.contains("banter") && name != "com.sidequest.creator-sdk" {
            findings.push(finding(
                "blocked",
                "Legacy Banter SDK",
                "Banter-to-Creator migration is not automatic in this preview.",
            ));
        }
    }
    for (name, version, title) in [
        (
            "com.sidequest.creator-sdk",
            logic::CREATOR_SDK_VERSION,
            "Creator SDK",
        ),
        (
            "com.unity.render-pipelines.universal",
            logic::URP_VERSION,
            "URP package",
        ),
        (
            "com.unity.inputsystem",
            logic::INPUT_SYSTEM_VERSION,
            "Input System",
        ),
        (
            "com.unity.visualscripting",
            "1.9.1",
            "Visual Scripting package",
        ),
    ] {
        match dependencies.get(name).and_then(Value::as_str) {
            Some(actual) if actual == version => findings.push(finding("pass", title, format!("Pinned version {version}"))),
            None if !dependencies.contains_key(name) => {
                dependencies.insert(name.into(), json!(version));
                changes.push(format!("Add {name} {version}."));
                findings.push(finding("repair", title, "Missing package."));
            }
            Some("1.12.0") if name == "com.unity.inputsystem" => {
                dependencies.insert(name.into(), json!(version));
                changes.push(format!("Upgrade Input System 1.12.0 to {version} for the tested Unity version."));
                findings.push(finding("repair", title, "1.12.0 failed compilation with the tested Unity recipe."));
            }
            other => findings.push(finding("blocked", title, format!("Installed reference {} differs from tested {version}. No automatic version replacement.", other.unwrap_or("invalid")))),
        }
    }
    let mut missing_modules = Vec::new();
    for name in logic::REQUIRED_BUILTIN_MODULES {
        match dependencies.get(*name) {
            None => {
                dependencies.insert((*name).into(), json!("1.0.0"));
                missing_modules.push(*name);
            }
            Some(value) if value == "1.0.0" => {}
            _ => findings.push(finding(
                "blocked",
                "Built-in module",
                format!("Unexpected version for {name}."),
            )),
        }
    }
    if !missing_modules.is_empty() {
        changes.push(format!(
            "Add missing built-in modules: {}.",
            missing_modules.join(", ")
        ));
        findings.push(finding(
            "repair",
            "Built-in modules",
            format!(
                "{} required module entries are missing.",
                missing_modules.len()
            ),
        ));
    }
    let registries = updated
        .as_object_mut()
        .ok_or("Invalid manifest.")?
        .entry("scopedRegistries")
        .or_insert(json!([]))
        .as_array_mut()
        .ok_or("scopedRegistries must be an array.")?;
    let mut missing_scopes = Vec::new();
    for required in REGISTRY_SCOPES {
        let mut covered = false;
        for registry in registries.iter() {
            let scopes = registry["scopes"]
                .as_array()
                .ok_or("A scoped registry has no scopes array.")?;
            for scope in scopes {
                let scope = scope.as_str().ok_or("Invalid registry scope.")?;
                if *required == scope || required.starts_with(&format!("{scope}.")) {
                    if registry["url"].as_str().map(|u| u.trim_end_matches('/'))
                        == Some(logic::REGISTRY_URL)
                    {
                        covered = true;
                    } else {
                        findings.push(finding("blocked", "Registry conflict", format!("{required} is owned by another scoped registry. It will not be replaced.")));
                    }
                }
            }
        }
        if !covered {
            missing_scopes.push(json!(required));
        }
    }
    if !missing_scopes.is_empty() {
        if let Some(registry) = registries.iter_mut().find(|r| {
            r["url"].as_str().map(|u| u.trim_end_matches('/')) == Some(logic::REGISTRY_URL)
        }) {
            registry["scopes"]
                .as_array_mut()
                .ok_or("Invalid registry scopes.")?
                .extend(missing_scopes);
        } else {
            registries.push(json!({"name":"Greenfield-registry.sdq.st", "url":logic::REGISTRY_URL, "scopes":missing_scopes}));
        }
        changes
            .push("Add missing Creator SDK registry scopes; preserve unrelated registries.".into());
        findings.push(finding(
            "repair",
            "Creator SDK registry",
            "Required scopes are missing.",
        ));
    }
    Ok((updated, changes, findings))
}

pub fn inspect(path: &Path) -> Result<Inspection, String> {
    let root = fs::canonicalize(path).map_err(|_| "Choose an existing Unity project folder.")?;
    if !checked_path(&root, "Assets")?.is_dir() {
        return Err("This folder has no Unity Assets directory.".into());
    }
    let version_bytes = read(&root, "ProjectSettings/ProjectVersion.txt")?
        .ok_or("ProjectVersion.txt is missing.")?;
    let text = String::from_utf8(version_bytes).map_err(|_| "Invalid project version file.")?;
    let version = text
        .lines()
        .find_map(|line| line.strip_prefix("m_EditorVersion:"))
        .unwrap_or("")
        .trim()
        .to_owned();
    let manifest_bytes =
        read(&root, "Packages/manifest.json")?.ok_or("Packages/manifest.json is missing.")?;
    let manifest: Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("Invalid package manifest: {e}"))?;
    let (updated, mut changes, mut findings) = package_plan(&manifest)?;
    let manifest_changed = updated != manifest;
    findings.insert(
        0,
        finding(
            if version == logic::EDITOR_VERSION {
                "pass"
            } else {
                "blocked"
            },
            "Unity version",
            if version == logic::EDITOR_VERSION {
                version.clone()
            } else {
                format!(
                    "{version}; this preview only repairs {}. No Editor upgrade will be attempted.",
                    logic::EDITOR_VERSION
                )
            },
        ),
    );
    let locked = checked_path(&root, "Temp/UnityLockfile")?.exists();
    if locked {
        findings.push(finding(
            "blocked",
            "Project is open",
            "Close this Unity project, then inspect again.",
        ));
    }
    if checked_path(&root, ".creator-project-setup/operation.lock")?.exists() {
        findings.push(finding("blocked", "Existing operation", "A repair/validation operation is running or was interrupted. Review its logs before removing the operation lock."));
    }
    if checked_path(&root, VALIDATOR)?.exists()
        || checked_path(&root, ".creator-project-setup/existing-request.json")?.exists()
    {
        findings.push(finding(
            "blocked",
            "Temporary validator already present",
            "An earlier setup validator needs review before another operation can run.",
        ));
    }
    let settings_missing = read(&root, VS_SETTINGS)?.is_none_or(|bytes| bytes.is_empty());
    let database_missing = !fs::metadata(checked_path(&root, VS_DATABASE)?)
        .is_ok_and(|meta| meta.is_file() && meta.len() > 0);
    let current_fingerprint = fingerprint(&root)?;
    let previous: Option<Value> = read(&root, ".creator-project-setup/last-validation.json")?
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let known_vs_failure = previous.as_ref().is_some_and(|report| {
        report["fingerprint"].as_str() == Some(current_fingerprint.as_str())
            && report["validation"]["error"] == ""
            && (report["validation"]["creatorVisualScriptingConfigured"] == false
                || report["validation"]["visualScriptingInitialized"] == false
                || report["validation"]["creatorNodeCount"] == 0)
    });
    let configure_vs = settings_missing || database_missing || known_vs_failure;
    if configure_vs {
        changes.push("Initialize Creator Visual Scripting and rebuild its node database; retain existing type selections.".into());
        findings.push(finding(
            "repair",
            "Visual Scripting setup",
            if settings_missing {
                "Project settings are missing."
            } else if database_missing {
                "Node database is missing."
            } else {
                "The latest Unity validation found invalid Creator node configuration."
            },
        ));
    } else {
        findings.push(finding(
            "check",
            "Visual Scripting setup",
            "Files are present; node validity requires Unity validation.",
        ));
    }
    match read(&root, "ProjectSettings/GraphicsSettings.asset")? {
        None => findings.push(finding("blocked", "Render pipeline", "GraphicsSettings.asset is missing. Automatic pipeline reconstruction is outside this preview.")),
        Some(bytes) => {
            let text = String::from_utf8_lossy(&bytes);
            if text.lines().any(|line| line.trim() == "m_CustomRenderPipeline: {fileID: 0}") {
                findings.push(finding("blocked", "Render pipeline", "No default render pipeline is assigned. Select a URP asset in Unity; this tool will not convert your materials."));
            } else { findings.push(finding("check", "Render pipeline", "Unity validation will check that the assigned pipeline is URP.")); }
        }
    }
    let environment = logic::probe_environment();
    if !environment.ready {
        findings.push(finding(
            "blocked",
            "Computer requirements",
            environment.blockers.join(" "),
        ));
    }
    let blocked = findings.iter().any(|f| f.status == "blocked");
    Ok(Inspection {
        project_path: display_path(&root),
        fingerprint: current_fingerprint,
        editor_version: version,
        can_repair: !blocked && !changes.is_empty(),
        can_validate: !blocked && !manifest_changed,
        proposed_changes: changes,
        findings,
        locked,
        manifest: updated,
        manifest_changed,
        configure_vs,
    })
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(source).map_err(|e| e.to_string())?;
    if is_link(&meta) {
        return Err(format!(
            "Refusing to back up a linked path: {}",
            display_path(source)
        ));
    }
    if meta.is_dir() {
        fs::create_dir_all(destination).map_err(|e| e.to_string())?;
        for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            copy_tree(&entry.path(), &destination.join(entry.file_name()))?;
        }
    } else if meta.is_file() {
        fs::create_dir_all(destination.parent().ok_or("Invalid backup path.")?)
            .map_err(|e| e.to_string())?;
        fs::copy(source, destination).map_err(|e| e.to_string())?;
        if fs::metadata(destination).map_err(|e| e.to_string())?.len() != meta.len()
            || file_hash(source)? != file_hash(destination)?
        {
            return Err("Incomplete backup copy.".into());
        }
    } else {
        return Err("Special files need manual backup.".into());
    }
    Ok(())
}

fn file_hash(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 32768];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    fs::write(path, bytes).map_err(|e| format!("Cannot write {}: {e}", display_path(path)))
}

struct OperationLock(PathBuf);
impl Drop for OperationLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub fn run(
    request: ExistingRequest,
    progress: impl Fn(SetupProgress),
) -> Result<ExistingResult, String> {
    if !request.approved {
        return Err("Review and approve the backup and operation first.".into());
    }
    let inspection = inspect(Path::new(&request.project_path))?;
    if inspection.fingerprint != request.fingerprint {
        return Err(
            "Project configuration changed since inspection. Inspect again before continuing."
                .into(),
        );
    }
    if (request.repair && !inspection.can_repair) || (!request.repair && !inspection.can_validate) {
        return Err(
            "This operation is blocked by the inspection findings. Inspect the project again."
                .into(),
        );
    }
    let root = fs::canonicalize(&inspection.project_path).map_err(|e| e.to_string())?;
    let folder = checked_path(&root, ".creator-project-setup")?;
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let lock_path = folder.join("operation.lock");
    File::options()
        .write(true)
        .create_new(true)
        .open(&lock_path)
        .map_err(|_| "Another operation already owns this project.")?;
    let _lock = OperationLock(lock_path);
    let backups = checked_path(&root, ".creator-project-setup/backups")?;
    fs::create_dir_all(&backups).map_err(|e| e.to_string())?;
    let backup = backups.join(unique_id());
    fs::create_dir(&backup).map_err(|e| e.to_string())?;
    progress(SetupProgress::new(
        1,
        "Backing up package manifests, project settings and generated Visual Scripting data.",
    ));
    for relative in [
        "Packages/manifest.json",
        "Packages/packages-lock.json",
        "ProjectSettings",
        VS_GENERATED,
        "Assets/Unity.VisualScripting.Generated.meta",
        ".creator-project-setup/unity-validation.json",
    ] {
        let source = checked_path(&root, relative)?;
        if source.exists() {
            copy_tree(&source, &backup.join(relative))?;
        }
    }
    write_json(&backup.join("review.json"), &inspection)?;
    if checked_path(&root, "Temp/UnityLockfile")?.exists()
        || fingerprint(&root)? != inspection.fingerprint
    {
        return Err(format!(
            "Project opened or changed during backup. Nothing was repaired. Backup: {}",
            display_path(&backup)
        ));
    }
    let validator = checked_path(&root, VALIDATOR)?;
    let request_path = checked_path(&root, ".creator-project-setup/existing-request.json")?;
    let report_path = backup.join("result.json");
    let mut validator_written = false;
    let mut request_written = false;
    let mut fresh_validation = false;
    let result = (|| -> Result<Value, String> {
        if request.repair && inspection.manifest_changed {
            progress(SetupProgress::new(
                2,
                "Applying only the package and registry changes in the reviewed plan.",
            ));
            write_json(
                &checked_path(&root, "Packages/manifest.json")?,
                &inspection.manifest,
            )?;
        }
        fs::create_dir_all(validator.parent().ok_or("Invalid validator path.")?)
            .map_err(|e| e.to_string())?;
        let mut file = File::options()
            .write(true)
            .create_new(true)
            .open(&validator)
            .map_err(|e| e.to_string())?;
        validator_written = true;
        file.write_all(logic::validation_script().as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        let mut request_file = File::options()
            .write(true)
            .create_new(true)
            .open(&request_path)
            .map_err(|e| e.to_string())?;
        request_written = true;
        serde_json::to_writer(
            &mut request_file,
            &json!({"backupPath": display_path(&backup)}),
        )
        .map_err(|e| e.to_string())?;
        request_file.sync_all().map_err(|e| e.to_string())?;
        drop(request_file);
        let validation_path = checked_path(&root, ".creator-project-setup/unity-validation.json")?;
        if validation_path.exists() {
            fs::remove_file(&validation_path).map_err(|e| e.to_string())?;
        }
        fresh_validation = true;
        let progress_file = checked_path(&root, ".creator-project-setup/unity-progress.json")?;
        if progress_file.exists() {
            fs::remove_file(progress_file).map_err(|e| e.to_string())?;
        }
        let editor = logic::probe_environment()
            .editors
            .into_iter()
            .find(|e| e.ready)
            .ok_or("Compatible Editor is unavailable.")?;
        if request.repair && inspection.configure_vs {
            progress(SetupProgress::new(3, "Opening Unity to resolve packages and initialize the missing Visual Scripting setup."));
            logic::run_unity(
                &editor.executable,
                &root,
                "CreatorWorks.ProjectSetupValidator.ConfigureExisting",
                &backup.join("configure.log"),
                3,
                &progress,
            )?;
        }
        progress(SetupProgress::new(
            5,
            "Validating compilation, Creator nodes, URP and both required build targets in Unity.",
        ));
        logic::run_unity(
            &editor.executable,
            &root,
            "CreatorWorks.ProjectSetupValidator.Validate",
            &backup.join("validate.log"),
            5,
            &progress,
        )?;
        let validation: Value =
            serde_json::from_slice(&fs::read(&validation_path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if validation["success"] != true {
            return Err(
                "Unity validation reported failures. Review the saved result and logs.".into(),
            );
        }
        Ok(validation)
    })();
    // Remove only the temporary script written for this approved operation.
    if validator_written
        && fs::read(&validator)
            .is_ok_and(|bytes| sha256(&bytes) == sha256(logic::validation_script().as_bytes()))
    {
        let _ = fs::remove_file(&validator);
        let _ = fs::remove_file(validator.with_extension("cs.meta"));
    }
    if request_written {
        let _ = fs::remove_file(&request_path);
    }
    let (success, message, validation) = match result {
        Ok(value) => (
            true,
            "Unity validation passed. The original settings backup and logs were retained.".into(),
            Some(value),
        ),
        Err(error) => (
            false,
            format!(
                "{error} Backup retained at {}. No automatic rollback was attempted.",
                display_path(&backup)
            ),
            if fresh_validation {
                read(&root, ".creator-project-setup/unity-validation.json")?
                    .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            } else {
                None
            },
        ),
    };
    if let Some(validation) = &validation {
        write_json(
            &checked_path(&root, ".creator-project-setup/last-validation.json")?,
            &json!({"fingerprint": fingerprint(&root)?, "validation":validation}),
        )?;
    }
    let result = ExistingResult {
        success,
        project_path: display_path(&root),
        backup_path: display_path(&backup),
        report_path: display_path(&report_path),
        message,
        validation,
    };
    write_json(&report_path, &result)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn manifest() -> Value {
        let mut dependencies = serde_json::Map::new();
        for module in logic::REQUIRED_BUILTIN_MODULES {
            dependencies.insert((*module).into(), json!("1.0.0"));
        }
        dependencies.insert(
            "com.sidequest.creator-sdk".into(),
            json!(logic::CREATOR_SDK_VERSION),
        );
        dependencies.insert(
            "com.unity.render-pipelines.universal".into(),
            json!(logic::URP_VERSION),
        );
        dependencies.insert(
            "com.unity.inputsystem".into(),
            json!(logic::INPUT_SYSTEM_VERSION),
        );
        dependencies.insert("com.unity.visualscripting".into(), json!("1.9.1"));
        json!({"dependencies":dependencies,"scopedRegistries":[{"name":"Creator", "url":logic::REGISTRY_URL,"scopes":REGISTRY_SCOPES}]})
    }
    #[test]
    fn healthy_manifest_is_unchanged() {
        let source = manifest();
        let (updated, changes, findings) = package_plan(&source).unwrap();
        assert_eq!(source, updated);
        assert!(changes.is_empty());
        assert!(!findings.iter().any(|f| f.status == "blocked"));
    }
    #[test]
    fn repairs_preserve_unrelated_packages_and_registries() {
        let mut source = manifest();
        source["dependencies"]
            .as_object_mut()
            .unwrap()
            .remove("com.unity.modules.cloth");
        source["dependencies"]["my.custom.package"] = json!("file:../package");
        source["scopedRegistries"]
            .as_array_mut()
            .unwrap()
            .push(json!({"name":"other","url":"https://example.com","scopes":["my.custom"]}));
        let (updated, changes, _) = package_plan(&source).unwrap();
        assert_eq!(
            updated["dependencies"]["my.custom.package"],
            "file:../package"
        );
        assert_eq!(updated["scopedRegistries"], source["scopedRegistries"]);
        assert_eq!(updated["dependencies"]["com.unity.modules.cloth"], "1.0.0");
        assert_eq!(changes.len(), 1);
    }
    #[test]
    fn sdk_version_changes_and_registry_conflicts_block_repair() {
        let mut source = manifest();
        source["dependencies"]["com.sidequest.creator-sdk"] = json!("4.0.99");
        source["scopedRegistries"][0]["url"] = json!("https://example.com");
        let (updated, _, findings) = package_plan(&source).unwrap();
        assert_eq!(
            updated["dependencies"]["com.sidequest.creator-sdk"],
            "4.0.99"
        );
        assert!(findings.iter().any(|f| f.title == "Registry conflict"));
        assert!(findings
            .iter()
            .any(|f| f.title == "Creator SDK" && f.status == "blocked"));
    }
    #[test]
    fn fingerprint_detects_changes_and_inspection_does_not_write() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("Packages")).unwrap();
        fs::write(temp.path().join("Packages/manifest.json"), "{}").unwrap();
        let before = fingerprint(temp.path()).unwrap();
        fs::write(temp.path().join("Packages/manifest.json"), "{ }").unwrap();
        assert_ne!(before, fingerprint(temp.path()).unwrap());
        assert!(inspect(temp.path()).is_err());
        assert!(!temp.path().join(".creator-project-setup").exists());
    }
    #[test]
    fn rejects_unapproved_operations_before_touching_disk() {
        let temp = tempfile::tempdir().unwrap();
        let result = run(
            ExistingRequest {
                project_path: display_path(temp.path()),
                fingerprint: String::new(),
                repair: true,
                approved: false,
            },
            |_| {},
        );
        assert!(result.is_err());
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
    }
    #[test]
    fn windows_display_paths_keep_unc_prefix() {
        assert_eq!(
            display_path(Path::new("\\\\?\\UNC\\server\\share")),
            "\\\\server\\share"
        );
        assert_eq!(display_path(Path::new("\\\\?\\C:\\project")), "C:\\project");
    }

    fn fixture() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("Assets")).unwrap();
        fs::create_dir_all(temp.path().join("Packages")).unwrap();
        fs::create_dir_all(temp.path().join("ProjectSettings")).unwrap();
        write_json(&temp.path().join("Packages/manifest.json"), &manifest()).unwrap();
        fs::write(
            temp.path().join("ProjectSettings/ProjectVersion.txt"),
            format!("m_EditorVersion: {}", logic::EDITOR_VERSION),
        )
        .unwrap();
        fs::write(
            temp.path().join("ProjectSettings/GraphicsSettings.asset"),
            "m_CustomRenderPipeline: {fileID: 11400000, guid: test, type: 2}",
        )
        .unwrap();
        temp
    }

    #[test]
    fn successful_inspection_is_read_only_and_stale_plans_cannot_run() {
        let temp = fixture();
        let root = fs::canonicalize(temp.path()).unwrap();
        let before = fingerprint(&root).unwrap();
        let report = inspect(temp.path()).unwrap();
        assert_eq!(report.fingerprint, before);
        assert_eq!(fingerprint(&root).unwrap(), before);
        assert!(report.configure_vs);
        assert!(!temp.path().join(".creator-project-setup").exists());
        fs::write(
            temp.path().join("ProjectSettings/ProjectSettings.asset"),
            "user edit",
        )
        .unwrap();
        let error = run(
            ExistingRequest {
                project_path: display_path(temp.path()),
                fingerprint: before,
                repair: true,
                approved: true,
            },
            |_| {},
        )
        .unwrap_err();
        assert!(error.contains("changed since inspection"));
        assert!(!temp.path().join(".creator-project-setup").exists());
    }

    #[test]
    fn open_project_and_unsupported_editor_block_operations() {
        let temp = fixture();
        fs::create_dir(temp.path().join("Temp")).unwrap();
        fs::write(temp.path().join("Temp/UnityLockfile"), "").unwrap();
        let report = inspect(temp.path()).unwrap();
        assert!(report.locked);
        assert!(!report.can_repair && !report.can_validate);
        fs::remove_file(temp.path().join("Temp/UnityLockfile")).unwrap();
        fs::write(
            temp.path().join("ProjectSettings/ProjectVersion.txt"),
            "m_EditorVersion: 2022.3.1f1",
        )
        .unwrap();
        let report = inspect(temp.path()).unwrap();
        assert!(report
            .findings
            .iter()
            .any(|f| f.title == "Unity version" && f.status == "blocked"));
        assert!(!report.can_repair && !report.can_validate);
    }

    #[test]
    fn backup_copies_exact_bytes_and_paths_cannot_escape() {
        let temp = fixture();
        let backup = tempfile::tempdir().unwrap();
        copy_tree(temp.path(), &backup.path().join("original")).unwrap();
        assert_eq!(
            file_hash(&temp.path().join("Packages/manifest.json")).unwrap(),
            file_hash(&backup.path().join("original/Packages/manifest.json")).unwrap()
        );
        assert!(checked_path(temp.path(), "../elsewhere").is_err());
        assert!(checked_path(temp.path(), "/elsewhere").is_err());
    }

    #[test]
    #[ignore = "creates and repairs only a named disposable copy using the real Unity Editor"]
    fn unity_existing_repair_smoke() {
        let source = PathBuf::from(
            std::env::var("CREATOR_SETUP_REPAIR_SMOKE_SOURCE")
                .expect("select source disposable project"),
        );
        let name = std::env::var("CREATOR_SETUP_REPAIR_SMOKE_NAME")
            .expect("select new disposable project name");
        assert!(name.starts_with("CreatorSetupRepair-") && !name.contains(['/', '\\']));
        assert!(!source.join("Temp/UnityLockfile").exists());
        let target = source.parent().unwrap().join(name);
        fs::create_dir(&target).expect("test never overwrites an existing directory");
        for folder in ["Assets", "Packages", "ProjectSettings"] {
            copy_tree(&source.join(folder), &target.join(folder)).unwrap();
        }
        let editor = logic::probe_environment()
            .editors
            .into_iter()
            .find(|e| e.ready)
            .unwrap();
        fs::create_dir_all(target.join("Assets/Editor")).unwrap();
        let seed = target.join("Assets/Editor/CreatorRepairSeed.cs");
        fs::write(&seed, include_str!("../../tests/UnityRepairSeed.cs")).unwrap();
        logic::run_unity(
            &editor.executable,
            &target,
            "CreatorRepairSeed.AddCustomSelection",
            &target.join("seed.log"),
            3,
            &|event| println!("seed {}: {}", event.step, event.detail),
        )
        .unwrap();
        fs::remove_file(&seed).unwrap();
        fs::remove_file(seed.with_extension("cs.meta")).unwrap();
        assert!(fs::read_to_string(target.join(VS_SETTINGS))
            .unwrap()
            .contains("System.Text.StringBuilder"));
        // A missing generated database is repairable, while the user's selections remain.
        let database = target.join(VS_DATABASE);
        fs::remove_file(database).unwrap();
        let mut damaged: Value =
            serde_json::from_slice(&fs::read(target.join("Packages/manifest.json")).unwrap())
                .unwrap();
        damaged["dependencies"]
            .as_object_mut()
            .unwrap()
            .remove("com.unity.modules.cloth");
        write_json(&target.join("Packages/manifest.json"), &damaged).unwrap();
        let protected_scene = target.join("Assets/Scenes/SampleScene.unity");
        let scene_before = file_hash(&protected_scene).unwrap();
        fs::write(
            target.join("Assets/UserContent.txt"),
            "preserve manually arranged content",
        )
        .unwrap();
        let manifest_before = fs::read(target.join("Packages/manifest.json")).unwrap();
        let inspected = inspect(&target).unwrap();
        assert!(inspected.can_repair, "{:?}", inspected.findings);
        let result = run(
            ExistingRequest {
                project_path: display_path(&target),
                fingerprint: inspected.fingerprint,
                repair: true,
                approved: true,
            },
            |event| println!("{}: {}", event.step, event.detail),
        )
        .unwrap();
        println!("{}", serde_json::to_string_pretty(&result).unwrap());
        assert!(result.success, "{}", result.message);
        assert_eq!(
            result.validation.as_ref().unwrap()["preservedVisualScriptingSelections"],
            true
        );
        assert_eq!(
            fs::read(Path::new(&result.backup_path).join("Packages/manifest.json")).unwrap(),
            manifest_before
        );
        assert_eq!(file_hash(&protected_scene).unwrap(), scene_before);
        assert_eq!(
            fs::read_to_string(target.join("Assets/UserContent.txt")).unwrap(),
            "preserve manually arranged content"
        );
        assert!(!target.join(VALIDATOR).exists());
        assert!(!target
            .join(".creator-project-setup/operation.lock")
            .exists());
        let after = inspect(&target).unwrap();
        assert!(!after.can_repair, "{:?}", after.proposed_changes);
        assert!(after.can_validate);
        let validation = run(
            ExistingRequest {
                project_path: display_path(&target),
                fingerprint: after.fingerprint,
                repair: false,
                approved: true,
            },
            |event| println!("validate {}: {}", event.step, event.detail),
        )
        .unwrap();
        assert!(validation.success, "{}", validation.message);
        assert_eq!(file_hash(&protected_scene).unwrap(), scene_before);
        assert!(fs::read_to_string(target.join(VS_SETTINGS))
            .unwrap()
            .contains("System.Text.StringBuilder"));
    }
}
