use crate::{
    catalog::{self, Release},
    manager::{self, Manager},
    platform,
    update_target::Target,
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
pub struct SelfUpdate(
    Mutex<Option<Release>>,
    #[cfg(unix)] Mutex<Option<Result<crate::installation_identity::Identity, String>>>,
);

#[cfg(unix)]
pub fn initialize(handle: &tauri::AppHandle) {
    let identity = raw_installed_location(handle).and_then(|target| {
        let exe = tauri::utils::platform::current_exe()
            .map_err(|_| "Cannot check the running Hub image.")?;
        crate::installation_identity::Identity::capture(&target, &exe)
    });
    if let Ok(mut state) = handle.state::<SelfUpdate>().1.lock() {
        *state = Some(identity);
    }
}

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

fn view_notice(views: &[crate::hosted_restore::View], restore_views: bool) -> String {
    if views.is_empty() {
        return String::new();
    }
    let reopening = if restore_views {
        "They will reopen after Hub restarts. The apps may ask for permission when reopening."
    } else {
        "Automatic reopening is turned off. You can open them again from Hub."
    };
    format!("\n\nHub will close these idle views: {}. Unsaved form entries will be discarded. {reopening} Standalone apps and MCP connections will stay open.", views.iter().map(|v| v.app.name()).collect::<Vec<_>>().join(", "))
}

fn cache_path(release: &Release) -> Result<PathBuf, String> {
    Ok(manager::child_dir("downloads")?.join(format!(
        "hub-{}{}",
        release.sha256,
        Target::native()?.extension
    )))
}

fn cached(release: &Release) -> bool {
    cache_path(release).is_ok_and(|path| {
        fs::metadata(&path).is_ok_and(|m| m.len() == release.byte_length)
            && manager::file_hash(&path).is_ok_and(|h| h == release.sha256)
    })
}

fn validate(release: &Release, preview: bool) -> Result<(), String> {
    validate_for(release, preview, Target::native()?)
}

fn validate_for(release: &Release, preview: bool, target: Target) -> Result<(), String> {
    let version = release.validate_target(APP_ID, preview, target)?;
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

fn installed_location(_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = raw_installed_location(_handle)?;
    #[cfg(unix)]
    {
        let state = _handle.state::<SelfUpdate>();
        let identity = state
            .1
            .lock()
            .map_err(|_| "The original Hub installation identity is unavailable.")?;
        match identity.as_ref().ok_or(
            "Hub startup identity is unavailable. Restart the installed app before updating.",
        )? {
            Ok(identity) => identity.verify(&path)?,
            Err(error) => return Err(error.clone()),
        }
    }
    Ok(path)
}

fn raw_installed_location(_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    Target::native()?;
    #[cfg(windows)]
    {
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
                return Err(
                    "Another Hub copy is installed. Open that copy before updating.".into(),
                );
            }
        }
        platform::verify_nsis_update_target("Creator Hub", &exe)?;
        Ok(exe)
    }
    #[cfg(target_os = "macos")]
    {
        let exe =
            tauri::utils::platform::current_exe().map_err(|_| "Cannot check this Hub app.")?;
        platform::reject_links(&exe)?;
        crate::update_target::mac_application(
            &exe,
            &dirs::home_dir().ok_or("Cannot check Applications.")?,
        )?;
        Ok(exe)
    }
    #[cfg(target_os = "linux")]
    {
        let exe =
            tauri::utils::platform::current_exe().map_err(|_| "Cannot check this Hub package.")?;
        let target = Target::native()?;
        crate::linux_update::preflight(target.package)?;
        let location = if target.package == "appimage" {
            let env = _handle.env();
            let appdir = PathBuf::from(
                env.appdir
                    .as_ref()
                    .ok_or("Cannot identify the AppImage mount.")?,
            );
            let image = PathBuf::from(
                env.appimage
                    .as_ref()
                    .ok_or("Cannot identify the original AppImage file.")?,
            );
            crate::update_target::appimage_location(&exe, &appdir, &image)?
        } else {
            if exe != std::path::Path::new("/usr/bin/creator-hub") {
                return Err("Open the installed Hub package before updating.".into());
            }
            exe
        };
        platform::reject_links(&location)?;
        if !fs::metadata(&location).is_ok_and(|m| m.is_file()) {
            return Err("The installed Hub package is unavailable.".into());
        }
        let restart = tauri::process::current_binary(&_handle.env())
            .map_err(|_| "Cannot verify Hub's restart target.")?;
        platform::reject_links(&restart)?;
        crate::update_target::verify_restart_target(&location, &restart)?;
        Ok(location)
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    Err("This platform does not have an accepted Hub updater.".into())
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
    let target = Target::native()?;
    let dir = manager::child_dir("hub-updates")?;
    let dir = if target.platform == "windows" {
        dir
    } else {
        dir.join(target.updater_key())
    };
    platform::reject_links(&dir)?;
    fs::create_dir_all(&dir).map_err(|_| "Cannot prepare Hub update records.")?;
    let mut warning = None;
    if online {
        let result = catalog::client().and_then(|client| {
            catalog::discover_target(&client, REPO, APP_ID, preview, &current(), target)
        });
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
            if let Ok(release) =
                catalog::verify_signed_target(APP_ID, &data, &signature, preview, target)
            {
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
                .or_else(|| installed_location(handle).err())
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
    restore_views: bool,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = handle.state::<Manager>().begin()?;
        let release = selected(&handle, &version)?;
        let installed = installed_location(&handle)?;
        let mut views = handle.state::<crate::hosted::Hosting>().update_views()?;
        views.extend(crate::features::update_views(&handle)?);
        let view_notice = view_notice(&views, restore_views);
        let approved = handle.dialog().message(format!("Update Creator Hub to {}?\n\nHub will close and reopen. Your projects, apps and settings will stay in place.{}", release.version, view_notice))
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
        // Tauri owns package installation; Unix requires an explicit restart.
        let endpoint = catalog::release_url(REPO, &release.version, "latest.json");
        let updater = handle.updater_builder()
            // The default callback destroys the UI before ShellExecute succeeds.
            // Hosted sessions are drained below; let the plugin exit only after
            // a successful launch so a refused launch can still show an error.
            .on_before_exit(|| {})
            .endpoints(vec![endpoint.parse().map_err(|_| "Invalid Hub update endpoint.")?])
            .map_err(|_| "Cannot prepare the Hub update.")?
            .timeout(Duration::from_secs(30))
            .pubkey(base64::engine::general_purpose::STANDARD.encode(include_bytes!("catalog-key.pub")))
            .target(Target::native()?.updater_key())
            .executable_path(&installed);
        #[cfg(windows)]
        let updater = updater.installer_arg("/NS")
            .installer_arg(format!("/D={}", installed.parent().ok_or("Invalid Hub folder.")?.display()));
        let updater = updater.build().map_err(|_| "Cannot prepare the Hub installer.")?;
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
        let rechecked = installed_location(&handle)?;
        if rechecked != installed { return Err("The running Hub installation changed. Restart Hub before updating.".into()); }
        if handle.state::<Manager>().cancellation().load(Ordering::SeqCst) { return Err("Hub update cancelled.".into()); }
        if !views.is_empty() {
            if restore_views {
                handle.state::<crate::hosted_restore::Restore>().remember(views, &release.version)?;
            }
            let message = if restore_views { "Closing app views for the update. They will reopen when Hub restarts..." } else { "Closing app views for the update..." };
            let _ = handle.emit("app-progress", Progress { message: message.into(), received: 0, total: 0, cancellable: false });
            handle.state::<crate::hosted::Hosting>().suspend_for_update(Duration::from_secs(30), |sessions| {
                let _ = handle.emit("hosted-apps-suspended", sessions);
            })?;
        }
        let _ = handle.emit("app-progress", Progress { message: "Restarting Hub to install the update...".into(), received: 0, total: 0, cancellable: false });
        installed_location(&handle)?;
        #[cfg(target_os = "macos")]
        crate::mac_update::install(&bytes, &installed, &release.executable_sha256, || installed_location(&handle).map(|_| ()))?;
        #[cfg(target_os = "linux")]
        if crate::linux_update::install(&bytes, release.byte_length, &release.sha256, Target::native()?.package)? == crate::linux_update::Outcome::Cancelled {
            return Ok("Hub update cancelled at system authorization. Nothing was installed. Your settings and retained MCP connections were kept; closed app views can be reopened from Hub.".into());
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        update.install(bytes).map_err(|_| "Hub could not complete its update. Retry from the installed app; your settings and runtime generations were retained.")?;
        #[cfg(unix)]
        handle.request_restart();
        Ok("Hub update started.".into())
    }).await.map_err(|_| "Hub update could not start.")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn update_confirmation_respects_reopen_preference_and_names_each_view() {
        let views = catalog::AppId::ALL.map(|app| crate::hosted_restore::View {
            app,
            path: std::env::temp_dir().join(app.exe()),
            bundled: true,
            direct: false,
        });
        for restore in [false, true] {
            assert!(view_notice(&[], restore).is_empty());
            let notice = view_notice(&views, restore);
            for app in catalog::AppId::ALL {
                assert!(notice.contains(app.name()));
            }
            assert!(notice.contains("Unsaved form entries will be discarded"));
            assert!(notice.contains("Standalone apps and MCP connections will stay open"));
            if restore {
                assert!(notice.contains("They will reopen after Hub restarts"));
            } else {
                assert!(notice.contains("Automatic reopening is turned off"));
                assert!(!notice.contains("They will reopen"));
                assert!(!notice.contains("will close and reopen"));
            }
        }
    }

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
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(config.pubkey)
            .unwrap();
        let configured =
            minisign_verify::PublicKey::decode(std::str::from_utf8(&decoded).unwrap()).unwrap();
        let embedded = include_str!("catalog-key.pub");
        for text in [
            embedded.to_owned(),
            embedded.replace("\r\n", "\n").replace('\n', "\r\n"),
        ] {
            assert_eq!(
                configured,
                minisign_verify::PublicKey::decode(&text).unwrap()
            );
        }
        assert!(!config.dangerous_insecure_transport_protocol);
        assert!(!config.dangerous_accept_invalid_certs);
        assert!(!config.dangerous_accept_invalid_hostnames);
        assert!(config.endpoints.is_empty());
    }
    #[test]
    fn hub_updates_require_correct_identity_newer_version_and_guarded_installer() {
        let target = Target::select("windows", "x86_64", None).unwrap();
        let mut r = catalog::bootstrap(catalog::AppId::Setup);
        r.version = "9.0.0-alpha.1".into();
        r.installer_protocol = 1;
        assert!(validate_for(&r, true, target).is_err());
        r.app_id = APP_ID.into();
        assert!(validate_for(&r, true, target).is_ok());
        assert!(validate_for(&r, false, target).is_err());
        r.installer_protocol = 0;
        assert!(validate_for(&r, true, target)
            .unwrap_err()
            .contains("restart"));
        r.installer_protocol = 1;
        r.version = env!("CARGO_PKG_VERSION").into();
        assert!(validate_for(&r, true, target).is_err());
    }

    #[test]
    fn native_updates_reject_other_architectures_packages_and_unaccepted_installers() {
        use tauri::utils::config::BundleType;
        for target in [
            Target::select("macos", "aarch64", Some(BundleType::App)).unwrap(),
            Target::select("macos", "x86_64", Some(BundleType::App)).unwrap(),
            Target::select("linux", "x86_64", Some(BundleType::AppImage)).unwrap(),
            Target::select("linux", "x86_64", Some(BundleType::Deb)).unwrap(),
            Target::select("linux", "x86_64", Some(BundleType::Rpm)).unwrap(),
        ] {
            let mut release = catalog::bootstrap(catalog::AppId::Setup);
            release.app_id = APP_ID.into();
            release.version = "99.0.0".into();
            release.platform = target.platform.into();
            release.architecture = target.architecture.into();
            release.package_type = target.package.into();
            release.asset_name = format!("Creator-Hub-99.0.0{}", target.extension);
            assert!(validate_for(&release, false, target)
                .unwrap_err()
                .contains("restart"));
            release.installer_protocol = 1;
            assert!(validate_for(&release, false, target).is_ok());
            for field in ["platform", "architecture", "package", "extension"] {
                let mut wrong = release.clone();
                match field {
                    "platform" => wrong.platform = "wrong".into(),
                    "architecture" => wrong.architecture = "wrong".into(),
                    "package" => wrong.package_type = "wrong".into(),
                    _ => wrong.asset_name = "Creator-Hub.dmg".into(),
                }
                assert!(validate_for(&wrong, false, target).is_err());
            }
        }
    }
}
