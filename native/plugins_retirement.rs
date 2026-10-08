//! Shared retirement boundary. Existing receipts/cancellation remain available.
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const CUTOFF_SECONDS: u64 = 1_792_454_400; // 2026-10-20 00:00:00 UTC
const WEBSITE: &str = "https://creatorplugins.store/";
const RETIRED: &str =
    "Creator Plugins has been retired from the Creator apps. Existing project files are unchanged.";

pub fn command_error(command: &str) -> Option<&'static str> {
    match command {
        "community_catalogue"
        | "community_projects"
        | "choose_community_project"
        | "install_community_menu"
        | "queue_community_import"
        | "open_community_link"
        | "download_community_package" => Some(RETIRED),
        _ => None,
    }
}

fn website_at(now: SystemTime) -> Result<&'static str, &'static str> {
    match now.duration_since(UNIX_EPOCH) {
        Ok(elapsed) if elapsed < Duration::from_secs(CUTOFF_SECONDS) => Ok(WEBSITE),
        _ => Err(RETIRED),
    }
}

#[tauri::command]
pub fn open_plugins_website() -> Result<(), String> {
    let url = website_at(SystemTime::now())?;
    let mut command = if cfg!(windows) {
        let mut command = std::process::Command::new("rundll32.exe");
        command.args(["url.dll,FileProtocolHandler", url]);
        command
    } else if cfg!(target_os = "macos") {
        let mut command = std::process::Command::new("open");
        command.arg(url);
        command
    } else {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(url);
        command
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|_| "Could not open the Creator Plugins website.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn website_has_one_fixed_target_and_an_inclusive_retirement_boundary() {
        let cutoff = UNIX_EPOCH + Duration::from_secs(CUTOFF_SECONDS);
        // Windows SystemTime cannot represent a one-nanosecond difference.
        assert_eq!(website_at(cutoff - Duration::from_millis(1)), Ok(WEBSITE));
        assert!(website_at(cutoff).is_err());
        assert!(website_at(cutoff + Duration::from_secs(86_400)).is_err());
        assert!(website_at(UNIX_EPOCH - Duration::from_secs(1)).is_err());
    }

    #[test]
    fn retired_operations_are_denied_but_receipt_and_cancel_cleanup_are_not() {
        for command in [
            "community_catalogue",
            "community_projects",
            "choose_community_project",
            "install_community_menu",
            "queue_community_import",
            "open_community_link",
            "download_community_package",
        ] {
            assert_eq!(command_error(command), Some(RETIRED));
        }
        for command in [
            "community_import_status",
            "community_transfer_status",
            "cancel_community_transfer",
            "open_plugins_website",
            "create_project",
            "load_config",
            "one_click_setup",
        ] {
            assert_eq!(command_error(command), None);
        }
    }
}
