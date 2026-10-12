fn main() {
    // Only this standalone test crate uses an empty generated manifest. Tests
    // exercise explicit fixture hashes; launcher/build.rs remains unchanged.
    let target =
        std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("hosted_payload.rs");
    std::fs::write(target, "pub const FILES: &[(&str, &str)] = &[];\n").unwrap();
}
