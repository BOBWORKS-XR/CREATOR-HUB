#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod catalog;
mod manager;
mod platform;
use catalog::AppId;
use tauri::{Emitter, Manager as _};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[tauri::command]
async fn app_inventory(
    app: tauri::AppHandle,
    check: bool,
    preview: bool,
) -> Result<manager::Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<manager::Manager>().snapshot(check, preview)
    })
    .await
    .map_err(|_| "App discovery worker failed.")?
}

#[tauri::command]
async fn download_app(
    handle: tauri::AppHandle,
    app: AppId,
    version: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        handle
            .state::<manager::Manager>()
            .prepare(app, version, |p| {
                let _ = handle.emit("app-progress", p);
            })
    })
    .await
    .map_err(|_| "Download worker failed.")?
}

#[tauri::command]
async fn install_app(
    handle: tauri::AppHandle,
    app: AppId,
    version: String,
    reopen: bool,
    close_running: bool,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let approved = handle.dialog().message(format!("Install or update {} {} from its verified official release?\n\nKeep the default installation folder. Your Unity projects and AI settings will not be changed by Hub. Older installers may show their normal installation window. No app, Unity Editor or MCP client will be force-closed.{}", app.name(), version, if close_running { "\n\nYou also allow a compatible idle app to close normally before updating." } else { "" }))
            .title("Install Creator app").kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom("Install".into(), "Cancel".into())).blocking_show();
        if !approved { return Ok("Installation cancelled. Nothing was installed.".into()); }
        handle.state::<manager::Manager>().install(app, version, reopen, close_running, |p| { let _ = handle.emit("app-progress", p); })
    }).await.map_err(|_| "Installation worker failed.")?
}

#[tauri::command]
fn cancel_download(handle: tauri::AppHandle) {
    handle.state::<manager::Manager>().cancel();
}

#[tauri::command]
async fn open_app(handle: tauri::AppHandle, app: AppId) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || handle.state::<manager::Manager>().open(app))
        .await
        .map_err(|_| "App launch worker failed.")?
}

#[tauri::command]
async fn use_existing_app(handle: tauri::AppHandle, app: AppId) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = handle
            .dialog()
            .file()
            .add_filter("Creator app", &["exe"])
            .blocking_pick_file()
        else {
            return Ok("No app selected.".into());
        };
        let path = path.into_path().map_err(|_| "Choose a local executable.")?;
        handle.state::<manager::Manager>().adopt(app, path)?;
        Ok("Existing app verified and added. No second copy was installed.".into())
    })
    .await
    .map_err(|_| "App selection worker failed.")?
}

fn resource_url(resource: &str) -> Option<&'static str> {
    match resource {
        "mcp-releases" => Some("https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/releases"),
        "setup-releases" => Some("https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/releases"),
        "mcp-source" => Some("https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP"),
        "setup-source" => Some("https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP"),
        "hub-plan" => Some("https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/blob/master/docs/CREATOR-HUB-PLAN.md"),
        "github" => Some("https://github.com/BOBWORKS-XR"),
        "sdk-source" => Some("https://greenfield-registry.sdq.st/-/web/detail/com.sidequest.creator-sdk"),
        _ => None,
    }
}

#[tauri::command]
fn open_resource(resource: String) -> Result<(), String> {
    let url = resource_url(&resource).ok_or("Unknown Creator resource.")?;
    #[cfg(target_os = "windows")]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new("rundll32.exe");
        command.args(["url.dll,FileProtocolHandler", url]);
        command.creation_flags(0x08000000);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(url);
        command
    };
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(url);
        command
    };
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open the browser: {error}"))
}

fn main() {
    // No arbitrary paths, commands, or installation routes on the command line.
    if std::env::args_os().len() != 1 {
        std::process::exit(2);
    }
    tauri::Builder::default()
        .manage(manager::Manager::default())
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if !window.state::<manager::Manager>().allow_close() {
                    api.prevent_close();
                    let _ = window.emit("close-blocked", "An app operation is running. Cancel the download or finish the installer before closing Hub.");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![open_resource, app_inventory, download_app, install_app, open_app, cancel_download, use_existing_app])
        .build(tauri::generate_context!())
        .expect("Creator Hub could not start")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if !app.state::<manager::Manager>().allow_close() { api.prevent_exit(); }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_named_public_resources_are_accepted() {
        for id in [
            "mcp-releases",
            "setup-releases",
            "mcp-source",
            "setup-source",
            "hub-plan",
            "github",
            "sdk-source",
        ] {
            assert!(resource_url(id).unwrap().starts_with("https://"));
        }
        for input in [
            "",
            "install",
            "https://example.com",
            "file:///C:/tool.exe",
            "mcp-releases --install",
            "MCP-RELEASES",
        ] {
            assert!(resource_url(input).is_none());
        }
    }
}
