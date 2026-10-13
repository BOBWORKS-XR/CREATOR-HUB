fn main() {
    // Only this standalone test crate binds synthetic resource bytes.
    // The launcher's generated manifest and real payload stay unchanged.
    let target =
        std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("hosted_payload.rs");
    std::fs::write(
        target,
        r#"pub const FILES: &[(&str, &str)] = &[
    ("runtime/node", "748dd86815268291e465669e48b589d8e59a00256408375fed97d268e377fc61"),
    ("creator-works-mcp.mjs", "676e20ee0736b41b96edc1b7db7791d0f3640bae1d79cb3ddb45d50e2aae5ca8"),
    ("unity-extension/Editor/BanterMCPBridge.cs", "f0b967842b5fdac4283e72d404a35bb3951d4c1f626af18661b5365738ed98da"),
    ("unity-extension/Editor/CreatorWorksMCPLogo.png", "f3624a18f8b0c35267269a78716f7244b525fff1d79ed9e23228feaa72bf4af7"),
];
"#,
    )
    .unwrap();
}
