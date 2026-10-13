use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tar::Archive;
use wait_timeout::ChildExt;

pub const EDITOR_VERSION: &str = "6000.3.21f1";
pub const EDITOR_CHANGESET: &str = "c02631ffc030";
pub const CREATOR_SDK_VERSION: &str = "4.0.14";
pub const URP_VERSION: &str = "17.3.0";
pub const INPUT_SYSTEM_VERSION: &str = "1.20.0";
pub const SDK_DECLARED_URP_VERSION: &str = "17.4.0";
pub(crate) const REGISTRY_URL: &str = "https://greenfield-registry.sdq.st";
pub(crate) const REQUIRED_BUILTIN_MODULES: &[&str] = &[
    "com.unity.modules.accessibility",
    "com.unity.modules.adaptiveperformance",
    "com.unity.modules.ai",
    "com.unity.modules.androidjni",
    "com.unity.modules.animation",
    "com.unity.modules.assetbundle",
    "com.unity.modules.audio",
    "com.unity.modules.cloth",
    "com.unity.modules.director",
    "com.unity.modules.imageconversion",
    "com.unity.modules.imgui",
    "com.unity.modules.jsonserialize",
    "com.unity.modules.particlesystem",
    "com.unity.modules.physics",
    "com.unity.modules.physics2d",
    "com.unity.modules.screencapture",
    "com.unity.modules.terrain",
    "com.unity.modules.terrainphysics",
    "com.unity.modules.tilemap",
    "com.unity.modules.ui",
    "com.unity.modules.uielements",
    "com.unity.modules.umbra",
    "com.unity.modules.unityanalytics",
    "com.unity.modules.unitywebrequest",
    "com.unity.modules.unitywebrequestassetbundle",
    "com.unity.modules.unitywebrequestaudio",
    "com.unity.modules.unitywebrequesttexture",
    "com.unity.modules.unitywebrequestwww",
    "com.unity.modules.vectorgraphics",
    "com.unity.modules.vehicles",
    "com.unity.modules.video",
    "com.unity.modules.vr",
    "com.unity.modules.wind",
    "com.unity.modules.xr",
];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Recipe {
    pub editor_version: String,
    pub editor_changeset: String,
    pub creator_sdk_version: String,
    pub urp_version: String,
    pub input_system_version: String,
    pub sdk_declared_urp_version: String,
    pub registry_url: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditorInstallation {
    pub version: String,
    pub root: String,
    pub executable: String,
    pub exact_recipe: bool,
    pub android_player: bool,
    pub android_sdk: bool,
    pub android_ndk: bool,
    pub open_jdk: bool,
    pub windows_standalone: bool,
    pub urp_template: Option<String>,
    pub ready: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentReport {
    pub platform: String,
    pub hub_installed: bool,
    pub hub_path: Option<String>,
    pub hub_version: Option<String>,
    pub hub_auto_registration: bool,
    pub unity_cli_installed: bool,
    pub unity_cli_path: Option<String>,
    pub recipe: Recipe,
    pub editors: Vec<EditorInstallation>,
    pub ready: bool,
    pub blockers: Vec<String>,
    pub suggested_project_parent: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRequest {
    pub project_name: String,
    pub parent_directory: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreationResult {
    pub success: bool,
    pub project_path: String,
    pub log_path: String,
    pub receipt_path: String,
    pub message: String,
    pub hub: crate::hub::HubRegistration,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SetupProgress {
    pub step: u8,
    pub detail: String,
    // Only native inspection may supply this, never the project's progress file.
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub environment: Option<EnvironmentReport>,
}

impl SetupProgress {
    pub(crate) fn new(step: u8, detail: impl Into<String>) -> Self {
        Self {
            step,
            detail: detail.into(),
            environment: None,
        }
    }

    fn requirements_checked(environment: EnvironmentReport) -> Self {
        Self {
            step: 1,
            detail: "Checked installed Unity and required modules.".into(),
            environment: Some(environment),
        }
    }
}

pub fn recipe() -> Recipe {
    Recipe {
        editor_version: EDITOR_VERSION.into(),
        editor_changeset: EDITOR_CHANGESET.into(),
        creator_sdk_version: CREATOR_SDK_VERSION.into(),
        urp_version: URP_VERSION.into(),
        input_system_version: INPUT_SYSTEM_VERSION.into(),
        sdk_declared_urp_version: SDK_DECLARED_URP_VERSION.into(),
        registry_url: REGISTRY_URL.into(),
    }
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

fn hub_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if cfg!(target_os = "windows") {
        if let Some(program_files) = env::var_os("ProgramFiles") {
            paths.push(PathBuf::from(program_files).join("Unity Hub/Unity Hub.exe"));
        }
    } else if cfg!(target_os = "macos") {
        paths.push(PathBuf::from("/Applications/Unity Hub.app"));
        if let Some(home) = dirs::home_dir() {
            paths.push(home.join("Applications/Unity Hub.app"));
        }
    } else {
        paths.extend([
            PathBuf::from("/usr/bin/unityhub"),
            PathBuf::from("/usr/bin/unityhub-bin"),
            PathBuf::from("/opt/unityhub/unityhub"),
        ]);
        if let Some(home) = dirs::home_dir() {
            paths.push(home.join("Applications/UnityHub.AppImage"));
        }
    }
    paths
}

fn editor_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    roots.extend(crate::bootstrap::known_editor_roots());
    if let Some(custom) = env::var_os("CREATOR_SETUP_EDITOR_ROOT") {
        roots.push(PathBuf::from(custom));
    }
    if cfg!(target_os = "windows") {
        if let Some(program_files) = env::var_os("ProgramFiles") {
            roots.push(PathBuf::from(program_files).join("Unity/Hub/Editor"));
        }
    } else if cfg!(target_os = "macos") {
        roots.push(PathBuf::from("/Applications/Unity/Hub/Editor"));
    } else if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Unity/Hub/Editor"));
        roots.push(home.join(".local/share/unityhub/editors"));
    }
    roots.sort();
    roots.dedup();
    roots
}

fn executable_for(root: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        root.join("Editor/Unity.exe")
    } else if cfg!(target_os = "macos") {
        root.join("Unity.app/Contents/MacOS/Unity")
    } else {
        root.join("Editor/Unity")
    }
}

pub(crate) fn editor_data(root: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        root.join("Unity.app/Contents")
    } else {
        root.join("Editor/Data")
    }
}

pub(crate) fn playback_engines(root: &Path) -> PathBuf {
    playback_engines_for(root, std::env::consts::OS)
}

fn playback_engines_for(root: &Path, host: &str) -> PathBuf {
    // macOS module packages live beside Unity.app, not inside its bundle.
    if host == "macos" {
        root.join("PlaybackEngines")
    } else {
        root.join("Editor/Data/PlaybackEngines")
    }
}

fn find_case_insensitive_child(parent: &Path, expected: &str) -> Option<PathBuf> {
    fs::read_dir(parent)
        .ok()?
        .filter_map(Result::ok)
        .find_map(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case(expected)
                .then(|| entry.path())
        })
}

fn find_urp_template(data: &Path) -> Option<PathBuf> {
    let directories = [
        data.join("Resources/PackageManager/ProjectTemplates"),
        data.join("PackageManager/ProjectTemplates"),
    ];
    for directory in directories {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        let mut matches = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                let name = path.file_name().and_then(OsStr::to_str).unwrap_or_default();
                name.ends_with(".tgz")
                    && (name.contains("template.3d-cross-platform")
                        || name.contains("template.universal"))
            })
            .collect::<Vec<_>>();
        matches.sort();
        if let Some(path) = matches.pop() {
            return Some(path);
        }
    }
    None
}

fn find_on_path(command: &str) -> Option<PathBuf> {
    let names = if cfg!(target_os = "windows") {
        vec![format!("{command}.exe"), command.to_owned()]
    } else {
        vec![command.to_owned()]
    };
    let path = env::var_os("PATH")?;
    env::split_paths(&path)
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .find(|candidate| candidate.is_file())
}

fn find_unity_cli() -> Option<PathBuf> {
    if let Some(path) = find_on_path("unity") {
        return Some(path);
    }
    let home = dirs::home_dir()?;
    let candidates = if cfg!(target_os = "windows") {
        vec![home.join("AppData/Local/Microsoft/WindowsApps/unity.exe")]
    } else {
        vec![
            home.join(".local/bin/unity"),
            home.join(".unity/bin/unity"),
            PathBuf::from("/opt/homebrew/bin/unity"),
            PathBuf::from("/usr/local/bin/unity"),
        ]
    };
    candidates.into_iter().find(|path| path.is_file())
}

pub(crate) fn inspect_editor(root: PathBuf) -> Option<EditorInstallation> {
    let version = root.file_name()?.to_string_lossy().to_string();
    let executable = executable_for(&root);
    if !executable.is_file() {
        return None;
    }
    let playback = playback_engines(&root);
    let android = find_case_insensitive_child(&playback, "AndroidPlayer");
    let windows = find_case_insensitive_child(&playback, "WindowsStandaloneSupport");
    let android_sdk = android.as_ref().is_some_and(|path| {
        path.join(if cfg!(windows) {
            "SDK/platform-tools/adb.exe"
        } else {
            "SDK/platform-tools/adb"
        })
        .is_file()
            && versioned_tool(
                &path.join("SDK/build-tools"),
                if cfg!(windows) { "aapt2.exe" } else { "aapt2" },
            )
            && versioned_tool(
                &path.join("SDK/cmdline-tools"),
                if cfg!(windows) {
                    "bin/sdkmanager.bat"
                } else {
                    "bin/sdkmanager"
                },
            )
    });
    let android_ndk = android.as_ref().is_some_and(|path| {
        path.join("NDK/source.properties").is_file()
            && path
                .join(if cfg!(windows) {
                    "NDK/ndk-build.cmd"
                } else {
                    "NDK/ndk-build"
                })
                .is_file()
    });
    let open_jdk = android.as_ref().is_some_and(|path| {
        path.join(if cfg!(windows) {
            "OpenJDK/bin/java.exe"
        } else {
            "OpenJDK/bin/java"
        })
        .is_file()
    });
    let template = find_urp_template(&editor_data(&root));
    let exact_recipe = version == EDITOR_VERSION;
    let ready = exact_recipe
        && android.is_some()
        && android_sdk
        && android_ndk
        && open_jdk
        && windows.is_some()
        && template.is_some();
    Some(EditorInstallation {
        version,
        root: root.to_string_lossy().to_string(),
        executable: executable.to_string_lossy().to_string(),
        exact_recipe,
        android_player: android.is_some(),
        android_sdk,
        android_ndk,
        open_jdk,
        windows_standalone: windows.is_some(),
        urp_template: template.map(|path| path.to_string_lossy().to_string()),
        ready,
    })
}

fn versioned_tool(parent: &Path, tool: &str) -> bool {
    fs::read_dir(parent).ok().is_some_and(|entries| {
        entries
            .filter_map(Result::ok)
            .take(64)
            .any(|entry| entry.path().join(tool).is_file())
    })
}

pub fn probe_environment() -> EnvironmentReport {
    let hub = hub_candidates().into_iter().find(|path| path.exists());
    let unity_cli = find_unity_cli();
    let mut editors = Vec::new();
    for parent in editor_roots() {
        if let Ok(entries) = fs::read_dir(parent) {
            editors.extend(entries.filter_map(Result::ok).filter_map(|entry| {
                entry
                    .file_type()
                    .ok()?
                    .is_dir()
                    .then(|| entry.path())
                    .and_then(inspect_editor)
            }));
        }
    }
    editors.sort_by(|a, b| b.version.cmp(&a.version));
    editors.dedup_by(|a, b| a.root == b.root);
    let exact = editors.iter().find(|editor| editor.exact_recipe);
    let mut blockers = Vec::new();
    if hub.is_none() && unity_cli.is_none() {
        blockers
            .push("Unity Hub or Unity CLI is required to manage the Editor and license.".into());
    }
    match exact {
        None => blockers.push(format!("Unity Editor {EDITOR_VERSION} is not installed.")),
        Some(editor) => {
            if !editor.android_player {
                blockers.push("Android Build Support is missing.".into());
            }
            if !editor.android_sdk || !editor.android_ndk || !editor.open_jdk {
                blockers.push("Android SDK, NDK, or OpenJDK child modules are missing.".into());
            }
            if !editor.windows_standalone {
                blockers.push("Windows standalone build support is missing.".into());
            }
            if editor.urp_template.is_none() {
                blockers.push("The Editor's official 3D URP template is missing.".into());
            }
        }
    }
    EnvironmentReport {
        platform: platform_name().into(),
        hub_installed: hub.is_some(),
        hub_path: hub.map(|path| path.to_string_lossy().to_string()),
        hub_version: crate::hub::detected_hub_version(),
        hub_auto_registration: crate::hub::supports_registration(
            crate::hub::detected_hub_version().as_deref(),
        ),
        unity_cli_installed: unity_cli.is_some(),
        unity_cli_path: unity_cli.map(|path| path.to_string_lossy().to_string()),
        recipe: recipe(),
        ready: blockers.is_empty() && exact.is_some_and(|editor| editor.ready),
        editors,
        blockers,
        suggested_project_parent: dirs::document_dir()
            .or_else(dirs::home_dir)
            .map(|path| path.to_string_lossy().to_string()),
    }
}

fn validate_project_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 64 {
        return Err("Project name must contain 1 to 64 characters.".into());
    }
    if !name
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, ' ' | '-' | '_'))
    {
        return Err("Use only letters, numbers, spaces, hyphens, and underscores.".into());
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Err("Project name cannot end with a space or period.".into());
    }
    Ok(())
}

fn extract_project_template(template: &Path, target: &Path) -> Result<(), String> {
    let file =
        File::open(template).map_err(|error| format!("Cannot open URP template: {error}"))?;
    let mut archive = Archive::new(GzDecoder::new(file));
    let entries = archive
        .entries()
        .map_err(|error| format!("Cannot read URP template: {error}"))?;
    for item in entries {
        let mut entry = item.map_err(|error| format!("Cannot read template entry: {error}"))?;
        let path = entry
            .path()
            .map_err(|error| format!("Invalid template path: {error}"))?
            .into_owned();
        let relative = match path.strip_prefix("package/ProjectData~") {
            Ok(relative) if !relative.as_os_str().is_empty() => relative,
            _ => continue,
        };
        if relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err("The Unity template contains an unsafe path.".into());
        }
        let allowed = matches!(
            relative.components().next(),
            Some(Component::Normal(name)) if name == "Assets" || name == "Packages" || name == "ProjectSettings"
        );
        if !allowed {
            continue;
        }
        let entry_type = entry.header().entry_type();
        if !entry_type.is_file() && !entry_type.is_dir() {
            return Err("The Unity template contains an unsupported link or special entry.".into());
        }
        let destination = target.join(relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Cannot create template directory {}: {error}",
                    parent.display()
                )
            })?;
        }
        entry
            .unpack(&destination)
            .map_err(|error| format!("Cannot extract {}: {error}", relative.display()))?;
    }
    Ok(())
}

fn update_manifest(project: &Path) -> Result<(), String> {
    let path = project.join("Packages/manifest.json");
    let text =
        fs::read_to_string(&path).map_err(|error| format!("Cannot read manifest: {error}"))?;
    let mut manifest: Value = serde_json::from_str(&text)
        .map_err(|error| format!("Invalid template manifest: {error}"))?;
    let dependencies = manifest
        .get_mut("dependencies")
        .and_then(Value::as_object_mut)
        .ok_or("Template manifest has no dependencies object.")?;
    // The stock URP template omits built-in modules referenced by Basis SDK.
    for module in REQUIRED_BUILTIN_MODULES {
        dependencies.insert((*module).into(), json!("1.0.0"));
    }
    // The stock template's Input System 1.12.0 does not compile against the
    // approved Unity 6000.3 line, so use the exact version from the passing smoke test.
    dependencies.insert("com.unity.inputsystem".into(), json!(INPUT_SYSTEM_VERSION));
    dependencies.insert(
        "com.sidequest.creator-sdk".into(),
        json!(CREATOR_SDK_VERSION),
    );
    dependencies.insert(
        "com.unity.render-pipelines.universal".into(),
        json!(URP_VERSION),
    );
    manifest["scopedRegistries"] = json!([{
        "name": "Greenfield-registry.sdq.st",
        "url": REGISTRY_URL,
        "scopes": [
            "com.sidequest.creator-sdk",
            "com.basis.bundlemanagement",
            "com.basis.common",
            "com.basis.sdk",
            "com.sidequest.ora",
            "com.sidequest.thirdparty.bouncycastle"
        ]
    }]);
    let serialized = serde_json::to_string_pretty(&manifest)
        .map_err(|error| format!("Cannot serialize manifest: {error}"))?;
    fs::write(&path, format!("{serialized}\n"))
        .map_err(|error| format!("Cannot write manifest: {error}"))?;
    let stale_lock = project.join("Packages/packages-lock.json");
    if stale_lock.exists() {
        fs::remove_file(stale_lock)
            .map_err(|error| format!("Cannot remove template lock: {error}"))?;
    }
    Ok(())
}

fn update_project_name(project: &Path, project_name: &str) -> Result<(), String> {
    let path = project.join("ProjectSettings/ProjectSettings.asset");
    let text = fs::read_to_string(&path)
        .map_err(|error| format!("Cannot read project settings: {error}"))?;
    let mut replaced = false;
    let output = text
        .lines()
        .map(|line| {
            if line.trim_start().starts_with("productName:") {
                replaced = true;
                format!("  productName: {project_name}")
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    if !replaced {
        return Err("Unity template does not contain a productName setting.".into());
    }
    fs::write(path, format!("{output}\n"))
        .map_err(|error| format!("Cannot write project settings: {error}"))
}

pub(crate) fn validation_script() -> String {
    include_str!("ProjectSetupValidator.cs")
        .replace("@@EDITOR_VERSION@@", EDITOR_VERSION)
        .replace("@@CREATOR_SDK_VERSION@@", CREATOR_SDK_VERSION)
        .replace("@@URP_VERSION@@", URP_VERSION)
        .replace("@@INPUT_SYSTEM_VERSION@@", INPUT_SYSTEM_VERSION)
}

fn log_tail(log: &Path, limit: u64) -> Option<String> {
    let mut file = File::open(log).ok()?;
    let length = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(length.saturating_sub(limit)))
        .ok()?;
    let mut bytes = Vec::new();
    file.take(limit).read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn package_failure_detail(text: &str) -> Option<String> {
    // Only diagnose a package-resolution block followed immediately by Unity's
    // abort, not a warning that was recovered before a different failure.
    let (_, section) = text.rsplit_once("An error occurred while resolving packages:")?;
    let (details, _) = section.split_once("Exiting without the bug reporter.")?;
    if details
        .lines()
        .any(|line| !line.trim().is_empty() && !line.starts_with(' ') && !line.starts_with('\t'))
    {
        return None;
    }
    for line in details.lines() {
        let Some((package, connection)) = line.trim().split_once(": Cannot connect to '") else {
            continue;
        };
        let Some((host, error)) = connection.split_once("' (error code: ") else {
            continue;
        };
        let Some((code, _)) = error.split_once(')') else {
            continue;
        };
        let meaning = match code {
            "ECONNRESET" => "connection reset",
            "ECONNREFUSED" => "connection refused",
            "ETIMEDOUT" | "ESOCKETTIMEDOUT" => "connection timed out",
            "ENOTFOUND" | "EAI_AGAIN" => "host name lookup failed",
            _ => continue,
        };
        // Never copy arbitrary log text, URLs, credentials or license data into
        // the UI/receipt. Only bounded package and DNS identifiers are allowed.
        if package.is_empty()
            || package.len() > 128
            || !package
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
            || host.len() > 253
            || !host.split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && label
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'-')
            })
        {
            continue;
        }
        return Some(format!(
            "Unity could not download a required package: {package} from {host} ({code}: {meaning}). Check your connection and any proxy/firewall rules for this host."
        ));
    }
    Some(
        "Unity could not resolve required packages. The Unity log contains the package errors."
            .into(),
    )
}

fn unity_failure(log: &Path, exit_code: Option<i32>) -> String {
    let detail = log_tail(log, 65536)
        .and_then(|text| package_failure_detail(&text))
        .unwrap_or_else(|| "Unity setup failed.".into());
    let status = exit_code.map_or_else(
        || "Unity stopped without an exit code.".into(),
        |code| format!("Unity exit code: {code}."),
    );
    format!(
        "{detail} {status} Review {}. The project was preserved.",
        crate::repair::display_path(log)
    )
}

fn unity_progress(target: &Path, log: &Path, step: u8) -> Option<SetupProgress> {
    let progress_path = target.join(".creator-project-setup/unity-progress.json");
    if let Ok(file) = File::open(progress_path) {
        if let Ok(progress) = serde_json::from_reader::<_, SetupProgress>(file.take(4096)) {
            if progress.step >= step && progress.step <= 5 {
                return Some(progress);
            }
        }
    }
    let text = log_tail(log, 32768)?;
    text.lines().rev().find_map(|line| {
        let asset = line
            .strip_prefix("Start importing ")?
            .split(" using Guid(")
            .next()?;
        Some(SetupProgress::new(
            step,
            format!("Importing {}", asset.chars().take(220).collect::<String>()),
        ))
    })
}

pub(crate) fn run_unity(
    editor: &str,
    target: &Path,
    method: &str,
    log: &Path,
    step: u8,
    progress: &impl Fn(SetupProgress),
) -> Result<(), String> {
    let mut child = Command::new(editor)
        .args(["-batchmode", "-nographics", "-projectPath"])
        .arg(crate::repair::display_path(target))
        .args([
            "-buildTarget",
            "Android",
            "-executeMethod",
            method,
            "-logFile",
        ])
        .arg(crate::repair::display_path(log))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Cannot launch Unity: {error}"))?;
    let started = Instant::now();
    let mut last = None;
    let exit = loop {
        match child.wait_timeout(Duration::from_secs(1)) {
            Ok(None) if started.elapsed() < Duration::from_secs(30 * 60) => {
                if let Some(update) = unity_progress(target, log, step) {
                    if last.as_ref() != Some(&update) {
                        progress(update.clone());
                        last = Some(update);
                    }
                }
            }
            result => break result,
        }
    };
    match exit {
        Ok(Some(status)) if status.success() => Ok(()),
        Ok(Some(status)) => Err(unity_failure(log, status.code())),
        result => {
            let _ = child.kill();
            let _ = child.wait();
            Err(format!(
                "Unity setup did not finish ({result:?}). Review {}. The project was preserved.",
                crate::repair::display_path(log)
            ))
        }
    }
}

fn write_receipt(project: &Path, value: &Value) -> Result<PathBuf, String> {
    let folder = project.join(".creator-project-setup");
    fs::create_dir_all(&folder)
        .map_err(|error| format!("Cannot create receipt folder: {error}"))?;
    let path = folder.join("setup-receipt.json");
    let mut receipt = value.clone();
    receipt["schemaVersion"] = json!(1);
    receipt["setupVersion"] = json!(env!("CARGO_PKG_VERSION"));
    receipt["recordedAtUnixMs"] = json!(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Cannot timestamp receipt: {error}"))?
        .as_millis());
    receipt["platform"] = json!(env::consts::OS);
    receipt["architecture"] = json!(env::consts::ARCH);
    receipt["logPaths"] = json!(["unity-setup.log", "unity-reopen-validation.log"]
        .iter()
        .map(|name| folder.join(name))
        .filter(|log| log.is_file())
        .map(|log| crate::repair::display_path(&log))
        .collect::<Vec<_>>());
    let text = serde_json::to_string_pretty(&receipt)
        .map_err(|error| format!("Cannot serialize setup receipt: {error}"))?;
    fs::write(&path, format!("{text}\n"))
        .map_err(|error| format!("Cannot write setup receipt: {error}"))?;
    Ok(path)
}

pub(crate) fn creation_target(request: &CreateRequest) -> Result<PathBuf, String> {
    let project_name = request.project_name.trim();
    validate_project_name(project_name)?;
    let parent = PathBuf::from(request.parent_directory.trim());
    if !parent.is_dir() {
        return Err("Choose an existing parent folder for the project.".into());
    }
    let target = parent.join(project_name);
    if target.exists() {
        return Err(format!(
            "{} already exists. Creator Project Setup never overwrites a project folder.",
            target.display()
        ));
    }
    Ok(target)
}

pub fn create_project(
    request: CreateRequest,
    progress: impl Fn(SetupProgress),
) -> Result<CreationResult, String> {
    let target = creation_target(&request)?;
    let project_name = request.project_name.trim();
    let environment = probe_environment();
    // The first project event also reaches Hub while create_project is running;
    // a separate probe command would queue behind it in the hosted transport.
    progress(SetupProgress::requirements_checked(environment.clone()));
    if !environment.ready {
        return Err(format!(
            "This computer is not ready: {}",
            environment.blockers.join(" ")
        ));
    }
    let editor = environment
        .editors
        .iter()
        .find(|editor| editor.ready)
        .ok_or("Compatible Unity Editor could not be selected.")?;
    let template = PathBuf::from(
        editor
            .urp_template
            .as_ref()
            .ok_or("The official URP template is unavailable.")?,
    );

    fs::create_dir(&target).map_err(|error| format!("Cannot create project folder: {error}"))?;
    let setup = (|| -> Result<CreationResult, String> {
        progress(SetupProgress::new(
            2,
            "Extracting the official URP template and adding the pinned Creator SDK.",
        ));
        extract_project_template(&template, &target)?;
        fs::write(
            target.join("ProjectSettings/ProjectVersion.txt"),
            format!(
                "m_EditorVersion: {EDITOR_VERSION}\nm_EditorVersionWithRevision: {EDITOR_VERSION} ({EDITOR_CHANGESET})\n"
            ),
        )
        .map_err(|error| format!("Cannot write ProjectVersion.txt: {error}"))?;
        update_manifest(&target)?;
        update_project_name(&target, project_name)?;

        let validator_dir = target.join("Assets/Editor");
        fs::create_dir_all(&validator_dir)
            .map_err(|error| format!("Cannot create temporary validator folder: {error}"))?;
        let validator = validator_dir.join("CreatorProjectSetupValidator.cs");
        fs::write(&validator, validation_script())
            .map_err(|error| format!("Cannot write temporary validator: {error}"))?;

        let status_folder = target.join(".creator-project-setup");
        fs::create_dir_all(&status_folder)
            .map_err(|error| format!("Cannot create status folder: {error}"))?;
        let log_path = status_folder.join("unity-setup.log");
        let _receipt_path = write_receipt(
            &target,
            &json!({
                "success": false,
                "stage": "launching_unity",
                "projectPath": target,
                "recipe": recipe(),
                "activeBuildTarget": "android",
                "requiredBuildTargets": ["android", "windows"],
                "note": "Unity setup has started. This is not a completion receipt."
            }),
        )?;

        progress(SetupProgress::new(
            3,
            "Unity is resolving packages, importing assets and compiling scripts.",
        ));
        run_unity(
            &editor.executable,
            &target,
            "CreatorWorks.ProjectSetupValidator.Configure",
            &log_path,
            3,
            &progress,
        )?;
        let reopen_log = status_folder.join("unity-reopen-validation.log");
        progress(SetupProgress::new(
            5,
            "Reopening Unity to check persisted settings, Creator nodes and build platforms.",
        ));
        run_unity(
            &editor.executable,
            &target,
            "CreatorWorks.ProjectSetupValidator.Validate",
            &reopen_log,
            5,
            &progress,
        )?;
        let validation_path = status_folder.join("unity-validation.json");
        if !validation_path.is_file() {
            return Err(format!(
                "Unity did not validate the project. Review {}. The partial project was preserved.",
                log_path.display()
            ));
        }
        let mut validation_text = String::new();
        File::open(&validation_path)
            .and_then(|mut file| file.read_to_string(&mut validation_text))
            .map_err(|error| format!("Cannot read Unity validation: {error}"))?;
        let validation: Value = serde_json::from_str(&validation_text)
            .map_err(|error| format!("Invalid Unity validation result: {error}"))?;
        if validation.get("success") != Some(&Value::Bool(true)) {
            return Err(format!(
                "Unity completed but the compatibility checks failed. Review {}.",
                validation_path.display()
            ));
        }

        let _ = fs::remove_file(&validator);
        let _ = fs::remove_file(validator.with_extension("cs.meta"));
        progress(SetupProgress::new(
            6,
            "Adding the validated project to Unity Hub.",
        ));
        let hub =
            crate::hub::register_project(&target, |detail| progress(SetupProgress::new(6, detail)));
        let receipt_path = write_receipt(
            &target,
            &json!({
                "success": true,
                "stage": "validated",
                "projectPath": target,
                "recipe": recipe(),
                "activeBuildTarget": "android",
                "requiredBuildTargets": ["android", "windows"],
                "validation": validation,
                "hub": hub,
                "logPath": log_path
            }),
        )?;
        progress(SetupProgress::new(
            7,
            "Validation passed. Project is ready to open.",
        ));
        Ok(CreationResult {
            success: true,
            project_path: target.to_string_lossy().to_string(),
            log_path: log_path.to_string_lossy().to_string(),
            receipt_path: receipt_path.to_string_lossy().to_string(),
            message: "Creator SDK project compiled, initialized Visual Scripting, and passed checks after reopening.".into(),
            hub,
        })
    })()
    .map_err(|error| format!(
        "{error} Setup is incomplete. For a fresh attempt, keep this folder and choose a different project name. Create does not resume or overwrite existing folders."
    ));

    if let Err(error) = &setup {
        let _ = write_receipt(
            &target,
            &json!({
                "success": false,
                "stage": "failed",
                "projectPath": target,
                "recipe": recipe(),
                "error": error,
                "note": "The project was preserved for diagnosis and was not deleted automatically."
            }),
        );
    }
    setup
}

pub fn open_project(path: &str) -> Result<(), String> {
    let project = PathBuf::from(path);
    if !project.join("ProjectSettings/ProjectVersion.txt").is_file() {
        return Err("The selected path is not a validated Unity project.".into());
    }
    let editor = probe_environment()
        .editors
        .into_iter()
        .find(|editor| editor.exact_recipe)
        .ok_or("The compatible Unity Editor is not installed.")?;
    Command::new(editor.executable)
        .arg("-projectPath")
        .arg(project)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Cannot open Unity project: {error}"))?;
    Ok(())
}

pub fn launch_hub() -> Result<(), String> {
    let report = probe_environment();
    let path = report.hub_path.ok_or("Unity Hub is not installed.")?;
    let mut command = if cfg!(target_os = "macos") {
        let mut command = Command::new("open");
        command.arg(path);
        command
    } else {
        Command::new(path)
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Cannot open Unity Hub: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PACKAGE_RESET_LOG: &str = include_str!("../../tests/fixtures/unity-package-reset.txt");

    #[test]
    fn module_locations_match_native_installation_layouts() {
        let root = Path::new("fixture");
        assert_eq!(
            playback_engines_for(root, "macos"),
            root.join("PlaybackEngines")
        );
        for host in ["windows", "linux"] {
            assert_eq!(
                playback_engines_for(root, host),
                root.join("Editor/Data/PlaybackEngines")
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn hub_candidates_include_verified_cli_appimage_destination() {
        let expected = dirs::home_dir()
            .unwrap()
            .join("Applications/UnityHub.AppImage");
        assert!(hub_candidates().contains(&expected));
    }

    #[test]
    fn empty_android_directories_are_not_installed_tools() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(EDITOR_VERSION);
        let executable = executable_for(&root);
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::write(&executable, "fixture").unwrap();
        let android = playback_engines(&root).join("AndroidPlayer");
        for child in ["SDK", "NDK", "OpenJDK"] {
            fs::create_dir_all(android.join(child)).unwrap();
        }
        let report = inspect_editor(root.clone()).unwrap();
        assert!(!report.android_sdk && !report.android_ndk && !report.open_jdk && !report.ready);
        let tools = if cfg!(windows) {
            [
                "SDK/platform-tools/adb.exe",
                "SDK/build-tools/36.0.0/aapt2.exe",
                "SDK/cmdline-tools/16.0/bin/sdkmanager.bat",
                "NDK/source.properties",
                "NDK/ndk-build.cmd",
                "OpenJDK/bin/java.exe",
            ]
        } else {
            [
                "SDK/platform-tools/adb",
                "SDK/build-tools/36.0.0/aapt2",
                "SDK/cmdline-tools/16.0/bin/sdkmanager",
                "NDK/source.properties",
                "NDK/ndk-build",
                "OpenJDK/bin/java",
            ]
        };
        for tool in tools {
            let path = android.join(tool);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "fixture").unwrap();
        }
        let report = inspect_editor(root).unwrap();
        assert!(report.android_sdk && report.android_ndk && report.open_jdk);
        assert!(
            !report.ready,
            "Other requirements must still pass independently"
        );
    }

    #[test]
    fn receipts_identify_build_and_time_without_copying_raw_logs() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join(".creator-project-setup");
        fs::create_dir(&folder).unwrap();
        let log = folder.join("unity-setup.log");
        fs::write(&log, "private raw log contents").unwrap();
        for success in [false, true] {
            let original = json!({"success": success, "stage": "test", "recipe": recipe()});
            let path = write_receipt(root.path(), &original).unwrap();
            let text = fs::read_to_string(path).unwrap();
            let value: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(value["setupVersion"], env!("CARGO_PKG_VERSION"));
            assert_eq!(value["schemaVersion"], 1);
            assert!(value["recordedAtUnixMs"].as_u64().unwrap() > 0);
            assert_eq!(value["success"], success);
            assert_eq!(value["recipe"], original["recipe"]);
            assert_eq!(
                value["logPaths"],
                json!([crate::repair::display_path(&log)])
            );
            assert!(!text.contains("private raw log contents"));
            assert!(original.get("setupVersion").is_none());
        }
        assert_eq!(fs::read_to_string(log).unwrap(), "private raw log contents");
    }

    #[test]
    fn package_reset_diagnostic_uses_fatal_error_not_recovered_warnings() {
        for text in [
            PACKAGE_RESET_LOG.to_owned(),
            PACKAGE_RESET_LOG.replace('\n', "\r\n"),
        ] {
            let message = package_failure_detail(&text).unwrap();
            assert!(message.contains("com.unity.timeline from download.packages.unity.com"));
            assert!(message.contains("ECONNRESET: connection reset"));
            assert!(message.contains("Check your connection"));
            assert!(!message.contains("Licensing"));
            assert!(!message.contains("directory name"));
        }
    }

    #[test]
    fn package_diagnostic_requires_terminal_failure_and_handles_unknown_errors() {
        let before_abort = PACKAGE_RESET_LOG
            .split("Exiting without the bug reporter.")
            .next()
            .unwrap();
        assert!(package_failure_detail(before_abort).is_none());
        let recovered = PACKAGE_RESET_LOG.replace(
            "Exiting without the bug reporter.",
            "[Package Manager] Resolution recovered\nScripts have compiler errors.\nExiting without the bug reporter.",
        );
        assert!(package_failure_detail(&recovered).is_none());
        let later_failure = format!(
            "{before_abort}\nAn error occurred while resolving packages:\n  Package version does not exist.\nExiting without the bug reporter."
        );
        let message = package_failure_detail(&later_failure).unwrap();
        assert!(message.contains("could not resolve required packages"));
        assert!(!message.contains("connection"));
        let unknown = PACKAGE_RESET_LOG.replace("ECONNRESET", "UNKNOWN_ERROR");
        assert!(!package_failure_detail(&unknown)
            .unwrap()
            .contains("Check your connection"));
    }

    #[test]
    fn package_diagnostic_only_copies_bounded_identifiers() {
        for host in [
            "https://user:secret@example.test/?token=private".to_owned(),
            "<script>alert(1)</script>".to_owned(),
            "a".repeat(254),
        ] {
            let text = PACKAGE_RESET_LOG.replace("download.packages.unity.com", &host);
            let message = package_failure_detail(&text).unwrap();
            assert_eq!(message, "Unity could not resolve required packages. The Unity log contains the package errors.");
        }
        let text = PACKAGE_RESET_LOG.replace("com.unity.timeline", &"p".repeat(129));
        assert!(!package_failure_detail(&text)
            .unwrap()
            .contains("could not download"));
        for code in [
            "ECONNREFUSED",
            "ETIMEDOUT",
            "ESOCKETTIMEDOUT",
            "ENOTFOUND",
            "EAI_AGAIN",
        ] {
            assert!(
                package_failure_detail(&PACKAGE_RESET_LOG.replace("ECONNRESET", code))
                    .unwrap()
                    .contains(code)
            );
        }
    }

    #[test]
    fn failure_message_reads_only_bounded_tail_and_preserves_log() {
        let root = tempfile::tempdir().unwrap();
        let log = root.path().join("unity.log");
        let mut bytes = vec![b'x'; 100_000];
        bytes.push(0xff);
        bytes.extend_from_slice(PACKAGE_RESET_LOG.as_bytes());
        fs::write(&log, &bytes).unwrap();
        assert!(log_tail(&log, 100).unwrap().len() <= 100);
        let message = unity_failure(&log, Some(1));
        assert!(message.contains("ECONNRESET"));
        assert!(message.contains("Unity exit code: 1"));
        assert!(message.contains("The project was preserved"));
        assert_eq!(fs::read(&log).unwrap(), bytes);
        fs::write(&log, b"Scripts have compiler errors.\n").unwrap();
        assert!(unity_failure(&log, Some(1)).starts_with("Unity setup failed."));
        let missing = unity_failure(&root.path().join("missing.log"), None);
        assert!(missing.contains("without an exit code"));
        assert!(!missing.contains("Check your connection"));
    }

    #[cfg(windows)]
    #[test]
    fn run_unity_reports_failed_child_but_never_diagnoses_success() {
        let root = tempfile::tempdir().unwrap();
        let fake_editor = root.path().join("Unity fixture.cmd");
        let log = root.path().join("unity-setup.log");
        fs::write(&fake_editor, "@exit /b 1\r\n").unwrap();
        fs::write(&log, PACKAGE_RESET_LOG).unwrap();
        let failed = run_unity(
            fake_editor.to_str().unwrap(),
            root.path(),
            "Test.Configure",
            &log,
            3,
            &|_| {},
        )
        .unwrap_err();
        assert!(failed.contains("com.unity.timeline"));
        assert!(failed.contains("Unity exit code: 1"));
        fs::write(&fake_editor, "@exit /b 0\r\n").unwrap();
        run_unity(
            fake_editor.to_str().unwrap(),
            root.path(),
            "Test.Validate",
            &log,
            5,
            &|_| {},
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&log).unwrap(), PACKAGE_RESET_LOG);
    }

    #[test]
    fn recipe_is_pinned() {
        let value = recipe();
        assert_eq!(value.editor_version, "6000.3.21f1");
        assert_eq!(value.creator_sdk_version, "4.0.14");
        assert_eq!(value.urp_version, "17.3.0");
        assert_eq!(value.input_system_version, "1.20.0");
        assert_eq!(value.sdk_declared_urp_version, "17.4.0");
    }

    #[test]
    fn validator_requires_visual_scripting_after_reopen() {
        let script = validation_script();
        assert!(!script.contains("@@"));
        assert!(script.contains(
            "result.visualScriptingInitialized && result.creatorVisualScriptingConfigured"
        ));
        assert!(script.contains("result.creatorNodeCount > 0"));
        assert!(script.contains("EditorApplication.delayCall += FinishConfiguration"));
    }

    #[test]
    fn requirements_snapshot_is_native_only_and_preserves_failed_checks() {
        let report = EnvironmentReport {
            platform: "windows".into(),
            hub_installed: true,
            hub_path: None,
            hub_version: Some("3.13.0".into()),
            hub_auto_registration: false,
            unity_cli_installed: true,
            unity_cli_path: None,
            recipe: recipe(),
            editors: vec![],
            ready: false,
            blockers: vec!["Unity Editor is not installed.".into()],
            suggested_project_parent: None,
        };
        let event = SetupProgress::requirements_checked(report.clone());
        assert_eq!(event.step, 1);
        assert_eq!(event.environment, Some(report));
        let serialized = serde_json::to_value(&event).unwrap();
        assert_eq!(serialized["environment"]["ready"], false);
        assert_eq!(
            serialized["environment"]["blockers"][0],
            "Unity Editor is not installed."
        );
        let from_project: SetupProgress = serde_json::from_value(serialized).unwrap();
        assert!(
            from_project.environment.is_none(),
            "Project progress files cannot supply installation evidence"
        );
        let ordinary = serde_json::to_value(SetupProgress::new(3, "Importing")).unwrap();
        assert!(
            ordinary.get("environment").is_none(),
            "Do not repeat the installation inventory on import updates"
        );
    }

    #[test]
    fn progress_is_bounded_and_reopen_ignores_old_stage() {
        let root = env::temp_dir().join(format!("creator-progress-test-{}", std::process::id()));
        let folder = root.join(".creator-project-setup");
        fs::create_dir_all(&folder).unwrap();
        let log = folder.join("unity.log");
        fs::write(&log, "Start importing Assets/Example.mat using Guid(123)\n").unwrap();
        assert_eq!(
            unity_progress(&root, &log, 3).unwrap().detail,
            "Importing Assets/Example.mat"
        );
        let status = folder.join("unity-progress.json");
        fs::write(&status, r#"{"step":4,"detail":"Generating nodes"}"#).unwrap();
        assert_eq!(unity_progress(&root, &log, 3).unwrap().step, 4);
        assert_eq!(unity_progress(&root, &log, 5).unwrap().step, 5);
        fs::write(&status, "{").unwrap();
        assert_eq!(unity_progress(&root, &log, 3).unwrap().step, 3);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_unsafe_project_names() {
        for name in [
            "",
            "..",
            "bad/name",
            "bad\\name",
            "bad:name",
            "trailing.",
            "comment#name",
        ] {
            assert!(validate_project_name(name).is_err(), "accepted {name:?}");
        }
        assert!(validate_project_name("My Creator Space").is_ok());
    }

    #[test]
    fn manifest_adds_pinned_sdk_and_registry() {
        let root =
            env::temp_dir().join(format!("creator-project-setup-test-{}", std::process::id()));
        let packages = root.join("Packages");
        fs::create_dir_all(&packages).unwrap();
        fs::write(
            packages.join("manifest.json"),
            r#"{"dependencies":{"com.unity.render-pipelines.universal":"17.0.1"}}"#,
        )
        .unwrap();
        fs::write(packages.join("packages-lock.json"), "{}").unwrap();
        update_manifest(&root).unwrap();
        let value: Value =
            serde_json::from_str(&fs::read_to_string(packages.join("manifest.json")).unwrap())
                .unwrap();
        assert_eq!(
            value["dependencies"]["com.sidequest.creator-sdk"],
            CREATOR_SDK_VERSION
        );
        assert_eq!(
            value["dependencies"]["com.unity.render-pipelines.universal"],
            URP_VERSION
        );
        assert_eq!(value["dependencies"]["com.unity.modules.cloth"], "1.0.0");
        assert_eq!(
            value["dependencies"]["com.unity.inputsystem"],
            INPUT_SYSTEM_VERSION
        );
        assert_eq!(value["scopedRegistries"][0]["url"], REGISTRY_URL);
        assert!(!packages.join("packages-lock.json").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "launches a real installed Unity Editor and creates a disposable project"]
    fn unity_creation_smoke() {
        let parent = env::var("CREATOR_SETUP_SMOKE_PARENT")
            .expect("set CREATOR_SETUP_SMOKE_PARENT to an existing disposable test directory");
        let name =
            env::var("CREATOR_SETUP_SMOKE_NAME").unwrap_or_else(|_| "CreatorSetupSmoke".into());
        let request = CreateRequest {
            project_name: name,
            parent_directory: parent,
        };
        assert!(
            probe_environment().ready,
            "This smoke never installs prerequisites on the developer's PC"
        );
        crate::bootstrap::ensure(
            &request,
            |_| panic!("No installation is allowed in this smoke"),
            |event| println!("{}", event.stage),
        )
        .unwrap();
        assert!(
            crate::bootstrap::licence_ready(|event| println!("{}", event.stage)).unwrap(),
            "Activate Unity normally before running the local creation test"
        );
        let result = create_project(request, |progress| {
            println!("progress: {} {}", progress.step, progress.detail)
        })
        .expect("real Unity setup should succeed");
        assert!(result.success);
        assert!(result.hub.registered, "{}", result.hub.message);
        assert!(Path::new(&result.receipt_path).is_file());
        println!("{}", serde_json::to_string(&result).unwrap());
    }
}
