use super::*;

fn project() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for name in ["Assets", "ProjectSettings", "Packages"] {
        fs::create_dir(dir.path().join(name)).unwrap();
    }
    dir
}

fn manifest(path: &Path, source: &str) {
    fs::write(path.join("Packages/manifest.json"), source).unwrap();
}

#[test]
fn auto_is_only_the_fresh_setup_default_and_manual_preferences_round_trip() {
    assert_eq!(
        default_launcher_config(PathBuf::from("server.mjs")).tool_groups,
        "auto"
    );
    let source = serde_json::json!({
        "channels": [{"id":"keep", "name":"Keep", "unity_project_path":"/keep",
            "scene_path":null, "enabled":true, "customChannel":{"value":9}}],
        "active_channel_id":"keep", "mcp_server_path":"keep.mjs", "auto_start":false,
        "enable_custom_scripts":true, "allow_all_tests":false, "customRoot":[1,2,3]
    });
    let legacy: LauncherConfig = serde_json::from_value(source.clone()).unwrap();
    assert_eq!(legacy.tool_groups, "core");
    for value in [
        "core",
        "all",
        "read",
        "core,banter",
        "core,creator",
        "core,banter,creator",
        "auto",
    ] {
        let mut input = source.clone();
        input["tool_groups"] = value.into();
        let mut config: LauncherConfig = serde_json::from_value(input.clone()).unwrap();
        config.tool_groups = normalize_tool_groups(&config.tool_groups).unwrap();
        let output = serde_json::to_value(config).unwrap();
        for key in [
            "channels",
            "active_channel_id",
            "mcp_server_path",
            "auto_start",
            "enable_custom_scripts",
            "allow_all_tests",
            "customRoot",
            "tool_groups",
        ] {
            assert_eq!(output[key], input[key], "{value}: {key}");
        }
    }
}

#[test]
fn auto_rechecks_actual_manifest_for_every_client_render_and_manual_bypasses_detection() {
    let dir = project();
    let channel = channel_for_project(dir.path()).unwrap();
    for (deps, expected) in [
        (r#"{"com.sidequest.creator-sdk":"4.0.25"}"#, "core,creator"),
        (r#"{"com.sidequest.banter":"3.2.1"}"#, "core,banter"),
        (
            r#"{"com.sidequest.creator-sdk":"4.0.25","com.sidequest.banter":"3.2.1"}"#,
            "core,banter,creator",
        ),
        ("{}", "core"),
    ] {
        manifest(dir.path(), &format!(r#"{{"dependencies":{deps}}}"#));
        assert_eq!(
            resolve_project_tool_groups("auto", dir.path()).unwrap(),
            expected
        );
        let claude = build_claude_mcp_config(
            serde_json::json!({"keep":17}),
            &channel,
            "node",
            "server.mjs",
            "auto",
        )
        .unwrap();
        assert_eq!(
            claude["mcpServers"][MCP_CLIENT_ID]["env"][TOOL_GROUPS_ENV],
            expected
        );
        assert_eq!(claude["keep"], 17);
        let codex =
            build_codex_mcp_config("model = 'keep'\n", &channel, "node", "server.mjs", "auto")
                .unwrap();
        assert!(codex.contains(&format!("{TOOL_GROUPS_ENV} = \"{expected}\"")));
        assert!(codex.contains("model = 'keep'"));
        let desktop = desktop_entry_for_target(&channel, "node", "server.mjs", "auto").unwrap();
        assert_eq!(desktop["env"][TOOL_GROUPS_ENV], expected);
        let antigravity = build_antigravity_mcp_config(
            serde_json::json!({}),
            &channel,
            "node",
            "server.mjs",
            "auto",
        )
        .unwrap();
        assert_eq!(
            antigravity["mcpServers"][MCP_CLIENT_ID]["env"][TOOL_GROUPS_ENV],
            expected
        );
        let opencode = build_opencode_mcp_config(
            serde_json::json!({}),
            &channel,
            "node",
            "server.mjs",
            "auto",
        )
        .unwrap();
        assert_eq!(
            opencode["mcp"][MCP_CLIENT_ID]["environment"][TOOL_GROUPS_ENV],
            expected
        );
    }
    manifest(dir.path(), "broken");
    assert!(resolve_project_tool_groups("auto", dir.path()).is_err());
    assert!(build_claude_mcp_config(
        serde_json::json!({}),
        &channel,
        "node",
        "server.mjs",
        "auto"
    )
    .is_err());
    assert!(build_codex_mcp_config("", &channel, "node", "server.mjs", "auto").is_err());
    assert!(desktop_entry_for_target(&channel, "node", "server.mjs", "auto").is_err());
    assert!(build_antigravity_mcp_config(
        serde_json::json!({}),
        &channel,
        "node",
        "server.mjs",
        "auto"
    )
    .is_err());
    assert!(build_opencode_mcp_config(
        serde_json::json!({}),
        &channel,
        "node",
        "server.mjs",
        "auto"
    )
    .is_err());
    for manual in ["core", "all", "core,banter", "core,creator"] {
        assert_eq!(
            resolve_project_tool_groups(manual, dir.path()).unwrap(),
            manual
        );
    }
    assert!(resolve_project_tool_groups("auto", &dir.path().join("missing")).is_err());
}

#[test]
fn auto_rejects_ambiguous_or_malformed_metadata_without_writes() {
    let dir = project();
    for source in [
        "[]",
        r#"{"dependencies":null}"#,
        r#"{"dependencies":{"com.sidequest.creator-sdk":null}}"#,
        r#"{"dependencies":{"com.sidequest.creator-sdk":"4.0.25","com.sidequest.creator-sdk":""}}"#,
        r#"{"dependencies":{},"dependencies":{"com.sidequest.creator-sdk":"4.0.25"}}"#,
    ] {
        manifest(dir.path(), source);
        assert!(
            resolve_project_tool_groups("auto", dir.path()).is_err(),
            "{source}"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("Packages/manifest.json")).unwrap(),
            source
        );
    }
    manifest(
        dir.path(),
        r#"{"dependencies":{"com.sidequest.creator-sdk":"4.0.25"}}"#,
    );
    for source in [
        "broken",
        r#"{"dependencies":{"com.sidequest.creator-sdk":{"version":null}}}"#,
        r#"{"dependencies":{"com.sidequest.creator-sdk":{}}}"#,
        r#"{"dependencies":{"com.sidequest.creator-sdk":{"version":"4.0.25","dependencies":[]}}}"#,
        r#"{"dependencies":{"com.sidequest.creator-sdk":{"version":"4.0.25","version":"4.0.14"}}}"#,
    ] {
        fs::write(dir.path().join("Packages/packages-lock.json"), source).unwrap();
        assert!(
            resolve_project_tool_groups("auto", dir.path()).is_err(),
            "{source}"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("Packages/packages-lock.json")).unwrap(),
            source
        );
    }
}

#[test]
fn sdk_detection_follows_transitive_dependencies_but_ignores_orphaned_lock_entries() {
    let dir = project();
    manifest(
        dir.path(),
        r#"{"dependencies":{"com.example.wrapper":"1.0.0"}}"#,
    );
    fs::write(dir.path().join("Packages/packages-lock.json"), r#"{"dependencies":{
        "com.example.wrapper":{"version":"1.0.0","dependencies":{"com.sidequest.creator-sdk":"4.0.25"}},
        "com.sidequest.creator-sdk":{"version":"4.0.25","dependencies":{}},
        "com.sidequest.banter":{"version":"3.0.0","dependencies":{}}
    }}"#).unwrap();
    assert_eq!(
        resolve_project_tool_groups("auto", dir.path()).unwrap(),
        "core,creator"
    );
    manifest(dir.path(), r#"{"dependencies":{}}"#);
    assert_eq!(
        resolve_project_tool_groups("auto", dir.path()).unwrap(),
        "core"
    );
    manifest(
        dir.path(),
        r#"{"dependencies":{"com.example.wrapper":"2.0.0"}}"#,
    );
    assert!(resolve_project_tool_groups("auto", dir.path()).is_err());
    assert_eq!(
        resolve_project_tool_groups("core,banter", dir.path()).unwrap(),
        "core,banter"
    );
}

#[test]
fn auto_accepts_unity_resolving_a_higher_shared_dependency_version() {
    let dir = project();
    manifest(
        dir.path(),
        r#"{"dependencies":{"com.example.a":"1.0.0","com.example.b":"1.0.0"}}"#,
    );
    fs::write(dir.path().join("Packages/packages-lock.json"), r#"{"dependencies":{
        "com.example.a":{"version":"1.0.0","dependencies":{"com.example.shared":"1.0.0"}},
        "com.example.b":{"version":"1.0.0","dependencies":{"com.example.shared":"2.0.0"}},
        "com.example.shared":{"version":"2.0.0","dependencies":{"com.sidequest.creator-sdk":"4.0.22"}},
        "com.sidequest.creator-sdk":{"version":"4.0.25","dependencies":{}}
    }}"#).unwrap();
    assert_eq!(
        resolve_project_tool_groups("auto", dir.path()).unwrap(),
        "core,creator"
    );
}
