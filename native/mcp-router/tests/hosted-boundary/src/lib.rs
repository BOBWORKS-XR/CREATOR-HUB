//! Headless native pipe, source-review and refusal tests; no GUI or release acceptance.
#![cfg(unix)]
#![allow(dead_code)]
use std::path::{Path, PathBuf};

const MCP_CLIENT_ID: &str = "creator-works";
const LEGACY_MCP_CLIENT_ID: &str = "banter";

#[path = "../../../../../modules/mcp/launcher/src-tauri/src/client_migration.rs"]
mod client_migration;
#[path = "../../../../../modules/mcp/launcher/src-tauri/src/client_ownership.rs"]
mod client_ownership;
#[path = "../../../../../modules/mcp/launcher/src-tauri/src/client_setup_write.rs"]
mod client_setup_write;
#[path = "../../../../../modules/mcp/launcher/src-tauri/src/hosted_unix.rs"]
mod hosted_unix;
#[path = "../../../../../modules/mcp/launcher/src-tauri/src/jsonc.rs"]
mod jsonc;
#[path = "../../../../../modules/mcp/launcher/src-tauri/src/settings_backup.rs"]
mod settings_backup;

fn normalized_existing_path(path: PathBuf) -> PathBuf {
    // Native Unix normalization used by the launcher; no Windows namespace here.
    std::fs::canonicalize(&path).unwrap_or(path)
}

fn atomic_write(_: &Path, _: &str) -> Result<(), String> {
    panic!("The built-in Unix test must refuse before reaching legacy publication")
}

mod client_recovery_ui {
    use std::path::{Path, PathBuf};
    pub(crate) fn require_no_pending_adjacent(_: &Path) -> Result<(), String> {
        Err(
            "Headless fixtures cannot enter live client admission; use an explicit journal root"
                .into(),
        )
    }
    pub(crate) fn central_root() -> Result<PathBuf, String> {
        Err("Headless fixtures never resolve the current user's configuration".into())
    }
}

#[test]
fn fixture_is_built_in_and_cannot_silently_skip_the_write_boundary() {
    assert!(
        client_setup_write::protected(),
        "Build with CREATOR_HUB_INTERNAL_MODULE=1"
    );
}
