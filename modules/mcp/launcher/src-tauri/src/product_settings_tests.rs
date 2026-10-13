use super::*;

static FORM_TEST_LOCK: Mutex<()> = Mutex::new(());

struct Fixture {
    root: tempfile::TempDir,
    paths: Paths,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let paths = Paths::new(root.path()).unwrap();
        for path in [&paths.current, &paths.legacy] {
            storage::private_directory(path.parent().unwrap()).unwrap()
        }
        Self { root, paths }
    }
    fn legacy(&self) -> Vec<u8> {
        let bytes = br#"{
  "channels": [{"id":"a","name":"Old","unity_project_path":"/unchanged/project","scene_path":null,"enabled":true,"futureChannel":{"keep":true}}],
  "active_channel_id":"a", "auto_start":true, "mcp_server_path":"/old/server.mjs",
  "futureSetting":{"unknown": [1, 2, 3]}
}
"#.to_vec();
        fs::write(&self.paths.legacy, &bytes).unwrap();
        bytes
    }
    fn inspect(&self) -> Report {
        inspect(self.root.path()).unwrap()
    }
}
fn after() -> Vec<u8> {
    br#"{"channels":[],"active_channel_id":null,"auto_start":false,"futureCurrent":"keep"}"#
        .to_vec()
}

#[test]
fn existing_shared_paths_and_read_precedence_are_not_migrated() {
    let fixture = Fixture::new();
    assert_eq!(fixture.inspect().status, Status::None);
    let legacy = fixture.legacy();
    assert_eq!(fixture.inspect().status, Status::LegacyOnly);
    assert!(!fixture.paths.current.exists());
    assert!(!fixture.paths.journal.exists());
    fs::write(&fixture.paths.current, &legacy).unwrap();
    assert_eq!(fixture.inspect().status, Status::Identical);
    fs::write(&fixture.paths.current, after()).unwrap();
    assert_eq!(fixture.inspect().status, Status::Conflict);
    fs::remove_file(&fixture.paths.legacy).unwrap();
    assert_eq!(fixture.inspect().status, Status::Current);
    assert!(!fixture.paths.journal.exists());
}

#[test]
fn conflict_backup_preserves_both_originals_unknown_fields_and_survives_reinspection() {
    let fixture = Fixture::new();
    let legacy = fixture.legacy();
    let current = after();
    fs::write(&fixture.paths.current, &current).unwrap();
    let reviewed = inventory(&fixture.paths).unwrap();
    preserve(&fixture.paths, &reviewed).unwrap();
    let report = fixture.inspect();
    assert_eq!(report.status, Status::Conflict);
    assert_eq!(report.backups.len(), 2);
    assert_eq!(fs::read(&report.backups[0]).unwrap(), current);
    assert_eq!(fs::read(&report.backups[1]).unwrap(), legacy);
    assert_eq!(fs::read(&fixture.paths.current).unwrap(), current);
    assert_eq!(fs::read(&fixture.paths.legacy).unwrap(), legacy);
    assert!(!fixture.paths.journal.exists());
    preserve(&fixture.paths, &reviewed).unwrap();
    assert_eq!(fixture.inspect().backups, report.backups);
}

#[test]
fn stale_save_refuses_instead_of_overwriting_new_external_fields() {
    let fixture = Fixture::new();
    fs::write(&fixture.paths.current, after()).unwrap();
    let loaded = snapshot(&fixture.paths).unwrap();
    let external = br#"{"channels":[],"auto_start":true,"externalField":"must survive"}"#;
    fs::write(&fixture.paths.current, external).unwrap();
    // This is the prior save_config publication primitive. Its before-image backup
    // does not stop a stale UI document from replacing the newer external fields.
    crate::atomic_write(
        &fixture.paths.current,
        std::str::from_utf8(&after()).unwrap(),
    )
    .unwrap();
    assert_eq!(fs::read(&fixture.paths.current).unwrap(), after());
    fs::write(&fixture.paths.current, external).unwrap();
    assert!(save_snapshot(&fixture.paths, &loaded, &after())
        .unwrap_err()
        .contains("changed since"));
    assert_eq!(fs::read(&fixture.paths.current).unwrap(), external);
    assert!(!fixture.paths.journal.exists());
}

#[test]
fn first_save_backup_failure_leaves_original_legacy_and_missing_current_untouched() {
    let fixture = Fixture::new();
    let original = fixture.legacy();
    let loaded = snapshot(&fixture.paths).unwrap();
    preserve(&fixture.paths, &loaded).unwrap();
    let retained = backup_path(&fixture.paths.legacy, &original);
    fs::write(&retained, b"externally modified backup").unwrap();
    assert!(save_snapshot(&fixture.paths, &loaded, &after()).is_err());
    assert!(!fixture.paths.current.exists());
    assert_eq!(fs::read(&fixture.paths.legacy).unwrap(), original);
    assert_eq!(fs::read(&retained).unwrap(), b"externally modified backup");
}

#[test]
fn launcher_and_channel_unknown_fields_survive_the_existing_serializer_on_first_save() {
    let fixture = Fixture::new();
    fixture.legacy();
    let loaded = snapshot(&fixture.paths).unwrap();
    let mut config: crate::LauncherConfig =
        serde_json::from_slice(loaded.legacy.as_deref().unwrap()).unwrap();
    config.auto_start = false;
    let after = serde_json::to_vec_pretty(&config).unwrap();
    save_snapshot(&fixture.paths, &loaded, &after).unwrap();
    let saved: serde_json::Value =
        serde_json::from_slice(&fs::read(&fixture.paths.current).unwrap()).unwrap();
    assert_eq!(
        saved["futureSetting"]["unknown"],
        serde_json::json!([1, 2, 3])
    );
    assert_eq!(saved["channels"][0]["futureChannel"]["keep"], true);
    assert_eq!(saved["mcp_server_path"], "/old/server.mjs");
}

#[test]
fn current_precedence_ignores_invalid_inactive_legacy_on_load_and_save() {
    let fixture = Fixture::new();
    fs::write(&fixture.paths.current, after()).unwrap();
    fs::write(&fixture.paths.legacy, b"inactive invalid legacy").unwrap();
    let loaded = snapshot(&fixture.paths).unwrap();
    assert!(loaded.legacy.is_none());
    save_snapshot(&fixture.paths, &loaded, &after()).unwrap();
    assert_eq!(
        fs::read(&fixture.paths.legacy).unwrap(),
        b"inactive invalid legacy"
    );
    assert!(inspect(fixture.root.path()).is_err());
}

#[test]
fn background_read_after_external_edit_never_renews_the_owned_form_snapshot() {
    let _form_test = FORM_TEST_LOCK.lock().unwrap();
    struct Restore(Option<Snapshot>);
    impl Drop for Restore {
        fn drop(&mut self) {
            *LOADED.lock().unwrap() = self.0.take();
        }
    }
    let fixture = Fixture::new();
    fs::write(&fixture.paths.current, after()).unwrap();
    let form_before = snapshot(&fixture.paths).unwrap();
    let previous = LOADED.lock().unwrap().replace(form_before.clone());
    let _restore = Restore(previous);
    let external =
        br#"{"channels":[],"auto_start":true,"externalField":"must survive background polling"}"#;
    fs::write(&fixture.paths.current, external).unwrap();

    // These are the actual product-status reader and the existing built-in loader
    // reused by discovery. Neither owns the form or may renew its before-image.
    inspect(fixture.root.path()).unwrap();
    let background =
        crate::load_builtin_config(&fixture.paths.current, &fixture.paths.legacy, || {
            panic!("Existing current settings require no default or migration")
        })
        .unwrap();
    assert_eq!(
        background.extra["externalField"],
        "must survive background polling"
    );
    let held_before = LOADED.lock().unwrap().clone().unwrap();
    assert_eq!(held_before, form_before);
    assert!(save_snapshot(&fixture.paths, &held_before, &after()).is_err());
    assert_eq!(fs::read(&fixture.paths.current).unwrap(), external);
    assert!(!fixture.paths.journal.exists());

    // The adapter's only renewing caller is the owned explicit form load handler.
    assert_eq!(
        include_str!("hosted_commands.rs")
            .matches("product_settings::load_form(")
            .count(),
        1
    );
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
#[test]
fn one_click_operation_uses_fresh_server_settings_not_unsaved_form_and_keeps_form_snapshot() {
    let _form_test = FORM_TEST_LOCK.lock().unwrap();
    struct Restore(Option<Snapshot>);
    impl Drop for Restore {
        fn drop(&mut self) {
            *LOADED.lock().unwrap() = self.0.take();
        }
    }
    let fixture = Fixture::new();
    let original = fixture.legacy();
    fs::write(&fixture.paths.current, &original).unwrap();
    let form_before = snapshot(&fixture.paths).unwrap();
    let previous = LOADED.lock().unwrap().replace(form_before.clone());
    let _restore = Restore(previous);
    let mut unsaved_form: crate::LauncherConfig = serde_json::from_slice(&original).unwrap();
    unsaved_form
        .extra
        .insert("notSavedInUi".into(), serde_json::json!(true));
    let mut fresh: serde_json::Value = serde_json::from_slice(&original).unwrap();
    fresh["futureSetting"]["serverEdit"] = serde_json::json!("keep");
    let fresh_bytes = serde_json::to_vec(&fresh).unwrap();
    fs::write(&fixture.paths.current, &fresh_bytes).unwrap();
    let (mut actual, operation) =
        load_operation_at(fixture.paths.clone(), || panic!("Current store exists")).unwrap();
    assert!(!actual.extra.contains_key("notSavedInUi"));
    assert_eq!(actual.extra["futureSetting"]["serverEdit"], "keep");
    assert_eq!(LOADED.lock().unwrap().as_ref(), Some(&form_before));
    let server = fixture.root.path().join("server.mjs");
    fs::write(&server, "// fixture only").unwrap();
    unsaved_form.mcp_server_path = server.to_string_lossy().into_owned();
    actual.mcp_server_path = server.to_string_lossy().into_owned();
    actual.auto_start = true;
    commit_operation(actual, operation).unwrap();
    let saved: serde_json::Value =
        serde_json::from_slice(&fs::read(&fixture.paths.current).unwrap()).unwrap();
    assert_eq!(saved["futureSetting"]["serverEdit"], "keep");
    assert_eq!(saved["channels"][0]["futureChannel"]["keep"], true);
    assert!(saved.get("notSavedInUi").is_none());
    assert_eq!(LOADED.lock().unwrap().as_ref(), Some(&form_before));
    assert!(save_snapshot(
        &fixture.paths,
        &form_before,
        &encoded_config(unsaved_form).unwrap()
    )
    .is_err());
    let report = fixture.inspect();
    assert!(report.recovery[0].completed);
    assert_eq!(
        fs::read(&report.recovery[0].files[0].before_image).unwrap(),
        fresh_bytes
    );
}

#[test]
fn one_click_operation_commit_refuses_changes_after_its_own_load_before_any_later_step() {
    let fixture = Fixture::new();
    fixture.legacy();
    let (mut config, operation) =
        load_operation_at(fixture.paths.clone(), || panic!("Legacy store exists")).unwrap();
    let server = fixture.root.path().join("server.mjs");
    fs::write(&server, "// fixture only").unwrap();
    config.mcp_server_path = server.to_string_lossy().into_owned();
    let external = after();
    fs::write(&fixture.paths.legacy, &external).unwrap();
    let mut later_step_ran = false;
    let result = (|| {
        commit_operation(config, operation)?;
        later_step_ran = true;
        Ok::<_, String>(())
    })();
    assert!(result.is_err());
    assert!(!later_step_ran);
    assert!(!fixture.paths.current.exists());
    assert_eq!(fs::read(&fixture.paths.legacy).unwrap(), external);
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
#[test]
fn operation_first_save_keeps_legacy_unknown_fields_and_exact_before_image() {
    let fixture = Fixture::new();
    let legacy = fixture.legacy();
    let (mut config, operation) =
        load_operation_at(fixture.paths.clone(), || panic!("Legacy store exists")).unwrap();
    let server = fixture.root.path().join("server.mjs");
    fs::write(&server, "// fixture only").unwrap();
    config.mcp_server_path = server.to_string_lossy().into_owned();
    commit_operation(config, operation).unwrap();
    assert_eq!(fs::read(&fixture.paths.legacy).unwrap(), legacy);
    assert_eq!(
        fs::read(backup_path(&fixture.paths.legacy, &legacy)).unwrap(),
        legacy
    );
    let saved: serde_json::Value =
        serde_json::from_slice(&fs::read(&fixture.paths.current).unwrap()).unwrap();
    assert_eq!(
        saved["futureSetting"]["unknown"],
        serde_json::json!([1, 2, 3])
    );
}

fn removal_fixture(
    client: &str,
    path: &Path,
    publish: impl FnOnce(&Path, &[u8], &str) -> Result<(), String>,
) -> Result<(), String> {
    match client {
        "codex" => crate::remove_codex_mcp_config_at(path, publish),
        "claude" => crate::remove_claude_mcp_config_at(path, publish),
        "antigravity" => crate::remove_antigravity_mcp_config_at(path, publish),
        "opencode" => crate::remove_opencode_mcp_config_at(path, publish),
        _ => panic!("Unknown test client"),
    }
}
fn removal_original(client: &str) -> String {
    if client == "codex" {
        return "# retained comment\nfuture='keep'\n[mcp_servers.other]\ncommand='other'\n[mcp_servers.creator-works]\ncommand='node'\nargs=['server.mjs']\n[mcp_servers.creator-works.env]\nCREATOR_WORKS_CONFIG_OWNER='creator-hub-v1'\n".into();
    }
    if client == "opencode" {
        return "{ // retained comment\n\"future\":\"keep\",\"mcp\":{\"other\":{\"command\":[\"other\"]},\"creator-works\":{\"command\":[\"node\",\"server.mjs\"],\"environment\":{\"CREATOR_WORKS_CONFIG_OWNER\":\"creator-hub-v1\"}}}}".into();
    }
    r#"{"future":"keep","mcpServers":{"other":{"command":"other"},"creator-works":{"command":"node","args":["server.mjs"],"env":{"CREATOR_WORKS_CONFIG_OWNER":"creator-hub-v1"}}}}"#.into()
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
#[test]
fn reachable_removal_hooks_pass_exact_parsed_before_image_and_refuse_external_edits() {
    for client in ["codex", "claude", "antigravity", "opencode"] {
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path().join("client-config");
        let original = removal_original(client);
        fs::write(&path, &original).unwrap();
        let external = "external modification after ownership/parse review";
        let result = removal_fixture(client, &path, |path, before, after| {
            assert_eq!(before, original.as_bytes());
            fs::write(path, external).unwrap();
            crate::client_setup_write::commit_fixture(
                "Removal fixture",
                path,
                Some(before),
                after,
                &fixture.path().join("journals"),
            )
        });
        assert!(result.is_err(), "{client}");
        assert_eq!(fs::read_to_string(&path).unwrap(), external, "{client}");
    }
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
#[test]
fn reachable_removal_hooks_preserve_unrelated_fields_and_exact_backups() {
    for client in ["codex", "claude", "antigravity", "opencode"] {
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path().join("client-config");
        let original = removal_original(client);
        fs::write(&path, &original).unwrap();
        let journals = fixture.path().join("journals");
        removal_fixture(client, &path, |path, before, after| {
            crate::client_setup_write::commit_fixture(
                "Removal fixture",
                path,
                Some(before),
                after,
                &journals,
            )
        })
        .unwrap();
        let saved = fs::read_to_string(&path).unwrap();
        if client == "codex" {
            let parsed: toml_edit::Document = saved.parse().unwrap();
            assert_eq!(parsed["future"].as_str(), Some("keep"));
            assert!(parsed["mcp_servers"].get("other").is_some());
            assert!(parsed["mcp_servers"].get("creator-works").is_none());
            assert!(saved.contains("# retained comment"));
        } else {
            let parsed = if client == "opencode" {
                crate::jsonc::parse(&saved).unwrap()
            } else {
                serde_json::from_str(&saved).unwrap()
            };
            let key = if client == "opencode" {
                "mcp"
            } else {
                "mcpServers"
            };
            assert_eq!(parsed["future"], "keep");
            assert!(parsed[key].get("other").is_some());
            assert!(parsed[key].get("creator-works").is_none());
        }
        let directory = fs::read_dir(&journals)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| path.is_dir())
            .unwrap();
        let report = recovery::Transaction::open(&directory, std::slice::from_ref(&path))
            .unwrap()
            .inspect()
            .unwrap();
        assert!(report.completed);
        assert_eq!(
            fs::read(&report.files[0].before_image).unwrap(),
            original.as_bytes()
        );
    }
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
#[test]
fn project_launcher_preference_hook_is_bound_to_the_loaded_document() {
    let fixture = tempfile::tempdir().unwrap();
    let project = fixture.path().to_str().unwrap();
    let state = fixture.path().join(".bantworks-mcp/state");
    fs::create_dir_all(&state).unwrap();
    let path = state.join("launcher-settings.json");
    let original = br#"{"future":{"keep":true},"allowAllTests":true}"#;
    fs::write(&path, original).unwrap();
    crate::update_unity_launcher_settings_using(
        project,
        |value| {
            value["enableCustomScripts"] = serde_json::json!(true);
        },
        |path, before, after| {
            assert_eq!(before, Some(original.as_slice()));
            commit_document_fixture("Project settings fixture", path, before, after)
        },
    )
    .unwrap();
    let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["future"]["keep"], true);
    assert_eq!(saved["allowAllTests"], true);
    assert_eq!(saved["enableCustomScripts"], true);
    let external = br#"{"external":"keep","allowAllTests":false}"#;
    let result = crate::update_unity_launcher_settings_using(
        project,
        |value| {
            value["allowAllTests"] = serde_json::json!(true);
            fs::write(&path, external).unwrap();
        },
        |path, before, after| {
            commit_document_fixture("Project settings fixture", path, before, after)
        },
    );
    assert!(result.is_err());
    assert_eq!(fs::read(&path).unwrap(), external);
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
#[test]
fn feedback_hook_preserves_unknown_preferences_and_stops_on_stale_second_file() {
    let fixture = tempfile::tempdir().unwrap();
    fs::create_dir_all(fixture.path().join("Assets")).unwrap();
    fs::create_dir_all(fixture.path().join("ProjectSettings")).unwrap();
    let folder = fixture.path().join(".bantworks-mcp/feedback");
    fs::create_dir_all(&folder).unwrap();
    let settings = folder.join("settings.json");
    let check_ins = folder.join("check-ins.json");
    let original = br#"{"feedbackEnabled":false,"futurePreference":{"keep":true}}"#;
    let original_check_ins = br#"{"lastPromptAt":1,"tasks":10,"futureCounter":"keep"}"#;
    fs::write(&settings, original).unwrap();
    fs::write(&check_ins, original_check_ins).unwrap();
    let project = fixture.path().to_str().unwrap();
    crate::feedback::write_using(project, true, true, true, |path, before, after| {
        if path == settings {
            assert_eq!(before, Some(original.as_slice()));
        }
        if path == check_ins {
            assert_eq!(before, Some(original_check_ins.as_slice()));
        }
        commit_document_fixture("Feedback fixture", path, before, after)
    })
    .unwrap();
    let saved: serde_json::Value = serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
    assert_eq!(saved["feedbackEnabled"], true);
    assert_eq!(saved["usageCheckInsEnabled"], true);
    assert_eq!(saved["futurePreference"]["keep"], true);
    let saved_check_ins: serde_json::Value =
        serde_json::from_slice(&fs::read(&check_ins).unwrap()).unwrap();
    assert_eq!(saved_check_ins["futureCounter"], "keep");
    assert_eq!(saved_check_ins["tasks"], 0);
    let external = br#"{"feedbackEnabled":false,"external":"must survive"}"#;
    let result =
        crate::feedback::write_using(project, false, false, true, |path, before, after| {
            let result = commit_document_fixture("Feedback fixture", path, before, after);
            if path == check_ins {
                fs::write(&settings, external).unwrap();
            }
            result
        });
    assert!(result.is_err());
    assert_eq!(fs::read(&settings).unwrap(), external);
    assert!(!folder.join(".write-lock").exists());
    assert_eq!(
        fs::read(backup_path(&settings, original)).unwrap(),
        original
    );
}

#[test]
fn removal_does_not_publish_missing_or_unowned_entries() {
    for client in ["codex", "claude", "antigravity", "opencode"] {
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path().join("client-config");
        removal_fixture(client, &path, |_, _, _| panic!("No creation on removal")).unwrap();
        let original = removal_original(client).replace("creator-hub-v1", "foreign-owner");
        fs::write(&path, &original).unwrap();
        assert!(removal_fixture(client, &path, |_, _, _| panic!(
            "No removal without ownership"
        ))
        .is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
    }
}

#[test]
fn standalone_project_writer_hook_retains_the_original_serialized_schema() {
    let fixture = tempfile::tempdir().unwrap();
    let project = fixture.path().to_str().unwrap();
    crate::update_unity_launcher_settings_using(
        project,
        |value| {
            value["allowAllTests"] = serde_json::json!(false);
        },
        |path, _, after| crate::atomic_write(path, after),
    )
    .unwrap();
    let path = fixture
        .path()
        .join(".bantworks-mcp/state/launcher-settings.json");
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "{\n  \"allowAllTests\": false\n}"
    );
}

#[test]
fn stale_backup_review_and_corrupt_retained_backup_refuse_without_repair() {
    let fixture = Fixture::new();
    let legacy = fixture.legacy();
    let loaded = snapshot(&fixture.paths).unwrap();
    fs::write(&fixture.paths.legacy, after()).unwrap();
    assert!(preserve(&fixture.paths, &loaded).is_err());
    assert!(!backup_path(&fixture.paths.legacy, &legacy).exists());
    let loaded = snapshot(&fixture.paths).unwrap();
    preserve(&fixture.paths, &loaded).unwrap();
    let retained = backup_path(&fixture.paths.legacy, loaded.legacy.as_deref().unwrap());
    fs::write(&retained, b"external backup change").unwrap();
    assert!(preserve(&fixture.paths, &loaded).is_err());
    assert_eq!(fs::read(&retained).unwrap(), b"external backup change");
    assert_eq!(fs::read(&fixture.paths.legacy).unwrap(), after());
}

#[test]
fn explicit_legacy_based_first_save_keeps_exact_legacy_backup_not_an_implicit_copy() {
    let fixture = Fixture::new();
    let legacy = fixture.legacy();
    let loaded = snapshot(&fixture.paths).unwrap();
    let saved = save_snapshot(&fixture.paths, &loaded, &after()).unwrap();
    assert_eq!(saved.current.as_deref(), Some(after().as_slice()));
    assert_eq!(fs::read(&fixture.paths.legacy).unwrap(), legacy);
    assert_eq!(
        fs::read(backup_path(&fixture.paths.legacy, &legacy)).unwrap(),
        legacy
    );
    assert_ne!(fs::read(&fixture.paths.current).unwrap(), legacy);
}

#[test]
fn concurrently_created_current_file_refuses_even_identical_new_content() {
    let fixture = Fixture::new();
    let loaded = snapshot(&fixture.paths).unwrap();
    fs::write(&fixture.paths.current, after()).unwrap();
    assert!(save_snapshot(&fixture.paths, &loaded, &after()).is_err());
    assert_eq!(fs::read(&fixture.paths.current).unwrap(), after());
    assert!(!fixture.paths.journal.exists());
}

#[test]
fn failed_first_publication_keeps_legacy_source_and_before_image() {
    let fixture = Fixture::new();
    let legacy = fixture.legacy();
    let loaded = snapshot(&fixture.paths).unwrap();
    // A destination directory is never a settings file and cannot be overwritten.
    fs::create_dir(&fixture.paths.current).unwrap();
    assert!(save_snapshot(&fixture.paths, &loaded, &after()).is_err());
    assert!(fixture.paths.current.is_dir());
    assert_eq!(fs::read(&fixture.paths.legacy).unwrap(), legacy);
}

#[cfg(windows)]
#[test]
fn current_save_uses_durable_existing_engine_receipts_and_exact_before_image() {
    let fixture = Fixture::new();
    let original = fixture.legacy();
    fs::write(&fixture.paths.current, &original).unwrap();
    let loaded = snapshot(&fixture.paths).unwrap();
    let saved = save_snapshot(&fixture.paths, &loaded, &after()).unwrap();
    assert_eq!(saved.current.as_deref(), Some(after().as_slice()));
    let report = fixture.inspect();
    assert_eq!(report.recovery.len(), 1);
    assert!(report.recovery[0].completed);
    assert_eq!(
        fs::read(&report.recovery[0].files[0].before_image).unwrap(),
        original
    );
    assert_eq!(
        fs::read(&report.recovery[0].files[0].after_image).unwrap(),
        after()
    );
    save_snapshot(&fixture.paths, &saved, &after()).unwrap();
    assert_eq!(fixture.inspect().recovery.len(), 1);
    assert_eq!(fs::read(&fixture.paths.legacy).unwrap(), original);
}

#[cfg(windows)]
#[test]
fn failed_existing_save_retains_durable_images_and_does_not_replace_locked_original() {
    let fixture = Fixture::new();
    let original = fixture.legacy();
    fs::write(&fixture.paths.current, &original).unwrap();
    let loaded = snapshot(&fixture.paths).unwrap();
    let transaction = recovery::Transaction::prepare(
        &fixture.paths.journal,
        vec![recovery::ReviewedWrite::new(
            "MCP launcher settings",
            &fixture.paths.current,
            &original,
            &after(),
        )],
    )
    .unwrap();
    let held = storage::protected_options()
        .open(&fixture.paths.current)
        .unwrap();
    let result = transaction.resume(|_| true);
    assert!(result.is_err() || !result.unwrap().completed);
    assert_eq!(fs::read(&fixture.paths.current).unwrap(), original);
    drop(held);
    let report = transaction.inspect().unwrap();
    assert_eq!(fs::read(&report.files[0].before_image).unwrap(), original);
    assert_eq!(fs::read(&report.files[0].after_image).unwrap(), after());
    assert_eq!(snapshot(&fixture.paths).unwrap().current, loaded.current);
}

#[test]
fn invalid_oversized_and_ambiguous_inputs_refuse_without_backup() {
    let fixture = Fixture::new();
    for invalid in [
        b"not JSON".to_vec(),
        vec![b' '; MAX_CONFIG + 1],
        br#"{"channels":0,"auto_start":false}"#.to_vec(),
    ] {
        fs::write(&fixture.paths.legacy, &invalid).unwrap();
        assert!(inspect(fixture.root.path()).is_err());
        assert_eq!(fs::read(&fixture.paths.legacy).unwrap(), invalid);
        assert!(!fixture.paths.journal.exists());
    }
    assert!(inspect(Path::new("relative")).is_err());
    assert!(inspect(&fixture.root.path().join("..")).is_err());
}

#[cfg(unix)]
#[test]
fn linked_settings_are_never_read_or_backed_up() {
    let fixture = Fixture::new();
    let legacy = fixture.legacy();
    fs::remove_file(&fixture.paths.legacy).unwrap();
    let external = fixture.root.path().join("external.json");
    fs::write(&external, &legacy).unwrap();
    std::os::unix::fs::symlink(&external, &fixture.paths.legacy).unwrap();
    assert!(inspect(fixture.root.path()).is_err());
    assert!(!fixture.paths.journal.exists());
    assert_eq!(fs::read(external).unwrap(), legacy);
}
