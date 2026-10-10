fn main() {
    println!("cargo:rerun-if-env-changed=CREATOR_BUILTIN_MANIFEST");
    let manifest = match std::env::var_os("CREATOR_BUILTIN_MANIFEST") {
        Some(path) => {
            let path = std::path::PathBuf::from(path);
            assert!(
                path.is_absolute(),
                "Built-in descriptor must have an absolute path"
            );
            println!("cargo:rerun-if-changed={}", path.display());
            std::fs::read(path).expect("Cannot read built-in descriptor")
        }
        None => b"null".to_vec(),
    };
    std::fs::write(
        std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap())
            .join("builtin-manifest.json"),
        manifest,
    )
    .expect("Cannot bind built-in descriptor to Hub");
    println!("cargo:rerun-if-env-changed=CREATOR_SETUP_HOST_SHA256");
    println!("cargo:rerun-if-env-changed=CREATOR_MCP_HOST_SHA256");
    println!("cargo:rerun-if-env-changed=CREATOR_MCP_HOST_READONLY_EVENTS");
    println!("cargo:rerun-if-env-changed=CREATOR_MCP_HOST_WRITABLE");
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "open_resource",
            "open_plugins_website",
            "community_catalogue",
            "open_community_link",
            "download_community_package",
            "community_transfer_status",
            "cancel_community_transfer",
            "community_projects",
            "choose_community_project",
            "install_community_menu",
            "queue_community_import",
            "community_import_status",
            "app_inventory",
            "download_app",
            "install_app",
            "disconnect_mcp",
            "hub_update_status",
            "download_hub_update",
            "install_hub_update",
            "pending_hosted_restore",
            "restore_hosted_app",
            "complete_hosted_restore",
            "open_app",
            "cancel_download",
            "use_existing_app",
            "project_inventory",
            "add_project_folder",
            "remove_project_folder",
            "open_unity_project",
            "get_launch_request",
            "start_hosted_app",
            "hosted_app_call",
            "stop_hosted_app",
            "abort_hosted_app",
        ]),
    ))
    .expect("Cannot build Hub command permissions")
}
