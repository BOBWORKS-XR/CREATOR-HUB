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

// Launch arguments navigate only. They never select an executable or approve a mutation.
pub fn parse(arguments: impl IntoIterator<Item = OsString>) -> Result<View, ()> {
    let arguments: Vec<_> = arguments.into_iter().take(4).collect();
    match arguments.as_slice() {
        [] => Ok(View::Hub),
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
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
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
}
