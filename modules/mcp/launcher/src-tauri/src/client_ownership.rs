//! A server ID is not ownership. Unknown legacy entries need reviewed migration.
use serde_json::Value;

pub(crate) const OWNER_KEY: &str = "CREATOR_WORKS_CONFIG_OWNER";
pub(crate) const OWNER: &str = "creator-hub-v1";

fn conflict(id: &str) -> String {
    format!("The {id} MCP entry belongs to a different or unverified setup. It was kept. Review that entry in your AI client's MCP settings before retrying; do not delete unrelated servers.")
}

fn same_path(left: &str, right: &str) -> bool {
    if cfg!(windows) {
        left.replace('\\', "/")
            .eq_ignore_ascii_case(&right.replace('\\', "/"))
    } else {
        left == right
    }
}

fn json_command(entry: &Value, opencode: bool) -> Option<(&str, &str)> {
    if opencode {
        let command = entry["command"].as_array()?;
        if command.len() != 2 {
            return None;
        }
        Some((command[0].as_str()?, command[1].as_str()?))
    } else {
        let args = entry["args"].as_array()?;
        if args.len() != 1 {
            return None;
        }
        Some((entry["command"].as_str()?, args[0].as_str()?))
    }
}

pub(crate) fn guard_json(
    config: &Value,
    expected: Option<&Value>,
    opencode: bool,
) -> Result<bool, String> {
    let key = if opencode { "mcp" } else { "mcpServers" };
    let env = if opencode { "environment" } else { "env" };
    if !config.is_object() || config.get(key).is_some_and(|servers| !servers.is_object()) {
        return Err("Client settings and MCP servers must be objects. Nothing was changed.".into());
    }
    let mut present = false;
    for id in [crate::MCP_CLIENT_ID, crate::LEGACY_MCP_CLIENT_ID] {
        let Some(existing) = config[key].get(id) else {
            continue;
        };
        present = true;
        let command = json_command(existing, opencode);
        let owned = existing[env][OWNER_KEY] == OWNER
            && command.is_some_and(|(node, server)| !node.is_empty() && !server.is_empty());
        let same = command
            .zip(expected.and_then(|entry| json_command(entry, opencode)))
            .is_some_and(|((node, server), (wanted_node, wanted_server))| {
                same_path(node, wanted_node) && same_path(server, wanted_server)
            });
        if !owned && !same {
            return Err(conflict(id));
        }
    }
    Ok(present)
}

pub(crate) fn guard_toml(content: &str, expected: Option<(&str, &str)>) -> Result<bool, String> {
    let document = content
        .parse::<toml_edit::Document>()
        .map_err(|_| "Invalid client TOML. Nothing was changed.")?;
    let Some(servers) = document.get("mcp_servers") else {
        return Ok(false);
    };
    let servers = servers
        .as_table_like()
        .ok_or("Client MCP servers must be a TOML table.")?;
    let mut present = false;
    for id in [crate::MCP_CLIENT_ID, crate::LEGACY_MCP_CLIENT_ID] {
        let Some(existing) = servers.get(id) else {
            continue;
        };
        present = true;
        let table = existing.as_table_like().ok_or_else(|| conflict(id))?;
        let node = table.get("command").and_then(toml_edit::Item::as_str);
        let args = table.get("args").and_then(toml_edit::Item::as_array);
        let server = args
            .filter(|args| args.len() == 1)
            .and_then(|args| args.get(0))
            .and_then(toml_edit::Value::as_str);
        let owner = table
            .get("env")
            .and_then(toml_edit::Item::as_table_like)
            .and_then(|env| env.get(OWNER_KEY))
            .and_then(toml_edit::Item::as_str);
        let owned = owner == Some(OWNER)
            && node.is_some_and(|s| !s.is_empty())
            && server.is_some_and(|s| !s.is_empty());
        let same = node.zip(server).zip(expected).is_some_and(
            |((node, server), (wanted_node, wanted_server))| {
                same_path(node, wanted_node) && same_path(server, wanted_server)
            },
        );
        if !owned && !same {
            return Err(conflict(id));
        }
    }
    Ok(present)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_owned_or_exact_verified_targets_can_be_replaced_and_removal_requires_ownership() {
        let expected = json!({"command":"/verified/node", "args":["/verified/server.mjs"]});
        for id in [crate::MCP_CLIENT_ID, crate::LEGACY_MCP_CLIENT_ID] {
            let mut config = json!({"mcpServers": {id: {"command":"custom", "args":["custom"]}}});
            assert!(guard_json(&config, Some(&expected), false).is_err());
            assert!(guard_json(&config, None, false).is_err());
            config["mcpServers"][id] = expected.clone();
            assert_eq!(guard_json(&config, Some(&expected), false), Ok(true));
            assert!(guard_json(&config, None, false).is_err());
            config["mcpServers"][id]["env"][OWNER_KEY] = json!(OWNER);
            assert_eq!(guard_json(&config, None, false), Ok(true));
            let config =
                json!({"mcp":{id:{"command":["custom","custom"],"environment":{OWNER_KEY:OWNER}}}});
            assert_eq!(guard_json(&config, None, true), Ok(true));
            let malformed = json!({"mcpServers":{id:{"env":{OWNER_KEY:OWNER}}}});
            assert!(guard_json(&malformed, None, false).is_err());
        }
        assert_eq!(
            guard_json(&json!({"mcpServers":{"other":{}}}), None, false),
            Ok(false)
        );
    }

    #[test]
    fn toml_guard_handles_quoted_dotted_and_inline_entries_without_serializing_them() {
        for input in [
            "[mcp_servers.'creator-works']\ncommand='custom'\nargs=['custom']\n",
            "mcp_servers = { creator-works = { command = 'custom', args = ['custom'] } }\n",
            "mcp_servers.'creator-works'.command='custom'\nmcp_servers.'creator-works'.args=['custom']\n",
        ] {
            assert!(guard_toml(input, Some(("/verified/node", "/verified/server.mjs"))).is_err());
            assert!(guard_toml(input, None).is_err());
            let matching = input.replace("'custom'", "'/verified/node'").replace("args=['/verified/node']", "args=['/verified/server.mjs']").replace("args = ['/verified/node']", "args = ['/verified/server.mjs']");
            assert_eq!(guard_toml(&matching, Some(("/verified/node", "/verified/server.mjs"))), Ok(true));
            assert!(guard_toml(&matching, None).is_err());
        }
        let owned = format!("[mcp_servers.banter]\ncommand='old-node'\nargs=['old-server']\n[mcp_servers.banter.env]\n{OWNER_KEY}='{OWNER}'\n");
        assert_eq!(guard_toml(&owned, None), Ok(true));
    }

    #[test]
    fn mixed_ownership_and_malformed_containers_refuse_the_entire_edit() {
        let expected = json!({"command":"/verified/node", "args":["/verified/server.mjs"]});
        let config = json!({"mcpServers":{
            "creator-works":{"command":"old", "args":["old-server"], "env":{OWNER_KEY:OWNER}},
            "banter":{"command":"custom", "args":["custom"]}
        }});
        let before = config.clone();
        assert!(guard_json(&config, Some(&expected), false).is_err());
        assert!(guard_json(&config, None, false).is_err());
        assert_eq!(config, before);
        let toml = format!("[mcp_servers.creator-works]\ncommand='old'\nargs=['old-server']\n[mcp_servers.creator-works.env]\n{OWNER_KEY}='{OWNER}'\n[mcp_servers.banter]\ncommand='custom'\nargs=['custom']\n");
        assert!(guard_toml(&toml, Some(("/verified/node", "/verified/server.mjs"))).is_err());
        assert!(guard_toml(&toml, None).is_err());
        for invalid in [json!(null), json!([]), json!({"mcpServers":[]})] {
            assert!(guard_json(&invalid, None, false).is_err());
        }
        for invalid in [json!(null), json!([]), json!({"mcp":[]})] {
            assert!(guard_json(&invalid, None, true).is_err());
        }
        assert!(guard_toml("mcp_servers=[]", None).is_err());
    }
}
