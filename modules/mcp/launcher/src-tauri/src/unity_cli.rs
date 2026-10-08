//! Optional official Unity MCP server. Never replace Creator Works or relax client permissions.
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

pub(crate) const CONSENT: &str = "unity-cli-experimental-v1";
const ID: &str = "creator-unity-cli";
const OWNER: &str = "creator-hub-unity-cli-v1";
const RELEASE: &str =
    include_str!("../../../../project-setup/src-tauri/src/unity-cli-release.json");

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    available: bool,
    enabled: bool,
    can_enable: bool,
    message: String,
}

fn platform() -> String {
    let os = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    format!("{os}-{arch}")
}

fn verified(path: &Path, binary: &Value) -> bool {
    if crate::settings_backup::reject_links(path).is_err() {
        return false;
    }
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    if !file
        .metadata()
        .is_ok_and(|m| m.is_file() && Some(m.len()) == binary["size"].as_u64())
    {
        return false;
    }
    let mut hash = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let Ok(size) = file.read(&mut buffer) else {
            return false;
        };
        if size == 0 {
            break;
        }
        hash.update(&buffer[..size]);
    }
    binary["sha256"].as_str() == Some(format!("{:x}", hash.finalize()).as_str())
}

pub(crate) fn detected() -> Option<PathBuf> {
    let release: Value = serde_json::from_str(RELEASE).ok()?;
    let binary = &release["binaries"][platform()];
    let name = if cfg!(windows) { "unity.exe" } else { "unity" };
    let mut paths = Vec::new();
    if let Some(local) = dirs::data_local_dir() {
        paths.push(
            local
                .join("CreatorProjectSetup/tools/unity-cli")
                .join(release["version"].as_str()?)
                .join(name),
        );
    }
    if let Some(path) = std::env::var_os("PATH") {
        paths.extend(
            std::env::split_paths(&path)
                .filter(|p| p.is_absolute())
                .take(128)
                .map(|p| p.join(name)),
        );
    }
    paths.into_iter().find(|path| verified(path, binary))
}

fn pipeline(project: &Path) -> bool {
    let version =
        crate::settings_backup::read_text(&project.join("ProjectSettings/ProjectVersion.txt"))
            .ok()
            .flatten()
            .unwrap_or_default();
    if !version
        .lines()
        .any(|line| line.trim().starts_with("m_EditorVersion: 6000."))
    {
        return false;
    }
    crate::settings_backup::read_text(&project.join("Packages/manifest.json"))
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .is_some_and(|value| value["dependencies"]["com.unity.pipeline"].is_string())
}

pub(crate) fn mode() -> Result<Option<bool>, String> {
    let Some(text) = crate::settings_backup::read_text(&crate::get_config_path())? else {
        return Ok(None);
    };
    let config: Value = serde_json::from_str(&text).map_err(|_| "Cannot read CLI preference.")?;
    preference(&config)
}

fn preference(config: &Value) -> Result<Option<bool>, String> {
    let Some(enabled) = config.get("unity_cli_enabled") else {
        return Ok(None);
    };
    let enabled = enabled.as_bool().ok_or("Invalid Unity CLI preference.")?;
    Ok(Some(
        enabled && config["unity_cli_consent_version"] == CONSENT,
    ))
}

pub(crate) fn require_consent(enabled: Option<bool>, receipt: Option<&str>) -> Result<(), String> {
    if enabled == Some(true) && receipt != Some(CONSENT) {
        return Err("Unity CLI remains off. Accept the warning that it is experimental in both Creator Hub and Unity before continuing.".into());
    }
    Ok(())
}

pub(crate) fn status(project: Option<&str>) -> Status {
    let available = detected().is_some();
    let package = project.is_some_and(|p| pipeline(Path::new(p)));
    Status {
        available, enabled: mode().ok().flatten() == Some(true) && available && package, can_enable: available && package,
        message: if !available { "No supported, hash-verified Unity CLI found. Creator Works does not need it." }
            else if !package { "Unity CLI detected. Optional Editor control needs Unity 6 and the Unity Pipeline package in this project." }
            else { "Unity CLI and Pipeline detected. Optional; experimental in both Creator Hub and Unity." }.into(),
    }
}

pub(crate) fn entry(project: &str) -> Result<Value, String> {
    if !pipeline(Path::new(project)) {
        return Err("Optional Unity CLI needs Unity 6 and com.unity.pipeline in the selected project. Use the normal Creator Works connection instead.".into());
    }
    let path = detected()
        .ok_or("No supported verified Unity CLI found. Nothing was executed or installed.")?;
    Ok(
        json!({"command":path, "args":["mcp","--project-path", project],
        "env":{"CREATOR_WORKS_CONFIG_OWNER": OWNER, "UNITY_NO_UPDATE_CHECK":"1"}}),
    )
}

pub(crate) fn optional_entry(project: &str) -> Option<Value> {
    if !pipeline(Path::new(project)) {
        return None;
    }
    entry(project).ok()
}

fn unity_mcp(command: Option<&str>, args: impl Iterator<Item = String>) -> bool {
    command.is_some_and(|command| {
        command.rsplit(['/', '\\']).next().is_some_and(|name| {
            name.eq_ignore_ascii_case("unity") || name.eq_ignore_ascii_case("unity.exe")
        })
    }) && args.into_iter().any(|arg| arg == "mcp")
}

fn json_unity_mcp(server: &Value, opencode: bool) -> bool {
    if opencode {
        let command = server["command"].as_array();
        unity_mcp(
            command.and_then(|a| a.first()).and_then(Value::as_str),
            command
                .into_iter()
                .flatten()
                .skip(1)
                .filter_map(Value::as_str)
                .map(str::to_owned),
        )
    } else {
        unity_mcp(
            server["command"].as_str(),
            server["args"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned),
        )
    }
}

fn owned(entry: &Value, opencode: bool) -> bool {
    entry[if opencode { "environment" } else { "env" }]["CREATOR_WORKS_CONFIG_OWNER"] == OWNER
}

pub(crate) fn merge_json(
    mut config: Value,
    entry: Option<Value>,
    opencode: bool,
) -> Result<Value, String> {
    let key = if opencode { "mcp" } else { "mcpServers" };
    if !config.is_object() || config.get(key).is_some_and(|v| !v.is_object()) {
        return Err("Client MCP settings must be an object. Nothing was changed.".into());
    }
    if let Some(existing) = config[key].get(ID) {
        if !owned(existing, opencode) {
            return Err(
                "A different creator-unity-cli entry already exists. It was not overwritten."
                    .into(),
            );
        }
    }
    if let Some(mut entry) = entry {
        if config[key].as_object().is_some_and(|servers| {
            servers
                .iter()
                .any(|(id, server)| id != ID && json_unity_mcp(server, opencode))
        }) {
            return Err("This client already has a Unity CLI MCP server. Keep using it or review it before adding another.".into());
        }
        if opencode {
            let mut command = vec![entry["command"].clone()];
            command.extend(
                entry["args"]
                    .as_array()
                    .ok_or("Invalid Unity CLI arguments.")?
                    .iter()
                    .cloned(),
            );
            entry = json!({"type":"local", "command":command, "environment":entry["env"], "enabled":true});
        }
        if config.get(key).is_none() {
            config[key] = json!({});
        }
        config[key][ID] = entry;
    } else if let Some(servers) = config[key].as_object_mut() {
        servers.remove(ID);
    }
    Ok(config)
}

pub(crate) fn augment_json(config: Value, project: &str, opencode: bool) -> Result<Value, String> {
    match mode()? {
        None => Ok(config),
        Some(enabled) => merge_json(
            config,
            if enabled {
                optional_entry(project)
            } else {
                None
            },
            opencode,
        ),
    }
}

pub(crate) fn merge_toml(text: &str, entry: Option<Value>) -> Result<String, String> {
    let mut doc = text
        .parse::<toml_edit::Document>()
        .map_err(|_| "Invalid Codex settings; nothing was changed.")?;
    if let Some(servers) = doc.get("mcp_servers") {
        let servers = servers
            .as_table_like()
            .ok_or("Codex mcp_servers must be a table.")?;
        if let Some(old) = servers.get(ID) {
            if old
                .get("env")
                .and_then(|v| v.get("CREATOR_WORKS_CONFIG_OWNER"))
                .and_then(|v| v.as_str())
                != Some(OWNER)
            {
                return Err(
                    "Codex has a different creator-unity-cli entry. It was not overwritten.".into(),
                );
            }
        }
        if entry.is_some()
            && servers.iter().any(|(id, v)| {
                id != ID
                    && unity_mcp(
                        v.get("command").and_then(|v| v.as_str()),
                        v.get("args")
                            .and_then(|v| v.as_array())
                            .into_iter()
                            .flatten()
                            .filter_map(|v| v.as_str())
                            .map(str::to_owned),
                    )
            })
        {
            return Err(
                "Codex already has a Unity CLI MCP server. Review it before adding another.".into(),
            );
        }
    }
    if let Some(entry) = entry {
        let mut table = toml_edit::Table::new();
        table.insert(
            "command",
            toml_edit::value(entry["command"].as_str().ok_or("Invalid CLI command.")?),
        );
        let mut args = toml_edit::Array::new();
        for arg in entry["args"].as_array().ok_or("Invalid CLI arguments.")? {
            args.push(arg.as_str().ok_or("Invalid CLI argument.")?);
        }
        table.insert("args", toml_edit::value(args));
        let mut env = toml_edit::Table::new();
        env.insert("CREATOR_WORKS_CONFIG_OWNER", toml_edit::value(OWNER));
        env.insert("UNITY_NO_UPDATE_CHECK", toml_edit::value("1"));
        table.insert("env", toml_edit::Item::Table(env));
        doc.entry("mcp_servers")
            .or_insert(toml_edit::table())
            .as_table_like_mut()
            .ok_or("Invalid Codex MCP table.")?
            .insert(ID, toml_edit::Item::Table(table));
    } else if let Some(servers) = doc
        .get_mut("mcp_servers")
        .and_then(|v| v.as_table_like_mut())
    {
        servers.remove(ID);
    }
    Ok(doc.to_string())
}

pub(crate) fn augment_toml(text: String, project: &str) -> Result<String, String> {
    match mode()? {
        None => Ok(text),
        Some(enabled) => merge_toml(
            &text,
            if enabled {
                optional_entry(project)
            } else {
                None
            },
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry() -> Value {
        json!({"command":"/verified/unity", "args":["mcp","--project-path","/project"], "env":{"CREATOR_WORKS_CONFIG_OWNER":OWNER}})
    }
    #[test]
    fn optional_json_server_preserves_creator_works_and_removes_only_ours() {
        for opencode in [true, false] {
            let key = if opencode { "mcp" } else { "mcpServers" };
            let original = json!({"preferences":{"keep":true},key:{"creator-works":{"keep":true}}});
            let added = merge_json(original.clone(), Some(entry()), opencode).unwrap();
            assert_eq!(added[key]["creator-works"], original[key]["creator-works"]);
            assert_eq!(merge_json(added, None, opencode).unwrap(), original);
            assert!(merge_json(
                json!({key:{ID:{"command":"custom"}}}),
                Some(entry()),
                opencode
            )
            .is_err());
        }
        assert!(merge_json(
            json!({"mcpServers":{"unity":{"command":"unity","args":["mcp"]}}}),
            Some(entry()),
            false
        )
        .is_err());
    }
    #[test]
    fn optional_codex_server_never_relaxes_permissions() {
        let original =
            "# keep\nsandbox_mode = 'workspace-write'\n[mcp_servers.other]\ncommand = 'other'\n";
        let added = merge_toml(original, Some(entry())).unwrap();
        assert!(added.contains("sandbox_mode = 'workspace-write'"));
        assert!(added.contains("# keep"));
        assert!(added.contains("mcp_servers.other"));
        let parsed: toml_edit::Document = added.parse().unwrap();
        assert_eq!(
            parsed["mcp_servers"][ID]["command"].as_str(),
            Some("/verified/unity")
        );
        assert_eq!(merge_toml(&added, Some(entry())).unwrap(), added);
        let removed = merge_toml(&added, None).unwrap();
        assert!(!removed.contains(ID));
        assert!(merge_toml(
            "[mcp_servers.creator-unity-cli]\ncommand='custom'",
            Some(entry())
        )
        .is_err());
        assert!(merge_toml(
            "[mcp_servers.unity]\ncommand='unity'\nargs=['mcp']",
            Some(entry())
        )
        .is_err());
    }

    #[test]
    fn optional_server_round_trips_inline_quoted_dotted_and_jsonc_settings() {
        for original in [
            "mcp_servers = { other = { command = 'keep' } }\n",
            "[mcp_servers.\"other\"]\ncommand = 'keep' # retained\n",
            "mcp_servers.other.command = 'keep'\n",
        ] {
            let added = merge_toml(original, Some(entry())).unwrap();
            let parsed: toml_edit::Document = added.parse().unwrap();
            assert_eq!(
                parsed["mcp_servers"]["other"]["command"].as_str(),
                Some("keep")
            );
            assert_eq!(
                parsed["mcp_servers"][ID]["command"].as_str(),
                Some("/verified/unity")
            );
            assert_eq!(merge_toml(&added, Some(entry())).unwrap(), added);
            let removed: toml_edit::Document = merge_toml(&added, None).unwrap().parse().unwrap();
            assert!(removed["mcp_servers"].get(ID).is_none());
        }
        let source = "{\n// keep this\n\"mcp\":{\"other\":{\"type\":\"local\",\"command\":[\"other\"]},},\n}\n";
        let base = crate::parse_opencode_config(source).unwrap();
        let merged = merge_json(base, Some(entry()), true).unwrap();
        let updated =
            crate::jsonc::update_managed_entry(source, "mcp", ID, ID, &merged["mcp"][ID]).unwrap();
        assert!(updated.contains("// keep this"));
        assert_eq!(crate::parse_opencode_config(&updated).unwrap(), merged);
        let removed = crate::jsonc::remove_managed_entries(&updated, "mcp", ID, ID).unwrap();
        assert!(removed.contains("// keep this"));
        assert!(crate::parse_opencode_config(&removed).unwrap()["mcp"]
            .get(ID)
            .is_none());
    }
    #[test]
    fn duplicate_checks_ignore_other_servers_but_include_unity_global_flags() {
        assert!(merge_json(
            json!({"mcpServers":{"other":{"command":"other","args":["mcp"]}}}),
            Some(entry()),
            false
        )
        .is_ok());
        assert!(merge_json(
            json!({"mcp":{"other":{"command":["other","mcp"]}}}),
            Some(entry()),
            true
        )
        .is_ok());
        assert!(merge_json(json!({"mcpServers":{"unity":{"command":"C:\\Tools\\UNITY.EXE","args":["--log-level","error","mcp"]}}}), Some(entry()), false).is_err());
        assert!(merge_json(
            json!({"mcp":{"unity":{"command":["/tools/unity","--log-level","error","mcp"]}}}),
            Some(entry()),
            true
        )
        .is_err());
        assert!(merge_toml(
            "[mcp_servers.other]\ncommand='other'\nargs=['mcp']",
            Some(entry())
        )
        .is_ok());
        assert!(merge_toml(
            "[mcp_servers.unity]\ncommand='/tools/unity'\nargs=['--log-level','error','mcp']",
            Some(entry())
        )
        .is_err());
    }
    #[test]
    fn cli_needs_explicit_versioned_agreement_and_missing_requirements_do_not_break_mcp() {
        for receipt in [None, Some("old-warning")] {
            assert!(require_consent(Some(true), receipt).is_err());
            assert!(require_consent(Some(false), receipt).is_ok());
        }
        assert!(require_consent(Some(true), Some(CONSENT)).is_ok());
        assert_eq!(preference(&json!({})).unwrap(), None);
        assert_eq!(
            preference(&json!({"unity_cli_enabled":true})).unwrap(),
            Some(false)
        );
        assert_eq!(
            preference(&json!({"unity_cli_enabled":true,"unity_cli_consent_version":CONSENT}))
                .unwrap(),
            Some(true)
        );
        assert!(optional_entry("/nonexistent-project-fixture").is_none());
    }
    #[test]
    fn discovery_never_trusts_a_name_without_the_pinned_hash() {
        let root = std::env::temp_dir().join(format!("unity-cli-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let path = root.join("unity");
        fs::write(&path, b"fake").unwrap();
        assert!(!verified(&path, &json!({"size":4,"sha256":"not-the-hash"})));
        let expected = format!("{:x}", Sha256::digest(b"fake"));
        assert!(verified(&path, &json!({"size":4,"sha256":expected})));
        fs::remove_dir_all(root).unwrap();
    }
}
