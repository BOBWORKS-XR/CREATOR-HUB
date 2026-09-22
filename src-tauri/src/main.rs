#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod catalog;
mod community;
mod community_project;
mod hosted;
mod hosted_operation;
mod hosted_restore;
mod installer_preflight;
mod launch;
mod manager;
mod mcp_runtime;
mod platform;
mod projects;
mod self_update;
use catalog::AppId;
use tauri::{Emitter, Manager as _};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

struct ShellKey(String);

#[tauri::command]
async fn community_projects(
    handle: tauri::AppHandle,
) -> Result<community_project::Targets, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = handle.state::<manager::Manager>().begin()?;
        let extra = projects::community_paths(&handle)?;
        community_project::projects_worker(handle, extra)
    })
    .await
    .map_err(|_| "Project discovery worker failed.")?
}
#[tauri::command]
async fn choose_community_project(
    handle: tauri::AppHandle,
) -> Result<Option<community_project::Target>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = handle.state::<manager::Manager>().begin()?;
        community_project::pick_worker(handle)
    })
    .await
    .map_err(|_| "Project selection worker failed.")?
}
#[tauri::command]
async fn install_community_menu(
    handle: tauri::AppHandle,
    project_id: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = handle.state::<manager::Manager>().begin()?;
        community_project::install_worker(handle, project_id)
    })
    .await
    .map_err(|_| "Unity menu worker failed.")?
}
#[tauri::command]
async fn queue_community_import(
    handle: tauri::AppHandle,
    id: String,
    project_id: String,
    operation_id: Option<String>,
) -> Result<community_project::Outcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = handle.state::<manager::Manager>().begin()?;
        community::queue_import_worker(handle, id, project_id, operation_id)
    })
    .await
    .map_err(|_| "Unity import queue worker failed.")?
}
#[tauri::command]
async fn community_import_status(
    handle: tauri::AppHandle,
    project_id: String,
    request_id: String,
) -> Result<community_project::Outcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        community_project::status_worker(handle, project_id, request_id)
    })
    .await
    .map_err(|_| "Unity receipt worker failed.")?
}

#[tauri::command]
async fn community_catalogue(
    handle: tauri::AppHandle,
    refresh: bool,
) -> Result<community::Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || community::catalogue_worker(handle, refresh))
        .await
        .map_err(|_| "Community worker failed.")?
}
#[tauri::command]
async fn open_community_link(
    handle: tauri::AppHandle,
    id: String,
    kind: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || community::open_link_worker(handle, id, kind))
        .await
        .map_err(|_| "Community link worker failed.")?
}
#[tauri::command]
async fn download_community_package(
    handle: tauri::AppHandle,
    id: String,
    operation_id: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = handle.state::<manager::Manager>().begin()?;
        community::download_worker(handle, id, operation_id)
    })
    .await
    .map_err(|_| "Community download worker failed.")?
}

#[tauri::command]
fn community_transfer_status(
    handle: tauri::AppHandle,
) -> Result<Option<community::transfer::Progress>, String> {
    handle.state::<community::Community>().1.status()
}
#[tauri::command]
fn cancel_community_transfer(handle: tauri::AppHandle, operation_id: String) -> Result<(), String> {
    handle
        .state::<community::Community>()
        .1
        .cancel(&operation_id)
}

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
async fn disconnect_mcp(handle: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        handle.state::<manager::Manager>().disconnect_mcp(|count| {
            handle.dialog().message(format!("Stop {count} private Creator Works MCP runtime(s) so MCP can be updated?\n\nFinish active AI work first. This ends MCP connections, including stuck ones. AI apps, Unity, unrelated Node processes, projects and settings are not closed or changed. Unity commands already submitted may still finish.\n\nPause or disable this MCP in your AI client if it reconnects automatically. Reconnect after updating."))
                .title("Disconnect MCP for update").kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom("Disconnect MCP".into(), "Cancel".into())).blocking_show()
        })
    }).await.map_err(|_| "MCP disconnect worker failed.")?
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
async fn use_existing_app(
    handle: tauri::AppHandle,
    app: AppId,
    path: Option<std::path::PathBuf>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(path) = path {
            handle
                .state::<manager::Manager>()
                .select_detected(app, path)?;
            return Ok(
                "Existing app selected and verified. Its settings and installation are unchanged."
                    .into(),
            );
        }
        #[allow(unused_mut)]
        let mut file_picker = handle.dialog().file();
        #[cfg(windows)]
        {
            file_picker = file_picker.add_filter("Creator app", &["exe"]);
        }
        let Some(path) = file_picker.blocking_pick_file() else {
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
        "github" => Some("https://github.com/BOBWORKS-XR/CREATOR-HUB"),
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

fn shell_initialization(shell_key: &str) -> String {
    format!("if(window === window.top) {{ Object.defineProperty(window, '__CREATOR_SHELL_KEY__', {{value: '{}', configurable: true}}); Object.defineProperty(window, '__CREATOR_HUB_VERSION__', {{value: '{}'}}); }}", shell_key, env!("CARGO_PKG_VERSION"))
}

#[cfg(target_os = "linux")]
fn configure_linux_webkit() {
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    // SteamOS ships a newer Wayland client library than the Ubuntu-built AppImage.
    // WebKitGTK's renderer can abort at EGL initialization when it loads the bundled
    // library against SteamOS Mesa. Keep an explicit user preload intact.
    let steamos = std::fs::read_to_string("/etc/os-release")
        .is_ok_and(|release| release.lines().any(|line| line == "ID=steamos"));
    let host_wayland = "/usr/lib/libwayland-client.so.0";
    if steamos
        && std::path::Path::new(host_wayland).is_file()
        && std::env::var_os("LD_PRELOAD").is_none()
    {
        std::env::set_var("LD_PRELOAD", host_wayland);
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    configure_linux_webkit();
    if let Some(wait) = installer_preflight::mode(std::env::args_os().skip(1)) {
        std::process::exit(installer_preflight::run(wait));
    }
    let initial_view = match launch::parse(std::env::args_os().skip(1)) {
        Ok(view) => view,
        Err(()) => std::process::exit(2),
    };
    let mut random = [0u8; 32];
    getrandom::fill(&mut random).expect("Cannot initialize Hub's private shell authority");
    let shell_key: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let initialize = shell_initialization(&shell_key);
    let commands: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        open_resource,
        community_catalogue,
        community_projects,
        choose_community_project,
        install_community_menu,
        queue_community_import,
        community_import_status,
        open_community_link,
        download_community_package,
        community_transfer_status,
        cancel_community_transfer,
        app_inventory,
        download_app,
        install_app,
        disconnect_mcp,
        open_app,
        cancel_download,
        use_existing_app,
        self_update::hub_update_status,
        self_update::download_hub_update,
        self_update::install_hub_update,
        hosted_restore::pending_hosted_restore,
        hosted_restore::restore_hosted_app,
        hosted_restore::complete_hosted_restore,
        projects::project_inventory,
        projects::add_project_folder,
        projects::remove_project_folder,
        projects::open_unity_project,
        launch::get_launch_request,
        hosted::start_hosted_app,
        hosted::hosted_app_call,
        hosted::stop_hosted_app,
        hosted::abort_hosted_app
    ];
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, arguments, _cwd| {
            launch::activate(app, arguments);
        }))
        .manage(launch::Launch::new(initial_view))
        .manage(ShellKey(shell_key))
        .append_invoke_initialization_script(initialize)
        .manage(manager::Manager::default())
        .manage(community::Community::default())
        .manage(community_project::ProjectImports::default())
        .manage(self_update::SelfUpdate::default())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(hosted::Hosting::default())
        .manage(hosted_restore::Restore::default())
        .manage(projects::Projects::default())
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if !window.state::<manager::Manager>().allow_close() {
                    api.prevent_close();
                    let _ = window.emit("close-blocked", "An app operation is running. Cancel the download or finish the installer before closing Hub.");
                }
            }
        })
        .invoke_handler(move |invoke| {
            let app = invoke.message.webview_ref().app_handle();
            let key = app.state::<ShellKey>();
            if invoke.message.headers().get("x-creator-shell-key").and_then(|value| value.to_str().ok()) != Some(key.0.as_str()) {
                invoke.resolver.reject("Hub commands are available only to its trusted shell.");
                return true;
            }
            commands(invoke)
        })
        .build(tauri::generate_context!())
        .expect("Creator Hub could not start")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if !app.state::<manager::Manager>().allow_close() { api.prevent_exit(); }
                else { app.state::<hosted::Hosting>().close_idle(); }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_version_comes_from_the_executable() {
        let script = shell_initialization("test-key");
        assert!(script.starts_with("if(window === window.top)"));
        assert!(script.contains(&format!(
            "'__CREATOR_HUB_VERSION__', {{value: '{}'}}",
            env!("CARGO_PKG_VERSION")
        )));
    }

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
