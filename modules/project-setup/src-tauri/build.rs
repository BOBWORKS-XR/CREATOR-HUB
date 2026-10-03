fn main() {
    println!("cargo:rerun-if-env-changed=CREATOR_HUB_INTERNAL_MODULE");
    tauri_build::build()
}
