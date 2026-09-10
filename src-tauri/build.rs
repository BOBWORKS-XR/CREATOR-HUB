fn main() {
    println!("cargo:rerun-if-env-changed=CREATOR_SETUP_HOST_SHA256");
    println!("cargo:rerun-if-env-changed=CREATOR_MCP_HOST_SHA256");
    println!("cargo:rerun-if-env-changed=CREATOR_MCP_HOST_READONLY_EVENTS");
    println!("cargo:rerun-if-env-changed=CREATOR_MCP_HOST_WRITABLE");
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "open_resource",
            "app_inventory",
            "download_app",
            "install_app",
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
