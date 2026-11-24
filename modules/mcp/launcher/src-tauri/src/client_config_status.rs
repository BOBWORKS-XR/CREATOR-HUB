//! Read-only evidence: a named entry is not proof that an AI app loaded it.
use crate::{LEGACY_MCP_CLIENT_ID, MCP_CLIENT_ID};
use serde_json::Value;
use std::path::Path;

pub(crate) fn json_entries(config: &Value, key: &str) -> Result<bool, ()> {
    let root = config.as_object().ok_or(())?;
    let Some(servers) = root.get(key) else {
        return Ok(false);
    };
    let servers = servers.as_object().ok_or(())?;
    let mut present = false;
    for id in [MCP_CLIENT_ID, LEGACY_MCP_CLIENT_ID] {
        if let Some(entry) = servers.get(id) {
            entry.as_object().ok_or(())?;
            present = true;
        }
    }
    Ok(present)
}

pub(crate) fn toml_entries(text: &str) -> Result<bool, ()> {
    let doc = text.parse::<toml_edit::Document>().map_err(|_| ())?;
    let Some(servers) = doc.get("mcp_servers") else {
        return Ok(false);
    };
    let servers = servers.as_table_like().ok_or(())?;
    let mut present = false;
    for id in [MCP_CLIENT_ID, LEGACY_MCP_CLIENT_ID] {
        if let Some(entry) = servers.get(id) {
            entry.as_table_like().ok_or(())?;
            present = true;
        }
    }
    Ok(present)
}

pub(crate) fn json_servers(text: &str) -> Result<bool, ()> {
    json_entries(&serde_json::from_str(text).map_err(|_| ())?, "mcpServers")
}

pub(crate) fn antigravity_servers(text: &str) -> Result<bool, ()> {
    if text.trim().is_empty() {
        Ok(false)
    } else {
        json_servers(text)
    }
}

pub(crate) fn from_file(
    path: &Path,
    parse: impl FnOnce(&str) -> Result<bool, ()>,
) -> Result<bool, ()> {
    match crate::settings_backup::read_text(path).map_err(|_| ())? {
        Some(text) => parse(&text),
        None => Ok(false),
    }
}

pub(crate) fn project_claude(project: &Path) -> &'static str {
    if !project.is_absolute() {
        return "unchecked";
    }
    match from_file(&project.join(".mcp.json"), json_servers) {
        Ok(true) => "present",
        Ok(false) => "notFound",
        Err(()) => "unreadable",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn distinguishes_absent_present_and_unreadable_without_modifying_project_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".mcp.json");
        assert_eq!(project_claude(dir.path()), "notFound");
        for (source, status) in [
            (
                r#"{"mcpServers":{"other":{"env":{"secret":"private"}}}}"#,
                "notFound",
            ),
            (
                r#"{"mcpServers":{"creator-works":{"command":"do-not-execute"}}}"#,
                "present",
            ),
            (
                r#"{"mcpServers":{"banter":{"url":"fixture:not-a-connection-test"}}}"#,
                "present",
            ),
            (
                r#"{"mcpServers":{"creator-works":{},"banter":null}}"#,
                "unreadable",
            ),
            (r#"{"mcpServers":[]}"#, "unreadable"),
            ("[", "unreadable"),
        ] {
            std::fs::write(&path, source).unwrap();
            assert_eq!(project_claude(dir.path()), status);
            assert_eq!(std::fs::read(&path).unwrap(), source.as_bytes());
        }
        std::fs::write(
            &path,
            vec![b' '; crate::settings_backup::MAX_BYTES as usize + 1],
        )
        .unwrap();
        assert_eq!(project_claude(dir.path()), "unreadable");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn invalid_user_files_are_not_missing_entries() {
        assert_eq!(toml_entries("[broken"), Err(()));
        assert_eq!(toml_entries("mcp_servers = []"), Err(()));
        assert_eq!(toml_entries("[mcp_servers.other]"), Ok(false));
        assert_eq!(toml_entries("[mcp_servers.banter]"), Ok(true));
        assert_eq!(json_servers("null"), Err(()));
        assert_eq!(json_servers("  "), Err(()));
        assert_eq!(antigravity_servers("  "), Ok(false));
        assert_eq!(antigravity_servers("broken"), Err(()));
        assert_eq!(json_servers(r#"{"projects":{}}"#), Ok(false));
    }

    #[cfg(windows)]
    #[test]
    fn locked_project_config_is_unknown_not_absent_and_rechecks_after_release() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".mcp.json");
        let bytes = br#"{"mcpServers":{"creator-works":{"command":"fixture"}}}"#;
        std::fs::write(&path, bytes).unwrap();
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        assert_eq!(project_claude(dir.path()), "unreadable");
        drop(lock);
        assert_eq!(project_claude(dir.path()), "present");
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
}
