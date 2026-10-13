use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use wait_timeout::ChildExt;

const CDN: &str = "https://public-cdn.cloud.unity3d.com/hub/prod/cli";
pub const MINIMUM_HUB_VERSION: &str = "3.21.1";
static HUB_OPERATION: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubRegistration {
    pub registered: bool,
    pub message: String,
    #[serde(default)]
    pub requires_hub_update: bool,
    #[serde(default)]
    pub refresh_pending: bool,
}

pub fn detected_hub_version() -> Option<String> {
    let config = dirs::config_dir()?;
    let path = if config.join("unityhub/hubInfo.json").is_file() {
        config.join("unityhub/hubInfo.json")
    } else {
        config.join("UnityHub/hubInfo.json")
    };
    let file = File::open(path).ok()?;
    let info: Value = serde_json::from_reader(file.take(16384)).ok()?;
    let version = info["version"].as_str()?;
    if version.len() > 64 {
        return None;
    }
    Some(version.to_owned())
}

pub fn supports_registration(version: Option<&str>) -> bool {
    let Some(version) = version else {
        return false;
    };
    let parts: Option<Vec<u32>> = version.split('.').map(|part| part.parse().ok()).collect();
    matches!(parts.as_deref(), Some([major, minor, patch]) if (*major, *minor, *patch) >= (3, 21, 1))
}

fn compatibility_warning(version: Option<&str>) -> HubRegistration {
    let installed = version
        .map(|v| format!("Unity Hub {v}"))
        .unwrap_or_else(|| "This Unity Hub version".into());
    HubRegistration {
        registered: false,
        requires_hub_update: true,
        refresh_pending: false,
        message: format!("{installed} cannot be verified as compatible with automatic registration. Update and open Unity Hub {MINIMUM_HUB_VERSION} or newer, then recheck. Or use Hub's Add > Add project from disk and select the project folder above. Your Unity project is ready to open."),
    }
}

#[derive(Deserialize)]
struct Release {
    version: String,
    binaries: BTreeMap<String, Binary>,
}
#[derive(Deserialize)]
struct Binary {
    filename: String,
    sha256: String,
    size: u64,
}

pub(crate) fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(crate) fn unique_id() -> String {
    format!(
        "{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        std::process::id()
    )
}

fn platform() -> String {
    let os = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    format!("{os}-{arch}")
}

fn verified(path: &Path, binary: &Binary) -> bool {
    fs::metadata(path).is_ok_and(|meta| meta.len() == binary.size)
        && fs::read(path).is_ok_and(|bytes| sha256(&bytes) == binary.sha256)
}

pub(crate) fn prepare_helper(progress: &impl Fn(&str)) -> Result<PathBuf, String> {
    let release: Release =
        serde_json::from_str(include_str!("unity-cli-release.json")).map_err(|e| e.to_string())?;
    let binary = release
        .binaries
        .get(&platform())
        .ok_or("Unity CLI is not packaged for this platform.")?;
    let folder = dirs::data_local_dir()
        .ok_or("Local application data folder is unavailable.")?
        .join("CreatorProjectSetup/tools/unity-cli")
        .join(&release.version);
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let destination = folder.join(if cfg!(windows) { "unity.exe" } else { "unity" });
    if !verified(&destination, binary) {
        progress("Downloading the verified official Unity helper (about 21 MB).");
        let client = reqwest::blocking::Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|e| e.to_string())?;
        let response = client
            .get(format!("{CDN}/{}/{}", release.version, binary.filename))
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("Helper download failed: {e}"))?;
        let mut bytes = Vec::new();
        response
            .take(binary.size + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 != binary.size || sha256(&bytes) != binary.sha256 {
            return Err(
                "Unity CLI download failed integrity verification. Nothing was executed.".into(),
            );
        }
        let staged = folder.join(format!("download-{}.part", unique_id()));
        let result = (|| {
            let mut file = File::options()
                .write(true)
                .create_new(true)
                .open(&staged)
                .map_err(|e| e.to_string())?;
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&staged, fs::Permissions::from_mode(0o700))
                    .map_err(|e| e.to_string())?;
            }
            // An invalid cached helper is never executed or treated as an installed CLI.
            if destination.exists() {
                fs::remove_file(&destination).map_err(|e| e.to_string())?;
            }
            fs::rename(&staged, &destination).map_err(|e| e.to_string())
        })();
        let _ = fs::remove_file(staged);
        result?;
    }
    Ok(destination)
}

fn cli(executable: &Path, args: &[&str]) -> Result<Value, String> {
    let folder = executable.parent().ok_or("Invalid helper path.")?;
    let id = unique_id();
    let stdout = folder.join(format!("{id}.out"));
    let stderr = folder.join(format!("{id}.err"));
    let result = (|| {
        let mut command = Command::new(executable);
        command
            .args(args)
            .args(["--json", "--non-interactive", "--no-banner", "--no-pager"])
            .env("UNITY_NO_CONSENT_PROMPT", "1")
            .stdin(Stdio::null())
            .stdout(File::create(&stdout).map_err(|e| e.to_string())?)
            .stderr(File::create(&stderr).map_err(|e| e.to_string())?);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("Cannot start Unity CLI: {e}"))?;
        let status = match child.wait_timeout(Duration::from_secs(45)) {
            Ok(Some(status)) => status,
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(
                    "Unity Hub registration timed out. Retry when Hub is available.".into(),
                );
            }
        };
        if !status.success() {
            return Err("Unity CLI could not register the project. The Unity project itself is still ready.".into());
        }
        let file = File::open(&stdout).map_err(|e| e.to_string())?;
        serde_json::from_reader(file.take(4 * 1024 * 1024))
            .map_err(|_| "Unity CLI returned an unexpected response.".into())
    })();
    let _ = fs::remove_file(stdout);
    let _ = fs::remove_file(stderr);
    result
}

fn matches_path(value: &Value, project: &Path) -> bool {
    value
        .get("path")
        .and_then(Value::as_str)
        .and_then(|path| fs::canonicalize(path).ok())
        .is_some_and(|path| path == project)
}

fn registry_contains(response: &Value, project: &Path) -> bool {
    response["success"] == true
        && response["data"]
            .as_array()
            .is_some_and(|items| items.iter().any(|value| matches_path(value, project)))
}

fn register(project: &Path, progress: &impl Fn(&str)) -> Result<(), String> {
    let project = fs::canonicalize(project).map_err(|_| "Unity project folder is unavailable.")?;
    if !project.join("ProjectSettings/ProjectVersion.txt").is_file() {
        return Err("Not a Unity project.".into());
    }
    let helper = prepare_helper(progress)?;
    // Use a normal absolute Windows path, not the extended-length display form.
    let path = crate::repair::display_path(&project);
    progress("Checking whether the project is already registered with Unity Hub.");
    if registry_contains(&cli(&helper, &["projects", "list", &path])?, &project) {
        return Ok(());
    }
    progress("Registering the project with Unity Hub.");
    // Unity returns an error for duplicate additions. A separate readback makes
    // retry safe even if another Hub instance registers it between these calls.
    let added = cli(&helper, &["projects", "add", &path]);
    progress("Verifying the project appears in Unity Hub's registry.");
    let listed = cli(&helper, &["projects", "list", &path])?;
    if !registry_contains(&listed, &project) {
        added?;
        return Err("Registration was requested, but the project could not be verified in Hub. You can retry.".into());
    }
    Ok(())
}

pub fn register_project(project: &Path, progress: impl Fn(&str)) -> HubRegistration {
    let version = detected_hub_version();
    register_for_hub_version(project, progress, version.as_deref())
}

pub fn restart_hub() -> Result<(), String> {
    let _lock = HUB_OPERATION
        .try_lock()
        .map_err(|_| "Another Hub operation is running. Please wait before restarting Hub.")?;
    let path = crate::logic::probe_environment()
        .hub_path
        .ok_or("Unity Hub is not installed.")?;
    crate::hub_restart::restart(Path::new(&path))
}

fn register_for_hub_version(
    project: &Path,
    progress: impl Fn(&str),
    version: Option<&str>,
) -> HubRegistration {
    // Older Hubs read projects-v1.json; the current CLI writes hub.db instead.
    // A CLI readback alone cannot prove registration with those desktop versions.
    if !supports_registration(version) {
        return compatibility_warning(version);
    }
    let result = HUB_OPERATION
        .lock()
        .map_err(|_| "Another Hub operation failed.".to_owned())
        .and_then(|_lock| register(project, &progress));
    match result {
        Ok(()) => HubRegistration {
            registered: true,
            requires_hub_update: false,
            refresh_pending: true,
            message: "Project registered. A running Unity Hub may need a full restart to show it in Projects. Your Unity project is ready to open."
                .into(),
        },
        Err(message) => HubRegistration {
            registered: false,
            requires_hub_update: false,
            refresh_pending: false,
            message,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hub_version_gate_rejects_legacy_unknown_and_prerelease_versions() {
        for version in [
            None,
            Some("3.14.4"),
            Some("3.20.1"),
            Some("3.21.0"),
            Some("3.21.1-beta.1"),
            Some("3.21"),
            Some("garbage"),
        ] {
            assert!(!supports_registration(version), "{version:?}");
        }
        assert!(supports_registration(Some("3.21.1")));
        assert!(supports_registration(Some("3.21.2")));
    }
    #[test]
    fn legacy_hub_cannot_report_registration_even_if_cli_could_succeed() {
        let result = register_for_hub_version(
            Path::new("not-a-project"),
            |_| panic!("Legacy registration must stop before helper operations"),
            Some("3.14.4"),
        );
        assert!(!result.registered);
        assert!(result.requires_hub_update);
        assert!(result.message.contains("3.14.4"));
        assert!(result.message.contains("3.21.1"));
    }
    #[test]
    fn manifest_pins_downloads() {
        let release: Release =
            serde_json::from_str(include_str!("unity-cli-release.json")).unwrap();
        assert_eq!(release.version, "1.0.0-beta.9");
        assert_eq!(release.binaries.len(), 6);
        for binary in release.binaries.values() {
            assert_eq!(binary.sha256.len(), 64);
            assert!(!binary.filename.contains('/') && !binary.filename.contains('\\'));
            assert!(binary.size < 32 * 1024 * 1024);
        }
    }
    #[test]
    fn corrupt_helper_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("unity");
        fs::write(&path, "wrong").unwrap();
        let binary = Binary {
            filename: "unity".into(),
            sha256: sha256(b"right"),
            size: 5,
        };
        assert!(!verified(&path, &binary));
    }
    #[test]
    fn registry_readback_must_match_the_exact_existing_project() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let expected = fs::canonicalize(first.path()).unwrap();
        assert!(matches_path(
            &serde_json::json!({"path": first.path()}),
            &expected
        ));
        assert!(!matches_path(
            &serde_json::json!({"path": second.path()}),
            &expected
        ));
        assert!(!matches_path(
            &serde_json::json!({"path": first.path().join("missing")}),
            &expected
        ));
        assert!(!matches_path(
            &serde_json::json!({"name": first.path()}),
            &expected
        ));
        assert!(!registry_contains(
            &serde_json::json!({"success": false, "data":[{"path": first.path()}]}),
            &expected
        ));
        assert!(registry_contains(
            &serde_json::json!({"success": true, "data":[{"path": first.path()}]}),
            &expected
        ));
    }
    #[test]
    #[ignore = "registers only the explicitly selected disposable project in Unity Hub"]
    fn hub_registration_smoke() {
        let path =
            std::env::var("CREATOR_SETUP_HUB_SMOKE_PROJECT").expect("select a disposable project");
        let result = register_project(Path::new(&path), |text| println!("{text}"));
        assert!(result.registered, "{}", result.message);
    }
}
