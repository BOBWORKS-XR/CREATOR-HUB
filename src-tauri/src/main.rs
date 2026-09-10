#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
    // This preview has no launch routes, install commands or hosted mode.
    if std::env::args_os().len() != 1 {
        std::process::exit(2);
    }
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![open_resource])
        .run(tauri::generate_context!())
        .expect("Creator Hub could not start");
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
