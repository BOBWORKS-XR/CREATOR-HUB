mod build_payload_inputs;

fn main() {
    println!("cargo:rerun-if-env-changed=CREATOR_HUB_INTERNAL_MODULE");
    use build_payload_inputs::{select_inputs, PayloadInput, OVERRIDE_ENV};
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};
    println!("cargo:rerun-if-env-changed={OVERRIDE_ENV}");
    println!("cargo:rerun-if-env-changed=CARGO_FEATURE_INTEGRATED_SERVICE");
    let supplied_root = std::env::var_os(OVERRIDE_ENV);
    let inputs = select_inputs(
        &std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default(),
        std::env::var_os("CARGO_FEATURE_INTEGRATED_SERVICE").is_some(),
        supplied_root.as_deref(),
    )
    .unwrap_or_else(|error| panic!("Cannot select MCP build payload: {error}"));
    let manifest =
        std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("hosted_payload.rs");
    let mut output =
        std::fs::File::create(manifest).expect("Cannot create hosted payload identity");
    writeln!(output, "pub const FILES: &[(&str, &str)] = &[").unwrap();
    for PayloadInput { name, source } in inputs {
        println!("cargo:rerun-if-changed={}", source.display());
        let mut file =
            std::fs::File::open(source).expect("Build the release payload before the launcher");
        let mut digest = Sha256::new();
        let mut buffer = [0; 65536];
        loop {
            let count = file.read(&mut buffer).expect("Cannot hash release payload");
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        writeln!(
            output,
            "({name:?}, {:?}),",
            format!("{:x}", digest.finalize())
        )
        .unwrap();
    }
    writeln!(output, "]; ").unwrap();
    tauri_build::build();
    // Tauri emits the Windows manifest for bin targets only. The native smoke
    // example also needs Common Controls v6, or its imports fail before main.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        let resource =
            std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("resource.lib");
        println!("cargo:rustc-link-arg-examples={}", resource.display());
    }
}
