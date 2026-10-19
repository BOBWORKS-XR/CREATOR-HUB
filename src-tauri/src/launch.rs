use serde::Serialize;
use std::ffi::OsString;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum View {
    Hub,
    Mcp,
    Setup,
}

// Launch roles never select an executable or approve a mutation.
pub fn native_support_requested(arguments: impl IntoIterator<Item = OsString>) -> bool {
    let arguments: Vec<_> = arguments.into_iter().take(2).collect();
    cfg!(all(
        target_os = "linux",
        feature = "experimental-linux-portable-update"
    )) && matches!(arguments.as_slice(), [flag] if flag == "--install-native-support")
}

pub fn parse(arguments: impl IntoIterator<Item = OsString>) -> Result<View, ()> {
    let arguments: Vec<_> = arguments.into_iter().take(4).collect();
    match arguments.as_slice() {
        [] => Ok(View::Hub),
        [flag] if native_support_requested([flag.clone()]) => Ok(View::Hub),
        [flag]
            if flag == "--flatpak-activate"
                && cfg!(all(
                    target_os = "linux",
                    feature = "experimental-flatpak-host",
                    feature = "integrated-features"
                )) =>
        {
            Ok(View::Hub)
        }
        [flag, app] if flag == "--open-app" && app == "mcp" => Ok(View::Mcp),
        [flag, app] if flag == "--open-app" && app == "setup" => Ok(View::Setup),
        _ => Err(()),
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    view: View,
    revision: u64,
}

pub struct Launch(Mutex<Request>);
impl Launch {
    pub fn new(view: View) -> Self {
        Self(Mutex::new(Request { view, revision: 0 }))
    }
    fn update(&self, view: View) -> Option<Request> {
        let mut request = self.0.lock().ok()?;
        request.revision = request.revision.checked_add(1)?;
        request.view = view;
        Some(request.clone())
    }
}

pub fn activate(app: &tauri::AppHandle, arguments: Vec<String>) {
    let Ok(view) = parse(arguments.into_iter().skip(1).map(OsString::from)) else {
        return;
    };
    if let Some(request) = app.state::<Launch>().update(view) {
        // The persisted in-memory revision also covers requests arriving before UI listeners.
        let _ = app.emit_to("main", "hub-launch-view", request);
    }
    let _ = focus(app);
}

pub fn focus(app: &tauri::AppHandle) -> bool {
    if app.state::<crate::manager::Manager>().is_closing() {
        return false;
    }
    if let Some(window) = app.get_webview_window("main") {
        let shown = window.show().is_ok();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return shown;
    }
    false
}

#[tauri::command]
pub fn get_launch_request(handle: tauri::AppHandle) -> Result<Request, String> {
    handle
        .state::<Launch>()
        .0
        .lock()
        .map(|value| value.clone())
        .map_err(|_| "Hub launch state is unavailable.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_fixed_navigation_arguments_are_accepted() {
        assert_eq!(parse([]), Ok(View::Hub));
        for (name, view) in [("mcp", View::Mcp), ("setup", View::Setup)] {
            assert_eq!(
                parse([OsString::from("--open-app"), OsString::from(name)]),
                Ok(view)
            );
        }
        for arguments in [
            vec!["--open-app"],
            vec!["--open-app=mcp"],
            vec!["--OPEN-APP", "mcp"],
            vec!["--open-app", "MCP"],
            vec!["--open-app", "../mcp"],
            vec!["--open-app", "mcp", "--install"],
            vec!["C:\\tool.exe"],
            vec!["--install", "setup"],
            vec!["--open-app", "setup", "--open-app", "mcp"],
        ] {
            assert!(parse(arguments.into_iter().map(OsString::from)).is_err());
        }
    }
    #[test]
    fn later_requests_supersede_startup_without_losing_order() {
        let launch = Launch::new(View::Setup);
        let mcp = launch.update(View::Mcp).unwrap();
        assert_eq!(mcp.view, View::Mcp);
        assert_eq!(mcp.revision, 1);
        let hub = launch.update(View::Hub).unwrap();
        assert_eq!(hub.revision, 2);
        assert_eq!(launch.0.lock().unwrap().view, View::Hub);
    }

    #[test]
    fn flatpak_activation_is_exact_and_requires_the_integrated_linux_host_build() {
        assert_eq!(
            parse([OsString::from("--flatpak-activate")]).is_ok(),
            cfg!(all(
                target_os = "linux",
                feature = "experimental-flatpak-host",
                feature = "integrated-features"
            ))
        );
        for args in [
            vec!["--flatpak-activate", "mcp"],
            vec!["--flatpak-activate=/tmp/app"],
            vec!["--flatpak-activate", "--install"],
            vec!["--FLATPAK-ACTIVATE"],
        ] {
            assert!(parse(args.into_iter().map(OsString::from)).is_err());
        }
    }

    #[test]
    fn native_support_role_requires_the_exact_single_flag_and_linux_update_feature() {
        let arguments = [OsString::from("--install-native-support")];
        let supported = cfg!(all(
            target_os = "linux",
            feature = "experimental-linux-portable-update"
        ));
        assert_eq!(native_support_requested(arguments.clone()), supported);
        assert_eq!(parse(arguments).is_ok(), supported);
        for args in [
            vec![],
            vec!["--install-native-support", "--open-app", "mcp"],
            vec!["--install-native-support", "--install-native-support"],
            vec!["--install-native-support=/tmp/store"],
            vec!["--INSTALL-NATIVE-SUPPORT"],
        ] {
            assert!(!native_support_requested(
                args.into_iter().map(OsString::from)
            ));
        }
    }
}
