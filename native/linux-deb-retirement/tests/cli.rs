use creator_hub_linux_deb_retirement::{pins, INSTALL_REFUSAL};
use std::process::Command;

#[test]
fn default_refuses_and_feature_build_still_requires_the_trusted_installed_image() {
    let binary = env!("CARGO_BIN_EXE_creator-hub-linux-deb-retirement");
    assert_ne!(
        std::path::Path::new(binary),
        std::path::Path::new(pins::HELPER)
    );
    let output = Command::new(binary)
        .arg("retire-mcp-2.7.7")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["status"], "refused");
    assert_eq!(report["packageTransactionStarted"], false);
    assert_eq!(report["manualRepairRequired"], false);
    assert_eq!(report["nativeAcceptance"], false);
    assert_eq!(
        report["experimentalTransactionCompiled"],
        cfg!(feature = "experimental-transaction")
    );
    if cfg!(feature = "experimental-transaction") {
        assert_ne!(report["reason"], INSTALL_REFUSAL);
    } else {
        assert_eq!(report["reason"], INSTALL_REFUSAL);
    }
}
