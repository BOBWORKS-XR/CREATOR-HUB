use crate::community_project::EditorLockState;
use crate::hub::unique_id;
use crate::logic::{self, SetupProgress};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};

const VALIDATOR: &str = "Assets/Editor/CreatorProjectSetupValidator.cs";
const VALIDATOR_META: &str = "Assets/Editor/CreatorProjectSetupValidator.cs.meta";
const EXISTING_REQUEST: &str = ".creator-project-setup/existing-request.json";
const VS_SETTINGS: &str = "ProjectSettings/VisualScriptingSettings.asset";
const VS_GENERATED: &str = "Assets/Unity.VisualScripting.Generated";
const VS_DATABASE: &str =
    "Assets/Unity.VisualScripting.Generated/VisualScripting.Flow/UnitOptions.db";
const EDITOR_USER_SETTINGS: &str = "UserSettings/EditorUserSettings.asset";
const BACKUP_PATHS: &[&str] = &[
    "Packages/manifest.json",
    "Packages/packages-lock.json",
    "ProjectSettings",
    EDITOR_USER_SETTINGS,
    VS_GENERATED,
    "Assets/Unity.VisualScripting.Generated.meta",
    ".creator-project-setup/unity-validation.json",
];
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
    EDITOR_USER_SETTINGS,
];

#[derive(Debug, Clone, Serialize)]
pub struct Finding {
    pub status: String,
    pub title: String,
    pub detail: String,
    #[serde(rename = "diagnosticPaths", skip_serializing_if = "Vec::is_empty")]
    pub diagnostic_paths: Vec<String>,
    #[serde(rename = "qualificationRequired", skip_serializing_if = "is_false")]
    pub qualification_required: bool,
}
fn is_false(value: &bool) -> bool {
    !value
}
fn finding(status: &str, title: &str, detail: impl Into<String>) -> Finding {
    Finding {
        status: status.into(),
        title: title.into(),
        detail: detail.into(),
        diagnostic_paths: Vec::new(),
        qualification_required: false,
    }
}

fn unqualified_version(title: &str, detail: impl Into<String>) -> Finding {
    Finding {
        qualification_required: true,
        ..finding("check", title, detail)
    }
}

fn existing_editor<'a>(
    environment: &'a logic::EnvironmentReport,
    version: &str,
) -> Result<&'a logic::EditorInstallation, String> {
    let editor = environment.editors.iter().find(|editor| editor.version == version)
        .ok_or_else(|| format!("Unity {version} is not installed. Install this project's exact Editor version in Unity Hub; no version change is required."))?;
    let mut missing = Vec::new();
    if !editor.android_player {
        missing.push("Android Build Support");
    }
    if !editor.android_sdk || !editor.android_ndk || !editor.open_jdk {
        missing.push("Android SDK, NDK and OpenJDK");
    }
    if !editor.windows_standalone {
        missing.push("Windows build support");
    }
    if missing.is_empty() {
        Ok(editor)
    } else {
        Err(format!("Unity {version} needs {} for validation. Add these modules to that Editor in Unity Hub.", missing.join(", ")))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub project_path: String,
    pub fingerprint: String,
    pub editor_version: String,
    pub sdk_version: Option<String>,
    pub findings: Vec<Finding>,
    pub proposed_changes: Vec<String>,
    pub can_repair: bool,
    pub can_validate: bool,
    pub partial_repair: bool,
    pub locked: bool,
    pub skipped_checks: Vec<String>,
    #[serde(skip)]
    manifest: Value,
    #[serde(skip)]
    manifest_before: Vec<u8>,
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
    pub validated: bool,
    pub partial_repair: bool,
    pub skipped_checks: Vec<String>,
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

fn editor_lock_state(root: &Path) -> Result<EditorLockState, String> {
    let path = checked_path(root, "Temp/UnityLockfile")?;
    match fs::symlink_metadata(&path) {
        Ok(info) if !info.is_file() => {
            return Err(
                "Unity lock marker is not an ordinary file. It was kept for review.".into(),
            );
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(EditorLockState::NotHeld)
        }
        Err(error) => return Err(format!("Cannot inspect Unity lock marker: {error}")),
    }
    #[cfg(windows)]
    {
        crate::community_project::editor_lock_state(&path)
    }
    #[cfg(not(windows))]
    {
        // Unity's Unix locking primitive is not established by the synthetic fs2 tests.
        Ok(EditorLockState::Unverified(
            "This platform cannot verify whether Unity still owns the lock marker.".into(),
        ))
    }
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

fn numeric_version(value: &str) -> Option<semver::Version> {
    let version = semver::Version::parse(value).ok()?;
    (version.to_string() == value).then_some(version)
}

fn newer_package(actual: &str, tested: &str) -> bool {
    numeric_version(actual)
        .zip(numeric_version(tested))
        .is_some_and(|(actual, tested)| actual.cmp_precedence(&tested).is_gt())
}

fn unity_version(value: &str) -> Option<(u64, u64, u64, u8, u64)> {
    let mut parts = value.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let last = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let channel_at = last.find(|c: char| !c.is_ascii_digit())?;
    let patch = last[..channel_at].parse().ok()?;
    let suffix = &last[channel_at..];
    let channel = match suffix.as_bytes().first()? {
        b'a' => 0,
        b'b' => 1,
        b'f' => 2,
        b'p' => 3,
        _ => return None,
    };
    let revision = suffix[1..].parse().ok()?;
    Some((major, minor, patch, channel, revision))
}

fn newer_unity(version: &str) -> bool {
    unity_version(version)
        .zip(unity_version(logic::EDITOR_VERSION))
        .is_some_and(|(actual, tested)| actual > tested)
}

fn package_plan(manifest: &Value) -> Result<(Value, Vec<String>, Vec<Finding>), String> {
    let (sdk_version, vs_version) = logic::existing_package_versions(manifest);
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
        ("com.sidequest.creator-sdk", sdk_version, "Creator SDK"),
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
            vs_version,
            "Visual Scripting package",
        ),
    ] {
        match dependencies.get(name).and_then(Value::as_str) {
            Some(actual) if actual == version => findings.push(finding("pass", title, format!("Tested version {version}; existing package kept."))),
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
            Some(actual) if newer_package(actual, version) => findings.push(unqualified_version(title, format!("Installed reference {actual} is newer than tested {version}. This is not a detected incompatibility. The installed version is kept; only supported metadata repairs are offered, without Unity validation."))),
            Some(actual) if numeric_version(actual).is_some() => findings.push(finding("blocked", title, format!("Installed reference {actual} differs from tested {version}. This older or mixed combination needs review; it was not replaced."))),
            other => findings.push(finding("blocked", title, format!("Package reference {} is not a supported exact version. Review it in Unity Package Manager. It was not replaced.", other.unwrap_or("invalid")))),
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
    repair_registries(&mut updated, &mut changes, &mut findings)?;
    Ok((updated, changes, findings))
}

fn repair_registries(
    updated: &mut Value,
    changes: &mut Vec<String>,
    findings: &mut Vec<Finding>,
) -> Result<(), String> {
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
    Ok(())
}

struct PartialPlan {
    manifest: Value,
    changes: Vec<String>,
    findings: Vec<Finding>,
    skipped_checks: Vec<String>,
    metadata: Value,
}

fn installed_requirements(
    root: &Path,
    manifest: &Value,
    held_manifest: Option<&[u8]>,
) -> Result<Option<crate::sdk_requirements::Requirements>, String> {
    match manifest["dependencies"]["com.sidequest.creator-sdk"].as_str() {
        Some(version) if numeric_version(version).is_some() => {
            if let Some(bytes) = held_manifest {
                crate::sdk_requirements::installed_with_manifest(root, version, bytes)
            } else {
                crate::sdk_requirements::installed(root, version)
            }
        }
        _ => Ok(None),
    }
}

fn partial_package_plan(
    manifest: &Value,
    editor_version: &str,
    metadata: Result<Option<crate::sdk_requirements::Requirements>, String>,
) -> Result<PartialPlan, String> {
    let mut plan = PartialPlan {
        manifest: manifest.clone(),
        changes: Vec::new(),
        findings: Vec::new(),
        skipped_checks: vec![
            "Unity compilation and runtime validation".into(),
            "Static Creator SDK and Visual Scripting validator injection".into(),
            "Visual Scripting configuration and node database rebuild".into(),
        ],
        metadata: Value::Null,
    };
    let requirements = match metadata {
        Ok(value) => value,
        Err(error) => {
            plan.findings.push(finding("check", "Installed SDK metadata", format!("Installed SDK requirements could not be safely read: {error} Version-dependent repairs are skipped; current package versions are kept.")));
            None
        }
    };
    plan.metadata = serde_json::to_value(&requirements).map_err(|e| e.to_string())?;
    if let Some(required_editor) = requirements
        .as_ref()
        .and_then(|value| value.unity_version.as_ref())
    {
        plan.findings.push(finding("check", "SDK Unity requirement", format!("Installed SDK metadata names Unity {required_editor}. Keep project Editor {editor_version}; runtime compatibility is not validated by this metadata repair.")));
    }
    let (tested_sdk, _) = logic::existing_package_versions(manifest);
    let dependencies = plan
        .manifest
        .get_mut("dependencies")
        .and_then(Value::as_object_mut)
        .ok_or("Manifest has no dependencies object.")?;
    for name in dependencies.keys() {
        if name.contains("banter") && name != "com.sidequest.creator-sdk" {
            plan.findings.push(finding(
                "blocked",
                "Legacy Banter SDK",
                "Banter-to-Creator migration requires manual review.",
            ));
        }
    }
    match dependencies
        .get("com.sidequest.creator-sdk")
        .and_then(Value::as_str)
    {
        Some(actual) if actual == tested_sdk || newer_package(actual, tested_sdk) => {
            plan.findings.push(unqualified_version("Creator SDK", format!("Keep installed SDK {actual}. This combination has not been runtime validated; only supported metadata repairs are offered.")));
        }
        None if !dependencies.contains_key("com.sidequest.creator-sdk") => {
            plan.skipped_checks
                .push("Adding Creator SDK: no reviewed installed SDK version".into());
            plan.findings.push(finding("check", "Creator SDK", "No SDK version is selected. Install the desired SDK in Unity Package Manager; this partial repair will not select a static version."));
        }
        _ => plan.findings.push(finding(
            "blocked",
            "Creator SDK",
            "An older, custom or unreadable SDK reference needs review. It was not replaced.",
        )),
    }
    for (name, title) in [
        ("com.unity.render-pipelines.universal", "URP package"),
        ("com.unity.inputsystem", "Input System"),
        ("com.unity.visualscripting", "Visual Scripting package"),
    ] {
        let current = dependencies.get(name);
        if current.is_some_and(|value| value.as_str().and_then(numeric_version).is_none()) {
            plan.findings.push(finding(
                "blocked",
                title,
                "A custom or unreadable package reference needs review. It was not replaced.",
            ));
            continue;
        }
        let required = requirements
            .as_ref()
            .and_then(|value| value.dependencies.get(name));
        let Some((required, required_version)) =
            required.and_then(|value| numeric_version(value).map(|version| (value, version)))
        else {
            plan.skipped_checks.push(format!(
                "{name}: exact installed SDK requirement unavailable"
            ));
            plan.findings.push(finding("check", title, "Installed SDK metadata has no exact requirement for this package. Its existing reference is unchanged."));
            continue;
        };
        match current.and_then(Value::as_str).and_then(numeric_version) {
            None => {
                dependencies.insert(name.into(), json!(required));
                plan.changes.push(format!("Add {name} {required} from installed SDK metadata."));
                plan.findings.push(finding("repair", title, "Missing dependency declared by the installed SDK."));
            }
            Some(actual) if actual.cmp_precedence(&required_version).is_lt() => {
                dependencies.insert(name.into(), json!(required));
                plan.changes.push(format!("Upgrade {name} {actual} to {required} from installed SDK metadata."));
                plan.findings.push(finding("repair", title, "Upgrade to the installed SDK's exact dependency requirement."));
            }
            Some(actual) => plan.findings.push(finding("check", title, format!("Keep {actual}; installed SDK requirement is {required}. No downgrade or runtime-validation claim."))),
        }
    }
    if editor_version == logic::EDITOR_VERSION {
        let mut missing = Vec::new();
        for name in logic::REQUIRED_BUILTIN_MODULES {
            match dependencies.get(*name) {
                None => {
                    dependencies.insert((*name).into(), json!("1.0.0"));
                    missing.push(*name);
                }
                Some(value) if value == "1.0.0" => {}
                _ => plan.findings.push(finding(
                    "blocked",
                    "Built-in module",
                    format!("Unexpected version for {name}."),
                )),
            }
        }
        if !missing.is_empty() {
            plan.changes.push(format!(
                "Add missing built-in modules for Unity {}: {}.",
                logic::EDITOR_VERSION,
                missing.join(", ")
            ));
        }
    } else {
        plan.skipped_checks.push(
            "Built-in module changes: this Editor's fixed module contracts are not verified".into(),
        );
        for name in logic::REQUIRED_BUILTIN_MODULES {
            if dependencies
                .get(*name)
                .is_some_and(|value| value.as_str().and_then(numeric_version).is_none())
            {
                plan.findings.push(finding(
                    "blocked",
                    "Built-in module",
                    format!("Custom or unreadable reference for {name} requires review."),
                ));
            }
        }
    }
    repair_registries(&mut plan.manifest, &mut plan.changes, &mut plan.findings)?;
    Ok(plan)
}

fn partial_fingerprint(root: &Path, plan: &PartialPlan) -> Result<String, String> {
    let mut digest = Sha256::new();
    digest.update(fingerprint(root)?.as_bytes());
    digest.update(
        serde_json::to_vec(&json!({
            "partialRepair": true, "metadata": plan.metadata,
            "manifest": plan.manifest, "skippedChecks": plan.skipped_checks,
        }))
        .map_err(|e| e.to_string())?,
    );
    Ok(format!("{:x}", digest.finalize()))
}

fn known_visual_scripting_failure(previous: Option<&Value>, fingerprint: &str) -> bool {
    previous.is_some_and(|report| {
        report["fingerprint"].as_str() == Some(fingerprint)
            && report["validation"]["error"] == ""
            && ([
                "creatorVisualScriptingConfigured",
                "visualScriptingInitialized",
                "sdkReadyDone",
                "nodesBuiltForThisVersion",
                "nodeDatabaseVerified",
            ]
            .iter()
            .any(|key| report["validation"][key] == false)
                || report["validation"]["creatorNodeCount"] == 0)
    })
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
    let (mut updated, mut changes, mut findings) = package_plan(&manifest)?;
    let partial_repair = newer_unity(&version)
        || findings
            .iter()
            .any(|finding| finding.qualification_required);
    let partial_plan = if partial_repair {
        Some(partial_package_plan(
            &manifest,
            &version,
            installed_requirements(&root, &manifest, None),
        )?)
    } else {
        None
    };
    let skipped_checks = if let Some(plan) = &partial_plan {
        updated = plan.manifest.clone();
        changes = plan.changes.clone();
        findings = plan.findings.clone();
        plan.skipped_checks.clone()
    } else {
        Vec::new()
    };
    let sdk_added = manifest["dependencies"]
        .get("com.sidequest.creator-sdk")
        .is_none();
    let manifest_changed = updated != manifest;
    findings.insert(0, if version == logic::EDITOR_VERSION {
        finding("pass", "Unity version", version.clone())
    } else if newer_unity(&version) {
        unqualified_version("Unity version", format!("Unity {version} is newer than tested {}. Keep this project's Editor; supported metadata repairs do not run a static Unity validator or change its version.", logic::EDITOR_VERSION))
    } else {
        finding("blocked", "Unity version", format!("Unity {version} is older than tested {} or cannot be identified safely. Its version was not changed.", logic::EDITOR_VERSION))
    });
    let locked = editor_lock_state(&root)?.blocks();
    if locked {
        findings.push(finding(
            "blocked",
            "Project lock needs review",
            if cfg!(windows) {
                "Unity may still be closing, or the lock could not be verified. Close the project and inspect again; if it persists, reopen and close it normally in Unity. The lock file has not been removed."
            } else {
                "A Unity lock file is present; this platform cannot verify whether Unity still owns it. Close the project and inspect again; if it persists, reopen and close it normally in Unity. The lock file has not been removed."
            },
        ));
    }
    let operation_marker = checked_path(&root, ".creator-project-setup/operation.lock")?;
    if operation_marker.exists() {
        let mut issue = finding("blocked", "Existing operation", "A Setup operation is running or was interrupted. Wait for it to finish, then inspect again. If this persists, copy the recovery details for support. Do not delete the retained files.");
        issue.diagnostic_paths = vec![
            display_path(&operation_marker),
            display_path(&checked_path(&root, ".creator-project-setup")?),
        ];
        findings.push(issue);
    }
    let mut retained = Vec::new();
    for relative in [VALIDATOR, VALIDATOR_META, EXISTING_REQUEST] {
        let path = checked_path(&root, relative)?;
        if path.exists() {
            retained.push(display_path(&path));
        }
    }
    if !retained.is_empty() {
        let mut issue = finding(
            "blocked",
            "Temporary validator already present",
            "An earlier Setup operation left validation files. Copy the recovery details for support before another repair. Do not delete these files or start another validator.",
        );
        retained.push(display_path(&checked_path(
            &root,
            ".creator-project-setup",
        )?));
        issue.diagnostic_paths = retained;
        findings.push(issue);
    }
    let settings_missing = read(&root, VS_SETTINGS)?.is_none_or(|bytes| bytes.is_empty());
    let database_missing = !fs::metadata(checked_path(&root, VS_DATABASE)?)
        .is_ok_and(|meta| meta.is_file() && meta.len() > 0);
    let current_fingerprint = match &partial_plan {
        Some(plan) => partial_fingerprint(&root, plan)?,
        None => fingerprint(&root)?,
    };
    let previous: Option<Value> = read(&root, ".creator-project-setup/last-validation.json")?
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let known_vs_failure = known_visual_scripting_failure(previous.as_ref(), &current_fingerprint);
    let configure_vs =
        !partial_repair && (sdk_added || settings_missing || database_missing || known_vs_failure);
    if configure_vs {
        changes.push("Initialize Creator Visual Scripting and rebuild its node database; retain existing type selections.".into());
        findings.push(finding(
            "repair",
            "Visual Scripting setup",
            if settings_missing {
                "Project settings are missing."
            } else if database_missing {
                "Node database is missing."
            } else if sdk_added {
                "Creator SDK is being added; initialize its nodes while retaining existing type selections."
            } else {
                "The latest Unity validation found invalid Creator node configuration."
            },
        ));
    } else {
        findings.push(finding(
            "check",
            "Visual Scripting setup",
            if partial_repair {
                "Static Visual Scripting configuration and validation are skipped. Open the project in its own Editor to resolve and inspect the installed SDK."
            } else {
                "Files are present; node validity requires Unity validation."
            },
        ));
    }
    match read(&root, "ProjectSettings/GraphicsSettings.asset")? {
        None => findings.push(finding(if partial_repair { "check" } else { "blocked" }, "Render pipeline", "GraphicsSettings.asset is missing. Automatic pipeline reconstruction is outside this preview.")),
        Some(bytes) => {
            let text = String::from_utf8_lossy(&bytes);
            if text.lines().any(|line| line.trim() == "m_CustomRenderPipeline: {fileID: 0}") {
                findings.push(finding(if partial_repair { "check" } else { "blocked" }, "Render pipeline", "No default render pipeline is assigned. Select a URP asset in Unity; this tool will not convert your materials."));
            } else { findings.push(finding("check", "Render pipeline", if partial_repair { "Render pipeline validation is skipped; existing assets are preserved." } else { "Unity validation will check that the assigned pipeline is URP." })); }
        }
    }
    if !partial_repair {
        let environment = logic::probe_environment();
        if let Err(issue) = existing_editor(&environment, &version) {
            findings.push(finding("blocked", "Computer requirements", issue));
        }
    }
    let blocked = findings.iter().any(|f| f.status == "blocked");
    Ok(Inspection {
        project_path: display_path(&root),
        fingerprint: current_fingerprint,
        sdk_version: manifest["dependencies"]["com.sidequest.creator-sdk"]
            .as_str()
            .map(str::to_owned),
        editor_version: version,
        can_repair: !blocked && !changes.is_empty(),
        can_validate: !partial_repair && !blocked && !manifest_changed,
        partial_repair,
        skipped_checks,
        proposed_changes: changes,
        findings,
        locked,
        manifest: updated,
        manifest_before: manifest_bytes,
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

fn reserved_file(path: &Path, delete: bool) -> Result<File, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true).write(!delete);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::{Foundation::GENERIC_READ, Storage::FileSystem::DELETE};
        options.share_mode(1).custom_flags(0x0020_0000); // Read sharing only; open reparse points themselves.
        if delete {
            options.access_mode(GENERIC_READ | DELETE);
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|_| {
        format!(
            "Cannot reserve {}; it was kept for review.",
            display_path(path)
        )
    })?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || is_link(&metadata) {
        return Err("Unexpected or redirected project file; it was kept for review.".into());
    }
    #[cfg(unix)]
    fs2::FileExt::try_lock_exclusive(&file)
        .map_err(|_| "A project file is busy; inspect again.")?;
    Ok(file)
}

fn file_identity(file: &File) -> Result<(u64, u64), String> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        // Identity comes from the held file, not a pathname that can be replaced.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0
            || info.dwFileAttributes & 0x400 != 0
        {
            return Err("Cannot verify the original project file identity.".into());
        }
        Ok((
            u64::from(info.dwVolumeSerialNumber),
            (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
        ))
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        Ok((metadata.dev(), metadata.ino()))
    }
}

fn held_bytes(file: &mut File) -> Result<Vec<u8>, String> {
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > 16 * 1024 * 1024 {
        return Err("Unexpected project file; it was kept for review.".into());
    }
    file.rewind().map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}

fn require_editor_lock_clear(state: EditorLockState) -> Result<(), String> {
    match state {
        EditorLockState::NotHeld => Ok(()),
        #[cfg(any(windows, test))]
        EditorLockState::Held => Err("Unity lock marker is in use. Its owner has not been verified. Inspect again; later edits were kept.".into()),
        EditorLockState::Unverified(reason) => Err(format!("Cannot verify the Unity lock marker: {reason}. Inspect again; later edits were kept.")),
    }
}

fn review_unchanged(root: &Path, inspection: &Inspection) -> Result<(), String> {
    review_unchanged_with_manifest(root, inspection, None)
}

fn review_unchanged_with_manifest(
    root: &Path,
    inspection: &Inspection,
    held_manifest: Option<&[u8]>,
) -> Result<(), String> {
    require_editor_lock_clear(editor_lock_state(root)?)?;
    let current = if inspection.partial_repair {
        let bytes = match held_manifest {
            Some(bytes) => std::borrow::Cow::Borrowed(bytes),
            None => std::borrow::Cow::Owned(
                read(root, "Packages/manifest.json")?.ok_or("Package manifest disappeared.")?,
            ),
        };
        let manifest: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        let plan = partial_package_plan(
            &manifest,
            &inspection.editor_version,
            installed_requirements(root, &manifest, held_manifest),
        )?;
        partial_fingerprint(root, &plan)?
    } else {
        fingerprint(root)?
    };
    if current != inspection.fingerprint {
        return Err(
            "Project or SDK metadata changed after review. Inspect again; later edits were kept."
                .into(),
        );
    }
    Ok(())
}

fn temporary_paths_absent(root: &Path) -> Result<(), String> {
    for relative in [VALIDATOR_META, VALIDATOR, EXISTING_REQUEST] {
        if checked_path(root, relative)?
            .try_exists()
            .map_err(|e| e.to_string())?
        {
            return Err(format!(
                "Temporary file appeared after review; it was kept: {relative}"
            ));
        }
    }
    Ok(())
}

fn publish_manifest(root: &Path, inspection: &Inspection) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(&inspection.manifest).map_err(|e| e.to_string())?;
    let path = checked_path(root, "Packages/manifest.json")?;
    let mut file = reserved_file(&path, false)?;
    let before = held_bytes(&mut file)?;
    if before != inspection.manifest_before {
        return Err("Package manifest changed after review; later edits were kept.".into());
    }
    review_unchanged_with_manifest(root, inspection, Some(&before))?;
    if file_identity(&file)? != file_identity(&File::open(&path).map_err(|e| e.to_string())?)? {
        return Err("Package manifest was replaced; inspect again.".into());
    }
    // Windows denies other writers/replacements through sync. Unix locks are
    // advisory: these last comparisons are not a CAS against external writers.
    file.rewind()
        .and_then(|_| file.write_all(&bytes))
        .and_then(|_| file.set_len(bytes.len() as u64))
        .and_then(|_| file.sync_all())
        .map_err(|e| {
            format!("Cannot publish manifest; backup retained, no rollback attempted: {e}")
        })
}

struct OwnedTemporary {
    relative: &'static str,
    identity: (u64, u64),
    bytes: Vec<u8>,
}

fn create_temporary(
    root: &Path,
    relative: &'static str,
    bytes: Vec<u8>,
) -> Result<OwnedTemporary, String> {
    let path = checked_path(root, relative)?;
    fs::create_dir_all(path.parent().ok_or("Invalid temporary path.")?)
        .map_err(|e| e.to_string())?;
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1);
    }
    let mut file = options.open(&path).map_err(|_| {
        format!("Temporary file appeared or cannot be created; it was kept: {relative}")
    })?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(OwnedTemporary {
        relative,
        identity: file_identity(&file)?,
        bytes,
    })
}

fn validator_metadata() -> Result<Vec<u8>, String> {
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|_| "Cannot allocate temporary validator identity.")?;
    let guid: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!("fileFormatVersion: 2\nguid: {guid}\nMonoImporter:\n  externalObjects: {{}}\n  serializedVersion: 2\n  defaultReferences: []\n  executionOrder: 0\n  icon: {{instanceID: 0}}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n").into_bytes())
}

fn reserve_temporaries(
    root: &Path,
    owned: &[OwnedTemporary],
) -> Result<Vec<(PathBuf, File)>, String> {
    let mut held = Vec::new();
    for expected in owned {
        let path = checked_path(root, expected.relative)?;
        let mut file = reserved_file(&path, true)?;
        if file_identity(&file)? != expected.identity || held_bytes(&mut file)? != expected.bytes {
            return Err(
                "Temporary files changed or were replaced; all were kept for review.".into(),
            );
        }
        held.push((path, file));
    }
    Ok(held)
}

fn cleanup_temporary(root: &Path, owned: &[OwnedTemporary]) -> Result<(), String> {
    for (path, file) in reserve_temporaries(root, owned)? {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Storage::FileSystem::{
                FileDispositionInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO,
            };
            let info = FILE_DISPOSITION_INFO { DeleteFile: true };
            // Delete the checked held object, never a newly substituted pathname.
            if unsafe {
                SetFileInformationByHandle(
                    file.as_raw_handle(),
                    FileDispositionInfo,
                    &info as *const _ as *const _,
                    std::mem::size_of_val(&info) as u32,
                )
            } == 0
            {
                return Err(format!(
                    "Cannot remove owned temporary file; review {}.",
                    display_path(&path)
                ));
            }
        }
        #[cfg(unix)]
        {
            if file_identity(&file)?
                != file_identity(&File::open(&path).map_err(|e| e.to_string())?)?
            {
                return Err("Temporary path changed during cleanup; it was kept.".into());
            }
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

struct OperationLock(PathBuf);
impl Drop for OperationLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn acquire_operation_lock(path: &Path) -> Result<OperationLock, String> {
    File::options()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "Another operation already owns this project.".into()
            } else {
                format!(
                    "Cannot create project operation lock {}: {error}",
                    display_path(path)
                )
            }
        })?;
    Ok(OperationLock(path.to_owned()))
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
    let _lock = acquire_operation_lock(&folder.join("operation.lock"))?;
    let backups = checked_path(&root, ".creator-project-setup/backups")?;
    fs::create_dir_all(&backups).map_err(|e| e.to_string())?;
    let backup = backups.join(unique_id());
    fs::create_dir(&backup).map_err(|e| e.to_string())?;
    progress(SetupProgress::new(
        1,
        "Backing up package manifests, project settings and generated Visual Scripting data.",
    ));
    for relative in BACKUP_PATHS {
        let source = checked_path(&root, relative)?;
        if source.exists() {
            copy_tree(&source, &backup.join(relative))?;
        }
    }
    write_json(&backup.join("review.json"), &inspection)?;
    review_unchanged(&root, &inspection).map_err(|error| {
        format!(
            "{error} Nothing was repaired. Backup: {}",
            display_path(&backup)
        )
    })?;
    let report_path = backup.join("result.json");
    if inspection.partial_repair {
        let applied = (|| -> Result<(), String> {
            review_unchanged(&root, &inspection)?;
            temporary_paths_absent(&root)?;
            if inspection.manifest_changed {
                progress(SetupProgress::new(2, "Applying only reviewed package metadata and registry repairs; Unity validation is skipped."));
                publish_manifest(&root, &inspection)?;
            }
            let expected =
                serde_json::to_vec_pretty(&inspection.manifest).map_err(|e| e.to_string())?;
            if read(&root, "Packages/manifest.json")?.as_deref() != Some(expected.as_slice()) {
                return Err(
                    "Manifest verification failed; retain the backup and inspect again.".into(),
                );
            }
            require_editor_lock_clear(editor_lock_state(&root)?)?;
            Ok(())
        })();
        let result = ExistingResult {
            success: applied.is_ok(),
            validated: false,
            partial_repair: true,
            skipped_checks: inspection.skipped_checks.clone(),
            project_path: display_path(&root),
            backup_path: display_path(&backup),
            report_path: display_path(&report_path),
            message: match applied {
                Ok(()) => "Supported manifest repairs completed and verified. Open in Unity, let the installed SDK finish importing, then Inspect again. Unity, compilation and Visual Scripting were not validated; skipped checks are recorded with the backup.".into(),
                Err(error) => format!("{error} Backup retained at {}. No automatic rollback or Unity validation was attempted.", display_path(&backup)),
            },
            validation: None,
        };
        write_json(&report_path, &result)?;
        return Ok(result);
    }
    let mut owned_temporary = Vec::new();
    let mut fresh_validation = false;
    let result = (|| -> Result<Value, String> {
        if request.repair && inspection.manifest_changed {
            progress(SetupProgress::new(
                2,
                "Applying only the package and registry changes in the reviewed plan.",
            ));
        }
        review_unchanged(&root, &inspection)?;
        temporary_paths_absent(&root)?;
        for (relative, bytes) in [
            (VALIDATOR_META, validator_metadata()?),
            (
                VALIDATOR,
                logic::existing_validation_script(&inspection.manifest)?.into_bytes(),
            ),
            (
                EXISTING_REQUEST,
                serde_json::to_vec(&json!({"backupPath": display_path(&backup)}))
                    .map_err(|e| e.to_string())?,
            ),
        ] {
            owned_temporary.push(create_temporary(&root, relative, bytes)?);
        }
        let temporary_guards = reserve_temporaries(&root, &owned_temporary)?;
        if request.repair && inspection.manifest_changed {
            publish_manifest(&root, &inspection)?;
        }
        drop(temporary_guards);
        let validation_path = checked_path(&root, ".creator-project-setup/unity-validation.json")?;
        if validation_path.exists() {
            fs::remove_file(&validation_path).map_err(|e| e.to_string())?;
        }
        fresh_validation = true;
        let progress_file = checked_path(&root, ".creator-project-setup/unity-progress.json")?;
        if progress_file.exists() {
            fs::remove_file(progress_file).map_err(|e| e.to_string())?;
        }
        let environment = logic::probe_environment();
        let editor = existing_editor(&environment, &inspection.editor_version)?;
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
    let result = match cleanup_temporary(&root, &owned_temporary) {
        Ok(()) => result,
        Err(error) => Err(format!(
            "{}Temporary cleanup needs review: {error} No automatic rollback was attempted.",
            result
                .err()
                .map(|before| format!("{before} "))
                .unwrap_or_default()
        )),
    };
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
        validated: success,
        partial_repair: false,
        skipped_checks: Vec::new(),
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

    #[test]
    fn diagnostic_operation_lock_preserves_existing_owner_and_releases_owned_marker() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("operation.lock");
        fs::write(&path, b"existing owner").unwrap();
        let error = acquire_operation_lock(&path).err().unwrap();
        assert_eq!(error, "Another operation already owns this project.");
        assert_eq!(fs::read(&path).unwrap(), b"existing owner");
        let owned_path = temp.path().join("owned.lock");
        let owned = acquire_operation_lock(&owned_path).unwrap();
        assert!(owned_path.is_file());
        assert!(acquire_operation_lock(&owned_path).is_err());
        drop(owned);
        assert!(!owned_path.exists());
        assert_eq!(fs::read(&path).unwrap(), b"existing owner");
    }

    #[test]
    fn diagnostic_operation_lock_io_failure_is_not_reported_as_an_owner() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("not-a-directory");
        fs::write(&parent, b"keep parent").unwrap();
        for path in [
            parent.join("operation.lock"),
            temp.path().join("missing/operation.lock"),
        ] {
            let native = File::options()
                .write(true)
                .create_new(true)
                .open(&path)
                .unwrap_err();
            assert_ne!(native.kind(), std::io::ErrorKind::AlreadyExists);
            let error = acquire_operation_lock(&path).err().unwrap();
            assert!(
                error.contains("Cannot create project operation lock"),
                "{error}"
            );
            assert!(error.contains(&display_path(&path)), "{error}");
            assert!(error.contains(&native.to_string()), "{error}");
            assert!(!error.contains("Another operation"));
        }
        assert_eq!(fs::read(parent).unwrap(), b"keep parent");
        assert!(!temp.path().join("missing").exists());
    }

    #[test]
    fn diagnostic_backup_lock_refusal_preserves_uncertainty() {
        let error =
            require_editor_lock_clear(EditorLockState::Unverified("fixture access denied".into()))
                .unwrap_err();
        assert!(
            error.contains("Cannot verify the Unity lock marker"),
            "{error}"
        );
        assert!(error.contains("fixture access denied"));
        assert!(!error.contains("Project opened or changed"));
        assert!(require_editor_lock_clear(EditorLockState::NotHeld).is_ok());
    }

    #[test]
    fn diagnostic_backup_lock_contention_does_not_claim_unity_ownership() {
        let error = require_editor_lock_clear(EditorLockState::Held).unwrap_err();
        assert!(error.contains("Unity lock marker is in use"), "{error}");
        assert!(!error.contains("Project opened or changed"));
    }
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
    fn tested_sdk4022_pair_is_preserved_without_downgrade() {
        let mut source = manifest();
        source["dependencies"]["com.sidequest.creator-sdk"] = json!("4.0.22");
        source["dependencies"]["com.unity.visualscripting"] = json!("1.9.12");
        source["dependencies"]["org.example.authored"] = json!("file:../authored");
        source["authored"] = json!({"keep": true});
        let (updated, changes, findings) = package_plan(&source).unwrap();
        assert_eq!(updated, source);
        assert!(changes.is_empty());
        assert!(
            !findings.iter().any(|f| f.status == "blocked"),
            "{findings:?}"
        );
    }

    #[test]
    fn tested_sdk4022_pair_adds_only_the_missing_partner() {
        for missing in ["com.sidequest.creator-sdk", "com.unity.visualscripting"] {
            let mut complete = manifest();
            complete["dependencies"]["com.sidequest.creator-sdk"] = json!("4.0.22");
            complete["dependencies"]["com.unity.visualscripting"] = json!("1.9.12");
            let mut source = complete.clone();
            source["dependencies"]
                .as_object_mut()
                .unwrap()
                .remove(missing);
            let (updated, changes, findings) = package_plan(&source).unwrap();
            assert_eq!(updated, complete);
            assert_eq!(changes.len(), 1);
            assert!(
                !findings.iter().any(|f| f.status == "blocked"),
                "{findings:?}"
            );
        }
    }

    #[test]
    fn tested_sdk_pairs_never_replace_mixed_unknown_or_non_registry_references() {
        for (sdk, vs) in [
            (json!("4.0.22"), json!("1.9.1")),
            (json!("4.0.14"), json!("1.9.12")),
            (json!("file:../sdk"), json!("1.9.12")),
            (json!("4.0.22"), json!("https://example.invalid/vs.git")),
            (Value::Null, json!("1.9.12")),
            (json!("4.0.22"), json!({"version": "1.9.12"})),
        ] {
            let mut source = manifest();
            source["dependencies"]["com.sidequest.creator-sdk"] = sdk;
            source["dependencies"]["com.unity.visualscripting"] = vs;
            let (updated, changes, findings) = package_plan(&source).unwrap();
            assert_eq!(updated, source);
            assert!(changes.is_empty());
            assert!(
                findings.iter().any(|f| f.status == "blocked"),
                "{findings:?}"
            );
        }
    }

    #[test]
    fn newer_sdk_readiness_failure_requires_a_current_successful_validation_report() {
        for key in [
            "creatorVisualScriptingConfigured",
            "visualScriptingInitialized",
            "sdkReadyDone",
            "nodesBuiltForThisVersion",
            "nodeDatabaseVerified",
        ] {
            let mut previous = json!({"fingerprint": "review", "validation": {"error": ""}});
            previous["validation"][key] = json!(false);
            assert!(
                known_visual_scripting_failure(Some(&previous), "review"),
                "{key}"
            );
            assert!(!known_visual_scripting_failure(Some(&previous), "changed"));
            previous["validation"]["error"] = json!("Compile error needs review");
            assert!(!known_visual_scripting_failure(Some(&previous), "review"));
            previous["validation"]["error"] = json!("");
            previous["validation"][key] = json!(true);
            assert!(!known_visual_scripting_failure(Some(&previous), "review"));
        }
        assert!(!known_visual_scripting_failure(None, "review"));
        assert!(!known_visual_scripting_failure(
            Some(&json!({"fingerprint":"review", "validation":{"error":""}})),
            "review"
        ));
    }

    #[test]
    fn project_local_sdk_stamp_storage_is_reviewed_and_backed_up_exactly() {
        let temp = tempfile::tempdir().unwrap();
        let backup = tempfile::tempdir().unwrap();
        let before = fingerprint(temp.path()).unwrap();
        let path = temp.path().join(EDITOR_USER_SETTINGS);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let bytes = b"Opaque existing project-local settings; keep all fields\x00";
        fs::write(&path, bytes).unwrap();
        assert_ne!(before, fingerprint(temp.path()).unwrap());
        assert!(BACKUP_PATHS.contains(&EDITOR_USER_SETTINGS));
        copy_tree(&path, &backup.path().join(EDITOR_USER_SETTINGS)).unwrap();
        assert_eq!(
            fs::read(backup.path().join(EDITOR_USER_SETTINGS)).unwrap(),
            bytes
        );
        assert_eq!(fs::read(path).unwrap(), bytes);
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
            .any(|f| f.title == "Creator SDK" && f.status == "check"));
        assert!(findings
            .iter()
            .any(|f| f.title == "Creator SDK" && f.qualification_required));
    }

    #[test]
    fn existing_editor_does_not_require_creation_template_or_different_version() {
        let mut environment = logic::EnvironmentReport {
            platform: "windows".into(),
            hub_installed: true,
            hub_path: None,
            hub_version: None,
            hub_auto_registration: false,
            unity_cli_installed: false,
            unity_cli_path: None,
            recipe: logic::recipe(),
            ready: false,
            editors: vec![logic::EditorInstallation {
                version: logic::EDITOR_VERSION.into(),
                root: "fixture".into(),
                executable: "Unity.exe".into(),
                exact_recipe: true,
                android_player: true,
                android_sdk: true,
                android_ndk: true,
                open_jdk: true,
                windows_standalone: true,
                urp_template: None,
                ready: false,
            }],
            blockers: vec!["The Editor's official 3D URP template is missing.".into()],
            suggested_project_parent: None,
        };
        assert!(existing_editor(&environment, logic::EDITOR_VERSION).is_ok());
        assert!(existing_editor(&environment, "6000.3.27f1")
            .unwrap_err()
            .contains("not installed"));
        environment.editors[0].android_ndk = false;
        assert!(existing_editor(&environment, logic::EDITOR_VERSION)
            .unwrap_err()
            .contains("Android SDK, NDK and OpenJDK"));
    }

    #[test]
    fn newer_packages_stay_unchanged_and_are_marked_unqualified_not_incompatible() {
        let mut source = manifest();
        source["dependencies"]["com.sidequest.creator-sdk"] = json!("4.0.25");
        let (updated, _, findings) = package_plan(&source).unwrap();
        assert_eq!(
            updated["dependencies"]["com.sidequest.creator-sdk"],
            "4.0.25"
        );
        let issue = findings.iter().find(|f| f.title == "Creator SDK").unwrap();
        assert!(issue.qualification_required);
        assert!(issue.detail.contains("not a detected incompatibility"));
        source["dependencies"]["com.sidequest.creator-sdk"] = json!("file:../custom-sdk");
        let (_, _, findings) = package_plan(&source).unwrap();
        let issue = findings.iter().find(|f| f.title == "Creator SDK").unwrap();
        assert!(!issue.qualification_required);
        assert_eq!(issue.status, "blocked");
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

    fn future_fixture(version: &str, editor: &str) -> tempfile::TempDir {
        let temp = fixture();
        let mut source = manifest();
        source["dependencies"]["com.sidequest.creator-sdk"] = json!(version);
        source["scopedRegistries"] = json!([]);
        write_json(&temp.path().join("Packages/manifest.json"), &source).unwrap();
        fs::write(
            temp.path().join("ProjectSettings/ProjectVersion.txt"),
            format!("m_EditorVersion: {editor}\n"),
        )
        .unwrap();
        temp
    }

    fn installed_metadata(root: &Path, version: &str, urp: &str) -> PathBuf {
        let file = root.join("Packages/com.sidequest.creator-sdk/package.json");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        write_json(
            &file,
            &json!({
                "name": "com.sidequest.creator-sdk", "version": version,
                "unity": "6000.3", "unityRelease": "21f1",
                "dependencies": {
                    "com.unity.render-pipelines.universal": urp,
                "com.unity.inputsystem": "1.4.4",
                "com.unity.visualscripting": "1.9.1"
                }
            }),
        )
        .unwrap();
        file
    }

    #[test]
    fn future_sdk_and_editor_are_advisory_without_static_validation() {
        for sdk in ["4.0.25", "999.0.0"] {
            let temp = future_fixture(sdk, "9999.0.1f1");
            let before = fs::read(temp.path().join("Packages/manifest.json")).unwrap();
            let inspected = inspect_unchanged(temp.path());
            assert!(inspected.partial_repair && inspected.can_repair);
            assert!(!inspected.can_validate && !inspected.configure_vs);
            assert!(!inspected.findings.iter().any(|f| f.status == "blocked"));
            for title in ["Creator SDK", "Unity version"] {
                assert!(inspected
                    .findings
                    .iter()
                    .any(|f| f.title == title && f.qualification_required && f.status == "check"));
            }
            assert_eq!(
                inspected.manifest["dependencies"]["com.sidequest.creator-sdk"],
                sdk
            );
            assert_eq!(
                fs::read(temp.path().join("Packages/manifest.json")).unwrap(),
                before
            );
        }
    }

    #[test]
    fn newer_prerelease_and_build_metadata_sdks_are_preserved_and_advisory() {
        for sdk in ["5.0.0-rc.1", "999.0.0+test"] {
            assert!(newer_package(sdk, "4.0.22"));
            let temp = future_fixture(sdk, logic::EDITOR_VERSION);
            let before = fs::read(temp.path().join("Packages/manifest.json")).unwrap();
            let inspected = inspect_unchanged(temp.path());
            assert!(inspected.partial_repair && inspected.can_repair);
            assert!(!inspected.can_validate && !inspected.configure_vs);
            assert!(!inspected.findings.iter().any(|f| f.status == "blocked"));
            assert!(inspected.findings.iter().any(|f| f.title == "Creator SDK"
                && f.qualification_required
                && f.status == "check"));
            assert_eq!(inspected.sdk_version.as_deref(), Some(sdk));
            assert_eq!(
                inspected.manifest["dependencies"]["com.sidequest.creator-sdk"],
                sdk
            );
            assert_eq!(
                fs::read(temp.path().join("Packages/manifest.json")).unwrap(),
                before
            );
        }
        assert!(!newer_package("4.0.22+test", "4.0.22"));
        assert!(!newer_package("4.0.22-rc.1", "4.0.22"));
        assert!(numeric_version("^5.0.0").is_none());
    }

    #[test]
    fn partial_plan_uses_installed_dependency_versions_without_downgrades() {
        let temp = future_fixture("4.0.25", logic::EDITOR_VERSION);
        let mut source: Value =
            serde_json::from_slice(&fs::read(temp.path().join("Packages/manifest.json")).unwrap())
                .unwrap();
        source["dependencies"]
            .as_object_mut()
            .unwrap()
            .remove("com.unity.visualscripting");
        write_json(&temp.path().join("Packages/manifest.json"), &source).unwrap();
        installed_metadata(temp.path(), "4.0.25", "17.4.0");
        let first = inspect_unchanged(temp.path());
        assert_eq!(
            first.manifest["dependencies"]["com.unity.render-pipelines.universal"],
            "17.4.0"
        );
        assert_eq!(
            first.manifest["dependencies"]["com.unity.visualscripting"],
            "1.9.1"
        );
        assert_eq!(
            first.manifest["dependencies"]["com.unity.inputsystem"],
            "1.20.0"
        );
        let result = run(
            ExistingRequest {
                project_path: first.project_path.clone(),
                fingerprint: first.fingerprint.clone(),
                repair: true,
                approved: true,
            },
            |_| {},
        )
        .unwrap();
        assert!(
            result.success && !result.validated && result.validation.is_none(),
            "{}",
            result.message
        );
        let applied: Value =
            serde_json::from_slice(&fs::read(temp.path().join("Packages/manifest.json")).unwrap())
                .unwrap();
        assert_eq!(applied, first.manifest);
        let mut source: Value = serde_json::from_slice(&first.manifest_before).unwrap();
        for (name, version) in [
            ("com.unity.render-pipelines.universal", "18.0.0"),
            ("com.unity.inputsystem", "2.0.0"),
            ("com.unity.visualscripting", "2.0.0"),
        ] {
            source["dependencies"][name] = json!(version);
        }
        write_json(&temp.path().join("Packages/manifest.json"), &source).unwrap();
        let second = inspect_unchanged(temp.path());
        assert_eq!(second.manifest["dependencies"], source["dependencies"]);
        assert!(second.can_repair && !second.can_validate);
    }

    #[test]
    fn partial_without_metadata_repairs_only_known_scopes_and_preserves_validation() {
        let temp = future_fixture("999.0.0", "6000.3.27f1");
        let mut source: Value =
            serde_json::from_slice(&fs::read(temp.path().join("Packages/manifest.json")).unwrap())
                .unwrap();
        source["dependencies"]
            .as_object_mut()
            .unwrap()
            .remove("com.unity.modules.cloth");
        write_json(&temp.path().join("Packages/manifest.json"), &source).unwrap();
        fs::create_dir_all(temp.path().join(".creator-project-setup")).unwrap();
        let previous = b"{\"keep\":\"previous validation\"}";
        for name in [
            "last-validation.json",
            "unity-validation.json",
            "unity-progress.json",
        ] {
            fs::write(
                temp.path().join(".creator-project-setup").join(name),
                previous,
            )
            .unwrap();
        }
        #[cfg(windows)]
        {
            fs::create_dir(temp.path().join("Temp")).unwrap();
            fs::write(temp.path().join("Temp/UnityLockfile"), b"unheld marker").unwrap();
        }
        let inspected = inspect_unchanged(temp.path());
        assert_eq!(inspected.manifest["dependencies"], source["dependencies"]);
        let result = run(
            ExistingRequest {
                project_path: inspected.project_path,
                fingerprint: inspected.fingerprint,
                repair: true,
                approved: true,
            },
            |_| {},
        )
        .unwrap();
        assert!(result.success && result.partial_repair && !result.validated);
        assert!(result.validation.is_none() && !result.skipped_checks.is_empty());
        let after: Value =
            serde_json::from_slice(&fs::read(temp.path().join("Packages/manifest.json")).unwrap())
                .unwrap();
        assert_eq!(after["dependencies"], source["dependencies"]);
        assert_eq!(
            fs::read(Path::new(&result.backup_path).join("Packages/manifest.json")).unwrap(),
            serde_json::to_vec_pretty(&source).unwrap()
        );
        for name in [
            "last-validation.json",
            "unity-validation.json",
            "unity-progress.json",
        ] {
            assert_eq!(
                fs::read(temp.path().join(".creator-project-setup").join(name)).unwrap(),
                previous
            );
        }
        for name in [
            VALIDATOR,
            VALIDATOR_META,
            EXISTING_REQUEST,
            ".creator-project-setup/operation.lock",
        ] {
            assert!(!temp.path().join(name).exists(), "{name}");
        }
        #[cfg(windows)]
        assert_eq!(
            fs::read(temp.path().join("Temp/UnityLockfile")).unwrap(),
            b"unheld marker"
        );
        let saved: Value = serde_json::from_slice(&fs::read(result.report_path).unwrap()).unwrap();
        assert_eq!(saved["validated"], false);
        assert_eq!(saved["partialRepair"], true);
    }

    #[test]
    fn dynamic_metadata_changes_invalidate_review_before_any_repair() {
        let temp = future_fixture("4.0.25", logic::EDITOR_VERSION);
        installed_metadata(temp.path(), "4.0.25", "17.4.0");
        let inspected = inspect_unchanged(temp.path());
        installed_metadata(temp.path(), "4.0.25", "17.5.0");
        let before = project_snapshot(temp.path());
        assert!(run(
            ExistingRequest {
                project_path: inspected.project_path,
                fingerprint: inspected.fingerprint,
                repair: true,
                approved: true
            },
            |_| {}
        )
        .unwrap_err()
        .contains("changed since inspection"));
        assert_eq!(before, project_snapshot(temp.path()));
    }

    #[test]
    fn dynamic_metadata_changes_after_backup_are_rejected() {
        let temp = future_fixture("4.0.25", logic::EDITOR_VERSION);
        installed_metadata(temp.path(), "4.0.25", "17.4.0");
        let inspected = inspect_unchanged(temp.path());
        let before = inspected.manifest_before.clone();
        let error = run(
            ExistingRequest {
                project_path: inspected.project_path,
                fingerprint: inspected.fingerprint,
                repair: true,
                approved: true,
            },
            |event| {
                let _ = event;
                installed_metadata(temp.path(), "4.0.25", "17.5.0");
            },
        )
        .unwrap_err();
        assert!(error.contains("Nothing was repaired"));
        assert_eq!(
            fs::read(temp.path().join("Packages/manifest.json")).unwrap(),
            before
        );
        assert!(temp.path().join(".creator-project-setup/backups").is_dir());
        assert!(!temp.path().join(VALIDATOR).exists());
    }

    #[test]
    fn unknown_sdk_metadata_uses_a_stable_nonblocking_plan() {
        let temp = future_fixture("4.0.25", logic::EDITOR_VERSION);
        let absent = inspect_unchanged(temp.path());
        let metadata = installed_metadata(temp.path(), "4.0.24", "17.4.0");
        let mismatched = inspect_unchanged(temp.path());
        assert_eq!(absent.fingerprint, mismatched.fingerprint);
        fs::write(&metadata, b"unreadable package metadata").unwrap();
        let malformed = inspect_unchanged(temp.path());
        assert_eq!(absent.fingerprint, malformed.fingerprint);
        assert!(malformed.can_repair && malformed.partial_repair && !malformed.can_validate);
        let original: Value = serde_json::from_slice(&malformed.manifest_before).unwrap();
        assert_eq!(malformed.manifest["dependencies"], original["dependencies"]);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            let held = File::options()
                .read(true)
                .share_mode(0)
                .open(&metadata)
                .unwrap();
            let unreadable = inspect(temp.path()).unwrap();
            assert_eq!(absent.fingerprint, unreadable.fingerprint);
            assert!(unreadable.can_repair);
            drop(held);
        }
    }

    #[test]
    fn partial_plan_blocks_older_custom_and_project_safety_issues_not_metadata_errors() {
        for sdk in ["4.0.13", "file:../sdk"] {
            let temp = future_fixture(sdk, "6000.3.27f1");
            assert_refused(&inspect_unchanged(temp.path()), "Creator SDK");
        }
        let temp = future_fixture("4.0.25", logic::EDITOR_VERSION);
        let absent = inspect_unchanged(temp.path());
        let metadata = installed_metadata(temp.path(), "4.0.25", "17.4.0");
        fs::remove_file(&metadata).unwrap();
        fs::create_dir(&metadata).unwrap();
        let unavailable = inspect_unchanged(temp.path());
        assert!(unavailable.partial_repair && unavailable.can_repair && !unavailable.can_validate);
        assert_eq!(unavailable.fingerprint, absent.fingerprint);
        assert_eq!(
            unavailable.manifest["dependencies"],
            absent.manifest["dependencies"]
        );
        assert!(unavailable
            .findings
            .iter()
            .any(|finding| finding.title == "Installed SDK metadata" && finding.status == "check"));
        assert!(metadata.is_dir());
        let temp = future_fixture("4.0.25", "2022.3.1f1");
        assert_refused(&inspect_unchanged(temp.path()), "Unity version");
        let temp = future_fixture("4.0.25", logic::EDITOR_VERSION);
        let mut source: Value =
            serde_json::from_slice(&fs::read(temp.path().join("Packages/manifest.json")).unwrap())
                .unwrap();
        source["scopedRegistries"] =
            json!([{"name":"other", "url":"https://example.invalid", "scopes":["com.sidequest"]}]);
        write_json(&temp.path().join("Packages/manifest.json"), &source).unwrap();
        assert_refused(&inspect_unchanged(temp.path()), "Registry conflict");
        let temp = future_fixture("4.0.25", logic::EDITOR_VERSION);
        fs::create_dir_all(temp.path().join(".creator-project-setup")).unwrap();
        let marker = temp.path().join(".creator-project-setup/operation.lock");
        fs::write(&marker, b"foreign operation").unwrap();
        assert_refused(&inspect_unchanged(temp.path()), "Existing operation");
        assert_eq!(fs::read(marker).unwrap(), b"foreign operation");
    }

    fn existing_urp_without_sdk() -> tempfile::TempDir {
        let temp = fixture();
        let mut source = manifest();
        source["dependencies"]
            .as_object_mut()
            .unwrap()
            .remove("com.sidequest.creator-sdk");
        source["dependencies"]["org.example.authored"] = json!("file:../authored-package");
        source["scopedRegistries"] = json!([{
            "name": "Authored packages",
            "url": "https://example.invalid/registry",
            "scopes": ["org.example"]
        }]);
        source["authoredMetadata"] = json!({"preserve": true});
        write_json(&temp.path().join("Packages/manifest.json"), &source).unwrap();
        for (relative, bytes) in [
            ("Packages/packages-lock.json", "{\"dependencies\":{\"org.example.authored\":{\"version\":\"file:../authored-package\",\"depth\":0}}}"),
            ("ProjectSettings/ProjectSettings.asset", "PlayerSettings:\n  productName: Authored project\n"),
            ("ProjectSettings/QualitySettings.asset", "QualitySettings:\n  m_CurrentQuality: 2\n"),
            (VS_SETTINGS, "typeOptions:\n- System.Text.StringBuilder\n"),
            (VS_DATABASE, "retained synthetic node database"),
            ("Assets/AuthoredContent.txt", "preserve authored content"),
            ("Assets/Settings/ExistingURP.asset", "MonoBehaviour:\n  m_Name: Existing URP\n"),
            ("Assets/Settings/ExistingURP.asset.meta", "guid: 11111111111111111111111111111111\n"),
            ("ProjectSettings/GraphicsSettings.asset", "m_CustomRenderPipeline: {fileID: 11400000, guid: 11111111111111111111111111111111, type: 2}\n"),
        ] {
            let path = temp.path().join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }
        temp
    }

    fn project_snapshot(root: &Path) -> std::collections::BTreeMap<PathBuf, Option<Vec<u8>>> {
        fn visit(
            root: &Path,
            directory: &Path,
            entries: &mut std::collections::BTreeMap<PathBuf, Option<Vec<u8>>>,
        ) {
            for entry in fs::read_dir(directory).unwrap() {
                let entry = entry.unwrap();
                let path = entry.path();
                let directory = entry.file_type().unwrap().is_dir();
                entries.insert(
                    path.strip_prefix(root).unwrap().to_path_buf(),
                    if directory {
                        None
                    } else {
                        Some(fs::read(&path).unwrap())
                    },
                );
                if directory {
                    visit(root, &path, entries);
                }
            }
        }
        let mut entries = std::collections::BTreeMap::new();
        visit(root, root, &mut entries);
        entries
    }

    fn inspect_unchanged(root: &Path) -> Inspection {
        let before = project_snapshot(root);
        let inspection = inspect(root).unwrap();
        assert_eq!(
            project_snapshot(root),
            before,
            "Inspection must not change any file or directory"
        );
        inspection
    }

    fn assert_refused(inspection: &Inspection, title: &str) {
        assert!(
            inspection
                .findings
                .iter()
                .any(|f| f.title == title && f.status == "blocked"),
            "Expected an independent {title} refusal: {:?}",
            inspection.findings
        );
        assert!(!inspection.can_repair && !inspection.can_validate);
    }

    #[test]
    fn existing_urp_missing_sdk_previews_sdk_and_registry_without_mutation() {
        let temp = existing_urp_without_sdk();
        let mut expected: Value =
            serde_json::from_slice(&fs::read(temp.path().join("Packages/manifest.json")).unwrap())
                .unwrap();
        expected["dependencies"]["com.sidequest.creator-sdk"] = json!(logic::CREATOR_SDK_VERSION);
        expected["scopedRegistries"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "name": "Greenfield-registry.sdq.st",
                "url": logic::REGISTRY_URL,
                "scopes": REGISTRY_SCOPES
            }));
        let inspection = inspect_unchanged(temp.path());
        assert_eq!(
            inspection.manifest, expected,
            "Only the SDK and its missing registry may be added to the preview"
        );
        assert!(inspection.manifest_changed);
        assert!(inspection.configure_vs);
        assert!(inspection
            .proposed_changes
            .iter()
            .any(|change| change.starts_with("Initialize Creator Visual Scripting")));
        assert!(inspection.proposed_changes.contains(&format!(
            "Add com.sidequest.creator-sdk {}.",
            logic::CREATOR_SDK_VERSION
        )));
        assert!(inspection
            .findings
            .iter()
            .any(|f| f.title == "Creator SDK registry" && f.status == "repair"));
        assert!(inspection
            .findings
            .iter()
            .any(|f| f.title == "Render pipeline" && f.status == "check"));
        // Installed tools may independently block this machine; package eligibility must not.
        let blockers: Vec<_> = inspection
            .findings
            .iter()
            .filter(|f| f.status == "blocked")
            .collect();
        assert!(
            blockers.iter().all(|f| f.title == "Computer requirements"),
            "{:?}",
            inspection.findings
        );
        assert_eq!(inspection.can_repair, blockers.is_empty());
        assert!(
            !inspection.can_validate,
            "Validation alone cannot add the missing SDK"
        );
    }

    #[test]
    fn existing_urp_missing_sdk_keeps_complete_registries_unchanged() {
        let temp = existing_urp_without_sdk();
        let mut source: Value =
            serde_json::from_slice(&fs::read(temp.path().join("Packages/manifest.json")).unwrap())
                .unwrap();
        source["scopedRegistries"]
            .as_array_mut()
            .unwrap()
            .push(manifest()["scopedRegistries"][0].clone());
        write_json(&temp.path().join("Packages/manifest.json"), &source).unwrap();
        let inspection = inspect_unchanged(temp.path());
        let mut expected = source;
        expected["dependencies"]["com.sidequest.creator-sdk"] = json!(logic::CREATOR_SDK_VERSION);
        assert_eq!(inspection.manifest, expected);
        assert!(inspection.configure_vs);
        assert_eq!(
            inspection.proposed_changes,
            vec![
                format!("Add com.sidequest.creator-sdk {}.", logic::CREATOR_SDK_VERSION),
                "Initialize Creator Visual Scripting and rebuild its node database; retain existing type selections.".into(),
            ]
        );
    }

    #[test]
    fn existing_urp_existing_sdk_and_vs_files_do_not_force_reconfiguration() {
        let temp = existing_urp_without_sdk();
        let mut source: Value =
            serde_json::from_slice(&fs::read(temp.path().join("Packages/manifest.json")).unwrap())
                .unwrap();
        source["dependencies"]["com.sidequest.creator-sdk"] = json!(logic::CREATOR_SDK_VERSION);
        source["scopedRegistries"]
            .as_array_mut()
            .unwrap()
            .push(manifest()["scopedRegistries"][0].clone());
        write_json(&temp.path().join("Packages/manifest.json"), &source).unwrap();
        let inspection = inspect_unchanged(temp.path());
        assert_eq!(inspection.manifest, source);
        assert!(!inspection.manifest_changed);
        assert!(!inspection.configure_vs);
        assert!(inspection.proposed_changes.is_empty());
        assert!(!inspection.can_repair);
        let blockers: Vec<_> = inspection
            .findings
            .iter()
            .filter(|f| f.status == "blocked")
            .collect();
        assert!(blockers.iter().all(|f| f.title == "Computer requirements"));
        assert_eq!(inspection.can_validate, blockers.is_empty());
    }

    #[test]
    fn existing_urp_missing_sdk_and_visual_scripting_package_previews_both_and_configures() {
        let temp = existing_urp_without_sdk();
        let mut source: Value =
            serde_json::from_slice(&fs::read(temp.path().join("Packages/manifest.json")).unwrap())
                .unwrap();
        source["dependencies"]
            .as_object_mut()
            .unwrap()
            .remove("com.unity.visualscripting");
        write_json(&temp.path().join("Packages/manifest.json"), &source).unwrap();
        let inspection = inspect_unchanged(temp.path());
        assert!(inspection.configure_vs);
        assert_eq!(
            inspection.manifest["dependencies"]["com.sidequest.creator-sdk"],
            logic::CREATOR_SDK_VERSION
        );
        assert_eq!(
            inspection.manifest["dependencies"]["com.unity.visualscripting"],
            "1.9.1"
        );
        assert!(inspection
            .proposed_changes
            .contains(&"Add com.unity.visualscripting 1.9.1.".to_owned()));
        assert!(inspection
            .proposed_changes
            .iter()
            .any(|change| change.starts_with("Initialize Creator Visual Scripting")));
    }

    #[test]
    fn existing_urp_missing_sdk_editor_mismatch_refuses() {
        let temp = existing_urp_without_sdk();
        fs::write(
            temp.path().join("ProjectSettings/ProjectVersion.txt"),
            "m_EditorVersion: 2022.3.1f1\n",
        )
        .unwrap();
        let inspection = inspect_unchanged(temp.path());
        assert_refused(&inspection, "Unity version");
        assert_eq!(inspection.editor_version, "2022.3.1f1");
        assert!(inspection.configure_vs);
    }

    fn inspect_package_mismatch(package: &str, version: &str, title: &str) {
        let temp = existing_urp_without_sdk();
        let mut source: Value =
            serde_json::from_slice(&fs::read(temp.path().join("Packages/manifest.json")).unwrap())
                .unwrap();
        source["dependencies"][package] = json!(version);
        write_json(&temp.path().join("Packages/manifest.json"), &source).unwrap();
        let inspection = inspect_unchanged(temp.path());
        assert_refused(&inspection, title);
        assert_eq!(
            inspection.configure_vs,
            package != "com.sidequest.creator-sdk"
        );
        assert_eq!(
            inspection.manifest["dependencies"][package], version,
            "Mismatched references cannot be silently replaced"
        );
    }

    #[test]
    fn existing_urp_sdk_version_mismatch_refuses() {
        inspect_package_mismatch("com.sidequest.creator-sdk", "4.0.13", "Creator SDK");
    }

    #[test]
    fn existing_urp_missing_sdk_newer_input_is_preserved_without_static_repair() {
        let temp = existing_urp_without_sdk();
        let mut source: Value =
            serde_json::from_slice(&fs::read(temp.path().join("Packages/manifest.json")).unwrap())
                .unwrap();
        source["dependencies"]["com.unity.inputsystem"] = json!("99.0.0");
        write_json(&temp.path().join("Packages/manifest.json"), &source).unwrap();
        let inspection = inspect_unchanged(temp.path());
        assert!(inspection.partial_repair);
        assert!(!inspection.can_validate && !inspection.configure_vs);
        assert_eq!(inspection.manifest["dependencies"], source["dependencies"]);
        assert!(!inspection.skipped_checks.is_empty());
    }

    #[test]
    fn existing_urp_missing_sdk_older_urp_version_mismatch_refuses() {
        inspect_package_mismatch(
            "com.unity.render-pipelines.universal",
            "16.0.0",
            "URP package",
        );
    }

    #[test]
    fn existing_urp_missing_sdk_registry_conflict_refuses() {
        let temp = existing_urp_without_sdk();
        let mut source: Value =
            serde_json::from_slice(&fs::read(temp.path().join("Packages/manifest.json")).unwrap())
                .unwrap();
        let foreign = json!({"name": "Foreign SDK registry", "url": "https://example.invalid/sdk", "scopes": ["com.sidequest.creator-sdk"]});
        source["scopedRegistries"]
            .as_array_mut()
            .unwrap()
            .push(foreign.clone());
        write_json(&temp.path().join("Packages/manifest.json"), &source).unwrap();
        let inspection = inspect_unchanged(temp.path());
        assert_refused(&inspection, "Registry conflict");
        assert_eq!(inspection.manifest["scopedRegistries"][1], foreign);
        assert!(inspection.configure_vs);
    }

    #[test]
    fn existing_urp_missing_sdk_unassigned_default_pipeline_refuses() {
        let temp = existing_urp_without_sdk();
        fs::write(
            temp.path().join("ProjectSettings/GraphicsSettings.asset"),
            "m_CustomRenderPipeline: {fileID: 0}\n",
        )
        .unwrap();
        let inspection = inspect_unchanged(temp.path());
        assert_refused(&inspection, "Render pipeline");
        assert!(inspection.configure_vs);
    }

    #[test]
    fn preexisting_validator_meta_refuses_read_only_inspection() {
        let temp = existing_urp_without_sdk();
        let meta = temp.path().join(VALIDATOR).with_extension("cs.meta");
        fs::create_dir_all(meta.parent().unwrap()).unwrap();
        fs::write(&meta, "guid: 22222222222222222222222222222222\n").unwrap();
        let inspection = inspect_unchanged(temp.path());
        assert_refused(&inspection, "Temporary validator already present");
        let issue = inspection
            .findings
            .iter()
            .find(|finding| finding.title == "Temporary validator already present")
            .unwrap();
        assert!(issue
            .diagnostic_paths
            .contains(&display_path(&fs::canonicalize(&meta).unwrap())));
        assert!(meta.is_file());
    }

    #[test]
    fn interrupted_operation_exposes_recovery_paths_without_removing_the_marker() {
        let temp = fixture();
        let marker = temp.path().join(".creator-project-setup/operation.lock");
        fs::create_dir_all(marker.parent().unwrap()).unwrap();
        fs::write(&marker, "retained operation").unwrap();
        let before = fingerprint(temp.path()).unwrap();
        let inspection = inspect(temp.path()).unwrap();
        assert_eq!(fingerprint(temp.path()).unwrap(), before);
        assert_refused(&inspection, "Existing operation");
        let issue = inspection
            .findings
            .iter()
            .find(|finding| finding.title == "Existing operation")
            .unwrap();
        assert!(issue
            .diagnostic_paths
            .contains(&display_path(&fs::canonicalize(&marker).unwrap())));
        assert_eq!(fs::read(&marker).unwrap(), b"retained operation");
    }

    fn owned_temporary_fixture(root: &Path) -> Vec<OwnedTemporary> {
        [
            (VALIDATOR_META, validator_metadata().unwrap()),
            (VALIDATOR, logic::validation_script().into_bytes()),
            (
                EXISTING_REQUEST,
                br#"{"backupPath":"owned fixture"}"#.to_vec(),
            ),
        ]
        .into_iter()
        .map(|(relative, bytes)| create_temporary(root, relative, bytes).unwrap())
        .collect()
    }

    #[test]
    fn unchanged_owned_temporary_files_are_removed() {
        let temp = existing_urp_without_sdk();
        let manifest_before = fs::read(temp.path().join("Packages/manifest.json")).unwrap();
        let settings_before = fs::read(temp.path().join(VS_SETTINGS)).unwrap();
        let owned = owned_temporary_fixture(temp.path());
        cleanup_temporary(temp.path(), &owned).unwrap();
        for file in owned {
            assert!(!temp.path().join(file.relative).exists());
        }
        assert_eq!(
            fs::read(temp.path().join("Packages/manifest.json")).unwrap(),
            manifest_before
        );
        assert_eq!(
            fs::read(temp.path().join(VS_SETTINGS)).unwrap(),
            settings_before
        );
    }

    #[test]
    fn same_content_replacement_is_preserved_by_temporary_identity() {
        for index in 0..3 {
            let temp = existing_urp_without_sdk();
            let owned = owned_temporary_fixture(temp.path());
            let path = temp.path().join(owned[index].relative);
            let retained = temp.path().join("retained original temporary");
            fs::rename(&path, &retained).unwrap();
            fs::write(&path, &owned[index].bytes).unwrap();
            let before = project_snapshot(temp.path());
            assert!(cleanup_temporary(temp.path(), &owned).is_err());
            assert_eq!(
                project_snapshot(temp.path()),
                before,
                "An identity mismatch must preserve every temporary file"
            );
        }
    }

    #[test]
    fn changed_temporary_bytes_preserve_all_cleanup_evidence() {
        for index in 0..3 {
            let temp = existing_urp_without_sdk();
            let owned = owned_temporary_fixture(temp.path());
            fs::write(
                temp.path().join(owned[index].relative),
                b"changed by another writer",
            )
            .unwrap();
            let before = project_snapshot(temp.path());
            assert!(cleanup_temporary(temp.path(), &owned).is_err());
            assert_eq!(project_snapshot(temp.path()), before);
        }
    }

    #[test]
    fn temporary_create_new_never_replaces_foreign_targets() {
        for relative in [VALIDATOR_META, VALIDATOR, EXISTING_REQUEST] {
            let temp = existing_urp_without_sdk();
            let path = temp.path().join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, b"foreign temporary target").unwrap();
            let before = project_snapshot(temp.path());
            assert!(create_temporary(temp.path(), relative, b"owned temporary".to_vec()).is_err());
            assert_eq!(project_snapshot(temp.path()), before);
        }
    }

    #[test]
    fn manifest_publication_keeps_late_byte_edits() {
        let temp = existing_urp_without_sdk();
        let inspection = inspect_unchanged(temp.path());
        let root = fs::canonicalize(temp.path()).unwrap();
        assert_eq!(fingerprint(&root).unwrap(), inspection.fingerprint);
        let mut late_bytes = inspection.manifest_before.clone();
        late_bytes.push(b'\n');
        fs::write(temp.path().join("Packages/manifest.json"), &late_bytes).unwrap();
        let before = project_snapshot(temp.path());
        let error = publish_manifest(&root, &inspection).unwrap_err();
        assert!(error.contains("Package manifest changed after review"));
        assert_eq!(project_snapshot(temp.path()), before);
        assert_ne!(late_bytes, inspection.manifest_before);
    }

    #[test]
    fn manifest_publication_writes_only_the_reviewed_plan() {
        let temp = existing_urp_without_sdk();
        let inspection = inspect_unchanged(temp.path());
        let root = fs::canonicalize(temp.path()).unwrap();
        assert_eq!(fingerprint(&root).unwrap(), inspection.fingerprint);
        let before = inspection.manifest_before.clone();
        publish_manifest(&root, &inspection).unwrap();
        assert_eq!(
            fs::read(temp.path().join("Packages/manifest.json")).unwrap(),
            serde_json::to_vec_pretty(&inspection.manifest).unwrap()
        );
        assert_eq!(inspection.manifest_before, before);
    }

    #[test]
    #[ignore = "Read-only installed requirements inventory; not portable fixture evidence or Unity acceptance"]
    fn installed_requirements_read_only_probe() {
        println!(
            "{}",
            serde_json::to_string_pretty(&logic::probe_environment()).unwrap()
        );
    }

    #[test]
    #[ignore = "Pre-Unity write-boundary audit with installed requirements; deliberately refuses before any Editor lookup or launch"]
    fn pre_unity_repair_write_boundary_audit() {
        let environment = logic::probe_environment();
        assert!(environment.ready, "{:?}", environment.blockers);
        let temp = existing_urp_without_sdk();
        let manifest_path = temp.path().join("Packages/manifest.json");
        let original_manifest = fs::read(&manifest_path).unwrap();
        let mut late_manifest: Value = serde_json::from_slice(&original_manifest).unwrap();
        late_manifest["authoredAfterBackup"] = json!(true);
        let inspection = inspect_unchanged(temp.path());
        assert!(inspection.can_repair, "{:?}", inspection.findings);
        let request_path = temp
            .path()
            .join(".creator-project-setup/existing-request.json");
        let request_marker = b"owned audit refusal before any Unity process";
        let refused_before_launch = std::cell::Cell::new(false);
        // Raced temporary targets must be refused before Editor lookup.
        let source = include_str!("repair.rs");
        let run_source = source
            .split("pub fn run(")
            .nth(1)
            .unwrap()
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        assert!(
            run_source.find("temporary_paths_absent(&root)?").unwrap()
                < run_source
                    .find("let environment = logic::probe_environment()")
                    .unwrap()
        );
        let result = run(
            ExistingRequest {
                project_path: display_path(temp.path()),
                fingerprint: inspection.fingerprint,
                repair: true,
                approved: true,
            },
            |progress| {
                assert!(
                    progress.step < 3,
                    "The audit must stop before any Unity launch"
                );
                if progress.step == 2 {
                    write_json(&manifest_path, &late_manifest).unwrap();
                    File::options()
                        .write(true)
                        .create_new(true)
                        .open(&request_path)
                        .unwrap()
                        .write_all(request_marker)
                        .unwrap();
                    refused_before_launch.set(true);
                }
            },
        )
        .unwrap();
        assert!(refused_before_launch.get());
        assert!(!result.success);
        assert!(result.validation.is_none());
        assert_eq!(fs::read(&request_path).unwrap(), request_marker);
        assert_eq!(
            fs::read(Path::new(&result.backup_path).join("Packages/manifest.json")).unwrap(),
            original_manifest
        );
        let actual_manifest: Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        assert_eq!(
            actual_manifest, late_manifest,
            "The progress callback's later edit must never be overwritten"
        );
        assert!(!temp.path().join(VALIDATOR).exists());
        assert!(!temp
            .path()
            .join(VALIDATOR)
            .with_extension("cs.meta")
            .exists());
        println!(
            "{}",
            json!({
                "forcedRefusalBeforeUnity": true,
                "originalManifestBackupPreserved": true,
                "lateManifestEditPreserved": actual_manifest == late_manifest,
            })
        );
    }

    #[test]
    #[ignore = "Pre-Unity raced-target regression with installed requirements; owned request collision prevents every Unity launch"]
    fn pre_unity_raced_temporary_targets_preserve_manifest_and_foreign_files() {
        assert!(logic::probe_environment().ready);
        for relative in [
            VALIDATOR,
            "Assets/Editor/CreatorProjectSetupValidator.cs.meta",
            ".creator-project-setup/existing-request.json",
        ] {
            let temp = existing_urp_without_sdk();
            let inspection = inspect_unchanged(temp.path());
            assert!(inspection.can_repair);
            let manifest_path = temp.path().join("Packages/manifest.json");
            let before = fs::read(&manifest_path).unwrap();
            let foreign = b"foreign file appeared after backup";
            let request_path = temp
                .path()
                .join(".creator-project-setup/existing-request.json");
            let raced = temp.path().join(relative);
            let result = run(
                ExistingRequest {
                    project_path: display_path(temp.path()),
                    fingerprint: inspection.fingerprint,
                    repair: true,
                    approved: true,
                },
                |progress| {
                    assert!(
                        progress.step < 3,
                        "The owned request collision must prevent Unity launch"
                    );
                    if progress.step == 2 {
                        fs::create_dir_all(raced.parent().unwrap()).unwrap();
                        fs::write(&raced, foreign).unwrap();
                        if raced != request_path {
                            fs::write(&request_path, foreign).unwrap();
                        }
                    }
                },
            )
            .unwrap();
            assert!(!result.success);
            assert_eq!(
                fs::read(&raced).unwrap(),
                foreign,
                "Raced {relative} must be preserved"
            );
            assert_eq!(fs::read(&request_path).unwrap(), foreign);
            assert_eq!(
                fs::read(&manifest_path).unwrap(),
                before,
                "A raced temporary target must refuse before manifest publication"
            );
        }
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

    #[cfg(windows)]
    #[test]
    fn editor_lock_stale_held_and_released_preserves_marker() {
        use std::os::windows::fs::OpenOptionsExt;
        let temp = fixture();
        fs::create_dir(temp.path().join("Temp")).unwrap();
        let lock = temp.path().join("Temp/UnityLockfile");
        fs::write(&lock, b"retained stale marker").unwrap();
        let before = fingerprint(&fs::canonicalize(temp.path()).unwrap()).unwrap();
        assert!(!inspect(temp.path()).unwrap().locked);
        let held = File::options()
            .read(true)
            .share_mode(0)
            .open(&lock)
            .unwrap();
        assert!(inspect(temp.path()).unwrap().locked);
        drop(held);
        assert!(!inspect(temp.path()).unwrap().locked);
        assert_eq!(fs::read(&lock).unwrap(), b"retained stale marker");
        assert_eq!(
            fingerprint(&fs::canonicalize(temp.path()).unwrap()).unwrap(),
            before
        );
        assert!(!temp.path().join(".creator-project-setup").exists());
    }

    #[cfg(windows)]
    #[test]
    fn editor_lock_release_keeps_newer_versions_advisory_without_validation() {
        use std::os::windows::fs::OpenOptionsExt;
        let temp = fixture();
        let manifest_path = temp.path().join("Packages/manifest.json");
        let mut packages = manifest();
        packages["dependencies"]["com.sidequest.creator-sdk"] = json!("4.0.23");
        packages["dependencies"]["com.unity.visualscripting"] = json!("1.9.13");
        write_json(&manifest_path, &packages).unwrap();
        let before = fs::read(&manifest_path).unwrap();
        fs::create_dir(temp.path().join("Temp")).unwrap();
        let lock = temp.path().join("Temp/UnityLockfile");
        fs::write(&lock, b"retained reported marker").unwrap();
        let assert_blocked = |locked| {
            let report = inspect(temp.path()).unwrap();
            assert_eq!(report.locked, locked);
            assert!(!report.can_repair && !report.can_validate);
            assert!(report.partial_repair);
            assert!(!report.configure_vs);
            assert!(report
                .findings
                .iter()
                .any(|finding| finding.title == "Creator SDK"
                    && finding.status == "check"
                    && finding.detail.contains("4.0.23")));
            assert!(
                report
                    .findings
                    .iter()
                    .any(|finding| finding.status == "blocked")
                    == locked
            );
            assert_eq!(fs::read(&manifest_path).unwrap(), before);
            assert!(!temp.path().join(".creator-project-setup").exists());
        };
        assert_blocked(false);
        let held = File::options()
            .read(true)
            .share_mode(0)
            .open(&lock)
            .unwrap();
        assert_blocked(true);
        drop(held);
        assert_blocked(false);
        assert_eq!(fs::read(lock).unwrap(), b"retained reported marker");
    }

    #[cfg(windows)]
    #[test]
    fn editor_lock_acquired_after_inspection_blocks_before_any_repair() {
        use std::os::windows::fs::OpenOptionsExt;
        let temp = fixture();
        fs::create_dir(temp.path().join("Temp")).unwrap();
        let lock = temp.path().join("Temp/UnityLockfile");
        fs::write(&lock, b"keep marker").unwrap();
        let inspection = inspect(temp.path()).unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        assert!(review_unchanged(&root, &inspection).is_ok());
        let held = File::options()
            .read(true)
            .share_mode(0)
            .open(&lock)
            .unwrap();
        assert!(review_unchanged(&root, &inspection).is_err());
        let error = run(
            ExistingRequest {
                project_path: inspection.project_path.clone(),
                fingerprint: inspection.fingerprint.clone(),
                repair: true,
                approved: true,
            },
            |_| {},
        )
        .unwrap_err();
        assert!(error.contains("blocked by the inspection findings"));
        assert!(!temp.path().join(".creator-project-setup").exists());
        drop(held);
        assert!(review_unchanged(&root, &inspection).is_ok());
        assert_eq!(fs::read(lock).unwrap(), b"keep marker");
    }

    #[test]
    fn editor_lock_nonregular_marker_is_retained_and_refused() {
        let temp = fixture();
        fs::create_dir_all(temp.path().join("Temp/UnityLockfile")).unwrap();
        let lock = temp.path().join("Temp/UnityLockfile");
        fs::write(lock.join("owner.txt"), b"keep").unwrap();
        assert!(inspect(temp.path())
            .unwrap_err()
            .contains("not an ordinary file"));
        assert_eq!(fs::read(lock.join("owner.txt")).unwrap(), b"keep");
        assert!(!temp.path().join(".creator-project-setup").exists());
    }

    #[cfg(unix)]
    #[test]
    fn editor_lock_symlink_is_retained_and_refused() {
        let temp = fixture();
        let external = tempfile::NamedTempFile::new().unwrap();
        fs::create_dir(temp.path().join("Temp")).unwrap();
        let lock = temp.path().join("Temp/UnityLockfile");
        std::os::unix::fs::symlink(external.path(), &lock).unwrap();
        assert!(inspect(temp.path())
            .unwrap_err()
            .contains("Linked files or folders"));
        assert!(fs::symlink_metadata(lock).unwrap().file_type().is_symlink());
    }

    #[cfg(windows)]
    #[test]
    fn editor_lock_junction_ancestor_is_retained_and_refused() {
        use std::os::windows::process::CommandExt;
        use wait_timeout::ChildExt;
        let temp = fixture();
        let external = tempfile::tempdir().unwrap();
        fs::write(
            external.path().join("UnityLockfile"),
            b"keep external marker",
        )
        .unwrap();
        let mut child = std::process::Command::new("cmd.exe")
            .args(["/d", "/v:off", "/c"])
            .raw_arg("mklink /J \"%CREATOR_TEST_JUNCTION%\" \"%CREATOR_TEST_JUNCTION_TARGET%\"")
            .env("CREATOR_TEST_JUNCTION", temp.path().join("Temp"))
            .env("CREATOR_TEST_JUNCTION_TARGET", external.path())
            .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let status = child
            .wait_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        if status.is_none() {
            child
                .kill()
                .expect("stop only the owned junction test helper");
            assert!(child
                .wait_timeout(std::time::Duration::from_secs(2))
                .unwrap()
                .is_some());
            panic!("junction test helper exceeded its deadline");
        }
        assert!(status.unwrap().success());
        assert!(inspect(temp.path())
            .unwrap_err()
            .contains("Linked files or folders"));
        assert_eq!(
            fs::read(external.path().join("UnityLockfile")).unwrap(),
            b"keep external marker"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn editor_lock_unheld_marker_stays_blocked_without_a_proven_native_protocol() {
        let temp = fixture();
        fs::create_dir(temp.path().join("Temp")).unwrap();
        let lock = temp.path().join("Temp/UnityLockfile");
        fs::write(&lock, b"retained marker").unwrap();
        assert!(inspect(temp.path()).unwrap().locked);
        assert_eq!(fs::read(lock).unwrap(), b"retained marker");
    }

    #[test]
    fn open_project_and_unsupported_editor_block_operations() {
        let temp = fixture();
        fs::create_dir(temp.path().join("Temp")).unwrap();
        fs::write(temp.path().join("Temp/UnityLockfile"), "").unwrap();
        #[cfg(windows)]
        let held = {
            use std::os::windows::fs::OpenOptionsExt;
            File::options()
                .read(true)
                .share_mode(0)
                .open(temp.path().join("Temp/UnityLockfile"))
                .unwrap()
        };
        let report = inspect(temp.path()).unwrap();
        assert!(report.locked);
        assert!(!report.can_repair && !report.can_validate);
        let finding = report
            .findings
            .iter()
            .find(|finding| finding.title == "Project lock needs review")
            .unwrap();
        assert!(finding
            .detail
            .contains("The lock file has not been removed."));
        assert!(!finding.detail.contains("Project is open"));
        #[cfg(windows)]
        drop(held);
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
