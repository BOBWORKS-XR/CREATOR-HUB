//! Claude Desktop is a separate client from Claude Code. Never touch its account data.
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

pub(crate) fn path() -> Result<PathBuf, String> {
    if !cfg!(any(windows, target_os = "macos")) {
        return Err(
            "Claude Desktop local setup is available on Windows and macOS, not Linux.".into(),
        );
    }
    dirs::config_dir()
        .map(|root| root.join("Claude/claude_desktop_config.json"))
        .ok_or("Claude Desktop settings folder is unavailable.".into())
}

pub(crate) fn read(path: &Path) -> Result<(Option<Vec<u8>>, Value), String> {
    crate::settings_backup::reject_links(path)?;
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((None, json!({}))),
        Err(_) => return Err("Cannot read client settings. Nothing was changed.".into()),
    };
    let mut bytes = Vec::new();
    file.by_ref()
        .take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read client settings.")?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("Client settings exceed 2 MiB. Nothing was changed.".into());
    }
    let config: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Client settings contain invalid JSON. Fix the file before retrying; it was not overwritten.")?;
    if !config.is_object()
        || config
            .get("mcpServers")
            .is_some_and(|servers| !servers.is_object())
    {
        return Err(
            "Client settings and mcpServers must be JSON objects. Nothing was changed.".into(),
        );
    }
    Ok((Some(bytes), config))
}

pub(crate) fn merge(mut config: Value, entry: Value) -> Result<Value, String> {
    if !config.is_object()
        || config
            .get("mcpServers")
            .is_some_and(|servers| !servers.is_object())
    {
        return Err("Claude Desktop settings and mcpServers must be JSON objects.".into());
    }
    if config.get("mcpServers").is_none() {
        config["mcpServers"] = json!({});
    }
    if let Some(existing) = config["mcpServers"].get(crate::MCP_CLIENT_ID) {
        if !owned(existing)
            && !(existing["command"] == entry["command"] && existing["args"] == entry["args"])
        {
            return Err("Claude Desktop already has a different creator-works entry. It was kept; review it in Desktop Settings > Developer > Edit Config.".into());
        }
    }
    // A former entry may still be in use; do not silently add a second server.
    if config["mcpServers"]
        .get(crate::LEGACY_MCP_CLIENT_ID)
        .is_some()
    {
        return Err("Claude Desktop has a legacy banter entry. Review it before adding Creator Works to avoid duplicate connections.".into());
    }
    config["mcpServers"][crate::MCP_CLIENT_ID] = entry;
    Ok(config)
}

pub(crate) fn owned(entry: &Value) -> bool {
    entry["env"]["CREATOR_WORKS_CONFIG_OWNER"] == "creator-hub-v1"
        && entry["command"].as_str().is_some_and(|s| !s.is_empty())
        && entry["args"]
            .as_array()
            .is_some_and(|a| a.len() == 1 && a[0].is_string())
}

pub(crate) fn write(path: &Path, before: Option<&[u8]>, config: &Value) -> Result<(), String> {
    crate::settings_backup::reject_links(path)?;
    crate::settings_backup::retain(path)?;
    let now = read(path)?.0;
    if now.as_deref() != before {
        return Err("Client settings changed during setup. Check again before retrying.".into());
    }
    let text =
        serde_json::to_string_pretty(config).map_err(|_| "Cannot encode client settings.")?;
    crate::atomic_write(path, &text)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry() -> Value {
        json!({"command":"/private/node", "args":["/private/server.mjs"],"env":{"CREATOR_WORKS_CONFIG_OWNER":"creator-hub-v1"}})
    }
    #[test]
    fn preserves_other_servers_preferences_and_requires_ownership() {
        let original =
            json!({"preferences":{"keep":true},"mcpServers":{"other":{"command":"other"}}});
        let merged = merge(original.clone(), entry()).unwrap();
        assert_eq!(merged["preferences"], original["preferences"]);
        assert_eq!(
            merged["mcpServers"]["other"],
            original["mcpServers"]["other"]
        );
        assert_eq!(merge(merged.clone(), entry()).unwrap(), merged);
        assert!(merge(
            json!({"mcpServers":{"creator-works":{"command":"custom"}}}),
            entry()
        )
        .is_err());
        assert!(merge(json!({"mcpServers":{"banter":{}}}), entry()).is_err());
        for invalid in [json!(null), json!([]), json!({"mcpServers":[]})] {
            assert!(merge(invalid, entry()).is_err());
        }
    }
    #[test]
    fn backs_up_exact_bytes_and_refuses_stale_or_malformed_writes() {
        let root = std::env::temp_dir().join(format!("desktop-settings-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let path = root.join("claude_desktop_config.json");
        fs::write(&path, b"{\"preferences\":{\"keep\":true}}\n").unwrap();
        let (before, config) = read(&path).unwrap();
        let merged = merge(config, entry()).unwrap();
        write(&path, before.as_deref(), &merged).unwrap();
        let backup = fs::read_dir(root.join(".creator-hub-settings-backups"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(fs::read(backup).unwrap(), before.unwrap());
        assert!(write(&path, Some(b"stale"), &merged).is_err());
        fs::write(&path, b"broken JSON").unwrap();
        assert!(read(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"broken JSON");
        fs::remove_dir_all(root).unwrap();
    }
}
