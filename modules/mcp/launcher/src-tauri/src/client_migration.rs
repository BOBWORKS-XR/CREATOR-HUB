//! Explicit single-client connection conversion; not the product installer transaction.
use crate::{client_ownership, jsonc, settings_backup};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy)]
pub(crate) enum Format {
    Codex,
    Json,
    OpenCode,
}

pub(crate) struct Plan {
    pub client: String,
    path: PathBuf,
    before: String,
    after: String,
    pub old_node: String,
    pub old_server: String,
    pub project: Option<String>,
}

fn target(path: &Path) -> Result<String, String> {
    if !path.is_absolute() || !path.is_file() {
        return Err("The retained Hub runtime is unavailable. No client was changed.".into());
    }
    settings_backup::reject_links(path)?;
    path.to_str()
        .map(str::to_owned)
        .ok_or("Runtime paths must be UTF-8.".into())
}

fn reviewable(value: &str) -> Result<(), String> {
    if value.len() > 4096 || value.chars().any(char::is_control) {
        return Err(
            "Client values cannot be shown safely in the review. Nothing was changed.".into(),
        );
    }
    Ok(())
}

fn safe_environment<'a>(keys: impl Iterator<Item = &'a str>) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for key in keys {
        let normalized = key.to_ascii_uppercase();
        if !seen.insert(normalized.clone())
            || ["NODE_OPTIONS", "NODE_PATH"].contains(&normalized.as_str())
            || normalized == client_ownership::OWNER_KEY && key != client_ownership::OWNER_KEY
        {
            return Err("Node overrides or ambiguous environment keys require manual review. Nothing was changed.".into());
        }
    }
    Ok(())
}

fn legacy_shape(node: &str, server: &str) -> Result<(), String> {
    reviewable(node)?;
    reviewable(server)?;
    for path in [Path::new(node), Path::new(server)] {
        if !path.is_absolute() {
            return Err(
                "Custom or relative client commands require manual review. Nothing was changed."
                    .into(),
            );
        }
        settings_backup::reject_links(path)?;
    }
    let node_name = Path::new(node).file_name().and_then(|s| s.to_str());
    let server_name = Path::new(server).file_name().and_then(|s| s.to_str());
    if !matches!(node_name, Some("node" | "node.exe"))
        || !matches!(
            server_name,
            Some("creator-works-mcp.mjs" | "banter-mcp.mjs")
        )
    {
        return Err("Custom client commands require manual review. Nothing was changed.".into());
    }
    Ok(())
}

impl Plan {
    pub(crate) fn review(
        client: &str,
        path: &Path,
        format: Format,
        node: &Path,
        server: &Path,
    ) -> Result<Option<Self>, String> {
        if !path.is_absolute() {
            return Err("Client settings require an absolute path.".into());
        }
        let Some(before) = settings_backup::read_text(path)? else {
            return Ok(None);
        };
        let node = target(node)?;
        let server = target(server)?;
        let (after, old_node, old_server, project) = match format {
            Format::Codex => {
                let mut doc = before
                    .parse::<toml_edit::Document>()
                    .map_err(|_| "Invalid Codex TOML. Nothing was changed.")?;
                let Some(servers) = doc.get_mut("mcp_servers") else {
                    return Ok(None);
                };
                let servers = servers
                    .as_table_like_mut()
                    .ok_or("Client MCP servers must be an object.")?;
                let ids: Vec<_> = [crate::MCP_CLIENT_ID, crate::LEGACY_MCP_CLIENT_ID]
                    .into_iter()
                    .filter(|id| servers.contains_key(id))
                    .collect();
                if ids.is_empty() {
                    return Ok(None);
                }
                if ids.len() != 1 {
                    return Err(
                        "Two Creator/Banter entries require manual review. Neither was changed."
                            .into(),
                    );
                }
                let entry = servers
                    .get_mut(ids[0])
                    .unwrap()
                    .as_table_like_mut()
                    .ok_or("Client entry must be a table.")?;
                let owner = entry
                    .get("env")
                    .and_then(toml_edit::Item::as_table_like)
                    .and_then(|env| env.get(client_ownership::OWNER_KEY));
                if owner.and_then(toml_edit::Item::as_str) == Some(client_ownership::OWNER) {
                    return Ok(None);
                }
                if owner.is_some() {
                    return Err("A different owner is recorded. Nothing was changed.".into());
                }
                let old_node = entry
                    .get("command")
                    .and_then(toml_edit::Item::as_str)
                    .ok_or("Custom client command requires manual review.")?
                    .to_owned();
                let args = entry
                    .get("args")
                    .and_then(toml_edit::Item::as_array)
                    .filter(|args| args.len() == 1)
                    .ok_or("Custom client arguments require manual review.")?;
                let old_server = args
                    .get(0)
                    .and_then(toml_edit::Value::as_str)
                    .ok_or("Custom client arguments require manual review.")?
                    .to_owned();
                legacy_shape(&old_node, &old_server)?;
                entry.insert("command", toml_edit::value(node));
                let mut args = toml_edit::Array::new();
                args.push(server);
                entry.insert("args", toml_edit::value(args));
                if entry.get("env").is_none() {
                    entry.insert("env", toml_edit::Item::Table(toml_edit::Table::new()));
                }
                let env = entry
                    .get_mut("env")
                    .unwrap()
                    .as_table_like_mut()
                    .ok_or("Client environment must be an object.")?;
                safe_environment(env.iter().map(|(key, _)| key))?;
                let project = env
                    .get("UNITY_PROJECT_PATH")
                    .and_then(toml_edit::Item::as_str)
                    .map(str::to_owned);
                env.insert(
                    client_ownership::OWNER_KEY,
                    toml_edit::value(client_ownership::OWNER),
                );
                (doc.to_string(), old_node, old_server, project)
            }
            Format::Json | Format::OpenCode => {
                if matches!(format, Format::Json) {
                    serde_json::from_str::<Value>(&before)
                        .map_err(|_| "Invalid client JSON. Nothing was changed.")?;
                }
                let mut config = jsonc::parse_unambiguous(&before)?;
                let key = if matches!(format, Format::OpenCode) {
                    "mcp"
                } else {
                    "mcpServers"
                };
                let env_key = if matches!(format, Format::OpenCode) {
                    "environment"
                } else {
                    "env"
                };
                if !config.is_object() {
                    return Err("Client settings must be an object.".into());
                }
                let Some(servers) = config.get_mut(key) else {
                    return Ok(None);
                };
                let servers = servers
                    .as_object_mut()
                    .ok_or("Client MCP servers must be an object.")?;
                let ids: Vec<_> = [crate::MCP_CLIENT_ID, crate::LEGACY_MCP_CLIENT_ID]
                    .into_iter()
                    .filter(|id| servers.contains_key(*id))
                    .collect();
                if ids.is_empty() {
                    return Ok(None);
                }
                if ids.len() != 1 {
                    return Err(
                        "Two Creator/Banter entries require manual review. Neither was changed."
                            .into(),
                    );
                }
                let id = ids[0];
                let entry = servers.get_mut(id).unwrap();
                if !entry.is_object() {
                    return Err("Client entry must be an object.".into());
                }
                let owner = entry
                    .get(env_key)
                    .and_then(|env| env.get(client_ownership::OWNER_KEY));
                if owner == Some(&Value::String(client_ownership::OWNER.into())) {
                    return Ok(None);
                }
                if owner.is_some() {
                    return Err("A different owner is recorded. Nothing was changed.".into());
                }
                let (old_node, old_server) = if matches!(format, Format::OpenCode) {
                    if entry["type"] != "local" {
                        return Err("Non-local OpenCode entries require manual review.".into());
                    }
                    let command = entry["command"]
                        .as_array()
                        .filter(|a| a.len() == 2)
                        .ok_or("Custom client arguments require manual review.")?;
                    (command[0].as_str(), command[1].as_str())
                } else {
                    let args = entry["args"]
                        .as_array()
                        .filter(|a| a.len() == 1)
                        .ok_or("Custom client arguments require manual review.")?;
                    (entry["command"].as_str(), args[0].as_str())
                };
                let (old_node, old_server) = (
                    old_node
                        .ok_or("Custom client command requires manual review.")?
                        .to_owned(),
                    old_server
                        .ok_or("Custom client arguments require manual review.")?
                        .to_owned(),
                );
                legacy_shape(&old_node, &old_server)?;
                if matches!(format, Format::OpenCode) {
                    entry["command"] = serde_json::json!([node, server]);
                } else {
                    entry["command"] = Value::String(node);
                    entry["args"] = serde_json::json!([server]);
                }
                if entry.get(env_key).is_none() {
                    entry[env_key] = serde_json::json!({});
                }
                let env = entry[env_key]
                    .as_object_mut()
                    .ok_or("Client environment must be an object.")?;
                safe_environment(env.keys().map(String::as_str))?;
                let project = env
                    .get("UNITY_PROJECT_PATH")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                env.insert(
                    client_ownership::OWNER_KEY.into(),
                    Value::String(client_ownership::OWNER.into()),
                );
                let entry = entry.clone();
                let other_id = if id == crate::MCP_CLIENT_ID {
                    crate::LEGACY_MCP_CLIENT_ID
                } else {
                    crate::MCP_CLIENT_ID
                };
                let after = jsonc::update_managed_entry(&before, key, id, other_id, &entry)?;
                if jsonc::parse_unambiguous(&after)? != config {
                    return Err("Client edit could not be verified. Nothing was changed.".into());
                }
                (after, old_node, old_server, project)
            }
        };
        if let Some(project) = &project {
            reviewable(project)?;
        }
        Ok(Some(Self {
            client: client.into(),
            path: path.into(),
            before,
            after,
            old_node,
            old_server,
            project,
        }))
    }

    pub(crate) fn apply(
        self,
        approve: impl FnOnce(&Self) -> bool,
    ) -> Result<Option<PathBuf>, String> {
        if !approve(&self) {
            return Ok(None);
        }
        if settings_backup::read_text(&self.path)?.as_deref() != Some(&self.before) {
            return Err(
                "Client settings changed after review. Nothing was changed; review again.".into(),
            );
        }
        settings_backup::retain(&self.path)?;
        if settings_backup::read_text(&self.path)?.as_deref() != Some(&self.before) {
            return Err(
                "Client settings changed during backup. Nothing was changed; review again.".into(),
            );
        }
        let backup = self
            .path
            .parent()
            .unwrap()
            .join(".creator-hub-settings-backups")
            .join(format!(
                "{}.{:x}.bak",
                self.path.file_name().unwrap().to_string_lossy(),
                Sha256::digest(self.before.as_bytes())
            ));
        if settings_backup::read_text(&backup)?.as_deref() != Some(&self.before) {
            return Err("The retained backup could not be verified. Nothing was changed.".into());
        }
        crate::atomic_write(&self.path, &self.after)?;
        if settings_backup::read_text(&self.path)?.as_deref() != Some(&self.after) {
            return Err("Migration outcome could not be verified. Keep the backup and inspect the client settings; no retry was attempted.".into());
        }
        Ok(Some(backup))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Fixture {
        _directory: tempfile::TempDir,
        root: PathBuf,
        node: PathBuf,
        server: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().canonicalize().unwrap();
            let node = root.join(if cfg!(windows) { "node.exe" } else { "node" });
            let server = root.join("creator-works-mcp.mjs");
            fs::write(&node, b"fixture, never executed").unwrap();
            fs::write(&server, b"fixture, never executed").unwrap();
            Self {
                _directory: directory,
                root,
                node,
                server,
            }
        }
        fn old_entry(&self) -> Value {
            serde_json::json!({"command":self.root.join("legacy").join(if cfg!(windows) { "node.exe" } else { "node" }),
                "args":[self.root.join("legacy/banter-mcp.mjs")], "timeout":37,
                "env":{"UNITY_PROJECT_PATH":"preserve the user's project", "CUSTOM":"keep", "CREATOR_WORKS_TOOL_GROUPS":"read"}})
        }
        fn review(&self, format: Format, content: &str) -> (PathBuf, Option<Plan>) {
            let path = self.root.join("client-config");
            fs::write(&path, content).unwrap();
            let plan =
                Plan::review("Fixture client", &path, format, &self.node, &self.server).unwrap();
            (path, plan)
        }
    }

    #[test]
    fn fresh_profiles_and_owned_entries_are_noop_without_backups_or_consent() {
        let f = Fixture::new();
        let path = f.root.join("missing.json");
        assert!(
            Plan::review("Fixture", &path, Format::Json, &f.node, &f.server)
                .unwrap()
                .is_none()
        );
        assert!(!path.exists());
        for format in [Format::Json, Format::OpenCode, Format::Codex] {
            let (path, plan) = f.review(
                format,
                if matches!(format, Format::Codex) {
                    "model='keep'\n"
                } else {
                    "{}\n"
                },
            );
            assert!(plan.is_none());
            assert!(path.exists());
            assert!(!f.root.join(".creator-hub-settings-backups").exists());
        }
        let mut entry = f.old_entry();
        entry["env"][client_ownership::OWNER_KEY] = Value::String(client_ownership::OWNER.into());
        let (_, plan) = f.review(
            Format::Json,
            &serde_json::json!({"mcpServers":{"creator-works":entry}}).to_string(),
        );
        assert!(plan.is_none());
    }

    #[test]
    fn cancel_and_stale_approval_never_overwrite_client_settings() {
        let f = Fixture::new();
        let original =
            serde_json::json!({"mcpServers":{"creator-works":f.old_entry()}}).to_string();
        let (path, plan) = f.review(Format::Json, &original);
        assert!(plan.unwrap().apply(|_| false).unwrap().is_none());
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        assert!(!f.root.join(".creator-hub-settings-backups").exists());
        let (_, plan) = f.review(Format::Json, &original);
        let error = plan
            .unwrap()
            .apply(|_| {
                fs::write(&path, b"user edited while reviewing").unwrap();
                true
            })
            .unwrap_err();
        assert!(error.contains("changed after review"));
        assert_eq!(fs::read(&path).unwrap(), b"user edited while reviewing");
    }

    #[test]
    fn approved_json_connection_keeps_project_other_servers_and_exact_before_image() {
        let f = Fixture::new();
        let entry = f.old_entry();
        let original = format!("{{\r\n  \"preferences\":{{\"keep\":true}},\r\n  \"mcpServers\":{{\"other\":{{\"command\":\"keep\"}},\"creator-works\":{entry}}}\r\n}}\r\n");
        let (path, plan) = f.review(Format::Json, &original);
        let backup = plan
            .unwrap()
            .apply(|p| {
                assert_eq!(p.project.as_deref(), Some("preserve the user's project"));
                true
            })
            .unwrap()
            .unwrap();
        assert_eq!(fs::read(&backup).unwrap(), original.as_bytes());
        let after: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(after["preferences"]["keep"], true);
        assert_eq!(after["mcpServers"]["other"]["command"], "keep");
        let migrated = &after["mcpServers"]["creator-works"];
        assert_eq!(migrated["command"], f.node.to_str().unwrap());
        assert_eq!(
            migrated["env"]["UNITY_PROJECT_PATH"],
            entry["env"]["UNITY_PROJECT_PATH"]
        );
        assert_eq!(migrated["env"]["CUSTOM"], "keep");
        assert_eq!(migrated["timeout"], 37);
        assert!(client_ownership::guard_json(&after, None, false).unwrap());
        assert!(
            Plan::review("Fixture", &path, Format::Json, &f.node, &f.server)
                .unwrap()
                .is_none()
        );
        assert_eq!(fs::read(&backup).unwrap(), original.as_bytes());
    }

    #[test]
    fn toml_quoted_dotted_and_inline_forms_keep_custom_fields_and_other_servers() {
        let f = Fixture::new();
        let node = f
            .root
            .join("old")
            .join(if cfg!(windows) { "node.exe" } else { "node" })
            .to_string_lossy()
            .into_owned();
        let server = f
            .root
            .join("old/creator-works-mcp.mjs")
            .to_string_lossy()
            .into_owned();
        for entry in [
            format!("[mcp_servers.'creator-works']\ncommand='{node}'\nargs=['{server}']\ntimeout=37\n[mcp_servers.'creator-works'.env]\nUNITY_PROJECT_PATH='keep'\n"),
            format!("mcp_servers = {{ creator-works = {{ command='{node}', args=['{server}'], timeout=37, env={{UNITY_PROJECT_PATH='keep'}} }}, other={{command='preserve'}} }}\n"),
            format!("mcp_servers.'creator-works'.command='{node}'\nmcp_servers.'creator-works'.args=['{server}']\nmcp_servers.'creator-works'.timeout=37\nmcp_servers.'creator-works'.env.UNITY_PROJECT_PATH='keep'\n"),
        ] {
            let original = format!("# exact unrelated comment\nmodel='keep'\n{entry}");
            let (path, plan) = f.review(Format::Codex, &original);
            let backup = plan.unwrap().apply(|_| true).unwrap().unwrap();
            assert_eq!(fs::read(&backup).unwrap(), original.as_bytes());
            let after = fs::read_to_string(&path).unwrap();
            assert!(after.starts_with("# exact unrelated comment\nmodel='keep'\n"));
            let doc = after.parse::<toml_edit::Document>().unwrap();
            assert_eq!(doc["mcp_servers"]["creator-works"]["timeout"].as_integer(), Some(37));
            assert_eq!(doc["mcp_servers"]["creator-works"]["env"]["UNITY_PROJECT_PATH"].as_str(), Some("keep"));
            assert!(client_ownership::guard_toml(&after, None).unwrap());
        }
    }

    #[test]
    fn opencode_comments_and_existing_environment_survive_migration() {
        let f = Fixture::new();
        let old = f.old_entry();
        let entry = serde_json::json!({"type":"local", "command":[old["command"],old["args"][0]],"environment":old["env"],"enabled":false});
        let original = format!("{{\n // keep this comment\n \"mcp\":{{\"banter\":{entry},\"other\":{{\"type\":\"remote\",\"url\":\"https://example.invalid\"}},}},\n}}\n");
        let (path, plan) = f.review(Format::OpenCode, &original);
        plan.unwrap().apply(|_| true).unwrap();
        let after = fs::read_to_string(path).unwrap();
        assert!(after.contains("// keep this comment"));
        let config = jsonc::parse(&after).unwrap();
        assert_eq!(config["mcp"]["banter"]["enabled"], false);
        assert_eq!(
            config["mcp"]["banter"]["environment"]["UNITY_PROJECT_PATH"],
            old["env"]["UNITY_PROJECT_PATH"]
        );
        assert!(client_ownership::guard_json(&config, None, true).unwrap());
    }

    #[test]
    fn ambiguous_foreign_custom_or_injected_entries_are_refused_unchanged() {
        let f = Fixture::new();
        let original = f.old_entry();
        let mut cases = vec![
            serde_json::json!({"mcpServers":{"creator-works":original,"banter":original}})
                .to_string(),
            "{\"mcpServers\":[],\"mcpServers\":{}}".into(),
            "{\"mcpServers\":[]}".into(),
            "[]".into(),
            "invalid JSON".into(),
        ];
        for changed in [
            serde_json::json!({"command":"custom","args":["custom"]}),
            serde_json::json!({"command":original["command"],"args":[original["args"][0],"extra"]}),
        ] {
            cases.push(serde_json::json!({"mcpServers":{"creator-works":changed}}).to_string());
        }
        for (key, value) in [
            (client_ownership::OWNER_KEY, serde_json::json!(17)),
            ("NODE_OPTIONS", serde_json::json!("--require custom")),
            ("NODE_PATH", serde_json::json!("custom")),
        ] {
            let mut entry = original.clone();
            entry["env"][key] = value;
            cases.push(serde_json::json!({"mcpServers":{"creator-works":entry}}).to_string());
        }
        for content in cases {
            let path = f.root.join("refuse.json");
            fs::write(&path, &content).unwrap();
            assert!(
                Plan::review("Fixture", &path, Format::Json, &f.node, &f.server).is_err(),
                "{content}"
            );
            assert_eq!(fs::read_to_string(path).unwrap(), content);
            assert!(!f.root.join(".creator-hub-settings-backups").exists());
        }
    }

    #[test]
    fn a_changed_backup_blocks_publication_and_is_not_overwritten() {
        let f = Fixture::new();
        let original =
            serde_json::json!({"mcpServers":{"creator-works":f.old_entry()}}).to_string();
        let (path, plan) = f.review(Format::Json, &original);
        settings_backup::retain(&path).unwrap();
        let backup = fs::read_dir(f.root.join(".creator-hub-settings-backups"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        fs::write(&backup, b"preserve changed backup").unwrap();
        assert!(plan.unwrap().apply(|_| true).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), original);
        assert_eq!(fs::read(backup).unwrap(), b"preserve changed backup");
    }

    #[test]
    fn environment_casing_and_unsafe_review_text_require_manual_review() {
        for key in ["node_options", "Node_Path", "creator_works_config_owner"] {
            assert!(safe_environment([key].into_iter()).is_err());
        }
        assert!(safe_environment(["PATH", "Path"].into_iter()).is_err());
        assert!(reviewable("project\nmisleading review text").is_err());
        assert!(reviewable(&"x".repeat(4097)).is_err());
        assert!(reviewable("a normal project path").is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn a_locked_client_file_preserves_its_original_bytes_and_backup() {
        use std::os::windows::fs::OpenOptionsExt;
        let f = Fixture::new();
        let original =
            serde_json::json!({"mcpServers":{"creator-works":f.old_entry()}}).to_string();
        let (path, plan) = f.review(Format::Json, &original);
        let _held = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        assert!(plan.unwrap().apply(|_| true).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        let backups = f.root.join(".creator-hub-settings-backups");
        let backup = fs::read_dir(backups)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(fs::read_to_string(backup).unwrap(), original);
    }
}
