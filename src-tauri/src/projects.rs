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
    time::{Duration, Instant},
};
use tauri::Manager as _;
use tauri_plugin_dialog::DialogExt;

const MAX_JSON: u64 = 2 * 1024 * 1024;
const MAX_PROJECTS: usize = 200;
const CREATOR: &str = "com.sidequest.creator-sdk";
const BANTER: &str = "com.sidequest.banter";

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
    issue: Option<String>,
}

#[derive(Serialize)]
pub struct Snapshot {
    projects: Vec<Project>,
    warnings: Vec<String>,
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

fn key(path: &Path) -> String {
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
        issue: None,
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

// Only the known, hash-pinned helper already cached by Project Setup is used.
// Discovery never downloads a CLI, edits Hub's database, or runs a PATH executable.
fn cli(args: &[&str]) -> Result<Value, String> {
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return Err("Current Unity Hub discovery is not yet supported on this platform.".into());
    }
    let path = dirs::data_local_dir()
        .ok_or("Local app data unavailable.")?
        .join("CreatorProjectSetup/tools/unity-cli/1.0.0-beta.9/unity.exe");
    crate::platform::reject_links(&path)?;
    let mut options = File::options();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1);
    }
    let mut pin = options.open(&path).map_err(|_| "Current Unity Hub discovery needs the verified Unity helper from Project Setup. Add a project folder manually in the meantime.")?;
    if pin
        .metadata()
        .map_err(|_| "Cannot inspect Unity helper.")?
        .len()
        != 20_835_248
    {
        return Err("Unity helper differs from the approved version; it was not executed.".into());
    }
    let mut digest = Sha256::new();
    std::io::copy(&mut pin, &mut digest).map_err(|_| "Cannot verify Unity helper.")?;
    if format!("{:x}", digest.finalize())
        != "325c5f4d0a241121034e0c066b3d6169ef776cd33b73b1489d5c151440c77876"
    {
        return Err("Unity helper failed integrity verification; it was not executed.".into());
    }
    let mut child = crate::platform::command(&path)
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
    projects.sort_by_key(|p| p.name.to_lowercase());
    Snapshot { projects, warnings }
}

fn refresh(handle: &tauri::AppHandle) -> Result<Snapshot, String> {
    let result = discover(
        &dirs::config_dir().ok_or("Config directory unavailable.")?,
        &saved_path()?,
        cli(&["projects", "list"]),
    );
    *handle
        .state::<Projects>()
        .0
        .lock()
        .map_err(|_| "Project list is busy.")? = result.projects.clone();
    Ok(result)
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

fn open_command(project: &Project, editor: &Path) -> Result<std::process::Command, String> {
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
    let mut command = crate::platform::command(editor);
    command
        .arg("-projectPath")
        .arg(root)
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
        let editor = editor_from(&cli(&["editors", "--installed"] )?, &project.unity_version)
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

    #[test]
    #[ignore = "Read-only inventory of this machine; no Unity launch or project writes"]
    fn live_project_inventory() {
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
            "Known projects: {}; SDK projects: {}; source warnings: {}",
            result.projects.len(),
            count,
            result.warnings.len()
        );
        assert!(count > 0);
    }
}
