use crate::{
    catalog::{self, Release},
    manager::{self, Manager},
    platform,
};
use base64::Engine;
use semver::Version;
use serde::Serialize;
use std::{
    fs,
    path::PathBuf,
    sync::{atomic::Ordering, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager as _};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::UpdaterExt;

const REPO: &str = "CREATOR-HUB";
const APP_ID: &str = "creator-hub";

#[derive(Default)]
pub struct SelfUpdate(Mutex<Option<Release>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    current_version: &'static str,
    available_version: Option<String>,
    downloaded: bool,
    install_blocked: Option<String>,
    warning: Option<String>,
}

#[derive(Clone, Serialize)]
struct Progress {
    message: String,
    received: u64,
    total: u64,
    cancellable: bool,
}

fn current() -> Version {
    Version::parse(env!("CARGO_PKG_VERSION")).unwrap()
}

fn cache_path(release: &Release) -> Result<PathBuf, String> {
    Ok(manager::child_dir("downloads")?.join(format!("hub-{}.exe", release.sha256)))
}

fn cached(release: &Release) -> bool {
    cache_path(release).is_ok_and(|path| {
        fs::metadata(&path).is_ok_and(|m| m.len() == release.byte_length)
            && manager::file_hash(&path).is_ok_and(|h| h == release.sha256)
    })
}

fn validate(release: &Release, preview: bool) -> Result<(), String> {
    let version = release.validate_id(APP_ID, preview)?;
    if version <= current() {
        return Err("Hub is already using this version or a newer one.".into());
    }
    if release.required_hub_version().is_some() {
        return Err("This Hub update needs an intermediate Hub version first.".into());
    }
    if release.installer_protocol != 1 {
        return Err("This Hub update has not passed the safe restart checks yet.".into());
    }
    Ok(())
}

fn installed_location() -> Result<PathBuf, String> {
    if !platform::supported() {
        return Err("Hub updates currently support Windows x64.".into());
    }
    let exe = std::env::current_exe().map_err(|_| "Cannot check this Hub copy.")?;
    let expected = dirs::data_local_dir()
        .ok_or("Local app data is unavailable.")?
        .join("Creator Hub")
        .join("creator-hub.exe");
    platform::reject_links(&exe)?;
    if !platform::same_path(&exe, &expected) {
        return Err(
            "This is a portable test copy. Install Creator Hub first to enable in-app upgrades."
                .into(),
        );
    }
    #[cfg(windows)]
    {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        let key = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Creator Hub")
            .map_err(|_| {
                "Hub's installation record is missing. Run the Hub installer to repair it."
            })?;
        let location: String = key
            .get_value("InstallLocation")
            .map_err(|_| "Hub's installation folder could not be checked.")?;
        let version: String = key
            .get_value("DisplayVersion")
            .map_err(|_| "Hub's installed version could not be checked.")?;
        if version != env!("CARGO_PKG_VERSION")
            || !platform::same_path(
                &exe,
                &PathBuf::from(location.trim_matches('"')).join("creator-hub.exe"),
            )
        {
            return Err("Another Hub copy is installed. Open that copy before updating.".into());
        }
    }
    platform::verify_nsis_update_target("Creator Hub", &exe)?;
    Ok(exe)
}

fn selected(handle: &tauri::AppHandle, expected: &str) -> Result<Release, String> {
    let state = handle.state::<SelfUpdate>();
    let release = state
        .0
        .lock()
        .map_err(|_| "Hub update state is unavailable.")?
        .clone()
        .ok_or("Check for a Hub update first.")?;
    if release.version != expected {
        return Err("The Hub update changed. Check again before installing.".into());
    }
    validate(&release, true)?;
    Ok(release)
}

fn check(handle: &tauri::AppHandle, online: bool, preview: bool) -> Result<State, String> {
    let _operation = handle.state::<Manager>().begin()?;
    let dir = manager::child_dir("hub-updates")?;
    let mut warning = None;
    if online {
        let result = catalog::client()
            .and_then(|client| catalog::discover_from(&client, REPO, APP_ID, preview, &current()));
        match result {
            Ok(Some((release, bytes, signature))) => {
                let path = dir.join(format!("{}.json", release.version));
                if path.exists() {
                    let old = manager::bounded_read(&path, catalog::MAX_METADATA)?;
                    if old != bytes {
                        warning = Some("The Hub update changed after publication. Keeping the previously verified update.".into());
                    }
                } else {
                    manager::atomic_write(&path.with_extension("minisig"), &signature)?;
                    manager::atomic_write(&path, &bytes)?;
                }
            }
            Ok(None) => {}
            Err(error) => warning = Some(error),
        }
    }
    let mut releases = Vec::new();
    for (index, entry) in fs::read_dir(&dir)
        .map_err(|_| "Cannot inspect Hub update downloads.")?
        .enumerate()
    {
        if index >= 128 {
            return Err("Too many Hub update records. Update checking was paused.".into());
        }
        let entry = entry.map_err(|_| "Cannot inspect Hub update record.")?;
        if entry.path().extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        if let (Ok(data), Ok(signature)) = (
            manager::bounded_read(&entry.path(), catalog::MAX_METADATA),
            manager::bounded_read(&entry.path().with_extension("minisig"), 4096),
        ) {
            if let Ok(release) = catalog::verify_signed_id(APP_ID, &data, &signature, preview) {
                if Version::parse(&release.version).is_ok_and(|v| v > current()) {
                    releases.push(release);
                }
            }
        }
    }
    let release = releases
        .into_iter()
        .max_by_key(|r| Version::parse(&r.version).unwrap());
    let state = State {
        current_version: env!("CARGO_PKG_VERSION"),
        available_version: release.as_ref().map(|r| r.version.clone()),
        downloaded: release.as_ref().is_some_and(cached),
        install_blocked: release.as_ref().and_then(|r| {
            validate(r, preview)
                .err()
                .or_else(|| installed_location().err())
        }),
        warning,
    };
    *handle
        .state::<SelfUpdate>()
        .0
        .lock()
        .map_err(|_| "Hub update state is unavailable.")? = release;
    Ok(state)
}

fn download(handle: &tauri::AppHandle, release: &Release) -> Result<PathBuf, String> {
    let path = cache_path(release)?;
    if cached(release) {
        return Ok(path);
    }
    platform::reject_links(&path)?;
    if fs2::available_space(path.parent().unwrap()).map_err(|_| "Cannot check free disk space.")?
        < release.byte_length.saturating_mul(4) + 128 * 1024 * 1024
    {
        return Err("There is not enough space to download the Hub update.".into());
    }
    let partial = path.with_extension("part");
    platform::reject_links(&partial)?;
    let file = fs::File::create(&partial).map_err(|_| "Cannot save the Hub download.")?;
    let result = manager::download_stream_url(
        &catalog::release_url(REPO, &release.version, &release.asset_name),
        release,
        file,
        handle.state::<Manager>().cancellation(),
        |received| {
            let _ = handle.emit(
                "app-progress",
                Progress {
                    message: format!("Downloading Creator Hub {}", release.version),
                    received,
                    total: release.byte_length,
                    cancellable: true,
                },
            );
        },
    );
    if let Err(error) = result {
        let _ = fs::remove_file(&partial);
        return Err(error);
    }
    fs::rename(&partial, &path).map_err(|_| "Cannot finish the Hub download.")?;
    Ok(path)
}

#[tauri::command]
pub async fn hub_update_status(
    handle: tauri::AppHandle,
    online: bool,
    preview: bool,
) -> Result<State, String> {
    tauri::async_runtime::spawn_blocking(move || check(&handle, online, preview))
        .await
        .map_err(|_| "Hub update check failed.")?
}

#[tauri::command]
pub async fn download_hub_update(
    handle: tauri::AppHandle,
    version: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = handle.state::<Manager>().begin()?;
        let release = selected(&handle, &version)?;
        download(&handle, &release)?;
        Ok("Hub update downloaded. Click Update Hub when you are ready.".into())
    })
    .await
    .map_err(|_| "Hub download failed.")?
}

#[tauri::command]
pub async fn install_hub_update(
    handle: tauri::AppHandle,
    version: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = handle.state::<Manager>().begin()?;
        let release = selected(&handle, &version)?;
        let installed = installed_location()?;
        if handle.state::<crate::hosted::Hosting>().has_sessions() {
            return Err("Close the app views inside Hub before updating Hub. Your standalone apps can stay open.".into());
        }
        let approved = handle.dialog().message(format!("Update Creator Hub to {}?\n\nHub will close and reopen. Your projects, apps and settings will stay in place.", release.version))
            .title("Update Creator Hub").buttons(MessageDialogButtons::OkCancelCustom("Update Hub".into(), "Not now".into())).blocking_show();
        if !approved { return Ok("Hub update cancelled. Nothing was installed.".into()); }
        let installer = download(&handle, &release)?;
        if handle.state::<Manager>().cancellation().load(Ordering::SeqCst) { return Err("Hub update cancelled.".into()); }
        let bytes = manager::bounded_read(&installer, catalog::MAX_ARTIFACT)?;
        use sha2::{Digest, Sha256};
        if bytes.len() as u64 != release.byte_length || format!("{:x}", Sha256::digest(&bytes)) != release.sha256 {
            return Err("The Hub download changed. Download it again.".into());
        }
        // The version, installer URL and bytes are bound to our signed catalog.
        // Tauri owns the Windows installer handoff and application restart.
        let endpoint = catalog::release_url(REPO, &release.version, "latest.json");
        let updater = handle.updater_builder()
            // The default callback destroys the UI before ShellExecute succeeds.
            // There are no hosted sessions here; let the plugin exit only after
            // a successful launch so a refused launch can still show an error.
            .on_before_exit(|| {})
            .endpoints(vec![endpoint.parse().map_err(|_| "Invalid Hub update endpoint.")?])
            .map_err(|_| "Cannot prepare the Hub update.")?
            .timeout(Duration::from_secs(30))
            .pubkey(base64::engine::general_purpose::STANDARD.encode(include_bytes!("catalog-key.pub")))
            .installer_arg("/NS")
            .installer_arg(format!("/D={}", installed.parent().ok_or("Invalid Hub folder.")?.display()))
            .build().map_err(|_| "Cannot prepare the Hub installer.")?;
        let update = tauri::async_runtime::block_on(updater.check())
            .map_err(|_| "The Hub restart information could not be downloaded. Try again.")?
            .ok_or("Hub is already up to date.")?;
        if update.version != release.version || update.download_url.as_str() != catalog::release_url(REPO, &release.version, &release.asset_name) {
            return Err("The Hub restart information does not match the verified update.".into());
        }
        // install() accepts already-downloaded bytes; verify its detached signature
        // too, since the plugin only verifies that signature during download().
        let signature = base64::engine::general_purpose::STANDARD.decode(&update.signature)
            .map_err(|_| "Invalid Hub installer signature.")?;
        let signature = std::str::from_utf8(&signature).map_err(|_| "Invalid Hub installer signature.")?;
        let key = minisign_verify::PublicKey::decode(include_str!("catalog-key.pub")).map_err(|_| "Invalid Hub update key.")?;
        let signature = minisign_verify::Signature::decode(signature).map_err(|_| "Invalid Hub installer signature.")?;
        key.verify(&bytes, &signature, false).map_err(|_| "Hub installer signature verification failed.")?;
        installed_location()?;
        if handle.state::<Manager>().cancellation().load(Ordering::SeqCst) { return Err("Hub update cancelled.".into()); }
        let _ = handle.emit("app-progress", Progress { message: "Restarting Hub to install the update...".into(), received: 0, total: 0, cancellable: false });
        update.install(bytes).map_err(|_| "Hub could not start its installer. Nothing was installed.")?;
        Ok("Hub update started.".into())
    }).await.map_err(|_| "Hub update could not start.")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn packaged_updater_configuration_initializes_with_the_catalog_key() {
        let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
        let value = context
            .config()
            .plugins
            .0
            .get("updater")
            .cloned()
            .unwrap_or_default();
        let config: tauri_plugin_updater::Config = serde_json::from_value(value).unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(config.pubkey)
                .unwrap(),
            include_bytes!("catalog-key.pub")
        );
        assert!(!config.dangerous_insecure_transport_protocol);
        assert!(!config.dangerous_accept_invalid_certs);
        assert!(!config.dangerous_accept_invalid_hostnames);
        assert!(config.endpoints.is_empty());
    }
    #[test]
    fn hub_updates_require_correct_identity_newer_version_and_guarded_installer() {
        let mut r = catalog::bootstrap(catalog::AppId::Setup);
        r.version = "9.0.0-alpha.1".into();
        r.installer_protocol = 1;
        assert!(validate(&r, true).is_err());
        r.app_id = APP_ID.into();
        assert!(validate(&r, true).is_ok());
        assert!(validate(&r, false).is_err());
        r.installer_protocol = 0;
        assert!(validate(&r, true).unwrap_err().contains("restart"));
        r.installer_protocol = 1;
        r.version = env!("CARGO_PKG_VERSION").into();
        assert!(validate(&r, true).is_err());
    }
}
