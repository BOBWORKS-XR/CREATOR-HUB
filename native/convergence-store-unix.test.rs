//! Disposable Unix root relationships exercise shared stores without selecting
//! live OS roots or changing process environment. Windows uses compact aliases
//! for the native roots, not long simulated Mac paths passed to Win32 retention.
//! These are not native Mac/Linux installer, permission or client acceptance.
use super::*;
use std::fs;

fn fixture(os: &str) -> (tempfile::TempDir, Roots) {
    let temp = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    let base = temp.path().canonicalize().unwrap();
    #[cfg(windows)]
    let base = temp.path().to_path_buf();
    #[cfg(unix)]
    let (config, local_data) = match os {
        "macos" => {
            let support = base.join("home/Library/Application Support");
            (support.clone(), support)
        }
        "linux" => (base.join("home/.config"), base.join("home/.local/share")),
        _ => unreachable!(),
    };
    #[cfg(windows)]
    let (config, local_data) = match os {
        "macos" => (base.join("m"), base.join("m")),
        "linux" => (base.join("c"), base.join("d")),
        _ => unreachable!(),
    };
    (temp, Roots { config, local_data })
}

#[test]
fn mac_linux_existing_selection_options_and_four_store_images_are_exact() {
    for os in ["macos", "linux"] {
        let (_temp, roots) = fixture(os);
        let launcher = serde_json::to_vec_pretty(&serde_json::json!({
            "channels":[{"id":"selected","name":"Keep","unity_project_path":roots.local_data.join("project"),"scene_path":null,"enabled":false,"futureChannelOption":3}],
            "active_channel_id":"selected", "mcp_server_path":roots.local_data.join("creator-works-mcp/server/creator-works-mcp.mjs"),
            "auto_start":false,"enable_custom_scripts":false,"allow_all_tests":false,"automatic_update_checks":false,
            "tool_groups":"keep","futureOption":{"keep":true}
        })).unwrap();
        let outcomes = br#"{"revision":1,"records":[]}"#.to_vec();
        let editors = serde_json::to_vec(&vec![roots.local_data.join("Unity/Editor")]).unwrap();
        for (store, body) in [
            (Store::McpCurrent, &launcher),
            (Store::McpLegacy, &launcher),
            (Store::McpHostedOutcomes, &outcomes),
            (Store::SetupEditors, &editors),
        ] {
            let path = store.path(&roots).unwrap();
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, body).unwrap();
            let saved = Snapshot::inspect(store, &roots).unwrap();
            let backup = saved
                .retain_reviewed()
                .unwrap_or_else(|error| panic!("{os} {store:?}: {error}"));
            saved.recheck().unwrap();
            backup.recheck().unwrap();
            assert_eq!(saved.bytes(), Some(body.as_slice()));
            assert_eq!(fs::read(path).unwrap(), *body);
            assert_eq!(fs::read(backup.path()).unwrap(), *body);
            if store != Store::McpHostedOutcomes {
                assert_eq!(
                    validate_import(&saved, &backup, Some(body), body).unwrap(),
                    ImportValidation::AlreadyIdentical
                );
            }
        }
        assert!(!roots.local_data.join("project").exists());
    }
}

#[test]
fn mac_linux_original_backup_survives_expected_server_field_transition_only() {
    for os in ["macos", "linux"] {
        let (_temp, roots) = fixture(os);
        let mut config = serde_json::json!({"channels":[],"active_channel_id":null,"auto_start":false,
            "mcp_server_path":roots.local_data.join("creator-works-mcp/server/creator-works-mcp.mjs"),"unknown":false});
        let original = serde_json::to_vec(&config).unwrap();
        let path = Store::McpCurrent.path(&roots).unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, &original).unwrap();
        let before = Snapshot::inspect(Store::McpCurrent, &roots).unwrap();
        let backup = before.retain_reviewed().unwrap();
        config["mcp_server_path"] =
            serde_json::json!(roots.local_data.join("creator-hub/runtime/server.mjs"));
        let transitioned = serde_json::to_vec(&config).unwrap();
        fs::write(&path, &transitioned).unwrap();
        assert!(before.recheck().is_err());
        let renewed = Snapshot::inspect(Store::McpCurrent, &roots).unwrap();
        assert!(renewed.recheck().is_ok());
        assert!(backup.verify(&renewed).is_err());
        assert!(backup.recheck().is_ok());
        assert_eq!(fs::read(backup.path()).unwrap(), original);
        fs::write(backup.path(), b"tampered").unwrap();
        assert!(backup.recheck().is_err());
        assert_eq!(fs::read(&path).unwrap(), transitioned);
        assert_eq!(fs::read(backup.path()).unwrap(), b"tampered");
    }
}

#[test]
fn mac_linux_absence_unknown_formats_and_conflicting_imports_never_supply_defaults() {
    for os in ["macos", "linux"] {
        let (_temp, roots) = fixture(os);
        for store in STORES {
            let missing = Snapshot::inspect(store, &roots).unwrap();
            assert!(missing.bytes().is_none());
            assert!(missing.retain_reviewed().is_err());
        }
        assert!(!roots.config.exists());
        assert!(!roots.local_data.exists());
        let path = Store::McpLegacy.path(&roots).unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let future = br#"{"channels":[],"auto_start":false,"schemaVersion":99}"#;
        fs::write(&path, future).unwrap();
        assert!(Snapshot::inspect(Store::McpLegacy, &roots).is_err());
        assert_eq!(fs::read(&path).unwrap(), future);
        let valid = br#"{"channels":[],"auto_start":false,"unknown":true}"#;
        fs::write(&path, valid).unwrap();
        let saved = Snapshot::inspect(Store::McpLegacy, &roots).unwrap();
        let backup = saved.retain_reviewed().unwrap();
        assert!(validate_import(&saved, &backup, Some(b"conflicting destination"), valid).is_err());
        assert_eq!(fs::read(path).unwrap(), valid);
        assert_eq!(fs::read(backup.path()).unwrap(), valid);
    }
}
