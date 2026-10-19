//! Shared retirement boundary. Existing receipts/cancellation remain available.
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
        | "download_community_package"
        | "open_plugins_website" => Some(RETIRED),
        _ => None,
    }
}

#[tauri::command]
pub fn open_plugins_website() -> Result<(), String> {
    Err(RETIRED.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removed_website_action_is_refused_without_launching_any_process() {
        assert_eq!(open_plugins_website(), Err(RETIRED.into()));
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
            "open_plugins_website",
        ] {
            assert_eq!(command_error(command), Some(RETIRED));
        }
        for command in [
            "community_import_status",
            "community_transfer_status",
            "cancel_community_transfer",
            "create_project",
            "load_config",
            "one_click_setup",
        ] {
            assert_eq!(command_error(command), None);
        }
    }
}
