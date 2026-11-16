use serde_json::Value;
use sha2::{Digest, Sha256};

fn inspect(bytes: &[u8], codex: bool, opencode: bool) -> Result<bool, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "Client configuration is not UTF-8.")?;
    if codex {
        let doc = text.parse::<toml_edit::Document>().map_err(|_| "Invalid Codex configuration.")?;
        for id in [crate::MCP_CLIENT_ID, crate::LEGACY_MCP_CLIENT_ID] {
            let Some(entry) = doc.get("mcp_servers").and_then(|v| v.get(id)) else { continue };
            let owner = entry.get("env").and_then(|v| v.get(crate::client_ownership::OWNER_KEY)).and_then(toml_edit::Item::as_str);
            if owner == Some(crate::client_ownership::OWNER) {
                let command = entry.get("command").and_then(toml_edit::Item::as_str).unwrap_or("").replace('\\', "/");
                let pin = entry.get("env").and_then(|v| v.get("CREATOR_WORKS_LAUNCHER_CONFIG"));
                let shared = command.contains("/.creator-hub/mcp-route-v1/windows-x86_64/router-v2/");
                if !shared || pin.is_none() { return Ok(true); }
            }
        }
        Ok(false)
    } else {
        let doc = crate::jsonc::parse(text)?;
        let (servers, env) = if opencode { ("mcp", "environment") } else { ("mcpServers", "env") };
        for id in [crate::MCP_CLIENT_ID, crate::LEGACY_MCP_CLIENT_ID] {
            let Some(entry) = doc.get(servers).and_then(|v| v.get(id)) else { continue };
            if entry[env][crate::client_ownership::OWNER_KEY] != crate::client_ownership::OWNER { continue; }
            let command = if opencode { entry["command"].get(0).and_then(Value::as_str) } else { entry["command"].as_str() };
            let bound = command.map(|s| s.replace('\\', "/")).is_some_and(|s| s.contains("/.creator-hub/mcp-route-v1/windows-x86_64/router-v2/"));
            if !bound || entry[env].get("CREATOR_WORKS_LAUNCHER_CONFIG").is_none() { return Ok(true); }
        }
        Ok(false)
    }
}

pub fn review_key() -> Result<Option<String>, String> {
    // Unit tests must never inspect the operator's real clients.
    if cfg!(test) { return Ok(None); }
    let mut hash = Sha256::new();
    let mut required = false;
    for id in ["codex", "claude", "claudeDesktop", "antigravity", "opencode"] {
        if id == "claudeDesktop" && cfg!(target_os = "linux") { continue; }
        let (_, path, _) = crate::client_target(id)?;
        let Some(bytes) = crate::settings_backup::read_bytes(&path)? else { continue };
        if inspect(&bytes, id == "codex", id == "opencode")? {
            required = true;
            hash.update(id.as_bytes());
            hash.update(Sha256::digest(&bytes));
        }
    }
    Ok(required.then(|| format!("{:x}", hash.finalize())))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_owned_router_and_missing_pin_need_review_but_ready_or_unowned_entries_do_not() {
        for (command, pin, owner, expected) in [("C:/router-v1/tool.exe", true, "creator-hub-v1", true),
            ("C:/router-v2/tool.exe", false, "creator-hub-v1", true),
            ("C:/.creator-hub/mcp-route-v1/windows-x86_64/router-v2/tool.exe", true, "creator-hub-v1", false),
            ("C:/custom.exe", false, "someone-else", false)] {
            let mut env = serde_json::json!({crate::client_ownership::OWNER_KEY:owner});
            if pin { env["CREATOR_WORKS_LAUNCHER_CONFIG"] = "preserve-custom-path".into(); }
            let doc = serde_json::json!({"mcpServers":{crate::MCP_CLIENT_ID:{"command":command,"env":env}}});
            assert_eq!(inspect(&serde_json::to_vec(&doc).unwrap(), false, false).unwrap(), expected);
        }
        let toml = "[mcp_servers.creator-works]\ncommand='C:/router-v1/tool.exe'\n[mcp_servers.creator-works.env]\nCREATOR_WORKS_CONFIG_OWNER='creator-hub-v1'\n";
        assert!(inspect(toml.as_bytes(), true, false).unwrap());
    }
}
