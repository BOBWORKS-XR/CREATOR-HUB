use super::*;
use serde_json::json;

fn base() -> PathBuf {
    if cfg!(windows) {
        PathBuf::from("C:/fixture")
    } else {
        PathBuf::from("/fixture")
    }
}

fn router() -> PathBuf {
    base().join("retained/creator-hub-mcp-router")
}
fn roots() -> Vec<PathBuf> {
    vec![base().join("old-install")]
}
fn routed(opencode: bool) -> Value {
    if opencode {
        json!({"type":"local", "command":[router()], "environment":{}})
    } else {
        json!({"command":router(), "args":[], "env":{}})
    }
}

fn check(client: Client, format: ConfigFormat, bytes: &[u8], coverage: Coverage) -> Vec<Blocker> {
    let documents = [ConfigDocument {
        label: "fixture config",
        format,
        content: DocumentContent::Bytes(bytes),
    }];
    inspect(Inspection {
        client,
        coverage,
        documents: &documents,
        removal_roots: &roots(),
        verified_router: &router(),
    })
}

fn json_check(client: Client, value: &Value) -> Vec<Blocker> {
    let format = if client == Client::OpenCode {
        ConfigFormat::OpenCodeJson
    } else {
        ConfigFormat::McpJson
    };
    check(
        client,
        format,
        value.to_string().as_bytes(),
        Coverage::EffectiveScopesSupplied,
    )
}

fn has(blockers: &[Blocker], kind: BlockerKind) -> bool {
    blockers.iter().any(|b| b.kind == kind)
}

#[test]
fn renamed_creator_routes_are_detected_in_every_structured_format() {
    let node = base().join("old-install/node");
    let server = base().join("old-install/banter-mcp.mjs");
    let json = json!({"mcpServers":{"renamed-by-user":{"command":node,"args":[server]}}});
    let opencode = json!({"mcp":{"renamed-by-user":{"type":"local","command":[node,server]}}});
    for blockers in [
        json_check(Client::ClaudeCode, &json),
        json_check(Client::OpenCode, &opencode),
    ] {
        assert!(has(&blockers, BlockerKind::InstalledCommand));
        assert!(!format!("{blockers:?}").contains("renamed-by-user"));
    }
    let toml = format!(
        "[mcp_servers.'renamed-by-user']\ncommand='{}'\nargs=['{}']\n",
        node.display(),
        server.display()
    );
    assert!(has(
        &check(
            Client::Codex,
            ConfigFormat::CodexToml,
            toml.as_bytes(),
            Coverage::EffectiveScopesSupplied
        ),
        BlockerKind::InstalledCommand
    ));
}

#[test]
fn claude_nested_projects_are_checked_without_exposing_project_keys() {
    let source = json!({"projects":{"secret-project-key":{"mcpServers":{"banter":{"command":base().join("old-install/node"),"args":[base().join("old-install/banter-mcp.mjs")]}}}}});
    let blockers = json_check(Client::ClaudeCode, &source);
    assert!(has(&blockers, BlockerKind::InstalledCommand));
    assert!(blockers
        .iter()
        .any(|b| b.location.starts_with("projects[scope#0].mcpServers")));
    assert!(!format!("{blockers:?}").contains("secret-project-key"));
}

#[test]
fn opencode_json_and_jsonc_effective_documents_are_both_inspected() {
    let legacy = json!({"mcp":{"creator-works":{"type":"local","command":[base().join("old-install/node"),base().join("old-install/creator-works-mcp.mjs")]}}});
    let jsonc = format!(
        "// fixture\n{}",
        json!({"mcp":{"creator-works":routed(true)}})
    );
    let bytes = legacy.to_string();
    let documents = [
        ConfigDocument {
            label: "opencode.json",
            format: ConfigFormat::OpenCodeJson,
            content: DocumentContent::Bytes(bytes.as_bytes()),
        },
        ConfigDocument {
            label: "opencode.jsonc",
            format: ConfigFormat::OpenCodeJsonc,
            content: DocumentContent::Bytes(jsonc.as_bytes()),
        },
    ];
    let blockers = inspect(Inspection {
        client: Client::OpenCode,
        coverage: Coverage::EffectiveScopesSupplied,
        documents: &documents,
        removal_roots: &roots(),
        verified_router: &router(),
    });
    assert!(blockers
        .iter()
        .any(|b| b.label == "opencode.json" && b.kind == BlockerKind::InstalledCommand));
    assert!(!blockers.iter().any(|b| b.label == "opencode.jsonc"));
}

#[test]
fn unenumerated_effective_scopes_block_even_with_a_routed_canonical_document() {
    let source = json!({"mcp":{"creator-works":routed(true)}});
    assert!(has(
        &check(
            Client::OpenCode,
            ConfigFormat::OpenCodeJson,
            source.to_string().as_bytes(),
            Coverage::Unknown
        ),
        BlockerKind::UnknownScopes
    ));
    let blockers = inspect(Inspection {
        client: Client::OpenCode,
        coverage: Coverage::EffectiveScopesSupplied,
        documents: &[],
        removal_roots: &roots(),
        verified_router: &router(),
    });
    assert!(has(&blockers, BlockerKind::UnknownScopes));
}

#[test]
fn both_launcher_overrides_are_blocked_behind_a_verified_router() {
    for key in CONFIG_OVERRIDES {
        for opencode in [false, true] {
            let mut entry = routed(opencode);
            let env = if opencode { "environment" } else { "env" };
            entry[env][key] = json!(base().join("old-install/launcher-config.json"));
            let (client, value) = if opencode {
                (Client::OpenCode, json!({"mcp":{"alias":entry}}))
            } else {
                (Client::ClaudeCode, json!({"mcpServers":{"alias":entry}}))
            };
            assert!(has(
                &json_check(client, &value),
                BlockerKind::LauncherConfigRemoved
            ));
        }
    }
}

#[test]
fn overridden_configuration_keeps_its_project_by_blocking_removal() {
    let config_path = base().join("old-install/launcher-config.json");
    let project = json!({"channels":[{"id":"selected","unity_project_path":"fixture retained project"}],"active_channel_id":"selected"});
    let mut retained = std::collections::BTreeMap::from([(config_path.clone(), project.clone())]);
    let mut entry = routed(false);
    entry["env"]["BANTWORKS_LAUNCHER_CONFIG"] = json!(config_path);
    let source = json!({"mcpServers":{"creator-works":entry}});
    let before = source.clone();
    for _ in 0..2 {
        let blockers = json_check(Client::ClaudeCode, &source);
        assert!(has(&blockers, BlockerKind::LauncherConfigRemoved));
        // A disposable removal model, not the Root uninstall authorization policy.
        if blockers.is_empty() {
            retained.remove(&config_path);
        }
    }
    assert_eq!(retained.get(&config_path), Some(&project));
    assert_eq!(source, before);
}

#[test]
fn toml_routed_entries_do_not_skip_environment_inspection() {
    let text = format!("[mcp_servers.'creator-works']\ncommand='{}'\nargs=[]\n[mcp_servers.'creator-works'.env]\nCREATOR_WORKS_CONFIG_OWNER='creator-hub-v1'\nBANTWORKS_LAUNCHER_CONFIG='{}'\n", router().display(), base().join("old-install/launcher-config.json").display());
    assert!(has(
        &check(
            Client::Codex,
            ConfigFormat::CodexToml,
            text.as_bytes(),
            Coverage::EffectiveScopesSupplied
        ),
        BlockerKind::LauncherConfigRemoved
    ));
}

#[test]
fn routed_owned_entries_with_bad_transport_still_block() {
    for opencode in [false, true] {
        let mut entry = routed(opencode);
        entry[if opencode { "environment" } else { "env" }][OWNER] = json!("creator-hub-v1");
        entry["type"] = json!("remote");
        entry["url"] = json!("https://secret.invalid/token");
        let (client, value) = if opencode {
            (Client::OpenCode, json!({"mcp":{"creator-works":entry}}))
        } else {
            (
                Client::ClaudeCode,
                json!({"mcpServers":{"creator-works":entry}}),
            )
        };
        assert!(has(
            &json_check(client, &value),
            BlockerKind::InvalidTransport
        ));
    }
}

#[test]
fn routed_environment_shape_and_case_collisions_are_not_trusted() {
    for env in [
        json!([]),
        json!({"CUSTOM":17}),
        json!({"PATH":"one","Path":"two"}),
        json!({"NODE_OPTIONS":"secret argument"}),
    ] {
        let mut entry = routed(false);
        entry["env"] = env;
        let source = json!({"mcpServers":{"creator-works":entry}});
        assert!(has(
            &json_check(Client::ClaudeCode, &source),
            BlockerKind::InvalidEnvironment
        ));
    }
}

#[test]
fn all_three_json_clients_get_typed_findings_and_valid_router_shapes() {
    for client in [
        Client::ClaudeCode,
        Client::ClaudeDesktop,
        Client::Antigravity,
    ] {
        let mut entry = routed(false);
        assert!(json_check(client, &json!({"mcpServers":{"creator-works":entry}})).is_empty());
        entry["env"]["NODE_PATH"] = json!("fixture opaque path");
        let blockers = json_check(client, &json!({"mcpServers":{"creator-works":entry}}));
        assert!(has(&blockers, BlockerKind::InvalidEnvironment));
        assert!(blockers.iter().all(|blocker| blocker.client == client));
    }
}

#[test]
fn too_many_entries_block_instead_of_silently_truncating() {
    let entries: Map<String, Value> = (0..=MAX_ENTRIES)
        .map(|index| {
            (
                format!("unrelated{index}"),
                json!({"command":"other","args":[]}),
            )
        })
        .collect();
    assert!(has(
        &json_check(Client::ClaudeCode, &json!({"mcpServers":entries})),
        BlockerKind::TooManyEntries
    ));
}

#[test]
fn relative_and_volume_root_removal_targets_are_refused() {
    let documents = [ConfigDocument {
        label: "fixture absence",
        format: ConfigFormat::McpJson,
        content: DocumentContent::Absent,
    }];
    for root in [
        PathBuf::from("relative/old-install"),
        if cfg!(windows) {
            PathBuf::from("C:/")
        } else {
            PathBuf::from("/")
        },
    ] {
        let blockers = inspect(Inspection {
            client: Client::ClaudeCode,
            coverage: Coverage::EffectiveScopesSupplied,
            documents: &documents,
            removal_roots: &[root],
            verified_router: &router(),
        });
        assert!(has(&blockers, BlockerKind::InvalidRemovalRoots));
    }
}

#[test]
fn unresolved_config_overrides_are_blockers_not_filesystem_requests() {
    for value in [
        "relative/launcher-config.json",
        "${CONFIG}/launcher-config.json",
        "~/launcher-config.json",
    ] {
        let mut entry = routed(false);
        entry["env"]["CREATOR_WORKS_LAUNCHER_CONFIG"] = json!(value);
        assert!(has(
            &json_check(
                Client::ClaudeCode,
                &json!({"mcpServers":{"creator-works":entry}})
            ),
            BlockerKind::UnresolvedLauncherConfig
        ));
    }
    let mut entry = routed(false);
    entry["env"]["CREATOR_WORKS_LAUNCHER_CONFIG"] =
        json!(base().join("${INSTALL_DIR}/launcher-config.json"));
    assert!(has(
        &json_check(
            Client::ClaudeCode,
            &json!({"mcpServers":{"creator-works":entry}})
        ),
        BlockerKind::UnresolvedLauncherConfig
    ));
}

#[test]
fn returned_blockers_are_bounded_without_becoming_an_empty_success() {
    let entries: Map<String, Value> = (0..=MAX_BLOCKERS)
        .map(|index| (format!("renamed{index}"), json!({"command":base().join("old-install/node"),"args":[base().join("old-install/banter-mcp.mjs")]})))
        .collect();
    let blockers = json_check(Client::ClaudeCode, &json!({"mcpServers":entries}));
    assert!(blockers.len() <= MAX_BLOCKERS);
    assert!(has(&blockers, BlockerKind::TooManyEntries));
}

#[test]
fn arbitrary_options_are_opaque_and_never_interpreted_as_paths() {
    let mut entry = routed(false);
    entry["custom"] =
        json!({"path":"/nonexistent/secret","command":"banter-mcp.mjs","token":"private-content"});
    entry["timeout"] = json!(37);
    let source = json!({"mcpServers":{"creator-works":entry}});
    assert!(json_check(Client::ClaudeCode, &source).is_empty());
}

#[test]
fn removal_matching_is_component_bounded_and_lexical() {
    let mut entry = routed(false);
    entry["env"]["BANTWORKS_LAUNCHER_CONFIG"] =
        json!(base().join("old-install-sibling/launcher-config.json"));
    assert!(json_check(
        Client::ClaudeCode,
        &json!({"mcpServers":{"creator-works":entry}})
    )
    .is_empty());
    entry["env"]["BANTWORKS_LAUNCHER_CONFIG"] =
        json!(base().join("old-install/../outside/launcher-config.json"));
    assert!(has(
        &json_check(
            Client::ClaudeCode,
            &json!({"mcpServers":{"creator-works":entry}})
        ),
        BlockerKind::UnresolvedLauncherConfig
    ));
}

#[test]
fn router_inside_planned_removal_is_not_retention_evidence() {
    let documents = [ConfigDocument {
        label: "absent",
        format: ConfigFormat::McpJson,
        content: DocumentContent::Absent,
    }];
    let blockers = inspect(Inspection {
        client: Client::ClaudeCode,
        coverage: Coverage::EffectiveScopesSupplied,
        documents: &documents,
        removal_roots: &roots(),
        verified_router: &base().join("old-install/creator-hub-mcp-router"),
    });
    assert!(has(&blockers, BlockerKind::RetainedRouterRemoved));
}

#[test]
fn parsed_input_and_bytes_have_identical_findings() {
    let text = json!({"mcpServers":{"creator-works":{"command":base().join("old-install/node"),"args":[base().join("old-install/banter-mcp.mjs")]}}}).to_string();
    let parsed = parse_document(ConfigFormat::McpJson, text.as_bytes()).unwrap();
    let documents = [ConfigDocument {
        label: "fixture config",
        format: ConfigFormat::McpJson,
        content: DocumentContent::Parsed(&parsed),
    }];
    let result = inspect(Inspection {
        client: Client::ClaudeCode,
        coverage: Coverage::EffectiveScopesSupplied,
        documents: &documents,
        removal_roots: &roots(),
        verified_router: &router(),
    });
    assert_eq!(
        result,
        check(
            Client::ClaudeCode,
            ConfigFormat::McpJson,
            text.as_bytes(),
            Coverage::EffectiveScopesSupplied
        )
    );
}

#[test]
fn duplicate_json_jsonc_and_toml_keys_cannot_disappear() {
    for (format, text) in [
        (
            ConfigFormat::McpJson,
            "{\"mcpServers\":{},\"mcpServers\":{}}",
        ),
        (
            ConfigFormat::OpenCodeJsonc,
            "// comment\n{\"mcp\":{},\"mcp\":{}}",
        ),
        (ConfigFormat::CodexToml, "mcp_servers={}\nmcp_servers={}\n"),
    ] {
        assert!(parse_document(format, text.as_bytes()).is_err());
    }
}

#[test]
fn invalid_oversized_and_wrong_format_documents_fail_closed() {
    assert!(has(
        &check(
            Client::ClaudeCode,
            ConfigFormat::McpJson,
            b"secret invalid contents",
            Coverage::EffectiveScopesSupplied
        ),
        BlockerKind::InvalidDocument
    ));
    assert!(parse_document(ConfigFormat::McpJson, &vec![b' '; MAX_BYTES + 1]).is_err());
    assert!(has(
        &check(
            Client::Codex,
            ConfigFormat::McpJson,
            b"{}",
            Coverage::EffectiveScopesSupplied
        ),
        BlockerKind::InvalidDocument
    ));
}

#[test]
fn public_findings_do_not_echo_commands_names_project_keys_or_env_values() {
    let source = json!({"projects":{"secret-project":{"mcpServers":{"secret-name":{"command":base().join("old-install/secret-node"),"args":["secret-argument"],"env":{"CREATOR_WORKS_LAUNCHER_CONFIG":base().join("old-install/secret-config.json"),"CUSTOM":"secret-value"}}}}}});
    let findings = serde_json::to_string(&json_check(Client::ClaudeCode, &source)).unwrap();
    for secret in [
        "secret-project",
        "secret-name",
        "secret-node",
        "secret-argument",
        "secret-config",
        "secret-value",
    ] {
        assert!(!findings.contains(secret));
    }
    assert!(findings.contains("fixture config"));
}

#[test]
fn ambiguous_wrapper_routes_are_blocked_without_shell_execution() {
    let source = json!({"mcpServers":{"renamed":{"command":"shell","args":["node old/banter-mcp.mjs --custom"]}}});
    assert!(has(
        &json_check(Client::ClaudeCode, &source),
        BlockerKind::UnverifiedCreatorRoute
    ));
}

#[test]
fn explicit_absence_is_not_an_implicit_scope_completeness_claim() {
    let documents = [ConfigDocument {
        label: "caller-checked absence",
        format: ConfigFormat::McpJson,
        content: DocumentContent::Absent,
    }];
    for coverage in [Coverage::Unknown, Coverage::EffectiveScopesSupplied] {
        let blockers = inspect(Inspection {
            client: Client::ClaudeCode,
            coverage,
            documents: &documents,
            removal_roots: &roots(),
            verified_router: &router(),
        });
        assert_eq!(
            has(&blockers, BlockerKind::UnknownScopes),
            coverage == Coverage::Unknown
        );
    }
}

#[cfg(windows)]
#[test]
fn windows_native_paths_match_case_and_separator_variants() {
    let mut entry = routed(false);
    entry["env"]["BANTWORKS_LAUNCHER_CONFIG"] =
        json!("c:\\FIXTURE\\OLD-INSTALL\\launcher-config.json");
    assert!(has(
        &json_check(
            Client::ClaudeCode,
            &json!({"mcpServers":{"creator-works":entry}})
        ),
        BlockerKind::LauncherConfigRemoved
    ));
}
