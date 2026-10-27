mod settings_profiles {
    use super::*;
    use std::collections::BTreeMap;
    use std::path::Path;

    #[test]
    fn settings_only_native_confirmation_names_import_and_keeps_exact_scope_disclosures() {
        let (_temp, base, _) = fixture_plan();
        let current = serde_json::to_vec(&config_with(vec![])).unwrap();
        let legacy = serde_json::to_vec(&config_with(vec![project(
            "old",
            &base.local_data.join("old"),
        )]))
        .unwrap();
        let proposal = merge_project_settings(&current, &legacy).unwrap();
        let (title, action, message) = prepare_confirmation(true, Some(&proposal));
        assert_eq!(title, "Import saved MCP projects");
        assert_eq!(action, "Back up and import projects");
        for text in [
            "Missing projects to import: 1",
            "Earlier entries already listed: 0",
            "Current preferences, selected project and existing project entries are kept",
            "Both original configurations are backed up first",
            "Older preferences remain in their backup",
            "verified idle standalone app windows to close normally",
            "Busy or unverified apps are not force-closed",
            "AI clients, Unity and Node connections stay open",
            "AI-client settings, Project Setup settings and installed apps are not changed",
            "No client migration or app removal is performed",
            "Cancel leaves the current setup unchanged",
        ] {
            assert!(message.contains(text), "Missing disclosure: {text}");
        }
        assert!(
            !message.contains("Let Creator Hub use your existing MCP and Project Setup settings")
        );
        for import in [None, Some(&proposal)] {
            let (title, action, message) = prepare_confirmation(false, import);
            assert_eq!(title, "Move to unified Creator Hub");
            assert_eq!(action, "Back up and continue");
            assert!(message.contains("Existing AI connections are reviewed separately"));
        }
    }

    fn install_profiles(base: &stores::Roots, plan: &mut Plan, profiles: [Option<&[u8]>; 2]) {
        for (index, bytes) in profiles.into_iter().enumerate() {
            let kind = plan.stores[index].store();
            let path = kind.path(base).unwrap();
            match bytes {
                Some(bytes) => {
                    fs::create_dir_all(path.parent().unwrap()).unwrap();
                    fs::write(&path, bytes).unwrap();
                }
                None if path.exists() => fs::remove_file(&path).unwrap(),
                None => {}
            }
            plan.stores[index] = stores::Snapshot::inspect(kind, base).unwrap();
        }
        plan.report.stage = "review";
        plan.report.settings_import_available =
            settings_import_available(&plan.stores, plan.report.stage, plan.retry_allowed);
    }

    fn files_at(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        let mut files = BTreeMap::new();
        for entry in fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                files.extend(files_at(&path));
            } else {
                files.insert(path.clone(), fs::read(path).unwrap());
            }
        }
        files
    }

    fn journal(base: &stores::Roots) -> PathBuf {
        base.config
            .join("creator-works-mcp")
            .join(".creator-hub-product-settings")
    }

    fn assert_import_recovery(plan: &Plan) {
        assert!(!plan.retry_allowed);
        assert!(plan.report.required);
        assert!(!plan.report.move_available);
        assert!(!plan.report.settings_import_available);
        assert!(!plan.report.retirement_available);
        assert!(plan.report.review_key.is_none());
        assert!(plan
            .report
            .recovery_help
            .as_ref()
            .unwrap()
            .contains("Saved MCP settings"));
        assert!(plan
            .report
            .recovery_help
            .as_ref()
            .unwrap()
            .contains("After recovery completes, restart Hub to check the saved outcome."));
        assert!(!plan
            .report
            .recovery_help
            .as_ref()
            .unwrap()
            .contains("move-v1.json"));
        assert!(can_prepare(plan).is_err());
        let wire = serde_json::to_value(&plan.report).unwrap();
        assert_eq!(wire["required"], true);
        assert_eq!(wire["moveAvailable"], false);
        assert_eq!(wire["settingsImportAvailable"], false);
    }

    fn restarted_profile(base: &stores::Roots) -> Plan {
        let (_temp, _, mut fresh) = fixture_plan();
        fresh.stores = stores::STORES
            .into_iter()
            .map(|kind| stores::Snapshot::inspect(kind, base).unwrap())
            .collect();
        fresh.report.stage = "review";
        fresh.report.required = false;
        fresh.report.review_key = Some("a".repeat(64));
        fresh.report.settings_import_available =
            settings_import_available(&fresh.stores, "review", true);
        restore_settings_import_recovery(&mut fresh, base).unwrap();
        fresh
    }

    #[test]
    fn preparation_failure_keeps_cached_recovery_visible_without_inventing_a_record() {
        let (temp, base, mut plan) = conflicting_plan();
        plan.report.required = false;
        plan.report.stage = "review";
        retain_fixture(&mut plan);
        let root = journal(&base);
        stores::storage::private_directory(&root).unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join("hub.lock"))
            .unwrap();
        let before = files_at(temp.path());
        fs2::FileExt::try_lock_exclusive(&lock).unwrap();
        assert!(import_missing_projects(&mut plan, &base)
            .unwrap_err()
            .contains("Another Hub migration"));
        assert_import_recovery(&plan);
        let help = plan.report.recovery_help.as_ref().unwrap();
        assert!(help.contains("No settings transaction record has been confirmed"));
        assert!(help.contains(&root.display().to_string()));
        drop(lock);
        assert_eq!(files_at(temp.path()), before);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        let mut fresh = restarted_profile(&base);
        assert!(preserve_settings_import_recovery(&mut fresh, Some(&plan)));
        assert_import_recovery(&fresh);
        assert_eq!(fresh.report.recovery_help, plan.report.recovery_help);
        assert_eq!(files_at(temp.path()), before);
    }

    #[test]
    fn prepared_import_failure_retains_exact_journal_across_inspection_and_restart() {
        use crate::convergence_recovery::{ReviewedWrite, Transaction};
        let (temp, base, mut plan) = conflicting_plan();
        plan.report.required = false;
        retain_fixture(&mut plan);
        let path = plan.stores[1].store().path(&base).unwrap();
        let transaction = Transaction::prepare(
            &journal(&base),
            vec![ReviewedWrite::new(
                "Pending fixture import",
                &path,
                plan.stores[1].bytes().unwrap(),
                plan.stores[0].bytes().unwrap(),
            )],
        )
        .unwrap();
        let exact = transaction.inspect().unwrap().journal;
        fs::write(
            &path,
            br#"{"channels":[],"auto_start":false,"external":"kept"}"#,
        )
        .unwrap();
        let before = files_at(temp.path());
        assert!(resume_project_import(&mut plan, &transaction).is_err());
        assert_import_recovery(&plan);
        assert!(plan
            .report
            .recovery_help
            .as_ref()
            .unwrap()
            .contains(&exact.display().to_string()));
        let mut fresh = restarted_profile(&base);
        assert_import_recovery(&fresh);
        assert!(preserve_settings_import_recovery(&mut fresh, Some(&plan)));
        assert_eq!(fresh.report.recovery_help, plan.report.recovery_help);
        let unrelated_complete = BatchRecord {
            policy: POLICY,
            phase: "cleanup".into(),
            outcome: "complete".into(),
            review_key: "a".repeat(64),
            retry_blocked: false,
        };
        assert!(inspection_can_admit(true, Some(&unrelated_complete)));
        assert_import_recovery(&fresh);
        assert_eq!(files_at(temp.path()), before);
    }

    #[test]
    fn restart_detects_equal_settings_with_unacknowledged_transaction_without_replay() {
        use crate::convergence_recovery::{ReviewedWrite, Transaction};
        let (temp, base, mut plan) = conflicting_plan();
        retain_fixture(&mut plan);
        let path = plan.stores[1].store().path(&base).unwrap();
        let transaction = Transaction::prepare(
            &journal(&base),
            vec![ReviewedWrite::new(
                "Completed publication fixture",
                &path,
                plan.stores[1].bytes().unwrap(),
                plan.stores[0].bytes().unwrap(),
            )],
        )
        .unwrap();
        let completed = transaction.resume(|_| true).unwrap();
        assert!(completed.completed);
        // Keep publication evidence, but simulate a stop before its final acknowledgment.
        fs::remove_file(completed.journal.join("completed.json")).unwrap();
        let before = files_at(temp.path());
        let fresh = restarted_profile(&base);
        assert!(!settings_conflict(&fresh));
        assert_import_recovery(&fresh);
        assert!(fresh
            .report
            .recovery_help
            .as_ref()
            .unwrap()
            .contains(&completed.journal.display().to_string()));
        assert!(!transaction.inspect().unwrap().completed);
        assert_eq!(files_at(temp.path()), before);
        assert!(transaction.resume(|_| true).unwrap().completed);
        let acknowledged = files_at(temp.path());
        let fresh = restarted_profile(&base);
        assert!(fresh.settings_import_recovery.is_none());
        assert!(!fresh.report.required);
        assert_eq!(files_at(temp.path()), acknowledged);
    }

    #[test]
    fn restart_incomplete_or_foreign_journal_is_blocked_without_claiming_its_identity() {
        use crate::convergence_recovery::{ReviewedWrite, Transaction};
        for foreign in [false, true] {
            let (temp, base, _) = conflicting_plan();
            let root = journal(&base);
            if foreign {
                let target = temp.path().join("not-an-allowlisted-store.json");
                fs::write(&target, b"before").unwrap();
                Transaction::prepare(
                    &root,
                    vec![ReviewedWrite::new(
                        "Foreign fixture",
                        &target,
                        b"before",
                        b"after",
                    )],
                )
                .unwrap();
            } else {
                fs::create_dir_all(root.join("incomplete")).unwrap();
                fs::write(root.join("incomplete/before.bin"), b"partial evidence").unwrap();
            }
            let before = files_at(temp.path());
            let fresh = restarted_profile(&base);
            assert_import_recovery(&fresh);
            let help = fresh.report.recovery_help.as_ref().unwrap();
            assert!(help.contains("No settings transaction record has been confirmed"));
            assert!(help.contains(&root.display().to_string()));
            assert_eq!(files_at(temp.path()), before);
        }
    }

    #[test]
    fn settings_recovery_is_bound_before_transaction_and_preserved_before_batch_admission() {
        let source = include_str!("convergence.rs");
        let body = source
            .split("fn import_reviewed_projects(")
            .nth(1)
            .unwrap()
            .split("fn resume_project_import(")
            .next()
            .unwrap();
        assert!(
            body.find("SettingsImportRecovery::Unconfirmed").unwrap()
                < body.find("Transaction::prepare(").unwrap()
        );
        assert!(source.contains("restore_settings_import_recovery(&mut plan, &base)?;"));
        assert!(source.contains(
            "if !import_needs_review && !inspection_can_admit(prior_blocked, record.as_ref())"
        ));
    }

    #[test]
    fn absent_single_and_identical_stores_retain_exact_bytes_without_inventing_defaults() {
        for present in [[false, false], [true, false], [false, true], [true, true]] {
            let (_temp, base, mut plan) = fixture_plan();
            let folder = base.local_data.join("offline-project");
            let mut config = config_with(vec![project("selected", &folder)]);
            config["active_channel_id"] = json!("selected");
            config["tool_groups"] = json!("custom,tools");
            config["enable_custom_scripts"] = json!(true);
            let bytes = serde_json::to_vec_pretty(&config).unwrap();
            install_profiles(
                &base,
                &mut plan,
                [
                    present[0].then_some(bytes.as_slice()),
                    present[1].then_some(bytes.as_slice()),
                ],
            );
            assert!(!plan.report.settings_import_available);
            retain_after_close(&mut plan, &base, None, || Ok(())).unwrap();
            for (index, exists) in present.into_iter().enumerate() {
                let path = plan.stores[index].store().path(&base).unwrap();
                assert_eq!(path.exists(), exists);
                assert_eq!(
                    plan.stores[index].bytes(),
                    exists.then_some(bytes.as_slice())
                );
                plan.stores[index].recheck().unwrap();
            }
            assert_eq!(
                plan.retained_images.len(),
                present.into_iter().filter(|p| *p).count()
            );
            for backup in &plan.retained_images {
                assert_eq!(fs::read(backup.path()).unwrap(), bytes);
            }
            assert_eq!(plan.report.stage, "backed-up");
            assert!(!plan.report.settings_import_available);
            assert!(!plan.report.retirement_available);
            assert!(!journal(&base).exists());
            assert!(!folder.exists());
        }
    }

    #[test]
    fn different_profile_matrix_imports_missing_projects_and_preserves_current_document() {
        for (current_folders, legacy_folders, added, overlap) in [
            (vec![], vec!["old"], 1, 0),
            (vec!["current"], vec![], 0, 0),
            (vec!["current"], vec!["old"], 1, 0),
            (
                vec!["shared", "current"],
                vec!["shared", "old", "old"],
                1,
                2,
            ),
            (vec!["shared"], vec!["shared"], 0, 1),
        ] {
            let (_temp, base, mut plan) = fixture_plan();
            let mut current = config_with(
                current_folders
                    .iter()
                    .enumerate()
                    .map(|(i, folder)| {
                        project(&format!("current-{i}"), &base.local_data.join(folder))
                    })
                    .collect(),
            );
            current["active_channel_id"] = if current_folders.is_empty() {
                Value::Null
            } else {
                json!("current-0")
            };
            current["tool_groups"] = json!("current,tools");
            current["mcp_server_path"] = json!("retain-current-server");
            current["enable_custom_scripts"] = json!(true);
            let mut legacy = config_with(
                legacy_folders
                    .iter()
                    .enumerate()
                    .map(|(i, folder)| {
                        let mut entry =
                            project(&format!("legacy-{i}"), &base.local_data.join(folder));
                        entry["enabled"] = json!(true);
                        entry["scene_path"] = json!("Assets/Legacy.unity");
                        entry
                    })
                    .collect(),
            );
            legacy["auto_start"] = json!(true);
            legacy["automatic_update_checks"] = json!(true);
            legacy["allow_all_tests"] = json!(true);
            legacy["legacyOnlyPreference"] = json!({"mustNotActivate":true});
            legacy["active_channel_id"] = if legacy_folders.is_empty() {
                Value::Null
            } else {
                json!("legacy-0")
            };
            let originals = [
                serde_json::to_vec_pretty(&current).unwrap(),
                serde_json::to_vec(&legacy).unwrap(),
            ];
            install_profiles(&base, &mut plan, [Some(&originals[0]), Some(&originals[1])]);
            let proposal = merge_project_settings(&originals[0], &originals[1]).unwrap();
            assert_eq!((proposal.added, proposal.already_present), (added, overlap));
            assert!(plan.report.settings_import_available);
            let mut expected = current.clone();
            for entry in legacy["channels"].as_array().unwrap() {
                let channels = expected["channels"].as_array_mut().unwrap();
                if !channels
                    .iter()
                    .any(|known| known["unity_project_path"] == entry["unity_project_path"])
                {
                    channels.push(entry.clone());
                }
            }
            retain_after_close(&mut plan, &base, Some(&proposal), || Ok(())).unwrap();
            for saved in &plan.stores[..2] {
                saved.recheck().unwrap();
                assert_eq!(saved.bytes(), Some(proposal.bytes.as_slice()));
                assert_eq!(
                    serde_json::from_slice::<Value>(saved.bytes().unwrap()).unwrap(),
                    expected
                );
            }
            for (backup, original) in plan.retained_images.iter().zip(&originals) {
                assert_eq!(fs::read(backup.path()).unwrap(), *original);
            }
            if added == 0 {
                assert_eq!(proposal.bytes, originals[0]);
            }
            let again = merge_project_settings(&proposal.bytes, &originals[1]).unwrap();
            assert_eq!(again.added, 0);
            assert_eq!(again.bytes, proposal.bytes);
            assert!(!plan.report.settings_import_available);
            assert!(
                plan.report.required,
                "Settings import must not complete broader migration"
            );
            assert!(!plan.report.retirement_available);
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_case_separator_and_dot_aliases_do_not_add_duplicate_folders() {
        for (current, legacy) in [
            (r"Z:\Projects\World", "z:/PROJECTS/world/"),
            (r"Z:\Projects\World", r"Z:\Projects\.\World\"),
            (r"\\server\share\World", "//SERVER/share/world/"),
        ] {
            let current =
                serde_json::to_vec(&config_with(vec![project("keep", Path::new(current))]))
                    .unwrap();
            let legacy =
                serde_json::to_vec(&config_with(vec![project("earlier", Path::new(legacy))]))
                    .unwrap();
            let result = merge_project_settings(&current, &legacy).unwrap();
            assert_eq!((result.added, result.already_present), (0, 1));
            assert_eq!(result.bytes, current);
        }
    }

    #[test]
    fn formatting_only_profiles_do_not_require_import_or_runtime_review() {
        let (temp, base, mut plan) = fixture_plan();
        let server = base
            .local_data
            .join("verified-runtime/creator-works-mcp.mjs");
        let mut config = config_with(vec![project("selected", &base.local_data.join("project"))]);
        config["active_channel_id"] = json!("selected");
        config["mcp_server_path"] = json!(server);
        let current = serde_json::to_vec_pretty(&config).unwrap();
        let legacy = format!(
            "{}\r\n",
            std::str::from_utf8(&current).unwrap().replace('\n', "\r\n")
        )
        .into_bytes();
        assert_ne!(current, legacy);
        assert_eq!(
            serde_json::from_slice::<Value>(&current).unwrap(),
            serde_json::from_slice::<Value>(&legacy).unwrap()
        );
        install_profiles(&base, &mut plan, [Some(&current), Some(&legacy)]);
        let before = files_at(temp.path());
        let proposal = merge_project_settings(&current, &legacy).unwrap();
        assert_eq!((proposal.added, proposal.already_present), (0, 1));
        assert_eq!(proposal.bytes, current);
        let readiness = (
            settings_conflict(&plan),
            settings_need_review(&plan.stores),
            settings_import_available(&plan.stores, "review", true),
            settings_use_verified_runtime(&plan.stores, &server),
        );
        assert_eq!(files_at(temp.path()), before);
        assert_eq!(
            readiness,
            (false, false, false, true),
            "LF/CRLF-only differences must not create a conflict, offer a zero-project import, or invalidate verified-runtime readiness"
        );
    }

    #[test]
    fn malformed_profiles_fail_before_backup_or_publication_in_either_store() {
        let malformed = [
            "{",
            "null",
            "{}",
            r#"{"channels":{},"auto_start":false}"#,
            r#"{"channels":[],"auto_start":"false"}"#,
            r#"{"channels":[],"auto_start":false,"schemaVersion":99}"#,
            r#"{"channels":[{"id":"id","name":"name","unity_project_path":"/project","enabled":"yes"}],"auto_start":false}"#,
            r#"{"channels":[],"auto_start":false,"auto_start":true}"#,
        ];
        for invalid in malformed {
            for index in 0..2 {
                let (temp, base, mut plan) = conflicting_plan();
                let originals = [
                    plan.stores[0].bytes().unwrap().to_vec(),
                    plan.stores[1].bytes().unwrap().to_vec(),
                ];
                let path = plan.stores[index].store().path(&base).unwrap();
                fs::write(&path, invalid).unwrap();
                let before = files_at(temp.path());
                assert!(stores::Snapshot::inspect(plan.stores[index].store(), &base).is_err());
                let inputs = if index == 0 {
                    [invalid.as_bytes(), originals[1].as_slice()]
                } else {
                    [originals[0].as_slice(), invalid.as_bytes()]
                };
                assert!(merge_project_settings(inputs[0], inputs[1]).is_err());
                assert!(retain_after_close(&mut plan, &base, None, || Ok(())).is_err());
                assert_eq!(files_at(temp.path()), before);
                assert!(plan.retained_images.is_empty());
            }
        }
    }

    #[test]
    fn stale_approved_profiles_never_overwrite_newer_current_or_legacy_bytes() {
        for index in 0..2 {
            let (temp, base, mut plan) = conflicting_plan();
            let proposal = merge_project_settings(
                plan.stores[0].bytes().unwrap(),
                plan.stores[1].bytes().unwrap(),
            )
            .unwrap();
            let changed = br#"{"channels":[],"auto_start":false,"externalEdit":"keep"}"#;
            fs::write(plan.stores[index].store().path(&base).unwrap(), changed).unwrap();
            let before = files_at(temp.path());
            assert!(retain_after_close(&mut plan, &base, Some(&proposal), || Ok(())).is_err());
            assert_eq!(files_at(temp.path()), before);
            assert!(plan.retained_images.is_empty());
        }
    }

    #[test]
    fn settings_only_availability_is_independent_of_completed_migration_and_never_grants_cleanup() {
        let (_temp, base, mut plan) = conflicting_plan();
        let review = base.config.join("review.json");
        save_review_at(&review, &plan.stores).unwrap();
        let reviewed = reviewed_snapshots_at(&review, &plan.stores).unwrap();
        plan.report.required = migration_required(0, 2, reviewed, false);
        plan.report.stage = "review";
        plan.report.settings_import_available =
            settings_import_available(&plan.stores, "review", true);
        assert!(!plan.report.required);
        assert!(plan.report.settings_import_available);
        let report = serde_json::to_value(&plan.report).unwrap();
        assert_eq!(report["settingsImportAvailable"], true);
        assert_eq!(report["required"], false);
        for stage in ["backed-up", "connections-reviewed", "complete"] {
            assert!(!settings_import_available(&plan.stores, stage, true));
        }
        assert!(!settings_import_available(&plan.stores, "review", false));
        let proposal = merge_project_settings(
            plan.stores[0].bytes().unwrap(),
            plan.stores[1].bytes().unwrap(),
        )
        .unwrap();
        retain_after_close(&mut plan, &base, Some(&proposal), || Ok(())).unwrap();
        assert!(!plan.report.required);
        assert!(!plan.report.settings_import_available);
        assert!(!plan.report.retirement_available);
        write_outcome(&base, "accepted");
        plan.stores[2] =
            stores::Snapshot::inspect(stores::Store::McpHostedOutcomes, &base).unwrap();
        assert!(!settings_import_available(&plan.stores, "review", true));
    }

    #[test]
    fn pending_import_requires_explicit_recovery_and_declining_keeps_every_file() {
        use crate::convergence_recovery::{ReviewedWrite, Transaction};
        let (temp, base, mut plan) = conflicting_plan();
        let current = serde_json::to_vec(&config_with(vec![project(
            "current",
            &base.local_data.join("current"),
        )]))
        .unwrap();
        let legacy = serde_json::to_vec(&config_with(vec![project(
            "old",
            &base.local_data.join("old"),
        )]))
        .unwrap();
        install_profiles(&base, &mut plan, [Some(&current), Some(&legacy)]);
        let proposal = merge_project_settings(&current, &legacy).unwrap();
        retain_fixture(&mut plan);
        let allowed: Vec<_> = plan.stores[..2]
            .iter()
            .map(|saved| saved.store().path(&base).unwrap())
            .collect();
        let transaction = Transaction::prepare(
            &journal(&base),
            plan.stores[..2]
                .iter()
                .zip(&allowed)
                .map(|(saved, path)| {
                    ReviewedWrite::new(
                        "Interrupted fixture import",
                        path,
                        saved.bytes().unwrap(),
                        &proposal.bytes,
                    )
                })
                .collect(),
        )
        .unwrap();
        let before = files_at(temp.path());
        assert!(import_reviewed_projects(&mut plan, &base, &proposal)
            .unwrap_err()
            .contains("recovery review"));
        assert_eq!(files_at(temp.path()), before);
        let report = transaction.inspect().unwrap();
        let reopened = Transaction::open_allowlisted(&report.journal, &allowed).unwrap();
        assert!(!reopened.resume(|_| false).unwrap().completed);
        assert_eq!(files_at(temp.path()), before);
        assert!(reopened.resume(|_| true).unwrap().completed);
        for path in &allowed {
            assert_eq!(fs::read(path).unwrap(), proposal.bytes);
        }
        for (backup, original) in plan.retained_images.iter().zip([&current, &legacy]) {
            assert_eq!(fs::read(backup.path()).unwrap(), *original);
        }
        assert!(check_settings_recovery(&base).is_ok());
    }

    #[test]
    fn native_prepare_cancellation_precedes_close_backup_and_import_and_clears_availability_on_success(
    ) {
        let source = include_str!("convergence.rs");
        let body = source
            .split("pub async fn prepare_convergence(")
            .nth(1)
            .unwrap()
            .split("const CLIENTS:")
            .next()
            .unwrap();
        let cancel = body.find("if !approved {").unwrap();
        let returned = body[cancel..].find("return Err(").unwrap() + cancel;
        assert!(returned < body.find("close_reviewed_guis(plan)?").unwrap());
        assert!(returned < body.find("snapshot.retain_reviewed()?").unwrap());
        assert!(returned < body.find("let imported =").unwrap());
        assert!(body.contains("plan.report.settings_import_available = false;"));
    }
}
