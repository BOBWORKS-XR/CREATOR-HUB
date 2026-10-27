use super::*;

static FORM_TEST_LOCK: Mutex<()> = Mutex::new(());

struct OwnedTempDir {
    _owner: tempfile::TempDir,
    path: PathBuf,
}
impl OwnedTempDir {
    fn new() -> Self {
        let owner = tempfile::tempdir().unwrap();
        // Resolve only our new fixture root, not a protected settings or link target.
        #[cfg(unix)]
        let path = owner.path().canonicalize().unwrap();
        #[cfg(not(unix))]
        let path = owner.path().to_path_buf();
        Self {
            _owner: owner,
            path,
        }
    }
    fn path(&self) -> &Path {
        &self.path
    }
}

struct Fixture {
    root: OwnedTempDir,
    paths: Paths,
}
impl Fixture {
    fn new() -> Self {
        let root = OwnedTempDir::new();
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

fn pending_review_save(fixture: &Fixture, path: &Path) -> recovery::Transaction {
    let before = after();
    let mut changed: serde_json::Value = serde_json::from_slice(&before).unwrap();
    changed["futureCurrent"] = "reviewed change".into();
    fs::write(path, &before).unwrap();
    recovery::Transaction::prepare(
        &fixture.paths.journal,
        vec![recovery::ReviewedWrite::new(
            "MCP settings review fixture",
            path,
            &before,
            &serde_json::to_vec(&changed).unwrap(),
        )],
    )
    .unwrap()
}

#[test]
fn review_receipt_preserves_report_wire_and_uses_only_the_actual_backup_decision() {
    for status in [
        Status::Current,
        Status::LegacyOnly,
        Status::Identical,
        Status::Conflict,
    ] {
        for approved in [false, true] {
            let fixture = Fixture::new();
            let legacy = fixture.legacy();
            match status {
                Status::Current => {
                    fs::write(&fixture.paths.current, &legacy).unwrap();
                    fs::remove_file(&fixture.paths.legacy).unwrap();
                }
                Status::LegacyOnly => {}
                Status::Identical => fs::write(&fixture.paths.current, &legacy).unwrap(),
                Status::Conflict => fs::write(&fixture.paths.current, after()).unwrap(),
                Status::None => unreachable!(),
            }
            let before = inventory(&fixture.paths).unwrap();
            let mut prompts = 0;
            let receipt = review_with(
                &fixture.paths,
                |_| panic!("No recovery"),
                |_| {
                    prompts += 1;
                    approved
                },
            )
            .unwrap();
            assert_eq!(prompts, 1);
            assert_eq!(receipt.report.status, status);
            assert_eq!(receipt.approved, approved);
            assert_eq!(inventory(&fixture.paths).unwrap(), before);
            let mut service_wire = serde_json::to_value(&receipt).unwrap();
            assert_eq!(
                service_wire.as_object_mut().unwrap().remove("approved"),
                Some(approved.into())
            );
            let report_wire = serde_json::to_value(&receipt.report).unwrap();
            assert_eq!(service_wire, report_wire);
            assert!(report_wire.get("approved").is_none());
            assert_eq!(
                report_wire,
                serde_json::to_value(fixture.inspect()).unwrap()
            );
            assert_eq!(receipt.report.backups.is_empty(), !approved);
        }
    }
}

#[test]
fn review_receipt_without_a_prompt_is_not_approval() {
    let fixture = Fixture::new();
    let receipt = review_with(
        &fixture.paths,
        |_| panic!("No recovery"),
        |_| panic!("No settings"),
    )
    .unwrap();
    assert_eq!(receipt.report.status, Status::None);
    assert!(!receipt.approved);
    assert!(!fixture.paths.current.exists());
    assert!(!fixture.paths.legacy.exists());
    assert!(!fixture.paths.journal.exists());
}

#[test]
fn review_receipt_records_recovery_approval_or_decline_without_inference() {
    for approved in [false, true] {
        let fixture = Fixture::new();
        let transaction = pending_review_save(&fixture, &fixture.paths.current);
        let pending = transaction.inspect().unwrap().journal.join("pending.json");
        let before = fs::read(&pending).unwrap();
        let mut prompts = 0;
        let receipt = review_with(
            &fixture.paths,
            |_| {
                prompts += 1;
                approved
            },
            |_| panic!("Recovery path must not ask for a backup decision"),
        )
        .unwrap();
        assert_eq!(prompts, 1);
        assert_eq!(receipt.approved, approved);
        assert_eq!(receipt.report.recovery.len(), 1);
        assert_eq!(receipt.report.recovery[0].completed, approved);
        assert_eq!(fs::read(pending).unwrap(), before);
        if !approved {
            assert_eq!(fs::read(&fixture.paths.current).unwrap(), after());
        }
    }
}

#[test]
fn review_receipt_is_false_if_any_recovery_decision_is_declined() {
    let fixture = Fixture::new();
    pending_review_save(&fixture, &fixture.paths.current);
    pending_review_save(&fixture, &fixture.paths.legacy);
    let mut prompts = 0;
    let receipt = review_with(
        &fixture.paths,
        |_| {
            prompts += 1;
            prompts == 1
        },
        |_| panic!("Recovery path"),
    )
    .unwrap();
    assert_eq!(prompts, 2);
    assert!(!receipt.approved);
    assert_eq!(
        receipt
            .report
            .recovery
            .iter()
            .filter(|report| report.completed)
            .count(),
        1
    );
}

#[test]
fn review_receipt_does_not_reuse_historical_approval_after_cancel() {
    let fixture = Fixture::new();
    let transaction = pending_review_save(&fixture, &fixture.paths.current);
    assert!(transaction.resume(|_| true).unwrap().completed);
    let before = inventory(&fixture.paths).unwrap();
    let receipt = review_with(
        &fixture.paths,
        |_| panic!("Completed history is not a new decision"),
        |_| false,
    )
    .unwrap();
    assert!(!receipt.approved);
    assert!(receipt.report.recovery[0].historical_completed);
    assert_eq!(inventory(&fixture.paths).unwrap(), before);
}

#[test]
fn review_receipt_cannot_report_success_after_an_approved_stale_backup() {
    let fixture = Fixture::new();
    fixture.legacy();
    assert!(review_with(
        &fixture.paths,
        |_| panic!("No recovery"),
        |paths| {
            fs::write(&paths.legacy, after()).unwrap();
            true
        }
    )
    .is_err());
    assert_eq!(fs::read(&fixture.paths.legacy).unwrap(), after());
    assert!(!fixture.paths.current.exists());
}

#[test]
fn review_receipt_is_service_only_and_native_dialog_answers_stay_explicit() {
    let _: fn(&tauri::AppHandle, &Path) -> Result<Report, String> = native_review;
    let _: fn(&tauri::AppHandle, &Path) -> Result<ReviewReceipt, String> = native_review_decision;
    let hosted = include_str!("hosted_commands.rs");
    assert!(hosted.contains("product_settings::native_review(app, &base)?"));
    assert!(!hosted.contains("native_review_decision"));
    let service = include_str!("service.rs");
    assert!(service.contains("if command == \"review_product_settings\""));
    assert!(service.contains("product_settings::native_review_decision("));
    assert!(service.contains("serde_json::from_value::<NoArgs>(args)"));
    assert!(crate::hosted_commands::needs_workflow(
        "review_product_settings"
    ));
}

#[test]
fn reviewed_server_transition_changes_only_path_and_preserves_identical_stores() {
    let fixture = Fixture::new();
    let original = fixture.legacy();
    fs::write(&fixture.paths.current, &original).unwrap();
    let saved = inventory(&fixture.paths).unwrap();
    let server = fixture.root.path().join("verified/server.mjs");
    let writes = server_writes(&fixture.paths, &saved, &server, |path| {
        Ok(path == Path::new("/old/server.mjs"))
    })
    .unwrap();
    assert_eq!(writes.len(), 2);
    let mut expected: serde_json::Value = serde_json::from_slice(&original).unwrap();
    expected["mcp_server_path"] = serde_json::json!(server);
    for write in &writes {
        assert_eq!(write.before, original);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&write.after).unwrap(),
            expected
        );
    }
    preserve(&fixture.paths, &saved).unwrap();
    let transaction = recovery::Transaction::prepare(
        &fixture.paths.journal,
        writes
            .iter()
            .map(|write| {
                recovery::ReviewedWrite::new(
                    "MCP retained server path",
                    &write.path,
                    &write.before,
                    &write.after,
                )
            })
            .collect(),
    )
    .unwrap();
    assert!(transaction.resume(|_| true).unwrap().completed);
    assert_eq!(fixture.inspect().status, Status::Identical);
    assert_eq!(fixture.inspect().recovery.len(), 1);
    assert_eq!(
        fs::read(backup_path(&fixture.paths.current, &original)).unwrap(),
        original
    );
    assert_eq!(
        fs::read(backup_path(&fixture.paths.legacy, &original)).unwrap(),
        original
    );
    let saved = inventory(&fixture.paths).unwrap();
    assert!(server_writes(&fixture.paths, &saved, &server, |_| Err(
        "must not inspect old server".into()
    ))
    .unwrap()
    .is_empty());
}

#[test]
fn formatting_and_key_order_equivalence_does_not_rewrite_settings_and_keeps_exact_backups() {
    let template = Fixture::new();
    let value: serde_json::Value = serde_json::from_slice(&template.legacy()).unwrap();
    let current = serde_json::to_vec_pretty(&value).unwrap();
    let reversed = format!(
        "{{{}}}",
        value
            .as_object()
            .unwrap()
            .iter()
            .rev()
            .map(|(key, value)| format!("{}:{value}", serde_json::to_string(key).unwrap()))
            .collect::<Vec<_>>()
            .join(",")
    )
    .into_bytes();
    for legacy in [
        serde_json::to_vec(&value).unwrap(),
        format!(
            "{}\r\n",
            std::str::from_utf8(&current).unwrap().replace('\n', "\r\n")
        )
        .into_bytes(),
        format!(" \t\n{} \r\n", std::str::from_utf8(&current).unwrap()).into_bytes(),
        reversed,
    ] {
        let fixture = Fixture::new();
        fs::write(&fixture.paths.current, &current).unwrap();
        fs::write(&fixture.paths.legacy, &legacy).unwrap();
        assert_ne!(current, legacy);
        let before = inventory(&fixture.paths).unwrap();
        let report = fixture.inspect();
        assert_eq!(report.status, Status::Identical);
        assert!(report.backups.is_empty());
        assert!(report.recovery.is_empty());
        assert!(server_writes(
            &fixture.paths,
            &before,
            Path::new("/old/server.mjs"),
            |_| { panic!("An unchanged server path must not require recognition") }
        )
        .unwrap()
        .is_empty());
        assert_eq!(inventory(&fixture.paths).unwrap(), before);
        assert!(!fixture.paths.journal.exists());
        preserve(&fixture.paths, &before).unwrap();
        for (path, bytes) in [
            (&fixture.paths.current, &current),
            (&fixture.paths.legacy, &legacy),
        ] {
            assert_eq!(fs::read(backup_path(path, bytes)).unwrap(), *bytes);
            assert_eq!(fs::read(path).unwrap(), *bytes);
        }
        // Semantic equality does not make a differently formatted backup valid.
        fs::write(backup_path(&fixture.paths.current, &current), &legacy).unwrap();
        assert!(inspect_paths(&fixture.paths).is_err());
        assert!(preserve(&fixture.paths, &before).is_err());
        assert_eq!(inventory(&fixture.paths).unwrap(), before);
    }
    assert!(settings_equivalent(
        br#"{"channels":[],"auto_start":false,"future":{"a":1,"b":2}}"#,
        br#"{"auto_start":false,"channels":[],"future":{"b":2,"a":1}}"#,
    )
    .unwrap());
}

#[test]
fn semantic_conflict_checks_keep_real_preferences_references_and_unknown_fields_distinct() {
    let fixture = Fixture::new();
    let original = fixture.legacy();
    let config: serde_json::Value = serde_json::from_slice(&original).unwrap();
    fs::write(&fixture.paths.current, &original).unwrap();
    for (pointer, value) in [
        ("/auto_start", serde_json::json!(false)),
        ("/active_channel_id", serde_json::json!(null)),
        (
            "/mcp_server_path",
            serde_json::json!("/different/server.mjs"),
        ),
        (
            "/channels/0/unity_project_path",
            serde_json::json!("/different/project"),
        ),
        ("/futureSetting/unknown", serde_json::json!([3, 2, 1])),
    ] {
        let mut changed = config.clone();
        *changed.pointer_mut(pointer).unwrap() = value;
        let legacy = serde_json::to_vec(&changed).unwrap();
        fs::write(&fixture.paths.legacy, &legacy).unwrap();
        assert_eq!(fixture.inspect().status, Status::Conflict);
        let saved = inventory(&fixture.paths).unwrap();
        assert!(server_writes(
            &fixture.paths,
            &saved,
            Path::new("/verified/server.mjs"),
            |_| { panic!("A genuine settings conflict cannot authorize a server change") }
        )
        .is_err());
        assert_eq!(inventory(&fixture.paths).unwrap(), saved);
        assert!(!fixture.paths.journal.exists());
    }
    assert!(!settings_equivalent(
        br#"{"channels":[],"auto_start":false}"#,
        br#"{"channels":[],"auto_start":false,"enable_custom_scripts":false}"#,
    )
    .unwrap());
}

#[test]
fn semantic_equivalence_refuses_invalid_types_jsonc_and_duplicate_unknown_keys() {
    let fixture = Fixture::new();
    let valid = after();
    for invalid in [
        "{",
        "null",
        "{}",
        r#"{"channels":[],"auto_start":"false"}"#,
        r#"{"channels":[],"auto_start":false,"auto_start":false}"#,
        r#"{"channels":[],"auto_start":false,"future":{"a":1,"a":1}}"#,
        r#"{"channels":[],"auto_start":false,"future":{"a":1,"\u0061":1}}"#,
        r#"{"channels":[],"auto_start":false,}"#,
        r#"{/*comment*/"channels":[],"auto_start":false}"#,
    ] {
        for (current, legacy) in [
            (invalid.as_bytes(), invalid.as_bytes()),
            (valid.as_slice(), invalid.as_bytes()),
        ] {
            assert!(settings_equivalent(current, legacy).is_err());
            fs::write(&fixture.paths.current, current).unwrap();
            fs::write(&fixture.paths.legacy, legacy).unwrap();
            assert!(inspect_paths(&fixture.paths).is_err());
            let saved = Snapshot {
                current: Some(current.to_vec()),
                legacy: Some(legacy.to_vec()),
            };
            assert!(server_writes(
                &fixture.paths,
                &saved,
                Path::new("/verified/server.mjs"),
                |_| Ok(true)
            )
            .is_err());
            assert_eq!(fs::read(&fixture.paths.current).unwrap(), current);
            assert_eq!(fs::read(&fixture.paths.legacy).unwrap(), legacy);
            assert!(!fixture.paths.journal.exists());
        }
    }
    assert!(settings_equivalent(&after(), &[0xff]).is_err());
    assert!(settings_equivalent(&after(), &vec![b' '; MAX_CONFIG + 1]).is_err());
}

#[test]
fn formatting_change_after_approval_is_stale_for_server_save_import_and_backup_boundaries() {
    for index in 0..2 {
        let fixture = Fixture::new();
        let legacy = fixture.legacy();
        let current =
            serde_json::to_vec(&serde_json::from_slice::<serde_json::Value>(&legacy).unwrap())
                .unwrap();
        fs::write(&fixture.paths.current, &current).unwrap();
        assert_eq!(fixture.inspect().status, Status::Identical);
        let approved = inventory(&fixture.paths).unwrap();
        let loaded = snapshot(&fixture.paths).unwrap();
        let server = fixture.root.path().join("verified/server.mjs");
        let review = server_review(&fixture.paths, &approved, &server, |_| Ok(true)).unwrap();
        let consent = ConvergenceSettings {
            paths: fixture.paths.clone(),
            original: approved.clone(),
            imported: approved.clone(),
            server: server.clone(),
            review,
            #[cfg(unix)]
            previous: UnixPreviousServers::new(vec![], 0, "fixture"),
        };
        let (path, before) = if index == 0 {
            (&fixture.paths.current, &current)
        } else {
            (&fixture.paths.legacy, &legacy)
        };
        let mut changed = before.clone();
        changed.push(b'\n');
        fs::write(path, &changed).unwrap();
        assert_eq!(fixture.inspect().status, Status::Identical);
        assert!(consent.recheck_original().is_err());
        assert!(consent.recheck_imported().is_err());
        assert!(finish_server_review(
            &fixture.paths,
            &approved,
            &server,
            &consent.review,
            true,
            |_| Ok(true)
        )
        .err()
        .unwrap()
        .contains("changed during review"));
        assert!(preserve(&fixture.paths, &approved).is_err());
        if index == 0 {
            assert!(save_snapshot(&fixture.paths, &loaded, &after()).is_err());
        }
        assert_eq!(fs::read(path).unwrap(), changed);
        assert!(fixture.inspect().backups.is_empty());
        assert!(!fixture.paths.journal.exists());
    }
}

#[test]
fn semantically_equal_documents_do_not_clear_pending_product_settings_recovery() {
    let fixture = Fixture::new();
    let transaction = pending_review_save(&fixture, &fixture.paths.current);
    let current = fs::read(&fixture.paths.current).unwrap();
    let mut legacy = current.clone();
    legacy.push(b'\n');
    fs::write(&fixture.paths.legacy, &legacy).unwrap();
    let original = inventory(&fixture.paths).unwrap();
    let pending_path = transaction.inspect().unwrap().journal.join("pending.json");
    let pending = fs::read(&pending_path).unwrap();
    let report = fixture.inspect();
    assert_eq!(report.status, Status::Identical);
    assert!(report
        .recovery
        .iter()
        .any(|r| !r.completed && !r.historical_completed));
    let consent = ConvergenceSettings {
        paths: fixture.paths.clone(),
        original: original.clone(),
        imported: original.clone(),
        server: fixture.root.path().join("verified/server.mjs"),
        review: ServerReview {
            writes: vec![],
            requires_replacement: false,
        },
        #[cfg(unix)]
        previous: UnixPreviousServers::new(vec![], 0, "fixture"),
    };
    assert!(consent.recheck_imported().is_err());
    assert_eq!(fs::read(pending_path).unwrap(), pending);
    assert_eq!(inventory(&fixture.paths).unwrap(), original);
}

#[test]
fn custom_conflicting_or_duplicate_server_settings_are_not_rewritten() {
    let fixture = Fixture::new();
    let original = fixture.legacy();
    let saved = inventory(&fixture.paths).unwrap();
    let server = fixture.root.path().join("verified/server.mjs");
    assert!(server_writes(&fixture.paths, &saved, &server, |_| Ok(false)).is_err());
    fs::write(&fixture.paths.current, after()).unwrap();
    assert!(server_writes(
        &fixture.paths,
        &inventory(&fixture.paths).unwrap(),
        &server,
        |_| Ok(true)
    )
    .is_err());
    fs::remove_file(&fixture.paths.current).unwrap();
    fs::write(
        &fixture.paths.legacy,
        br#"{"channels":[],"auto_start":false,"mcp_server_path":"one","mcp_server_path":"two"}"#,
    )
    .unwrap();
    assert!(inventory(&fixture.paths).is_err());
    fs::write(&fixture.paths.legacy, &original).unwrap();
    assert_eq!(fs::read(&fixture.paths.legacy).unwrap(), original);
    assert!(!fixture.paths.journal.exists());
}

#[test]
fn missing_server_field_can_be_reviewed_without_inventing_other_defaults() {
    let fixture = Fixture::new();
    fs::write(&fixture.paths.current, after()).unwrap();
    let server = fixture.root.path().join("verified/server.mjs");
    let writes = server_writes(
        &fixture.paths,
        &inventory(&fixture.paths).unwrap(),
        &server,
        |_| Err("unused".into()),
    )
    .unwrap();
    assert_eq!(writes.len(), 1);
    let mut expected: serde_json::Value = serde_json::from_slice(&after()).unwrap();
    expected["mcp_server_path"] = serde_json::json!(server);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&writes[0].after).unwrap(),
        expected
    );
}

struct ServerReviewFixture {
    settings: Fixture,
    old: PathBuf,
    server: PathBuf,
    original: Vec<u8>,
    clients: Vec<(PathBuf, Vec<u8>)>,
}
impl ServerReviewFixture {
    fn new() -> Self {
        let settings = Fixture::new();
        let old = settings
            .root
            .path()
            .join("hub-cache/generations/unretained-old/server/creator-works-mcp.mjs");
        let server = settings
            .root
            .path()
            .join("managed-runtime/current/server/creator-works-mcp.mjs");
        // Inert files only; verifying the real replacement belongs to the native caller.
        for (path, bytes) in [
            (&old, b"unverified old generation fixture".as_slice()),
            (&server, b"replacement runtime fixture".as_slice()),
        ] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }
        let mut value: serde_json::Value = serde_json::from_slice(&settings.legacy()).unwrap();
        value["mcp_server_path"] = serde_json::json!(old);
        value["auto_start"] = false.into();
        value["enable_custom_scripts"] = true.into();
        value["allow_all_tests"] = false.into();
        value["automatic_update_checks"] = false.into();
        value["tool_groups"] = "core,scene,custom".into();
        value["channels"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "id": "b", "name": "Disabled project", "enabled": false,
                "unity_project_path": "/second/unchanged/project",
                "scene_path": "Assets/Scenes/Keep.unity",
                "futureChannel": {"nested": [false, null, {"keep": "exact"}]}
            }));
        value["active_channel_id"] = "b".into();
        value["futurePreference"] = serde_json::json!({"keep": [null, false, "verbatim"]});
        let mut original = serde_json::to_vec_pretty(&value).unwrap();
        original.push(b'\n');
        for path in [&settings.paths.current, &settings.paths.legacy] {
            fs::write(path, &original).unwrap();
        }
        let clients = ["codex", "claude", "antigravity", "opencode"]
            .into_iter()
            .map(|client| {
                let path = settings.root.path().join("client-configs").join(client);
                let bytes = removal_original(client).into_bytes();
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(&path, &bytes).unwrap();
                (path, bytes)
            })
            .collect();
        Self {
            settings,
            old,
            server,
            original,
            clients,
        }
    }

    fn assert_other_files_unchanged(&self) {
        for (path, bytes) in &self.clients {
            assert_eq!(&fs::read(path).unwrap(), bytes);
        }
        assert_eq!(
            fs::read(&self.old).unwrap(),
            b"unverified old generation fixture"
        );
        assert_eq!(
            fs::read(&self.server).unwrap(),
            b"replacement runtime fixture"
        );
    }

    fn assert_no_review_artifacts(&self) {
        assert!(!self.settings.paths.journal.exists());
        for path in [&self.settings.paths.current, &self.settings.paths.legacy] {
            assert!(!backup_path(path, &self.original).parent().unwrap().exists());
        }
        self.assert_other_files_unchanged();
    }

    fn assert_original_stores(&self) {
        for path in [&self.settings.paths.current, &self.settings.paths.legacy] {
            assert_eq!(fs::read(path).unwrap(), self.original);
        }
    }
}

#[test]
fn server_review_unverified_old_generation_stages_replacement_without_writes() {
    let fixture = ServerReviewFixture::new();
    let paths = &fixture.settings.paths;
    let before = inventory(paths).unwrap();
    assert!(server_writes(paths, &before, &fixture.server, |_| Ok(false)).is_err());
    let review = server_review(paths, &before, &fixture.server, |path| {
        assert_eq!(path, fixture.old.as_path());
        Ok(false)
    })
    .unwrap();
    assert!(review.requires_replacement);
    assert_eq!(review.writes.len(), 2);
    let mut expected: serde_json::Value = serde_json::from_slice(&fixture.original).unwrap();
    expected["mcp_server_path"] = serde_json::json!(fixture.server);
    for (write, path) in review.writes.iter().zip([&paths.current, &paths.legacy]) {
        assert_eq!(&write.path, path);
        assert_eq!(write.before, fixture.original);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&write.after).unwrap(),
            expected
        );
    }
    assert_eq!(inventory(paths).unwrap(), before);
    fixture.assert_original_stores();
    fixture.assert_no_review_artifacts();
}

#[test]
fn server_review_explicit_cancel_has_no_writes_journal_or_backups() {
    for recognized in [false, true] {
        let fixture = ServerReviewFixture::new();
        let paths = &fixture.settings.paths;
        let before = inventory(paths).unwrap();
        let review = server_review(paths, &before, &fixture.server, |_| Ok(recognized)).unwrap();
        let result = finish_server_review(paths, &before, &fixture.server, &review, false, |_| {
            panic!("Cancellation must return before revalidation or publication")
        });
        let error = result.err().expect("Cancellation must not report success");
        assert!(error.to_ascii_lowercase().contains("cancel"), "{error}");
        assert_eq!(inventory(paths).unwrap(), before);
        fixture.assert_original_stores();
        fixture.assert_no_review_artifacts();
    }
}

#[test]
fn server_review_explicit_replacement_preserves_every_other_field_client_and_exact_backup() {
    for recognition_error in [false, true] {
        let fixture = ServerReviewFixture::new();
        let paths = &fixture.settings.paths;
        let before = inventory(paths).unwrap();
        let recognizes = |path: &Path| {
            assert_eq!(path, fixture.old.as_path());
            if recognition_error {
                Err("No matching retained descriptor for the old generation".into())
            } else {
                Ok(false)
            }
        };
        let review = server_review(paths, &before, &fixture.server, recognizes).unwrap();
        assert!(review.requires_replacement);
        fixture.assert_original_stores();
        fixture.assert_no_review_artifacts();
        let historical = after();
        for path in [&paths.current, &paths.legacy] {
            let backup = backup_path(path, &historical);
            storage::private_directory(backup.parent().unwrap()).unwrap();
            fs::write(backup, &historical).unwrap();
        }
        let transition =
            finish_server_review(paths, &before, &fixture.server, &review, true, recognizes)
                .unwrap();
        assert!(transition.changed);
        assert_eq!(transition.server, fixture.server);
        let mut expected: serde_json::Value = serde_json::from_slice(&fixture.original).unwrap();
        expected["mcp_server_path"] = serde_json::json!(fixture.server);
        for path in [&paths.current, &paths.legacy] {
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&fs::read(path).unwrap()).unwrap(),
                expected
            );
            assert_eq!(
                fs::read(backup_path(path, &fixture.original)).unwrap(),
                fixture.original
            );
            assert_eq!(
                fs::read(backup_path(path, &historical)).unwrap(),
                historical
            );
        }
        fixture.assert_other_files_unchanged();
        let report = fixture.settings.inspect();
        assert_eq!(report.status, Status::Identical);
        assert_eq!(report.recovery.len(), 1);
        let receipt = &report.recovery[0];
        assert!(receipt.completed);
        assert_eq!(receipt.files.len(), 2);
        for (file, write) in receipt.files.iter().zip(&review.writes) {
            assert_eq!(file.path, fs::canonicalize(&write.path).unwrap());
            assert_eq!(fs::read(&file.before_image).unwrap(), fixture.original);
            assert_eq!(fs::read(&file.after_image).unwrap(), write.after);
            assert_eq!(fs::read(&file.path).unwrap(), write.after);
        }
    }
}

#[test]
fn server_review_recognized_to_unverified_or_error_race_rejects_before_publication() {
    for recognition_error in [false, true] {
        let fixture = ServerReviewFixture::new();
        let paths = &fixture.settings.paths;
        let before = inventory(paths).unwrap();
        let review = server_review(paths, &before, &fixture.server, |_| Ok(true)).unwrap();
        assert!(!review.requires_replacement);
        assert!(
            finish_server_review(paths, &before, &fixture.server, &review, true, |_| {
                if recognition_error {
                    Err("The previously recognized old payload changed during review".into())
                } else {
                    Ok(false)
                }
            })
            .is_err()
        );
        assert_eq!(inventory(paths).unwrap(), before);
        fixture.assert_original_stores();
        fixture.assert_no_review_artifacts();
    }
}

#[test]
fn server_review_changed_current_or_legacy_config_after_staging_is_not_overwritten() {
    for change_current in [false, true] {
        let fixture = ServerReviewFixture::new();
        let paths = &fixture.settings.paths;
        let before = inventory(paths).unwrap();
        let review = server_review(paths, &before, &fixture.server, |_| Ok(false)).unwrap();
        let path = if change_current {
            &paths.current
        } else {
            &paths.legacy
        };
        let mut external: serde_json::Value = serde_json::from_slice(&fixture.original).unwrap();
        external["futurePreference"]["externalEdit"] = "keep this concurrent edit".into();
        fs::write(path, serde_json::to_vec_pretty(&external).unwrap()).unwrap();
        let changed = inventory(paths).unwrap();
        assert!(
            finish_server_review(paths, &before, &fixture.server, &review, true, |_| {
                panic!("Inventory changes must refuse before recognition")
            })
            .is_err()
        );
        assert_eq!(inventory(paths).unwrap(), changed);
        fixture.assert_no_review_artifacts();
    }
}

#[test]
fn server_review_recognition_error_requires_replacement_consent_and_never_auto_adopts() {
    let fixture = ServerReviewFixture::new();
    let paths = &fixture.settings.paths;
    let before = inventory(paths).unwrap();
    assert!(server_writes(paths, &before, &fixture.server, |_| Err(
        "unreadable descriptor".into()
    ))
    .is_err());
    let review = server_review(paths, &before, &fixture.server, |_| {
        Err("unreadable descriptor".into())
    })
    .unwrap();
    assert!(review.requires_replacement);
    assert_eq!(review.writes.len(), 2);
    fixture.assert_original_stores();
    fixture.assert_no_review_artifacts();
    assert!(
        finish_server_review(paths, &before, &fixture.server, &review, false, |_| {
            panic!("Recognition errors are not approval")
        })
        .is_err()
    );
    assert_eq!(inventory(paths).unwrap(), before);
    fixture.assert_no_review_artifacts();
}

#[test]
fn server_review_changed_recognition_or_write_plan_is_not_implicitly_approved() {
    for change in [
        "recognition",
        "before",
        "after",
        "destination",
        "target",
        "missing-write",
    ] {
        let fixture = ServerReviewFixture::new();
        let paths = &fixture.settings.paths;
        let before = inventory(paths).unwrap();
        let mut review = server_review(paths, &before, &fixture.server, |_| Ok(false)).unwrap();
        let mut target = fixture.server.clone();
        match change {
            "recognition" => review.requires_replacement = false,
            "before" => review.writes[0].before.push(b' '),
            "after" => {
                let mut value: serde_json::Value =
                    serde_json::from_slice(&review.writes[0].after).unwrap();
                value["auto_start"] = true.into();
                review.writes[0].after = serde_json::to_vec_pretty(&value).unwrap();
            }
            "destination" => review.writes[0].path = fixture.clients[0].0.clone(),
            "target" => target = fixture.old.clone(),
            "missing-write" => {
                review.writes.pop();
            }
            _ => unreachable!(),
        }
        assert!(
            finish_server_review(paths, &before, &target, &review, true, |_| Ok(false)).is_err(),
            "{change}"
        );
        assert_eq!(inventory(paths).unwrap(), before);
        fixture.assert_original_stores();
        fixture.assert_no_review_artifacts();
    }
}

#[test]
fn server_review_known_path_approval_and_subsequent_noop_keep_existing_behavior() {
    let fixture = ServerReviewFixture::new();
    let paths = &fixture.settings.paths;
    let before = inventory(paths).unwrap();
    let review = server_review(paths, &before, &fixture.server, |path| {
        Ok(path == fixture.old.as_path())
    })
    .unwrap();
    assert!(!review.requires_replacement);
    assert_eq!(review.writes.len(), 2);
    fixture.assert_no_review_artifacts();
    let transition = finish_server_review(paths, &before, &fixture.server, &review, true, |path| {
        Ok(path == fixture.old.as_path())
    })
    .unwrap();
    assert!(transition.changed);
    assert_eq!(transition.server, fixture.server);
    let saved = inventory(paths).unwrap();
    let noop = server_review(paths, &saved, &fixture.server, |_| {
        panic!("Already current")
    })
    .unwrap();
    assert!(!noop.requires_replacement);
    assert!(noop.writes.is_empty());
    let transition = finish_server_review(paths, &saved, &fixture.server, &noop, true, |_| {
        panic!("Already current")
    })
    .unwrap();
    assert!(!transition.changed);
    assert_eq!(transition.server, fixture.server);
    assert_eq!(inventory(paths).unwrap(), saved);
    assert_eq!(fixture.settings.inspect().recovery.len(), 1);
    for path in [&paths.current, &paths.legacy] {
        assert_eq!(
            fs::read(backup_path(path, &fixture.original)).unwrap(),
            fixture.original
        );
        let mut expected: serde_json::Value = serde_json::from_slice(&fixture.original).unwrap();
        expected["mcp_server_path"] = serde_json::json!(fixture.server);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&fs::read(path).unwrap()).unwrap(),
            expected
        );
    }
    fixture.assert_other_files_unchanged();
}

#[test]
fn server_review_empty_missing_or_blank_server_settings_do_not_require_replacement() {
    for layout in ["none", "current", "legacy", "both", "blank"] {
        let fixture = Fixture::new();
        let paths = &fixture.paths;
        let mut original = after();
        if layout == "blank" {
            let mut value: serde_json::Value = serde_json::from_slice(&original).unwrap();
            value["mcp_server_path"] = "".into();
            original = serde_json::to_vec_pretty(&value).unwrap();
        }
        if matches!(layout, "current" | "both" | "blank") {
            fs::write(&paths.current, &original).unwrap();
        }
        if matches!(layout, "legacy" | "both" | "blank") {
            fs::write(&paths.legacy, &original).unwrap();
        }
        let before = inventory(paths).unwrap();
        let server = fixture.root.path().join("verified/server.mjs");
        let review = server_review(paths, &before, &server, |_| panic!("No old server")).unwrap();
        assert!(!review.requires_replacement);
        assert_eq!(
            review.writes.len(),
            match layout {
                "none" => 0,
                "current" | "legacy" => 1,
                _ => 2,
            }
        );
        assert_eq!(inventory(paths).unwrap(), before);
        assert!(!paths.journal.exists());
        let transition = finish_server_review(paths, &before, &server, &review, true, |_| {
            panic!("No old server")
        })
        .unwrap();
        assert_eq!(transition.changed, layout != "none");
        assert_eq!(transition.server, server);
        for (path, bytes) in [
            (&paths.current, &before.current),
            (&paths.legacy, &before.legacy),
        ] {
            if let Some(bytes) = bytes {
                let mut expected: serde_json::Value = serde_json::from_slice(bytes).unwrap();
                expected["mcp_server_path"] = serde_json::json!(server);
                assert_eq!(
                    serde_json::from_slice::<serde_json::Value>(&fs::read(path).unwrap()).unwrap(),
                    expected
                );
                assert_eq!(fs::read(backup_path(path, bytes)).unwrap(), *bytes);
            } else {
                assert!(!path.exists());
            }
        }
        assert_eq!(
            fixture.inspect().recovery.len(),
            usize::from(layout != "none")
        );
        if layout == "none" {
            assert!(!paths.journal.exists());
        }
    }
}

#[test]
fn server_review_conflicting_stores_are_not_downgraded_to_replacement_consent() {
    let fixture = ServerReviewFixture::new();
    let paths = &fixture.settings.paths;
    fs::write(&paths.current, after()).unwrap();
    let before = inventory(paths).unwrap();
    assert!(server_review(paths, &before, &fixture.server, |_| {
        panic!("Conflicting settings must refuse before server recognition")
    })
    .is_err());
    assert_eq!(inventory(paths).unwrap(), before);
    fixture.assert_no_review_artifacts();
}

const PREVIOUS_UNIX_FIXTURE: &[u8] = b"disposable pinned previous release server; never executed";

fn unix_fixture_servers(fixture: &Fixture) -> (PathBuf, UnixPreviousServers) {
    #[cfg(unix)]
    let base = fixture.root.path().canonicalize().unwrap();
    #[cfg(not(unix))]
    let base = fixture.root.path().to_path_buf();
    let native_data = base.join("native-data");
    let home = base.join("native-home");
    let paths = unix_previous_paths("linux", &native_data, Some(&home)).unwrap();
    let old = paths[0].clone();
    fs::create_dir_all(old.parent().unwrap()).unwrap();
    fs::write(&old, PREVIOUS_UNIX_FIXTURE).unwrap();
    let previous = UnixPreviousServers::new(
        paths,
        PREVIOUS_UNIX_FIXTURE.len(),
        &format!("{:x}", Sha256::digest(PREVIOUS_UNIX_FIXTURE)),
    );
    (old, previous)
}

fn unix_fixture_settings(fixture: &Fixture, old: &Path) -> Vec<u8> {
    let mut value: serde_json::Value = serde_json::from_slice(&fixture.legacy()).unwrap();
    value["mcp_server_path"] = serde_json::json!(old);
    value["auto_start"] = false.into();
    value["allow_all_tests"] = false.into();
    let before = serde_json::to_vec_pretty(&value).unwrap();
    fs::write(&fixture.paths.legacy, &before).unwrap();
    fs::write(&fixture.paths.current, &before).unwrap();
    before
}

#[test]
fn unix_native_paths_are_finite_and_independent_of_configured_server() {
    let fixture = Fixture::new();
    let data = fixture.root.path().join("native-data");
    let home = fixture.root.path().join("native-home");
    let linux = unix_previous_paths("linux", &data, Some(&home)).unwrap();
    assert_eq!(linux.len(), 7);
    assert_eq!(
        linux[0],
        data.join("creator-works-mcp/server/creator-works-mcp.mjs")
    );
    assert_eq!(linux[3], data.join("bantworks-mcp/server/banter-mcp.mjs"));
    assert_eq!(linux[5], data.join("banter-mcp/server/banter-mcp.mjs"));
    assert_eq!(
        linux[6],
        Path::new("/usr/lib/Creator Works MCP/server/creator-works-mcp.mjs")
    );
    let mac = unix_previous_paths("macos", &data, Some(&home)).unwrap();
    assert_eq!(mac.len(), 8);
    assert_eq!(
        mac[6],
        Path::new(
            "/Applications/Creator Works MCP.app/Contents/Resources/server/creator-works-mcp.mjs"
        )
    );
    assert_eq!(
        mac[7],
        home.join(
            "Applications/Creator Works MCP.app/Contents/Resources/server/creator-works-mcp.mjs"
        )
    );
    assert!(unix_previous_paths("freebsd", &data, Some(&home)).is_err());
    assert_eq!(UNIX_277_SERVER_BYTES, 1_221_209);
    assert_eq!(
        UNIX_277_SERVER_SHA,
        "8d7cbe21d3b3691d6b1aa052846d6ee36f4274c18bd4228c6d4a73583be74149"
    );
    assert!(!data.exists());
    assert!(!home.exists());
}

#[test]
fn unix_recognizer_rechecks_captured_server_and_keeps_exact_backups_through_transaction() {
    let fixture = Fixture::new();
    let (old, previous) = unix_fixture_servers(&fixture);
    let original = unix_fixture_settings(&fixture, &old);
    let before = inventory(&fixture.paths).unwrap();
    let server = fixture.root.path().join("verified/server.mjs");
    let recognizes = |path: &Path| previous.recognizes(path);
    let writes = server_writes(&fixture.paths, &before, &server, recognizes).unwrap();
    assert_eq!(previous.captured.borrow().len(), 1);
    assert_eq!(fs::read(&fixture.paths.current).unwrap(), original);
    assert!(!fixture.paths.journal.exists());
    // Simulated native approval; reuse the original server binding, not a new
    // hash derived from the configuration or a freshly changed source file.
    assert_eq!(
        server_writes(&fixture.paths, &before, &server, recognizes)
            .unwrap()
            .len(),
        2
    );
    assert_eq!(previous.captured.borrow().len(), 1);
    preserve(&fixture.paths, &before).unwrap();
    let transaction = recovery::Transaction::prepare(
        &fixture.paths.journal,
        writes
            .iter()
            .map(|write| {
                recovery::ReviewedWrite::new(
                    "MCP retained server path",
                    &write.path,
                    &write.before,
                    &write.after,
                )
            })
            .collect(),
    )
    .unwrap();
    assert!(transaction.resume(|_| true).unwrap().completed);
    let mut expected: serde_json::Value = serde_json::from_slice(&original).unwrap();
    expected["mcp_server_path"] = serde_json::json!(server);
    for path in [&fixture.paths.current, &fixture.paths.legacy] {
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&fs::read(path).unwrap()).unwrap(),
            expected
        );
        assert_eq!(fs::read(backup_path(path, &original)).unwrap(), original);
    }
    assert_eq!(fs::read(old).unwrap(), PREVIOUS_UNIX_FIXTURE);
    assert!(server_writes(
        &fixture.paths,
        &inventory(&fixture.paths).unwrap(),
        &server,
        recognizes
    )
    .unwrap()
    .is_empty());
}

#[test]
fn unix_changed_or_missing_previous_payload_after_review_refuses_before_publication() {
    for remove in [false, true] {
        let fixture = Fixture::new();
        let (old, previous) = unix_fixture_servers(&fixture);
        let original = unix_fixture_settings(&fixture, &old);
        let before = inventory(&fixture.paths).unwrap();
        let server = fixture.root.path().join("verified/server.mjs");
        let recognizes = |path: &Path| previous.recognizes(path);
        assert_eq!(
            server_writes(&fixture.paths, &before, &server, recognizes)
                .unwrap()
                .len(),
            2
        );
        if remove {
            fs::remove_file(&old).unwrap();
        } else {
            let mut changed = PREVIOUS_UNIX_FIXTURE.to_vec();
            changed[0] ^= 1;
            fs::write(&old, changed).unwrap();
        }
        assert!(server_writes(&fixture.paths, &before, &server, recognizes).is_err());
        assert_eq!(fs::read(&fixture.paths.current).unwrap(), original);
        assert_eq!(fs::read(&fixture.paths.legacy).unwrap(), original);
        assert!(!fixture.paths.journal.exists());
    }
}

#[test]
fn unix_custom_same_bytes_bad_pin_and_conflicting_stores_are_not_adopted() {
    let fixture = Fixture::new();
    let (old, previous) = unix_fixture_servers(&fixture);
    let custom = fixture.root.path().join("custom/creator-works-mcp.mjs");
    fs::create_dir(custom.parent().unwrap()).unwrap();
    fs::write(&custom, PREVIOUS_UNIX_FIXTURE).unwrap();
    let original = unix_fixture_settings(&fixture, &custom);
    let server = fixture.root.path().join("verified/server.mjs");
    assert!(server_writes(
        &fixture.paths,
        &inventory(&fixture.paths).unwrap(),
        &server,
        |path| previous.recognizes(path)
    )
    .is_err());
    assert!(previous.captured.borrow().is_empty());
    assert_eq!(fs::read(&fixture.paths.current).unwrap(), original);
    let original = unix_fixture_settings(&fixture, &old);
    let bad = UnixPreviousServers::new(
        vec![old.clone()],
        PREVIOUS_UNIX_FIXTURE.len(),
        &"0".repeat(64),
    );
    assert!(server_writes(
        &fixture.paths,
        &inventory(&fixture.paths).unwrap(),
        &server,
        |path| bad.recognizes(path)
    )
    .is_err());
    fs::write(&fixture.paths.current, after()).unwrap();
    assert!(server_writes(
        &fixture.paths,
        &inventory(&fixture.paths).unwrap(),
        &server,
        |_| panic!("conflict must refuse before recognition")
    )
    .is_err());
    assert_eq!(fs::read(&fixture.paths.legacy).unwrap(), original);
    assert!(!fixture.paths.journal.exists());
}

#[test]
#[ignore = "Requires freshly checksum-verified public v2.7.7 extraction in an explicit proof directory"]
fn public_unix_277_pin_recognizes_extracted_fixture_before_and_after_review() {
    let proof = std::env::var_os("CREATOR_UNIX_277_PROOF_DIR")
        .expect("explicit public-package proof directory, never live native data");
    let body = storage::read_bytes(&PathBuf::from(proof).join("deb/server/creator-works-mcp.mjs"))
        .unwrap()
        .expect("freshly extracted public server");
    assert_eq!(body.len(), UNIX_277_SERVER_BYTES);
    assert_eq!(format!("{:x}", Sha256::digest(&body)), UNIX_277_SERVER_SHA);
    let fixture = Fixture::new();
    let (old, _) = unix_fixture_servers(&fixture);
    fs::write(&old, &body).unwrap();
    let previous = UnixPreviousServers::new(
        vec![old.clone()],
        UNIX_277_SERVER_BYTES,
        UNIX_277_SERVER_SHA,
    );
    let original = unix_fixture_settings(&fixture, &old);
    let before = inventory(&fixture.paths).unwrap();
    let server = fixture.root.path().join("verified/server.mjs");
    for _ in 0..2 {
        let writes = server_writes(&fixture.paths, &before, &server, |path| {
            previous.recognizes(path)
        })
        .unwrap();
        assert_eq!(writes.len(), 2);
        assert!(writes.iter().all(|write| write.before == original));
        assert_eq!(previous.captured.borrow().len(), 1);
        assert_eq!(fs::read(&fixture.paths.current).unwrap(), original);
    }
    let mut changed = body;
    changed[0] ^= 1;
    fs::write(&old, changed).unwrap();
    assert!(server_writes(&fixture.paths, &before, &server, |path| {
        previous.recognizes(path)
    })
    .is_err());
    assert!(!fixture.paths.journal.exists());
    assert_eq!(fs::read(&fixture.paths.current).unwrap(), original);
}

#[cfg(unix)]
#[test]
fn unix_linked_cache_payload_and_live_path_selection_in_unit_tests_refuse() {
    let fixture = Fixture::new();
    let (old, previous) = unix_fixture_servers(&fixture);
    let real = fixture.root.path().canonicalize().unwrap().join("real.mjs");
    fs::write(&real, PREVIOUS_UNIX_FIXTURE).unwrap();
    fs::remove_file(&old).unwrap();
    std::os::unix::fs::symlink(&real, &old).unwrap();
    assert!(previous.recognizes(&old).is_err());
    assert!(UnixPreviousServers::native().is_err());
    assert_eq!(fs::read(real).unwrap(), PREVIOUS_UNIX_FIXTURE);
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
fn product_recovery_inspection_keeps_a_missing_leaf_absent() {
    let fixture = Fixture::new();
    fixture.legacy();
    let transaction = pending_review_save(&fixture, &fixture.paths.current);
    let journal = transaction.inspect().unwrap().journal;
    let pending = fs::read(journal.join("pending.json")).unwrap();
    fs::remove_file(&fixture.paths.current).unwrap();
    let before = inventory(&fixture.paths).unwrap();
    let report = inspect_paths(&fixture.paths).unwrap();
    assert_eq!(report.status, Status::LegacyOnly);
    assert_eq!(report.recovery.len(), 1);
    assert_eq!(report.recovery[0].files.len(), 1);
    assert_eq!(
        report.recovery[0].files[0].status,
        recovery::Status::ExternalChange
    );
    assert!(!report.recovery[0].completed);
    assert!(report.backups.is_empty());
    assert!(!fixture.paths.current.exists());
    assert_eq!(inventory(&fixture.paths).unwrap(), before);
    assert_eq!(fs::read(journal.join("pending.json")).unwrap(), pending);
    assert!(!journal.join("0.intent.json").exists());
    assert!(!journal.join("completed.json").exists());
    assert_eq!(
        fs::read(&report.recovery[0].files[0].before_image).unwrap(),
        after()
    );
}

#[test]
fn product_recovery_refuses_a_foreign_journal_even_with_identical_settings_bytes() {
    let fixture = Fixture::new();
    fixture.legacy();
    fs::write(&fixture.paths.current, after()).unwrap();
    let foreign = fixture.root.path().join("foreign.json");
    let transaction = pending_review_save(&fixture, &foreign);
    let journal = transaction.inspect().unwrap().journal;
    let pending = fs::read(journal.join("pending.json")).unwrap();
    let before = inventory(&fixture.paths).unwrap();
    let error = inspect_paths(&fixture.paths).err().unwrap();
    assert_eq!(
        error,
        "Recovery journal includes an unapproved settings path."
    );
    assert_eq!(inventory(&fixture.paths).unwrap(), before);
    assert_eq!(fs::read(&foreign).unwrap(), after());
    assert_eq!(fs::read(journal.join("pending.json")).unwrap(), pending);
    assert!(!journal.join("0.intent.json").exists());
    assert!(!journal.join("completed.json").exists());
    assert_eq!(
        transaction.inspect().unwrap().files[0].status,
        recovery::Status::Ready
    );
}

#[cfg(windows)]
#[test]
#[ignore = "Live read-only probe; requires CREATOR_MCP_READONLY_RECOVERY_PROBE=read-only"]
fn windows_readonly_recovery_probe() {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};

    assert!(
        std::env::var("CREATOR_MCP_READONLY_RECOVERY_PROBE").as_deref() == Ok("read-only"),
        "Live read-only probe requires CREATOR_MCP_READONLY_RECOVERY_PROBE=read-only"
    );
    let base = dirs::config_dir().expect("Read-only probe status=config-directory-unavailable");
    let paths =
        Paths::new(&base).unwrap_or_else(|_| panic!("Read-only probe status=config-paths-refused"));
    // Inspection opens hub.lock with create(true); pin an existing file without
    // delete sharing so inspection cannot create or replace that lock.
    let lock_path = paths.journal.join("hub.lock");
    storage::reject_links(&lock_path)
        .unwrap_or_else(|_| panic!("Read-only probe status=journal-lock-path-refused"));
    let existing_lock = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(&lock_path)
        .unwrap_or_else(|_| panic!("Read-only probe status=existing-journal-lock-required"));
    assert!(
        existing_lock
            .metadata()
            .is_ok_and(|metadata| metadata.is_file()),
        "Read-only probe status=journal-lock-not-file"
    );
    let before = inventory(&paths)
        .unwrap_or_else(|_| panic!("Read-only probe status=before-snapshot-failed"));
    let inspected = inspect_paths(&paths);
    let after = inventory(&paths)
        .unwrap_or_else(|_| panic!("Read-only probe status=after-snapshot-failed"));
    let unchanged = before == after;
    eprintln!(
        "readonly-recovery-probe inspection_ok={} settings_unchanged={} current_bytes={} legacy_bytes={}",
        inspected.is_ok(),
        unchanged,
        before.current.as_ref().map_or(0, Vec::len),
        before.legacy.as_ref().map_or(0, Vec::len)
    );
    fn bounded(path: PathBuf) -> String {
        path.to_string_lossy().chars().take(1024).collect()
    }
    for (label, path) in [("current", &paths.current), ("legacy", &paths.legacy)] {
        let canonical_file = fs::canonicalize(path).ok().map(bounded);
        let canonical_parent_leaf = fs::canonicalize(path.parent().unwrap())
            .ok()
            .map(|parent| parent.join(path.file_name().unwrap()))
            .map(bounded);
        eprintln!(
            "readonly-recovery-probe {label} canonical_file={canonical_file:?} canonical_parent_leaf={canonical_parent_leaf:?}"
        );
    }
    // Equality diagnostics must never include either settings document.
    assert!(unchanged, "Read-only probe status=settings-changed");
    let report = inspected.unwrap_or_else(|_| panic!("Read-only probe status=inspection-failed"));
    eprintln!(
        "readonly-recovery-probe status={:?} recovery={} files={} completed={} backups={}",
        report.status,
        report.recovery.len(),
        report
            .recovery
            .iter()
            .map(|item| item.files.len())
            .sum::<usize>(),
        report.recovery.iter().filter(|item| item.completed).count(),
        report.backups.len()
    );
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
        let fixture = OwnedTempDir::new();
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
        let fixture = OwnedTempDir::new();
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
    let fixture = OwnedTempDir::new();
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
    let fixture = OwnedTempDir::new();
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
        let fixture = OwnedTempDir::new();
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
    let fixture = OwnedTempDir::new();
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
