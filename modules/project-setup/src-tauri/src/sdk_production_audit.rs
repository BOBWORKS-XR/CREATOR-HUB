//! Guarded production inspection/backup/repair audit on a new disposable copy.
use super::*;

const PRODUCTION_TARGET: &str = "E:/UnityTest/CreatorSetupSdk4022Vs1912-Production-20261026";
const DATABASE: &str = "Assets/Unity.VisualScripting.Generated/VisualScripting.Flow/UnitOptions.db";
const USER_SETTINGS: &str = "UserSettings/EditorUserSettings.asset";
const HELPER: &str = include_str!("../../tests/UnitySdkProductionAudit.cs");

fn production_gate(values: &BTreeMap<String, String>) -> Result<(), String> {
    gate_for_target(values, PRODUCTION_TARGET)
}

fn backup_inputs(target: &Path) -> Result<Snapshot, String> {
    let mut result: Snapshot = snapshot(target)?
        .into_iter()
        .filter(|(name, _)| {
            name.starts_with("ProjectSettings/")
                || name.starts_with("Assets/Unity.VisualScripting.Generated/")
                || matches!(
                    name.as_str(),
                    "Assets/Unity.VisualScripting.Generated.meta"
                        | "Packages/manifest.json"
                        | "Packages/packages-lock.json"
                )
        })
        .collect();
    for relative in [
        USER_SETTINGS,
        ".creator-project-setup/unity-validation.json",
    ] {
        let path = target.join(relative);
        match fs::symlink_metadata(&path) {
            Ok(_) => {
                result.insert(relative.into(), digest(&path)?);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(result)
}

fn require_repaired(validation: &Value) -> Result<(), String> {
    for (key, expected) in [
        ("unityVersion", EDITOR_VERSION),
        ("creatorSdkVersion", SDK),
        ("visualScriptingVersion", VS),
        ("urpVersion", URP_VERSION),
        ("inputSystemVersion", INPUT_SYSTEM_VERSION),
        ("sdkReadinessState", "Done"),
        ("error", ""),
    ] {
        if validation[key] != expected {
            return Err(format!("Unexpected production result: {key}"));
        }
    }
    for key in [
        "success",
        "sdkReadyDone",
        "nodesBuiltForThisVersion",
        "nodeDatabaseVerified",
        "preservedVisualScriptingSelections",
    ] {
        if validation[key] != true {
            return Err(format!("Missing production result: {key}"));
        }
    }
    for key in ["nodeCount", "creatorNodeCount"] {
        if validation[key].as_u64().unwrap_or(0) == 0 {
            return Err(format!("Empty production node data: {key}"));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn operation(
    target: &Path,
    repair: bool,
) -> Result<(crate::repair::ExistingResult, Snapshot), String> {
    let inspection = crate::repair::inspect(target)?;
    if (repair && !inspection.can_repair) || (!repair && !inspection.can_validate) {
        return Err(format!(
            "Normal inspection did not offer the requested operation: {:?}",
            inspection.findings
        ));
    }
    let before = backup_inputs(target)?;
    let result = crate::repair::run(
        crate::repair::ExistingRequest {
            project_path: inspection.project_path,
            fingerprint: inspection.fingerprint,
            repair,
            approved: true,
        },
        |event| println!("{}: {}", event.step, event.detail),
    )?;
    let backup = Path::new(&result.backup_path);
    check_files(backup, &before)?;
    for relative in [
        "Assets/Editor/CreatorProjectSetupValidator.cs",
        "Assets/Editor/CreatorProjectSetupValidator.cs.meta",
        ".creator-project-setup/existing-request.json",
        ".creator-project-setup/operation.lock",
    ] {
        if target.join(relative).exists() {
            return Err(format!(
                "Production operation did not clean up its temporary path: {relative}"
            ));
        }
    }
    Ok((result, before))
}

#[test]
fn production_audit_does_not_adopt_the_frozen_qualification_target() {
    let mut values: BTreeMap<String, String> = [
        ("CREATOR_SETUP_SDK_COMPATIBILITY_AUDIT", PRODUCTION_TARGET),
        ("CREATOR_SETUP_SDK_COMPATIBILITY_GUARDS_REVIEWED", "yes"),
        ("CREATOR_SETUP_SDK_COMPATIBILITY_EDITORS_CLOSED", "yes"),
        ("CREATOR_SETUP_SDK_COMPATIBILITY_PREF_GUARD_REVIEWED", "yes"),
        (
            "CREATOR_SETUP_SDK_COMPATIBILITY_PREPARED_BASELINE_REVIEWED",
            "yes",
        ),
        (
            "CREATOR_SETUP_SDK_COMPATIBILITY_VS38_PREF_BACKUP_APPROVED",
            "yes",
        ),
        (
            "CREATOR_SETUP_SDK_COMPATIBILITY_MARKER_EXPECTED_PRESENT",
            "yes",
        ),
        ("CREATOR_SETUP_REAL_SDK_CACHE_EXPECTED_BEFORE", "4.0.14"),
    ]
    .into_iter()
    .map(|(key, value)| (key.into(), value.into()))
    .collect();
    assert!(production_gate(&values).is_ok());
    assert!(gate(&values).is_err());
    for key in values.keys().cloned().collect::<Vec<_>>() {
        let mut missing = values.clone();
        missing.remove(&key);
        assert!(production_gate(&missing).is_err(), "{key}");
    }
    for target in [TARGET, SOURCE, "E:/UnityTest", ""] {
        values.insert(
            "CREATOR_SETUP_SDK_COMPATIBILITY_AUDIT".into(),
            target.into(),
        );
        assert!(production_gate(&values).is_err());
    }
    assert!(HELPER.contains(PRODUCTION_TARGET));
    assert!(HELPER.contains("RequireReady();"));
    assert!(HELPER.contains("FileMode.CreateNew"));
    assert!(!HELPER.contains("EditorPrefs.Set"));
}

#[test]
fn production_backup_evidence_includes_project_local_stamp_and_exact_node_data() {
    let temp = tempfile::tempdir().unwrap();
    for relative in ["Assets", "Packages", "ProjectSettings", "UserSettings"] {
        fs::create_dir(temp.path().join(relative)).unwrap();
    }
    let database = temp.path().join(DATABASE);
    fs::create_dir_all(database.parent().unwrap()).unwrap();
    fs::write(&database, b"node-database-before").unwrap();
    fs::write(temp.path().join(USER_SETTINGS), b"opaque-local-settings").unwrap();
    fs::write(
        temp.path().join("Assets/Keep.scene"),
        b"not a repair backup target",
    )
    .unwrap();
    let before = backup_inputs(temp.path()).unwrap();
    assert_eq!(before.len(), 2);
    assert_eq!(before[DATABASE], digest(&database).unwrap());
    assert!(before.contains_key(USER_SETTINGS));
    let mut value = qualified_receipts().0;
    value["error"] = json!("");
    assert!(require_repaired(&value).is_ok());
    value["nodesBuiltForThisVersion"] = json!(false);
    assert!(require_repaired(&value).is_err());
}

#[test]
#[cfg(windows)]
#[ignore = "Real normal Setup repair: exact new target, no human Editors, approved external VS38 preference guard required."]
fn unity_sdk4022_vs1912_production_repair() {
    production_gate(&env::vars().collect()).unwrap();
    let _exclusive = crate::bootstrap::OPERATION.try_lock().unwrap();
    let source = Path::new(SOURCE);
    let target = Path::new(PRODUCTION_TARGET);
    ancestors(target.parent().unwrap()).unwrap();
    assert!(
        matches!(fs::symlink_metadata(target), Err(error) if error.kind() == std::io::ErrorKind::NotFound),
        "Never adopt, delete or resume a previous fixture"
    );
    let source_before = snapshot(source).unwrap();
    review_prepared_source().unwrap();
    let manifest = fs::read(source.join("Packages/manifest.json")).unwrap();
    existing_pair(&serde_json::from_slice(&manifest).unwrap()).unwrap();
    let environment = probe_environment();
    assert!(environment.ready, "{:?}", environment.blockers);
    let editor = environment
        .editors
        .iter()
        .find(|editor| editor.ready)
        .unwrap();
    let copied: Snapshot = source_before
        .iter()
        .filter(|(name, _)| !excluded(name))
        .map(|(name, hash)| (name.clone(), hash.clone()))
        .collect();
    let preserved = protected(&copied);
    assert_eq!(preserved.len(), 50);
    fs::create_dir(target).unwrap();
    // Missing generated DB is the first repair case; the original stays in the source fixture.
    let mut missing_database = copied.clone();
    assert!(missing_database.remove(DATABASE).is_some());
    copy_inventory(source, target, &missing_database).unwrap();
    let status = target.join(".creator-project-setup");
    fs::create_dir(&status).unwrap();
    fs::create_dir_all(target.join("Assets/Editor")).unwrap();
    write_new(
        &target.join("Assets/Editor/UnitySdkProductionAudit.cs"),
        HELPER.as_bytes(),
    )
    .unwrap();
    let outcome = (|| -> Result<(), String> {
        let (first, first_before) = operation(target, true)?;
        if !first.success {
            return Err(format!("First normal repair: {}", first.message));
        }
        require_repaired(
            first
                .validation
                .as_ref()
                .ok_or("Missing first validation")?,
        )?;
        let first_backup = Path::new(&first.backup_path);
        let first_receipt = first_backup.join("sdk4022-node-stamp-before.json");
        let first_receipt_hash = digest(&first_receipt)?;
        check_files(target, &preserved)?;
        run_unity(
            &editor.executable,
            target,
            "UnitySdkProductionAudit.PrepareRepeatRepair",
            &status.join("repeat-preparation.log"),
            4,
            &|event| println!("{}: {}", event.step, event.detail),
        )?;
        let (stale, _) = operation(target, false)?;
        if stale.success
            || stale.validation.as_ref().is_none_or(|value| {
                value["error"] != "" || value["nodesBuiltForThisVersion"] != false
            })
        {
            return Err(
                "Normal validation did not report the deliberately lost project stamp.".into(),
            );
        }
        let (second, _) = operation(target, true)?;
        if !second.success {
            return Err(format!("Repeat normal repair: {}", second.message));
        }
        require_repaired(
            second
                .validation
                .as_ref()
                .ok_or("Missing repeat validation")?,
        )?;
        if second.backup_path == first.backup_path {
            return Err("Repeat repair reused its backup.".into());
        }
        digest(&Path::new(&second.backup_path).join("sdk4022-node-stamp-before.json"))?;
        check_files(first_backup, &first_before)?;
        if digest(&first_receipt)? != first_receipt_hash {
            return Err("Repeat repair changed earlier evidence.".into());
        }
        let (reopened, _) = operation(target, false)?;
        if !reopened.success {
            return Err(format!("Reopened validation: {}", reopened.message));
        }
        require_repaired(
            reopened
                .validation
                .as_ref()
                .ok_or("Missing reopened validation")?,
        )?;
        run_unity(
            &editor.executable,
            target,
            "UnitySdkProductionAudit.VerifyReopened",
            &status.join("production-reopened.log"),
            4,
            &|event| println!("{}: {}", event.step, event.detail),
        )?;
        let final_inspection = crate::repair::inspect(target)?;
        if !final_inspection.can_validate || final_inspection.can_repair {
            return Err("Healthy project still requests repair after reopening.".into());
        }
        if fs::read(target.join("Packages/manifest.json")).map_err(|e| e.to_string())? != manifest {
            return Err("Normal repair changed the existing package manifest.".into());
        }
        write_new(&status.join("production-operations.json"), &serde_json::to_vec_pretty(&json!({
            "firstRepair":first,"readinessValidation":stale,"repeatRepair":second,"reopenedValidation":reopened,
            "earlierBackupPreserved":true,"manifestPreserved":true,"releaseAcceptance":false,
        })).map_err(|e| e.to_string())?)?;
        Ok(())
    })();
    finish_report(
        &status,
        source,
        target,
        &source_before,
        &preserved,
        &outcome,
    )
    .unwrap();
}
