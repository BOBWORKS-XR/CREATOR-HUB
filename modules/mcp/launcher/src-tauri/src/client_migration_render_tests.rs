use super::*;
use std::fs;

struct Fixture {
    _temporary: tempfile::TempDir,
    root: PathBuf,
    router: PathBuf,
}

#[test]
fn legacy_node_migrations_pin_missing_configuration_for_every_format() {
    let f = Fixture::new();
    let source = f.root.join("launcher-config.json");
    fs::write(&source, "{}").unwrap();
    for format in [Format::Codex, Format::Json, Format::OpenCode] {
        let old = f.old();
        let original = match format {
            Format::Codex => format!("[mcp_servers.creator-works]\ncommand={}\nargs=[{}]\n[mcp_servers.creator-works.env]\nCUSTOM='keep'\n",old["command"],old["args"][0]),
            Format::Json => serde_json::json!({"mcpServers":{"creator-works":old}}).to_string(),
            Format::OpenCode => serde_json::json!({"mcp":{"creator-works":{"type":"local","command":[old["command"],old["args"][0]],"environment":{"CUSTOM":"keep"}}}}).to_string(),
        };
        let file = f.root.join("legacy-config");
        fs::write(&file, &original).unwrap();
        let plan = Plan::review_router_with_config("Fixture", &file, format, &f.router, &source).unwrap().unwrap();
        assert!(plan.after.contains(LAUNCHER_CONFIG));
        assert!(plan.after.contains("keep"));
        assert_eq!(fs::read_to_string(file).unwrap(), original);
    }
}

#[test]
fn legacy_pin_regression_json_inserts_owner_and_config_together() {
    for format in [Format::Json, Format::OpenCode] {
        let opencode = matches!(format, Format::OpenCode);
        let key = if opencode { "mcp" } else { "mcpServers" };
        let env_key = if opencode { "environment" } else { "env" };
        let mut environments = vec!["{}", "{\"CUSTOM\": {\"nested\": [1, 2]}}", "{\"CUSTOM\": {\"nested\": [1, 2]}\n}"];
        if opencode {
            environments.extend([
                "{\r\n // environment\r\n \"CUSTOM\": {\"nested\": [1, 2]} // last value\r\n}",
                "{\r\n // environment\r\n \"CUSTOM\": {\"nested\": [1, 2]}, // trailing comma\r\n}",
            ]);
        }
        for id in [crate::MCP_CLIENT_ID, crate::LEGACY_MCP_CLIENT_ID] {
            for environment in &environments {
                let f = Fixture::new();
                let source = f.root.join("launcher-config.json");
                fs::write(&source, "{}").unwrap();
                let old = f.old();
                let command = if opencode {
                    format!("\"type\":\"local\",\"command\":[{},{}]", old["command"], old["args"][0])
                } else {
                    format!("\"command\":{},\"args\":[{}]", old["command"], old["args"][0])
                };
                let original = format!("{{\"{key}\":{{\"{id}\":{{{command},\"{env_key}\":{environment},\"enabled\":false}},\"other\":{{\"command\":\"keep\"}}}},\"preferences\":{{\"keep\":true}}}}");
                let file = f.root.join("client-config");
                fs::write(&file, &original).unwrap();
                let mut expected = jsonc::parse_unambiguous(&original).unwrap();
                expected[key][id]["command"] = if opencode {
                    serde_json::json!([target(&f.router).unwrap()])
                } else {
                    serde_json::json!(target(&f.router).unwrap())
                };
                if !opencode { expected[key][id]["args"] = serde_json::json!([]); }
                expected[key][id][env_key][client_ownership::OWNER_KEY] = client_ownership::OWNER.into();
                expected[key][id][env_key][LAUNCHER_CONFIG] = target(&source).unwrap().into();
                let plan = Plan::review_router_with_config("Fixture", &file, format, &f.router, &source).unwrap().unwrap();
                assert_eq!(jsonc::parse_unambiguous(&plan.after).unwrap(), expected);
                for comment in ["// environment", "// last value", "// trailing comma"] {
                    assert_eq!(plan.after.matches(comment).count(), original.matches(comment).count());
                }
                if environment.contains("CUSTOM") {
                    assert!(plan.after.contains("\"CUSTOM\": {\"nested\": [1, 2]}"));
                }
                assert!(plan.apply(|_| false).unwrap().is_none());
                assert_eq!(fs::read_to_string(&file).unwrap(), original);
                assert!(!f.root.join(".creator-hub-settings-backups").exists());
                let plan = Plan::review_router_with_config("Fixture", &file, format, &f.router, &source).unwrap().unwrap();
                let backup = plan.apply(|_| true).unwrap().unwrap();
                assert_eq!(fs::read_to_string(backup).unwrap(), original);
                assert_eq!(jsonc::parse_unambiguous(&fs::read_to_string(&file).unwrap()).unwrap(), expected);
                assert!(Plan::review_router_with_config("Fixture", &file, format, &f.router, &source).unwrap().is_none());
                assert_eq!(fs::read_to_string(source).unwrap(), "{}");
            }
        }
    }
}

#[test]
fn legacy_pin_regression_codex_without_environment_gets_config_pin() {
    for id in [crate::MCP_CLIENT_ID, crate::LEGACY_MCP_CLIENT_ID] {
            let f = Fixture::new();
            let source = f.root.join("launcher-config.json");
            fs::write(&source, "{}").unwrap();
            let old = f.old();
            let command = &old["command"];
            let server = &old["args"][0];
            let original = format!("# root\n[mcp_servers.'{id}']\ncommand={command} # command\nargs=[{server}] # args\nenabled=false # disabled\n[mcp_servers.other]\ncommand='keep'\n");
            let file = f.root.join("client-config.toml");
            fs::write(&file, &original).unwrap();
            let plan = Plan::review_router_with_config("Fixture", &file, Format::Codex, &f.router, &source).unwrap().unwrap();
            let mut expected = original.parse::<toml_edit::Document>().unwrap();
            expected["mcp_servers"][id]["command"] = toml_edit::value(target(&f.router).unwrap());
            expected["mcp_servers"][id]["args"] = toml_edit::value(toml_edit::Array::new());
            expected["mcp_servers"][id]["env"] = toml_edit::table();
            expected["mcp_servers"][id]["env"][client_ownership::OWNER_KEY] = toml_edit::value(client_ownership::OWNER);
            expected["mcp_servers"][id]["env"][LAUNCHER_CONFIG] = toml_edit::value(target(&source).unwrap());
            let after = plan.after.parse::<toml_edit::Document>().unwrap();
            assert!(same_toml(after.as_item(), expected.as_item()), "missing config pin");
            for comment in ["# root", "# command", "# args", "# disabled"] {
                assert_eq!(plan.after.matches(comment).count(), original.matches(comment).count());
            }
            assert!(plan.apply(|_| false).unwrap().is_none());
            assert_eq!(fs::read_to_string(&file).unwrap(), original);
            assert!(!f.root.join(".creator-hub-settings-backups").exists());
            let plan = Plan::review_router_with_config("Fixture", &file, Format::Codex, &f.router, &source).unwrap().unwrap();
            let backup = plan.apply(|_| true).unwrap().unwrap();
            assert_eq!(fs::read_to_string(backup).unwrap(), original);
            let saved = fs::read_to_string(&file).unwrap().parse::<toml_edit::Document>().unwrap();
            assert!(same_toml(saved.as_item(), expected.as_item()));
            assert!(Plan::review_router_with_config("Fixture", &file, Format::Codex, &f.router, &source).unwrap().is_none());
            assert_eq!(fs::read_to_string(source).unwrap(), "{}");
    }
}

#[test]
fn legacy_pin_regression_planned_view_is_not_written_during_review_or_decline() {
    for format in [Format::Codex, Format::Json, Format::OpenCode] {
        let f = Fixture::new();
        let planned = f.root.join("settings-views/not-created/launcher-config.json");
        let old = f.old();
        let original = match format {
            Format::Codex => format!("[mcp_servers.creator-works]\ncommand={}\nargs=[{}]\n[mcp_servers.creator-works.env]\nCUSTOM='keep'\n", old["command"], old["args"][0]),
            Format::Json => serde_json::json!({"mcpServers":{"creator-works":old}}).to_string(),
            Format::OpenCode => serde_json::json!({"mcp":{"creator-works":{"type":"local","command":[old["command"],old["args"][0]],"environment":{"CUSTOM":"keep"}}}}).to_string(),
        };
        let file = f.root.join("client-config");
        fs::write(&file, &original).unwrap();
        let plan = Plan::review_router_with_config("Fixture", &file, format, &f.router, &planned).unwrap().unwrap();
        let pin = match format {
            Format::Codex => plan.after.parse::<toml_edit::Document>().unwrap()["mcp_servers"]["creator-works"]["env"][LAUNCHER_CONFIG].as_str().unwrap().to_owned(),
            Format::Json => jsonc::parse_unambiguous(&plan.after).unwrap()["mcpServers"]["creator-works"]["env"][LAUNCHER_CONFIG].as_str().unwrap().to_owned(),
            Format::OpenCode => jsonc::parse_unambiguous(&plan.after).unwrap()["mcp"]["creator-works"]["environment"][LAUNCHER_CONFIG].as_str().unwrap().to_owned(),
        };
        assert_eq!(pin, crate::managed_settings_path::physical(&planned).unwrap());
        assert_eq!(fs::read_to_string(&file).unwrap(), original);
        assert!(!f.root.join("settings-views").exists());
        assert!(plan.apply(|_| false).unwrap().is_none());
        assert_eq!(fs::read_to_string(file).unwrap(), original);
        assert!(!f.root.join("settings-views").exists());
        assert!(!f.root.join(".creator-hub-settings-backups").exists());
    }
}

#[test]
fn legacy_pin_regression_preserves_fallback_and_primary_overrides() {
    for format in [Format::Codex, Format::Json, Format::OpenCode] {
        for primary in [None, Some("primary override.json")] {
            let f = Fixture::new();
            let source = f.root.join("launcher-config.json");
            fs::write(&source, "{}").unwrap();
            let mut old = f.old();
            old["env"][client_ownership::OWNER_KEY] = client_ownership::OWNER.into();
            old["env"]["BANTWORKS_LAUNCHER_CONFIG"] = "legacy override.json".into();
            if let Some(primary) = primary { old["env"][LAUNCHER_CONFIG] = primary.into(); }
            let original = match format {
                Format::Codex => format!("[mcp_servers.creator-works]\ncommand={}\nargs=[{}]\n[mcp_servers.creator-works.env]\nCREATOR_WORKS_CONFIG_OWNER='creator-hub-v1'\nBANTWORKS_LAUNCHER_CONFIG='legacy override.json' # keep fallback\nCUSTOM='keep'\n{}",
                    old["command"], old["args"][0], primary.map(|value| format!("CREATOR_WORKS_LAUNCHER_CONFIG='{value}' # keep primary\n")).unwrap_or_default()),
                Format::Json => serde_json::json!({"mcpServers":{"creator-works":old}}).to_string(),
                Format::OpenCode => serde_json::json!({"mcp":{"creator-works":{"type":"local","command":[old["command"],old["args"][0]],"environment":old["env"]}}}).to_string(),
            };
            let file = f.root.join("client-config");
            fs::write(&file, &original).unwrap();
            let plan = Plan::review_router_with_config("Fixture", &file, format, &f.router, &source).unwrap().unwrap();
            let expected = primary.unwrap_or("legacy override.json");
            match format {
                Format::Codex => {
                    let doc = plan.after.parse::<toml_edit::Document>().unwrap();
                    let env = &doc["mcp_servers"]["creator-works"]["env"];
                    assert_eq!(env[LAUNCHER_CONFIG].as_str(), Some(expected));
                    assert_eq!(env["BANTWORKS_LAUNCHER_CONFIG"].as_str(), Some("legacy override.json"));
                    assert!(plan.after.contains("# keep fallback"));
                    if primary.is_some() { assert!(plan.after.contains("# keep primary")); }
                }
                Format::Json | Format::OpenCode => {
                    let doc = jsonc::parse_unambiguous(&plan.after).unwrap();
                    let (key, env_key) = if matches!(format, Format::OpenCode) { ("mcp", "environment") } else { ("mcpServers", "env") };
                    assert_eq!(doc[key]["creator-works"][env_key][LAUNCHER_CONFIG], expected);
                    assert_eq!(doc[key]["creator-works"][env_key]["BANTWORKS_LAUNCHER_CONFIG"], "legacy override.json");
                    assert_eq!(doc[key]["creator-works"][env_key]["CUSTOM"], "keep");
                }
            }
            assert!(plan.apply(|_| false).unwrap().is_none());
            assert_eq!(fs::read_to_string(file).unwrap(), original);
            assert_eq!(fs::read_to_string(source).unwrap(), "{}");
        }
    }
}

impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let router = root.join(if cfg!(windows) {
            "creator-hub-mcp-router.exe"
        } else {
            "creator-hub-mcp-router"
        });
        fs::write(&router, b"not executed").unwrap();
        Self {
            _temporary: temporary,
            root,
            router,
        }
    }
    fn old(&self) -> Value {
        serde_json::json!({"command":self.root.join("legacy").join(if cfg!(windows) { "node.exe" } else { "node" }),
            "args":[self.root.join("legacy/creator-works-mcp.mjs")],
            "env":{"CUSTOM":"keep","UNITY_PROJECT_PATH":"keep project"}})
    }
    fn review(&self, format: Format, text: &str) -> Plan {
        let path = self.root.join("config");
        fs::write(&path, text).unwrap();
        Plan::review_router("Fixture", &path, format, &self.router)
            .unwrap()
            .unwrap()
    }
}

#[cfg(windows)]
struct RetainedRouter {
    command: PathBuf,
    files: Vec<(PathBuf, Vec<u8>)>,
    checks: std::cell::Cell<usize>,
}

#[cfg(windows)]
impl RetainedRouter {
    fn new(f: &Fixture) -> Self {
        let directory = f.root.join("old-store/mcp-route-v1/windows-x86_64/router-v1");
        fs::create_dir_all(&directory).unwrap();
        let command = directory.join("creator-hub-mcp-router.exe");
        let files = vec![
            (command.clone(), b"router-a".to_vec()),
            (
                directory.join("router.json"),
                include_bytes!("../../../../../native/mcp-router/tests/bootstrap-fixtures/windows-x86_64-a.json").to_vec(),
            ),
            (
                directory.join("router.minisig"),
                include_bytes!("../../../../../native/mcp-router/tests/bootstrap-fixtures/windows-x86_64-a.minisig").to_vec(),
            ),
        ];
        for (path, bytes) in &files {
            fs::write(path, bytes).unwrap();
        }
        Self { command, files, checks: std::cell::Cell::new(0) }
    }

    fn verify(&self, command: &Path) -> Result<(), String> {
        self.checks.set(self.checks.get() + 1);
        settings_backup::reject_links(command)?;
        if !command.is_absolute() || command.canonicalize().ok() != Some(self.command.clone()) {
            return Err("Unexpected test router.".into());
        }
        // Pin the existing signed fixture exactly. Native router tests own signature
        // verification; this seam only tests the migration's verification decision.
        for (path, bytes) in &self.files {
            if fs::read(path).map_err(|e| e.to_string())? != *bytes {
                return Err("Signed test router changed.".into());
            }
        }
        use sha2::{Digest, Sha256};
        let descriptor: Value = serde_json::from_slice(&self.files[1].1).unwrap();
        assert_eq!(descriptor["sha256"], format!("{:x}", Sha256::digest(&self.files[0].1)));
        Ok(())
    }

    fn assert_unchanged(&self) {
        for (path, bytes) in &self.files {
            assert_eq!(fs::read(path).unwrap(), *bytes);
        }
    }

    fn json_entry(&self, format: Format) -> Value {
        let environment = serde_json::json!({
            "CREATOR_WORKS_CONFIG_OWNER":client_ownership::OWNER,
            "UNITY_PROJECT_PATH":"keep project", "CUSTOM":"keep"
        });
        if matches!(format, Format::OpenCode) {
            serde_json::json!({"type":"local", "command":[self.command],
                "environment":environment, "enabled":false, "timeout":37})
        } else {
            serde_json::json!({"command":self.command, "args":[], "env":environment,
                "enabled":false, "timeout":37})
        }
    }

    fn review(&self, f: &Fixture, path: &Path, format: Format) -> Result<Option<Plan>, String> {
        Plan::review_target_inner("Fixture", path, format, &f.router, None, None, |command| {
            self.verify(command)
        })
    }
}

#[cfg(windows)]
#[test]
fn verified_owned_router_relocation_preserves_json_options_and_retained_files() {
    let f = Fixture::new();
    let old = RetainedRouter::new(&f);
    for format in [Format::Json, Format::OpenCode] {
        for id in [crate::MCP_CLIENT_ID, crate::LEGACY_MCP_CLIENT_ID] {
            let key = if matches!(format, Format::OpenCode) { "mcp" } else { "mcpServers" };
            let original = serde_json::json!({key:{id:old.json_entry(format),
                "other":{"command":"keep"}}, "preferences":{"keep":true}});
            let text = original.to_string();
            let file = f.root.join("relocate.json");
            fs::write(&file, &text).unwrap();
            let plan = old.review(&f, &file, format).unwrap().unwrap();
            assert_eq!(plan.old_node, old.command.to_str().unwrap());
            assert_eq!(plan.old_server, "");
            assert_eq!(plan.project.as_deref(), Some("keep project"));
            assert_eq!(fs::read_to_string(&file).unwrap(), text);
            let mut expected = original;
            let target = target(&f.router).unwrap();
            if matches!(format, Format::OpenCode) {
                expected[key][id]["command"] = serde_json::json!([target]);
            } else {
                expected[key][id]["command"] = serde_json::json!(target);
            }
            assert_eq!(jsonc::parse_unambiguous(&plan.after).unwrap(), expected);
            assert_eq!(plan.after, expected.to_string(), "Only the command bytes may change");
            assert!(plan.apply(|_| false).unwrap().is_none());
            assert_eq!(fs::read_to_string(&file).unwrap(), text);
            assert!(!f.root.join(".creator-hub-settings-backups").exists());
            old.assert_unchanged();
        }
    }
    assert_eq!(old.checks.get(), 4);
}

#[cfg(windows)]
#[test]
fn verified_owned_router_relocation_preserves_toml_forms_and_all_comments() {
    let f = Fixture::new();
    let old = RetainedRouter::new(&f);
    let command = old.command.to_str().unwrap();
    let quoted = toml_edit::Value::from(target(&f.router).unwrap()).to_string();
    for original in [
        format!("# root\n[mcp_servers.'creator-works']\ncommand='{command}' # command\nargs=[\n # no arguments\n] # args\nenabled=false # disabled\ntimeout=37\n[mcp_servers.'creator-works'.env]\nCUSTOM='keep' # custom\nUNITY_PROJECT_PATH='keep project' # project\nCREATOR_WORKS_CONFIG_OWNER='creator-hub-v1' # owner\n[mcp_servers.other]\ncommand='keep'\n"),
        format!("# root\nmcp_servers={{banter={{command='{command}',args=[],enabled=false,env={{CUSTOM='keep',UNITY_PROJECT_PATH='keep project',CREATOR_WORKS_CONFIG_OWNER='creator-hub-v1'}}}},other={{command='keep'}}}} # inline\n"),
        format!("# root\nmcp_servers.banter.command='{command}' # command\nmcp_servers.banter.args=[] # args\nmcp_servers.banter.enabled=false\nmcp_servers.banter.env.CUSTOM='keep'\nmcp_servers.banter.env.UNITY_PROJECT_PATH='keep project'\nmcp_servers.banter.env.CREATOR_WORKS_CONFIG_OWNER='creator-hub-v1' # owner\nmcp_servers.other.command='keep'\n"),
    ] {
        let file = f.root.join("relocate.toml");
        fs::write(&file, &original).unwrap();
        let plan = old.review(&f, &file, Format::Codex).unwrap().unwrap();
        let expected = original.replace(&format!("'{command}'"), &quoted);
        assert_eq!(plan.after, expected, "Only the command value may change");
        assert_eq!(plan.project.as_deref(), Some("keep project"));
        assert_eq!(fs::read_to_string(file).unwrap(), original);
        old.assert_unchanged();
    }
}

#[cfg(windows)]
#[test]
fn verified_owned_router_relocation_preserves_jsonc_command_and_environment_comments() {
    let f = Fixture::new();
    let old = RetainedRouter::new(&f);
    let command = serde_json::to_string(&old.command).unwrap();
    let original = format!("{{\r\n // root\r\n \"mcp\": {{\"banter\": {{\r\n \"type\":\"local\",\r\n \"command\":[ /* command */ {command} /* trailing */ ],\r\n \"enabled\":false, // disabled\r\n \"environment\":{{\"CREATOR_WORKS_CONFIG_OWNER\":\"creator-hub-v1\", /* owner */\r\n \"CUSTOM\":\"keep\", \"UNITY_PROJECT_PATH\":\"keep project\"}},\r\n \"custom\":{{\"nested\":[1,2]}}\r\n }}, \"other\": {{\"type\":\"remote\",\"url\":\"https://example.invalid\"}} }}\r\n}}\r\n");
    let file = f.root.join("relocate.jsonc");
    fs::write(&file, &original).unwrap();
    let plan = old.review(&f, &file, Format::OpenCode).unwrap().unwrap();
    // Compare the entire unchanged prefix/suffix separately from the edited array.
    let root = json_object(&original, 0).unwrap();
    let servers = json_object(&original, json_member(&root, "mcp").unwrap().start).unwrap();
    let entry = json_object(&original, json_member(&servers, "banter").unwrap().start).unwrap();
    let range = json_member(&entry, "command").unwrap();
    assert!(plan.after.starts_with(&original[..range.start]));
    assert!(plan.after.ends_with(&original[range.end..]));
    assert!(plan.after.contains("/* command */"));
    assert!(plan.after.contains("/* trailing */"));
    let mut expected = jsonc::parse_unambiguous(&original).unwrap();
    expected["mcp"]["banter"]["command"] = serde_json::json!([target(&f.router).unwrap()]);
    assert_eq!(jsonc::parse_unambiguous(&plan.after).unwrap(), expected);
    assert_eq!(fs::read_to_string(file).unwrap(), original);
    old.assert_unchanged();
}

#[cfg(windows)]
#[test]
fn relocated_router_requires_exact_owner_zero_arguments_and_safe_environment() {
    let f = Fixture::new();
    let old = RetainedRouter::new(&f);
    for format in [Format::Json, Format::OpenCode] {
        let opencode = matches!(format, Format::OpenCode);
        let key = if opencode { "mcp" } else { "mcpServers" };
        let env = if opencode { "environment" } else { "env" };
        for change in ["unowned", "foreign", "numeric-owner", "extra-argument",
            "missing-arguments", "invalid-command", "node-options", "ambiguous-owner", "duplicate-entries", "remote"] {
            if change == "remote" && !opencode { continue; }
            let mut entry = old.json_entry(format);
            match change {
                "unowned" => { entry[env].as_object_mut().unwrap().remove(client_ownership::OWNER_KEY); }
                "foreign" => entry[env][client_ownership::OWNER_KEY] = serde_json::json!("other"),
                "numeric-owner" => entry[env][client_ownership::OWNER_KEY] = serde_json::json!(1),
                "extra-argument" if opencode => entry["command"].as_array_mut().unwrap().push(serde_json::json!("--custom")),
                "extra-argument" => entry["args"] = serde_json::json!(["--custom"]),
                "missing-arguments" if opencode => entry["command"] = serde_json::json!([]),
                "missing-arguments" => { entry.as_object_mut().unwrap().remove("args"); }
                "invalid-command" => entry["command"] = serde_json::json!(17),
                "node-options" => entry[env]["NODE_OPTIONS"] = serde_json::json!("--require custom"),
                "ambiguous-owner" => entry[env]["creator_works_config_owner"] = serde_json::json!(client_ownership::OWNER),
                "duplicate-entries" => (),
                "remote" => entry["type"] = serde_json::json!("remote"),
                _ => unreachable!(),
            }
            let mut config = serde_json::json!({key:{"creator-works":entry}});
            if change == "duplicate-entries" { config[key]["banter"] = config[key]["creator-works"].clone(); }
            let original = config.to_string();
            let file = f.root.join("refuse-relocation.json");
            fs::write(&file, &original).unwrap();
            let before_checks = old.checks.get();
            assert!(old.review(&f, &file, format).is_err(), "{change}");
            if !matches!(change, "node-options" | "ambiguous-owner") {
                assert_eq!(old.checks.get(), before_checks, "{change} must fail before verifying");
            }
            assert_eq!(fs::read_to_string(file).unwrap(), original);
            assert!(!f.root.join(".creator-hub-settings-backups").exists());
            old.assert_unchanged();
        }
    }
    for (args, owner, env) in [
        ("[]", "", ""),
        ("[]", "CREATOR_WORKS_CONFIG_OWNER='other'", ""),
        ("['--custom']", "CREATOR_WORKS_CONFIG_OWNER='creator-hub-v1'", ""),
        ("[]", "CREATOR_WORKS_CONFIG_OWNER='creator-hub-v1'", "NODE_PATH='custom'"),
        ("[]", "CREATOR_WORKS_CONFIG_OWNER='creator-hub-v1'", "creator_works_config_owner='creator-hub-v1'"),
    ] {
        let original = format!("[mcp_servers.creator-works]\ncommand='{}'\nargs={args}\n[mcp_servers.creator-works.env]\n{owner}\n{env}\n", old.command.display());
        let file = f.root.join("refuse-relocation.toml");
        fs::write(&file, &original).unwrap();
        assert!(old.review(&f, &file, Format::Codex).is_err());
        assert_eq!(fs::read_to_string(file).unwrap(), original);
        old.assert_unchanged();
    }
}

#[cfg(windows)]
#[test]
fn production_router_review_rejects_unsigned_and_fixture_key_routers_in_all_formats() {
    let f = Fixture::new();
    let old = RetainedRouter::new(&f);
    for signed in [true, false] {
        if !signed { fs::remove_file(&old.files[2].0).unwrap(); }
        for format in [Format::Codex, Format::Json, Format::OpenCode] {
            let original = match format {
                Format::Codex => format!("[mcp_servers.creator-works]\ncommand='{}'\nargs=[]\n[mcp_servers.creator-works.env]\nCREATOR_WORKS_CONFIG_OWNER='creator-hub-v1'\n", old.command.display()),
                Format::Json => serde_json::json!({"mcpServers":{"creator-works":old.json_entry(format)}}).to_string(),
                Format::OpenCode => serde_json::json!({"mcp":{"creator-works":old.json_entry(format)}}).to_string(),
            };
            let file = f.root.join("production-refusal");
            fs::write(&file, &original).unwrap();
            let error = Plan::review_router("Fixture", &file, format, &f.router).err().unwrap();
            assert!(!error.contains("Custom client arguments"), "must reach the real verifier: {error}");
            assert_eq!(fs::read_to_string(file).unwrap(), original);
            assert_eq!(fs::read(&old.command).unwrap(), b"router-a");
            assert!(!f.root.join(".creator-hub-settings-backups").exists());
        }
    }
}

#[cfg(windows)]
#[test]
fn router_verification_failure_never_falls_back_to_marker_or_basename_trust() {
    let f = Fixture::new();
    let old = RetainedRouter::new(&f);
    for change in ["missing", "changed-image", "changed-metadata", "changed-signature"] {
        for (path, bytes) in &old.files { fs::write(path, bytes).unwrap(); }
        match change {
            "missing" => fs::remove_file(&old.command).unwrap(),
            "changed-image" => fs::write(&old.command, b"tampered").unwrap(),
            "changed-metadata" => fs::write(&old.files[1].0, b"{}").unwrap(),
            "changed-signature" => fs::write(&old.files[2].0, b"unsigned").unwrap(),
            _ => unreachable!(),
        }
        for format in [Format::Codex, Format::Json, Format::OpenCode] {
            let original = match format {
                Format::Codex => format!("[mcp_servers.creator-works]\ncommand='{}'\nargs=[]\n[mcp_servers.creator-works.env]\nCREATOR_WORKS_CONFIG_OWNER='creator-hub-v1'\n", old.command.display()),
                Format::Json => serde_json::json!({"mcpServers":{"creator-works":old.json_entry(format)}}).to_string(),
                Format::OpenCode => serde_json::json!({"mcp":{"creator-works":old.json_entry(format)}}).to_string(),
            };
            let file = f.root.join("tamper-refusal");
            fs::write(&file, &original).unwrap();
            let checks = old.checks.get();
            assert!(old.review(&f, &file, format).is_err(), "{change}");
            assert_eq!(old.checks.get(), checks + 1);
            assert_eq!(fs::read_to_string(file).unwrap(), original);
            assert!(!f.root.join(".creator-hub-settings-backups").exists());
        }
    }
}

#[cfg(windows)]
#[test]
fn verified_router_relocation_keeps_transaction_backups_stale_review_guard_and_noop() {
    let f = Fixture::new();
    let old = RetainedRouter::new(&f);
    let file = f.root.join("transaction.json");
    let original = serde_json::json!({"mcpServers":{"creator-works":old.json_entry(Format::Json)}}).to_string();
    fs::write(&file, &original).unwrap();
    let plan = old.review(&f, &file, Format::Json).unwrap().unwrap();
    assert!(plan.apply(|_| { fs::write(&file, b"user edit").unwrap(); true }).is_err());
    assert_eq!(fs::read(&file).unwrap(), b"user edit");
    fs::write(&file, &original).unwrap();
    let plan = old.review(&f, &file, Format::Json).unwrap().unwrap();
    let after = plan.after.clone();
    let backup = plan.apply(|_| true).unwrap().unwrap();
    assert_eq!(fs::read_to_string(&backup).unwrap(), original);
    assert_eq!(fs::read_to_string(&file).unwrap(), after);
    assert!(Plan::review_router("Fixture", &file, Format::Json, &f.router).unwrap().is_none());
    old.assert_unchanged();
}

#[cfg(windows)]
#[test]
fn configuration_pin_preserves_json_overrides_options_and_current_command_spelling() {
    let f = Fixture::new();
    let old = RetainedRouter::new(&f);
    let config = f.root.join("launcher-config.json");
    fs::write(&config, b"{}").unwrap();
    let physical = target(&config).unwrap();
    assert!(!physical.starts_with(r"\\?\"));
    for format in [Format::Json, Format::OpenCode] {
        let opencode = matches!(format, Format::OpenCode);
        let key = if opencode { "mcp" } else { "mcpServers" };
        let env = if opencode { "environment" } else { "env" };
        for same in [false, true] {
            for override_value in [None, Some("explicit custom config")] {
                let mut entry = old.json_entry(format);
                entry[env]["CREATOR_WORKS_TOOL_GROUPS"] = serde_json::json!("read,banter");
                if let Some(value) = override_value { entry[env][LAUNCHER_CONFIG] = serde_json::json!(value); }
                if same {
                    let forward = crate::normalized_existing_path(old.command.clone()).to_string_lossy().replace('\\', "/");
                    if opencode { entry["command"][0] = serde_json::json!(forward); }
                    else { entry["command"] = serde_json::json!(forward); }
                }
                let original = serde_json::json!({key:{"creator-works":entry},"custom":{"keep":true}});
                let text = original.to_string();
                let file = f.root.join("pin.json");
                fs::write(&file, &text).unwrap();
                let router = if same { &old.command } else { &f.router };
                let checks = old.checks.get();
                let plan = Plan::review_target_inner("Fixture", &file, format, router, None,
                    Some(&config), |command| old.verify(command)).unwrap();
                if same && override_value.is_some() {
                    assert!(plan.is_none());
                    assert_eq!(old.checks.get(), checks);
                } else {
                    let plan = plan.unwrap();
                    assert_eq!(old.checks.get(), checks + 1);
                    let mut expected = original;
                    if !same {
                        if opencode { expected[key]["creator-works"]["command"] = serde_json::json!([target(router).unwrap()]); }
                        else { expected[key]["creator-works"]["command"] = serde_json::json!(target(router).unwrap()); }
                    }
                    if override_value.is_none() { expected[key]["creator-works"][env][LAUNCHER_CONFIG] = serde_json::json!(physical); }
                    assert_eq!(jsonc::parse_unambiguous(&plan.after).unwrap(), expected);
                    let backup = plan.apply(|_| true).unwrap().unwrap();
                    assert_eq!(fs::read_to_string(backup).unwrap(), text);
                    assert!(Plan::review_router_with_config("Fixture", &file, format, router, &config).unwrap().is_none());
                }
                old.assert_unchanged();
                assert_eq!(fs::read(&config).unwrap(), b"{}");
            }
        }
    }
}

#[cfg(windows)]
#[test]
fn configuration_pin_preserves_toml_forms_comments_and_existing_overrides() {
    let f = Fixture::new();
    let old = RetainedRouter::new(&f);
    let config = f.root.join("launcher-config.json");
    fs::write(&config, b"{}").unwrap();
    let command = crate::normalized_existing_path(old.command.clone()).to_string_lossy().replace('\\', "/");
    for original in [
        format!("# root\n[mcp_servers.'creator-works']\ncommand='{command}' # command\nargs=[\n # empty\n] # args\nenabled=false\n[mcp_servers.'creator-works'.env]\nCREATOR_WORKS_CONFIG_OWNER='creator-hub-v1' # owner\nUNITY_PROJECT_PATH='keep project' # project\nCREATOR_WORKS_TOOL_GROUPS='read,banter' # groups\nCUSTOM='keep'\n"),
        format!("# root\nmcp_servers={{'creator-works'={{command='{command}',args=[],enabled=false,env={{CREATOR_WORKS_CONFIG_OWNER='creator-hub-v1',CUSTOM='keep',UNITY_PROJECT_PATH='keep project',CREATOR_WORKS_TOOL_GROUPS='read,banter'}}}},other={{command='keep'}}}} # inline\n"),
        format!("# root\nmcp_servers.'creator-works'.command='{command}' # command\nmcp_servers.'creator-works'.args=[] # args\nmcp_servers.'creator-works'.enabled=false\nmcp_servers.'creator-works'.env.CREATOR_WORKS_CONFIG_OWNER='creator-hub-v1' # owner\nmcp_servers.'creator-works'.env.CUSTOM='keep'\nmcp_servers.'creator-works'.env.UNITY_PROJECT_PATH='keep project'\nmcp_servers.'creator-works'.env.CREATOR_WORKS_TOOL_GROUPS='read,banter' # groups\n"),
    ] {
        for same in [false, true] {
            let file = f.root.join("pin.toml");
            fs::write(&file, &original).unwrap();
            let router = if same { &old.command } else { &f.router };
            let plan = Plan::review_target_inner("Fixture", &file, Format::Codex, router, None,
                Some(&config), |command| old.verify(command)).unwrap().unwrap();
            let mut expected = original.parse::<toml_edit::Document>().unwrap();
            if !same { expected["mcp_servers"]["creator-works"]["command"] = toml_edit::value(target(router).unwrap()); }
            expected["mcp_servers"]["creator-works"]["env"][LAUNCHER_CONFIG] = toml_edit::value(target(&config).unwrap());
            let after = plan.after.parse::<toml_edit::Document>().unwrap();
            assert!(same_toml(after.as_item(), expected.as_item()));
            assert_eq!(plan.after.matches("# root").count(), 1);
            if same { assert!(plan.after.contains(&format!("command='{command}'"))); }
            for comment in ["# command", "# args", "# owner", "# project", "# groups", "# inline"] {
                assert_eq!(plan.after.matches(comment).count(), original.matches(comment).count());
            }
            let backup = plan.apply(|_| true).unwrap().unwrap();
            assert_eq!(fs::read_to_string(backup).unwrap(), original);
            assert!(Plan::review_router_with_config("Fixture", &file, Format::Codex, router, &config).unwrap().is_none());
            old.assert_unchanged();
        }
    }
    let file = f.root.join("override.toml");
    let original = format!("[mcp_servers.banter]\ncommand='{command}'\nargs=[]\n[mcp_servers.banter.env]\nCREATOR_WORKS_CONFIG_OWNER='creator-hub-v1'\nCREATOR_WORKS_LAUNCHER_CONFIG='custom override' # custom pin\n");
    fs::write(&file, &original).unwrap();
    let plan = Plan::review_target_inner("Fixture", &file, Format::Codex, &f.router, None,
        Some(&config), |command| old.verify(command)).unwrap().unwrap();
    assert!(plan.after.contains("CREATOR_WORKS_LAUNCHER_CONFIG='custom override' # custom pin"));
    assert!(Plan::review_router_with_config("Fixture", &file, Format::Codex, &old.command, &config).unwrap().is_none());
}

#[cfg(windows)]
#[test]
fn same_router_configuration_pin_requires_real_verification_and_unambiguous_config() {
    let f = Fixture::new();
    let old = RetainedRouter::new(&f);
    let config = f.root.join("launcher-config.json");
    fs::write(&config, b"{}").unwrap();
    for format in [Format::Codex, Format::Json, Format::OpenCode] {
        let command = crate::normalized_existing_path(old.command.clone());
        let mut entry = old.json_entry(format);
        if matches!(format, Format::OpenCode) { entry["command"][0] = serde_json::json!(command); }
        else { entry["command"] = serde_json::json!(command); }
        let original = match format {
            Format::Codex => format!("[mcp_servers.creator-works]\ncommand='{}'\nargs=[]\n[mcp_servers.creator-works.env]\nCREATOR_WORKS_CONFIG_OWNER='creator-hub-v1'\n", command.display()),
            Format::Json => serde_json::json!({"mcpServers":{"creator-works":entry}}).to_string(),
            Format::OpenCode => serde_json::json!({"mcp":{"creator-works":entry}}).to_string(),
        };
        let file = f.root.join("refuse-pin");
        fs::write(&file, &original).unwrap();
        assert!(Plan::review_router("Fixture", &file, format, &old.command).unwrap().is_none());
        assert!(Plan::review_router_with_config("Fixture", &file, format, &old.command, &config).is_err());
        let raw_root = crate::normalized_existing_path(f.root.clone());
        for bad in [PathBuf::from("relative.json"), PathBuf::from(format!("{}/missing/../config.json", raw_root.display()))] {
            assert!(Plan::review_target_inner("Fixture", &file, format, &old.command, None,
                Some(&bad), |command| old.verify(command)).is_err(), "Accepted invalid config path: {} for format {}", bad.display(), match format { Format::Codex => "codex", Format::Json => "json", Format::OpenCode => "opencode" });
        }
        assert!(Plan::review_router_with_config("Fixture", &file, format,
            &f.root.join("missing-router.exe"), &config).is_err());
        assert_eq!(fs::read_to_string(file).unwrap(), original);
        old.assert_unchanged();
    }
    assert!(!f.root.join(".creator-hub-settings-backups").exists());
}

#[cfg(windows)]
#[test]
fn owned_codex_router_from_normal_setup_is_recognized_with_forward_slashes() {
    let f = Fixture::new();
    let router = crate::normalized_existing_path(f.router.clone())
        .to_string_lossy()
        .replace('\\', "/");
    let original = format!(
        "[mcp_servers.creator-works]\ncommand={}\nargs=[]\n[mcp_servers.creator-works.env]\n{}='{}'\n",
        serde_json::to_string(&router).unwrap(),
        client_ownership::OWNER_KEY,
        client_ownership::OWNER,
    );
    let file = f.root.join("codex-config.toml");
    fs::write(&file, &original).unwrap();
    let result = Plan::review_router("Codex", &file, Format::Codex, &f.router);
    assert!(result.is_ok(), "App-created router entry was refused: {:?}", result.err());
    assert!(result.unwrap().is_none(), "Equivalent current router must not require a rewrite");
    assert_eq!(fs::read_to_string(file).unwrap(), original);
}

#[cfg(windows)]
#[test]
fn owned_json_and_opencode_router_separator_variants_are_read_only() {
    let f = Fixture::new();
    let forward = crate::normalized_existing_path(f.router.clone())
        .to_string_lossy()
        .replace('\\', "/");
    for format in [Format::Json, Format::OpenCode] {
        let entry = if matches!(format, Format::OpenCode) {
            serde_json::json!({"mcp":{"creator-works":{"type":"local","command":[forward],
                "environment":{"CREATOR_WORKS_CONFIG_OWNER":client_ownership::OWNER}}}})
        } else {
            serde_json::json!({"mcpServers":{"creator-works":{"command":forward,"args":[],
                "env":{"CREATOR_WORKS_CONFIG_OWNER":client_ownership::OWNER}}}})
        };
        let file = f.root.join("owned-router.json");
        let original = entry.to_string();
        fs::write(&file, &original).unwrap();
        assert!(Plan::review_router("Fixture", &file, format, &f.router)
            .unwrap().is_none());
        assert_eq!(fs::read_to_string(&file).unwrap(), original);
    }
}

#[test]
fn owned_router_separator_support_does_not_adopt_other_commands_or_arguments() {
    let f = Fixture::new();
    let command = crate::normalized_existing_path(f.router.clone())
        .to_string_lossy().to_string();
    let owned = serde_json::json!({"command":command,"args":[],
        "env":{"CREATOR_WORKS_CONFIG_OWNER":client_ownership::OWNER}});
    for change in ["other-path", "extra-argument", "unowned", "different-owner"] {
        let mut entry = owned.clone();
        match change {
            "other-path" => entry["command"] = serde_json::json!(f.root.join("other-router")),
            "extra-argument" => entry["args"] = serde_json::json!(["unexpected"]),
            "unowned" => { entry["env"].as_object_mut().unwrap().clear(); },
            "different-owner" => entry["env"][client_ownership::OWNER_KEY] = serde_json::json!("other"),
            _ => unreachable!(),
        }
        let file = f.root.join("refused-router.json");
        let original = serde_json::json!({"mcpServers":{"creator-works":entry}}).to_string();
        fs::write(&file, &original).unwrap();
        assert!(Plan::review_router("Fixture", &file, Format::Json, &f.router).is_err(), "{change}");
        assert_eq!(fs::read_to_string(file).unwrap(), original);
    }
}

#[test]
fn router_review_preserves_internal_jsonc_comments_and_custom_bytes() {
    let f = Fixture::new();
    let old = f.old();
    let original = format!("{{\r\n // root comment\r\n \"mcp\": {{\"banter\": {{\r\n   \"type\": \"local\",\r\n   \"command\": [ /* node comment */ {}, // server comment\r\n {} ],\r\n   // disabled comment\r\n   \"enabled\": false,\r\n   \"custom\": {{ \"literal\": \"/* not a comment */\", \"nested\": [1,{{\"x\":2}}] }},\r\n   \"environment\": {{ // environment comment\r\n     \"CUSTOM\": \"keep\", /* custom comment */\r\n     \"UNITY_PROJECT_PATH\": \"keep project\" // project comment\r\n   }}\r\n }}, \"other\": {{ \"type\": \"remote\", \"url\": \"https://example.invalid\" }} }}\r\n}}\r\n", old["command"], old["args"][0]);
    let plan = f.review(Format::OpenCode, &original);
    for fragment in ["// root comment", "/* node comment */", "// server comment", "// disabled comment\r\n   \"enabled\": false", "\"custom\": { \"literal\": \"/* not a comment */\", \"nested\": [1,{\"x\":2}] }", "// environment comment\r\n     \"CUSTOM\": \"keep\", /* custom comment */\r\n     \"UNITY_PROJECT_PATH\": \"keep project\"", "// project comment\r\n", "\"other\": { \"type\": \"remote\", \"url\": \"https://example.invalid\" }"] {
        assert!(plan.after.contains(fragment), "lost: {fragment}\n{}", plan.after);
    }
    assert_eq!(
        jsonc::parse_unambiguous(&plan.after).unwrap()["mcp"]["banter"]["enabled"],
        false
    );
    assert_eq!(fs::read_to_string(&plan.path).unwrap(), original);
}

#[test]
fn json_field_edits_handle_empty_env_missing_env_escaped_keys_and_compact_closers() {
    let f = Fixture::new();
    for env in ["", ",\"env\":{}", ",\"env\":{\"CUSTOM\":\"keep\"}"] {
        let old = f.old();
        let original = format!("{{\"mcpServers\":{{\"creator-\\u0077orks\":{{\"command\":{},\"disabled\":true,\"timeout\":37,\"args\":[{}]{env}}},\"other\":{{ \"command\":\"keep\" }}}}}}", old["command"], old["args"][0]);
        let plan = f.review(Format::Json, &original);
        assert!(plan.after.contains("\"creator-\\u0077orks\""));
        assert!(plan.after.contains("\"disabled\":true,\"timeout\":37"));
        assert!(plan.after.contains("\"other\":{ \"command\":\"keep\" }"));
        assert!(client_ownership::guard_json(
            &jsonc::parse_unambiguous(&plan.after).unwrap(),
            None,
            false
        )
        .unwrap());
    }
}

#[test]
fn toml_router_review_preserves_changed_field_and_environment_comments() {
    let f = Fixture::new();
    let old = f.old();
    let node = old["command"].as_str().unwrap();
    let server = old["args"][0].as_str().unwrap();
    let original = format!("# root comment\n[mcp_servers.'creator-works']\ncommand='{node}' # command comment\nargs=[\n # node argument comment\n '{server}', # argument tail comment\n] # args comment\nenabled=false # disabled comment\n[mcp_servers.'creator-works'.env]\nCUSTOM='keep' # custom comment\nUNITY_PROJECT_PATH='keep' # project comment\n");
    let plan = f.review(Format::Codex, &original);
    for comment in [
        "# root comment",
        "# command comment",
        "# node argument comment",
        "# argument tail comment",
        "# args comment",
        "enabled=false # disabled comment",
        "CUSTOM='keep' # custom comment",
        "UNITY_PROJECT_PATH='keep' # project comment",
    ] {
        assert!(
            plan.after.contains(comment),
            "lost {comment}\n{}",
            plan.after
        );
    }
    let doc = plan.after.parse::<toml_edit::Document>().unwrap();
    assert!(doc["mcp_servers"]["creator-works"]["args"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(fs::read_to_string(&plan.path).unwrap(), original);
}

#[cfg(windows)]
#[test]
fn approved_existing_codex_claude_code_and_desktop_batch_has_a_single_recoverable_journal() {
    let f = Fixture::new();
    let old = f.old();
    let mut plans = Vec::new();
    let mut paths = Vec::new();
    for (name, format, text) in [
        (
            "Codex",
            Format::Codex,
            format!(
                "# keep\n[mcp_servers.creator-works]\ncommand='{}'\nargs=['{}']\nenabled=false\n",
                old["command"].as_str().unwrap(),
                old["args"][0].as_str().unwrap()
            ),
        ),
        (
            "Claude Code",
            Format::Json,
            serde_json::json!({"mcpServers":{"banter":old},"custom":{"keep":true}}).to_string(),
        ),
        (
            "Claude Desktop",
            Format::Json,
            serde_json::json!({"mcpServers":{"creator-works":old},"preferences":{"keep":true}})
                .to_string(),
        ),
    ] {
        let path = f.root.join(format!("{}.config", name.replace(' ', "-")));
        fs::write(&path, text).unwrap();
        plans.push(
            Plan::review_router(name, &path, format, &f.router)
                .unwrap()
                .unwrap(),
        );
        paths.push(path);
    }
    let root = f.root.join("batch-journal");
    assert!(Plan::apply_reviewed(&plans, &root, |_| false)
        .unwrap()
        .is_none());
    assert!(!root.exists());
    let result = Plan::apply_reviewed(&plans, &root, |review| review.len() == 3)
        .unwrap()
        .unwrap();
    assert!(result.completed);
    for file in &result.files {
        assert!(plans.iter().any(|plan| plan.client == file.client));
        assert_eq!(
            fs::read(&file.before_image).unwrap(),
            fs::read(&file.before_backup).unwrap()
        );
        assert_eq!(
            fs::read(&file.after_image).unwrap(),
            fs::read(&file.path).unwrap()
        );
    }
    assert!(
        recovery::Transaction::open(&result.journal, &paths)
            .unwrap()
            .resume(|_| true)
            .unwrap()
            .completed
    );
}
