//! Opt-in disposable qualification only. No production compatibility policy is changed.
//! The external runner owns the exact 38 VS EditorPrefs before-image and restoration.
//! Do not run until human Editors are closed and that separate preference guard is reviewed.

use super::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Write;

const SOURCE: &str = "E:/UnityTest/CreatorSetupSdkAddOrdinary-20261019";
const TARGET: &str = "E:/UnityTest/CreatorSetupSdk4022Vs1912-20261021";
const SDK: &str = "4.0.22";
const VS: &str = "1.9.12";
const SEED: &str = include_str!("../../tests/UnitySdkCompatibilitySeed.cs");
const ROOTS: [&str; 3] = ["Assets", "Packages", "ProjectSettings"];
const MAX_FILES: usize = 20_000;
const MAX_BYTES: u64 = 1_073_741_824;
type Snapshot = BTreeMap<String, String>;

fn gate(values: &BTreeMap<String, String>) -> Result<(), String> {
    for (key, expected) in [
        ("CREATOR_SETUP_SDK_COMPATIBILITY_AUDIT", TARGET),
        ("CREATOR_SETUP_SDK_COMPATIBILITY_GUARDS_REVIEWED", "yes"),
        ("CREATOR_SETUP_SDK_COMPATIBILITY_EDITORS_CLOSED", "yes"),
        ("CREATOR_SETUP_SDK_COMPATIBILITY_PREF_GUARD_REVIEWED", "yes"),
        (
            "CREATOR_SETUP_SDK_COMPATIBILITY_VS38_PREF_BACKUP_APPROVED",
            "yes",
        ),
    ] {
        if values.get(key).map(String::as_str) != Some(expected) {
            return Err(format!("Missing exact runtime review: {key}"));
        }
    }
    if !values
        .get("CREATOR_SETUP_REAL_SDK_CACHE_EXPECTED_BEFORE")
        .is_some_and(|value| value.len() <= 256)
        || !matches!(
            values
                .get("CREATOR_SETUP_SDK_COMPATIBILITY_MARKER_EXPECTED_PRESENT")
                .map(String::as_str),
            Some("yes" | "no")
        )
    {
        return Err("The separately guarded SDK marker before-image is required.".into());
    }
    Ok(())
}

fn validator() -> String {
    let original = validation_script();
    let expected = format!("result.creatorSdkVersion == \"{CREATOR_SDK_VERSION}\"");
    assert_eq!(original.matches(&expected).count(), 1);
    original.replacen(
        &expected,
        &format!("result.creatorSdkVersion == \"{SDK}\""),
        1,
    )
}

fn seed() -> String {
    SEED.replace("@@EDITOR_VERSION@@", EDITOR_VERSION)
}

fn manifest_pair(original: &Value) -> Result<Value, String> {
    let mut result = original.clone();
    let dependencies = result["dependencies"]
        .as_object_mut()
        .ok_or("Missing dependency object")?;
    for (name, before, after) in [
        ("com.sidequest.creator-sdk", CREATOR_SDK_VERSION, SDK),
        ("com.unity.visualscripting", "1.9.1", VS),
    ] {
        if dependencies.get(name).and_then(Value::as_str) != Some(before) {
            return Err(format!("Unreviewed source dependency: {name}"));
        }
        dependencies.insert(name.into(), json!(after));
    }
    for (name, expected) in [
        ("com.unity.render-pipelines.universal", URP_VERSION),
        ("com.unity.inputsystem", INPUT_SYSTEM_VERSION),
    ] {
        if dependencies.get(name).and_then(Value::as_str) != Some(expected) {
            return Err(format!("Unreviewed source dependency: {name}"));
        }
    }
    Ok(result)
}

fn plain(path: &Path) -> Result<fs::Metadata, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("Linked fixture path refused.".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("Reparse fixture path refused.".into());
        }
    }
    if !metadata.is_dir() && !metadata.is_file() {
        return Err("Special fixture path refused.".into());
    }
    Ok(metadata)
}

fn ancestors(path: &Path) -> Result<(), String> {
    for parent in path.ancestors().filter(|path| !path.as_os_str().is_empty()) {
        if !plain(parent)?.is_dir() {
            return Err("Fixture ancestry is not a plain directory.".into());
        }
    }
    Ok(())
}

fn digest(path: &Path) -> Result<String, String> {
    if !plain(path)?.is_file() {
        return Err("Expected a regular fixture file.".into());
    }
    let mut input = File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 32768];
    loop {
        let length = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if length == 0 {
            return Ok(format!("{:x}", hash.finalize()));
        }
        hash.update(&buffer[..length]);
    }
}

fn snapshot(root: &Path) -> Result<Snapshot, String> {
    fn walk(
        root: &Path,
        relative: &Path,
        result: &mut Snapshot,
        bytes: &mut u64,
    ) -> Result<(), String> {
        let path = root.join(relative);
        let metadata = plain(&path)?;
        if metadata.is_dir() {
            for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                walk(root, &relative.join(entry.file_name()), result, bytes)?;
            }
        } else {
            *bytes = bytes
                .checked_add(metadata.len())
                .ok_or("Fixture size overflow")?;
            if result.len() >= MAX_FILES || *bytes > MAX_BYTES {
                return Err("Fixture inventory bound exceeded.".into());
            }
            let name = relative
                .to_str()
                .ok_or("Non UTF-8 fixture path")?
                .replace('\\', "/");
            result.insert(name, digest(&path)?);
        }
        Ok(())
    }
    ancestors(root)?;
    let mut result = BTreeMap::new();
    let mut bytes = 0;
    for relative in ROOTS {
        walk(root, Path::new(relative), &mut result, &mut bytes)?;
    }
    Ok(result)
}

fn excluded(name: &str) -> bool {
    matches!(
        name,
        "Assets/Editor/UnityPlainUrpSeed.cs"
            | "Assets/Editor/UnityPlainUrpSeed.cs.meta"
            | "Assets/Editor/CreatorProjectSetupValidator.cs"
            | "Assets/Editor/CreatorProjectSetupValidator.cs.meta"
    )
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = File::options()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())
}

fn copy_inventory(from: &Path, to: &Path, files: &Snapshot) -> Result<(), String> {
    for (relative, expected) in files {
        let source = from.join(relative);
        if digest(&source)? != *expected {
            return Err("Source fixture changed before copy.".into());
        }
        let destination = to.join(relative);
        fs::create_dir_all(destination.parent().unwrap()).map_err(|e| e.to_string())?;
        let mut output = File::options()
            .write(true)
            .create_new(true)
            .open(&destination)
            .map_err(|e| e.to_string())?;
        let mut input = File::open(&source).map_err(|e| e.to_string())?;
        std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
        output.sync_all().map_err(|e| e.to_string())?;
        if digest(&destination)? != *expected || digest(&source)? != *expected {
            return Err("Exact fixture copy verification failed.".into());
        }
    }
    Ok(())
}

fn check_files(root: &Path, files: &Snapshot) -> Result<(), String> {
    for (relative, expected) in files {
        if digest(&root.join(relative))? != *expected {
            return Err(format!("Protected file changed: {relative}"));
        }
    }
    Ok(())
}

fn protected(files: &Snapshot) -> Snapshot {
    files
        .iter()
        .filter(|(name, _)| {
            (!name.starts_with("Assets/Unity.VisualScripting.Generated/")
                && name.as_str() != "Assets/Unity.VisualScripting.Generated.meta"
                && name.starts_with("Assets/"))
                || matches!(
                    name.as_str(),
                    "ProjectSettings/GraphicsSettings.asset"
                        | "ProjectSettings/QualitySettings.asset"
                        | "ProjectSettings/ProjectSettings.asset"
                )
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn finish_report(
    status: &Path,
    source: &Path,
    target: &Path,
    source_before: &Snapshot,
    preserved: &Snapshot,
    outcome: &Result<(), String>,
) -> Result<(), String> {
    let source_check = snapshot(source);
    let source_preserved = source_check
        .as_ref()
        .is_ok_and(|after| after == source_before);
    let protected_check = check_files(target, preserved);
    let protected_preserved = protected_check.is_ok();
    write_new(
        &status.join("qualification-result.json"),
        &serde_json::to_vec_pretty(&json!({
            "schemaVersion":1,"source":crate::repair::display_path(source),
            "target":crate::repair::display_path(target),
            "packageChecksPassed":outcome.is_ok() && source_preserved && protected_preserved,
            "qualificationPassed":false,"error":outcome.as_ref().err(),
            "sourcePreserved":source_preserved,"protectedFilesPreserved":protected_preserved,
            "sourceCheckError":source_check.as_ref().err(),
            "protectedFilesCheckError":protected_check.as_ref().err(),
            "protectedFiles":preserved,"sourceBefore":source_before,
            "externalPreferencesRestorationVerified":false,
            "sharedPackageCacheSourcePatchingApproved":false,"releaseAcceptance":false
        }))
        .map_err(|e| e.to_string())?,
    )?;
    if let Err(error) = outcome {
        return Err(error.clone());
    }
    if !source_preserved || !protected_preserved {
        return Err("Preservation checks failed; the original runtime result is retained.".into());
    }
    outcome.clone()
}

fn qualify(hub: &Value, sdk: &Value) -> Result<(), String> {
    if hub["success"] != true {
        return Err("Production validator failed.".into());
    }
    for (key, expected) in [
        ("unityVersion", EDITOR_VERSION),
        ("creatorSdkVersion", SDK),
        ("urpVersion", URP_VERSION),
        ("inputSystemVersion", INPUT_SYSTEM_VERSION),
    ] {
        if hub[key] != expected {
            return Err(format!("Unexpected resolved production value: {key}"));
        }
    }
    for (key, expected) in [
        ("phase", "reloaded"),
        ("unityVersion", EDITOR_VERSION),
        ("creatorSdkVersion", SDK),
        ("visualScriptingVersion", VS),
        ("creatorSdkSource", "Registry"),
        ("visualScriptingSource", "Registry"),
        ("sdkReadinessState", "Done"),
    ] {
        if sdk[key] != expected {
            return Err(format!("Unexpected reloaded SDK audit value: {key}"));
        }
    }
    for key in [
        "sdkReadyDone",
        "nodesBuiltForThisVersion",
        "nodeDatabaseExists",
        "customTypePreserved",
        "customAssemblyPreserved",
        "markerUnchanged",
    ] {
        if sdk[key] != true {
            return Err(format!("SDK qualification remains incomplete: {key}"));
        }
    }
    if hub["preservedVisualScriptingSelections"] != true
        || hub["nodeCount"].as_u64().unwrap_or(0) == 0
        || hub["creatorNodeCount"].as_u64().unwrap_or(0) == 0
    {
        return Err("Reloaded Creator nodes or original selections were not verified.".into());
    }
    Ok(())
}

fn qualified_receipts() -> (Value, Value) {
    (
        json!({"success":true,"unityVersion":EDITOR_VERSION,"creatorSdkVersion":SDK,
        "urpVersion":URP_VERSION,"inputSystemVersion":INPUT_SYSTEM_VERSION,
        "preservedVisualScriptingSelections":true,"nodeCount":10,"creatorNodeCount":3}),
        json!({"phase":"reloaded","unityVersion":EDITOR_VERSION,"creatorSdkVersion":SDK,
        "creatorSdkSource":"Registry","visualScriptingSource":"Registry",
        "visualScriptingVersion":VS,"sdkReadinessState":"Done","sdkReadyDone":true,
        "nodesBuiltForThisVersion":true,"nodeDatabaseExists":true,"customTypePreserved":true,
        "customAssemblyPreserved":true,"markerUnchanged":true}),
    )
}

#[test]
fn green_hub_without_sdk_stamp_is_not_qualification() {
    let (hub, mut sdk) = qualified_receipts();
    sdk["sdkReadyDone"] = json!(false);
    sdk["nodesBuiltForThisVersion"] = json!(false);
    sdk["sdkReadinessState"] = json!("NeedsFix");
    assert!(qualify(&hub, &sdk).is_err());
}

#[test]
fn qualification_refuses_missing_wrong_or_lost_evidence() {
    let (hub, sdk) = qualified_receipts();
    assert!(qualify(&hub, &sdk).is_ok());
    for key in sdk.as_object().unwrap().keys() {
        let mut missing = sdk.clone();
        missing.as_object_mut().unwrap().remove(key);
        assert!(qualify(&hub, &missing).is_err(), "{key}");
        let mut wrong = sdk.clone();
        wrong[key] = json!("wrong");
        assert!(qualify(&hub, &wrong).is_err(), "{key}");
    }
    for key in hub.as_object().unwrap().keys() {
        let mut missing = hub.clone();
        missing.as_object_mut().unwrap().remove(key);
        assert!(qualify(&missing, &sdk).is_err(), "{key}");
    }
    for version in ["1.9.1", "1.9.13", "file:custom", "missing"] {
        let mut wrong = sdk.clone();
        wrong["visualScriptingVersion"] = json!(version);
        assert!(qualify(&hub, &wrong).is_err());
    }
    let mut empty = hub.clone();
    empty["creatorNodeCount"] = json!(0);
    assert!(qualify(&empty, &sdk).is_err());
}

#[test]
fn test_validator_only_substitutes_the_sdk_expectation() {
    assert_eq!(CREATOR_SDK_VERSION, "4.0.14");
    assert_eq!(
        validator().replace(
            "result.creatorSdkVersion == \"4.0.22\"",
            "result.creatorSdkVersion == \"4.0.14\""
        ),
        validation_script()
    );
    assert!(!validation_script().contains("4.0.22"));
    assert!(seed().contains("ProjectSetupValidator.ConfigureExisting();"));
    assert!(seed().contains("ProjectSetupValidator.Validate();"));
    assert!(seed().contains("sdkReadyDone = status.State == SetupState.Done"));
    assert!(!seed().contains("SetVSTypesAndAssemblies("));
    assert!(!seed().contains("EditorPrefs.Set"));
    assert!(!seed().contains("SetConfigValue("));
    assert!(!seed().contains("CREATOR_SETUP_REAL_SDK_CACHE_RESTORE_APPROVED"));
    let keys: Vec<_> = SEED
        .lines()
        .flat_map(|line| line.split('"').skip(1).step_by(2))
        .filter(|key| key.starts_with("VisualScripting."))
        .collect();
    assert_eq!(keys.len(), 38);
    assert_eq!(
        keys.iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        38
    );
    for (prefix, count) in [("Core", 23), ("Flow", 10), ("State", 5)] {
        assert_eq!(
            keys.iter()
                .filter(|key| key.starts_with(&format!("VisualScripting.{prefix}.")))
                .count(),
            count
        );
        assert!(keys.contains(&format!("VisualScripting.{prefix}.editorSetupCompleted").as_str()));
    }
}

#[test]
fn runtime_gate_requires_every_explicit_review() {
    let values = BTreeMap::from([
        (
            "CREATOR_SETUP_SDK_COMPATIBILITY_AUDIT".into(),
            TARGET.into(),
        ),
        (
            "CREATOR_SETUP_SDK_COMPATIBILITY_GUARDS_REVIEWED".into(),
            "yes".into(),
        ),
        (
            "CREATOR_SETUP_SDK_COMPATIBILITY_EDITORS_CLOSED".into(),
            "yes".into(),
        ),
        (
            "CREATOR_SETUP_SDK_COMPATIBILITY_PREF_GUARD_REVIEWED".into(),
            "yes".into(),
        ),
        (
            "CREATOR_SETUP_SDK_COMPATIBILITY_VS38_PREF_BACKUP_APPROVED".into(),
            "yes".into(),
        ),
        (
            "CREATOR_SETUP_REAL_SDK_CACHE_EXPECTED_BEFORE".into(),
            "reviewed-before".into(),
        ),
        (
            "CREATOR_SETUP_SDK_COMPATIBILITY_MARKER_EXPECTED_PRESENT".into(),
            "yes".into(),
        ),
    ]);
    assert!(gate(&values).is_ok());
    for key in values.keys() {
        let mut missing = values.clone();
        missing.remove(key);
        assert!(gate(&missing).is_err(), "{key}");
    }
    let mut wrong = values.clone();
    wrong.insert(
        "CREATOR_SETUP_SDK_COMPATIBILITY_AUDIT".into(),
        SOURCE.into(),
    );
    assert!(gate(&wrong).is_err());
    let mut old_authority = values.clone();
    old_authority.remove("CREATOR_SETUP_SDK_COMPATIBILITY_VS38_PREF_BACKUP_APPROVED");
    old_authority.insert(
        "CREATOR_SETUP_REAL_SDK_CACHE_RESTORE_APPROVED".into(),
        "yes".into(),
    );
    assert!(
        gate(&old_authority).is_err(),
        "Old SDK marker approval cannot authorize VS38 restoration"
    );
}

#[test]
fn only_reviewed_pair_changes_and_unknown_fields_survive() {
    let original = json!({"dependencies": {"com.sidequest.creator-sdk": "4.0.14", "com.unity.visualscripting": "1.9.1", "com.unity.render-pipelines.universal": "17.3.0", "com.unity.inputsystem": "1.20.0", "other": "file:unchanged"}, "scopedRegistries": [{"custom": true}], "unknown": {"preserve": 7}});
    let changed = manifest_pair(&original).unwrap();
    let mut restored = changed.clone();
    restored["dependencies"]["com.sidequest.creator-sdk"] = json!("4.0.14");
    restored["dependencies"]["com.unity.visualscripting"] = json!("1.9.1");
    assert_eq!(restored, original);
    for name in [
        "com.sidequest.creator-sdk",
        "com.unity.visualscripting",
        "com.unity.render-pipelines.universal",
        "com.unity.inputsystem",
    ] {
        let mut wrong = original.clone();
        wrong["dependencies"][name] = json!("unreviewed");
        assert!(manifest_pair(&wrong).is_err());
    }
}

#[test]
fn exclusive_copy_refuses_overwrite_and_keeps_source() {
    let from = tempfile::tempdir().unwrap();
    let to = tempfile::tempdir().unwrap();
    for root in ROOTS {
        fs::create_dir(from.path().join(root)).unwrap();
    }
    fs::write(from.path().join("Assets/Authored.txt"), b"exact original").unwrap();
    let before = snapshot(from.path()).unwrap();
    copy_inventory(from.path(), to.path(), &before).unwrap();
    assert!(copy_inventory(from.path(), to.path(), &before).is_err());
    assert_eq!(snapshot(from.path()).unwrap(), before);
    check_files(to.path(), &before).unwrap();
    assert!(!excluded("Assets/Authored.txt"));
    assert!(excluded("Assets/Editor/UnityPlainUrpSeed.cs.meta"));
}

#[test]
fn failed_runtime_receipt_survives_source_check_failure() {
    let fixture = tempfile::tempdir().unwrap();
    let source = fixture.path().join("source");
    let target = fixture.path().join("target");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&target).unwrap();
    for root in ROOTS {
        fs::create_dir(source.join(root)).unwrap();
    }
    for relative in [
        "Assets/Authored.txt",
        "Assets/Authored.txt.meta",
        "ProjectSettings/GraphicsSettings.asset",
        "ProjectSettings/QualitySettings.asset",
        "ProjectSettings/ProjectSettings.asset",
    ] {
        fs::write(source.join(relative), relative.as_bytes()).unwrap();
    }
    let before = snapshot(&source).unwrap();
    copy_inventory(&source, &target, &before).unwrap();
    let preserved = protected(&before);
    assert_eq!(preserved.len(), 5);
    for (index, checked_source) in [&source, &fixture.path().join("missing-source")]
        .into_iter()
        .enumerate()
    {
        let status = fixture.path().join(format!("failure-{index}"));
        fs::create_dir(&status).unwrap();
        assert!(finish_report(
            &status,
            checked_source,
            &target,
            &before,
            &preserved,
            &Err("simulated Unity failure".into())
        )
        .is_err());
        let report: Value =
            serde_json::from_slice(&fs::read(status.join("qualification-result.json")).unwrap())
                .unwrap();
        assert_eq!(report["error"], "simulated Unity failure");
        assert_eq!(report["packageChecksPassed"], false);
        assert_eq!(report["qualificationPassed"], false);
        assert_eq!(report["sourcePreserved"], index == 0);
        assert_eq!(report["sourceCheckError"].is_null(), index == 0);
        assert_eq!(report["protectedFilesPreserved"], true);
        assert_eq!(report["releaseAcceptance"], false);
    }
    assert_eq!(snapshot(&source).unwrap(), before);
    check_files(&target, &preserved).unwrap();
}

#[test]
#[cfg(windows)]
#[ignore = "Real Unity qualification: exact new target, Editors closed, and scoped external VS preference backup/restoration review required. Parent owns execution."]
fn unity_sdk4022_vs1912_disposable_qualification() {
    gate(&env::vars().collect()).unwrap();
    let _exclusive = crate::bootstrap::OPERATION.try_lock().unwrap();
    let source = Path::new(SOURCE);
    let target = Path::new(TARGET);
    ancestors(target.parent().unwrap()).unwrap();
    assert!(
        matches!(fs::symlink_metadata(target), Err(error) if error.kind() == std::io::ErrorKind::NotFound),
        "Never resume, overwrite or delete an existing fixture"
    );
    let source_before = snapshot(source).unwrap();
    let copied: Snapshot = source_before
        .iter()
        .filter(|(name, _)| !excluded(name))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let original: Value =
        serde_json::from_slice(&fs::read(source.join("Packages/manifest.json")).unwrap()).unwrap();
    let next = manifest_pair(&original).unwrap();
    let environment = probe_environment();
    assert!(environment.ready, "{:?}", environment.blockers);
    let editor = environment
        .editors
        .iter()
        .find(|editor| editor.ready)
        .unwrap();
    fs::create_dir(target).unwrap();
    copy_inventory(source, target, &copied).unwrap();
    let status = target.join(".creator-project-setup");
    fs::create_dir(&status).unwrap();
    let initial_backup = status.join("backups/initial-inputs");
    fs::create_dir_all(&initial_backup).unwrap();
    copy_inventory(target, &initial_backup, &copied).unwrap();
    check_files(&initial_backup, &copied).unwrap();
    let preserved = protected(&copied);
    let manifest = serde_json::to_vec_pretty(&next).unwrap();
    fs::write(target.join("Packages/manifest.json"), &manifest).unwrap();
    fs::create_dir_all(target.join("Assets/Editor")).unwrap();
    write_new(
        &target.join("Assets/Editor/CreatorProjectSetupValidator.cs"),
        validator().as_bytes(),
    )
    .unwrap();
    write_new(
        &target.join("Assets/Editor/UnitySdkCompatibilitySeed.cs"),
        seed().as_bytes(),
    )
    .unwrap();
    let outcome = (|| -> Result<(), String> {
        for (phase, method) in [
            ("seed", "UnitySdkCompatibilitySeed.Seed"),
            ("configure", "UnitySdkCompatibilitySeed.ConfigureExisting"),
            ("reloaded", "UnitySdkCompatibilitySeed.Validate"),
        ] {
            if phase == "configure" {
                let before = snapshot(target)?;
                let backup = status.join("backups/pre-configure");
                fs::create_dir(&backup).map_err(|e| e.to_string())?;
                copy_inventory(target, &backup, &before)?;
                check_files(&backup, &before)?;
                write_new(
                    &status.join("existing-request.json"),
                    &serde_json::to_vec_pretty(
                        &json!({"backupPath": crate::repair::display_path(&backup)}),
                    )
                    .unwrap(),
                )?;
            }
            let result = run_unity(
                &editor.executable,
                target,
                method,
                &status.join(format!("compatibility-{phase}.log")),
                4,
                &|event| println!("{}: {}", event.step, event.detail),
            );
            if snapshot(source)? != source_before {
                return Err("Read-only source changed.".into());
            }
            check_files(target, &preserved)?;
            if fs::read(target.join("Packages/manifest.json")).map_err(|e| e.to_string())?
                != manifest
            {
                return Err("Manifest changed during qualification; no downgrade accepted.".into());
            }
            result?;
        }
        let hub: Value = serde_json::from_slice(
            &fs::read(status.join("unity-validation.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let sdk: Value = serde_json::from_slice(
            &fs::read(status.join("sdk-compatibility-reloaded.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        qualify(&hub, &sdk)
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
