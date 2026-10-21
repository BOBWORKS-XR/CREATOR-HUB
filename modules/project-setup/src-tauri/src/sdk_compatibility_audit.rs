//! Opt-in disposable qualification only. No production compatibility policy is changed.
//! The external runner owns the exact 38 VS EditorPrefs before-image and restoration.
//! Do not run until human Editors are closed and that separate preference guard is reviewed.

use super::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Write;

const ORIGINAL: &str = "E:/UnityTest/CreatorSetupSdkAddOrdinary-20261019";
const SOURCE: &str = "E:/UnityTest/CreatorSetupSdk4022Vs1912-20261021";
const TARGET: &str = "E:/UnityTest/CreatorSetupSdk4022Vs1912-Repair-20261021";
const OPENXR: &str = "Assets/XR/Settings/OpenXR Package Settings.asset";
const OPENXR_BEFORE: &str = "70b46e01cc0dff25bbe4eba004043b3546493497bcae15d257e357dce5a9e4f6";
const OPENXR_PREPARED: &str = "19ad8ebdd2e2018e5e8c577436ba7a8ed5d929d0c5fbe8045cdad237b542709b";
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
            "CREATOR_SETUP_SDK_COMPATIBILITY_PREPARED_BASELINE_REVIEWED",
            "yes",
        ),
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
    candidate_validation_script()
}

fn seed() -> String {
    SEED.replace("@@EDITOR_VERSION@@", EDITOR_VERSION)
}

fn existing_pair(original: &Value) -> Result<(), String> {
    let dependencies = original["dependencies"]
        .as_object()
        .ok_or("Missing dependency object")?;
    for (name, expected) in [
        ("com.sidequest.creator-sdk", SDK),
        ("com.unity.visualscripting", VS),
        ("com.unity.render-pipelines.universal", URP_VERSION),
        ("com.unity.inputsystem", INPUT_SYSTEM_VERSION),
    ] {
        if dependencies.get(name).and_then(Value::as_str) != Some(expected) {
            return Err(format!("Unreviewed source dependency: {name}"));
        }
    }
    Ok(())
}

fn prepared_protected(baseline: &Value, seed: &Value) -> Result<Snapshot, String> {
    let failure = format!("Protected file changed: {OPENXR}");
    for (key, expected) in [
        ("schemaVersion", json!(1)),
        ("source", json!(ORIGINAL)),
        ("target", json!(SOURCE)),
        ("sourcePreserved", json!(true)),
        ("protectedFilesPreserved", json!(false)),
        ("packageChecksPassed", json!(false)),
        ("qualificationPassed", json!(false)),
        ("releaseAcceptance", json!(false)),
        ("sourceCheckError", Value::Null),
        ("error", json!(failure)),
        ("protectedFilesCheckError", json!(failure)),
    ] {
        if baseline[key] != expected {
            return Err(format!("Unreviewed failed baseline: {key}"));
        }
    }
    for (key, expected) in [
        ("phase", json!("seed")),
        ("unityVersion", json!(EDITOR_VERSION)),
        ("creatorSdkVersion", json!(SDK)),
        ("visualScriptingVersion", json!(VS)),
        ("creatorSdkSource", json!("Registry")),
        ("visualScriptingSource", json!("Registry")),
        ("customTypePreserved", json!(true)),
        ("customAssemblyPreserved", json!(true)),
        ("nodeDatabaseExists", json!(true)),
        ("markerUnchanged", json!(true)),
        ("sdkReadyDone", json!(false)),
        ("nodesBuiltForThisVersion", json!(false)),
        ("sdkReadinessState", json!("NeedsFix")),
        ("releaseAcceptance", json!(false)),
    ] {
        if seed[key] != expected {
            return Err(format!("Unreviewed prepared seed: {key}"));
        }
    }
    let mut files: Snapshot =
        serde_json::from_value(baseline["protectedFiles"].clone()).map_err(|e| e.to_string())?;
    if files.len() != 50 || files.get(OPENXR).map(String::as_str) != Some(OPENXR_BEFORE) {
        return Err("The exact original 50-file protection baseline is required.".into());
    }
    // Only fixture preparation accepts this exact reviewed before/after pair.
    // The measured repair continues to compare every protected file byte-for-byte.
    files.insert(OPENXR.into(), OPENXR_PREPARED.into());
    Ok(files)
}

fn reviewed_json(path: &Path, size: usize, sha256: &str) -> Result<Value, String> {
    ancestors(path.parent().ok_or("Missing reviewed input parent")?)?;
    if !plain(path)?.is_file()
        || fs::metadata(path).map_err(|e| e.to_string())?.len() != size as u64
    {
        return Err("Reviewed input size or type differs.".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() != size || format!("{:x}", Sha256::digest(&bytes)) != sha256 {
        return Err("Reviewed input hash differs.".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn review_prepared_source() -> Result<Value, String> {
    let folder = Path::new(SOURCE).join(".creator-project-setup");
    let result_sha = "0b9be50fc0dd421fcc59d90c99e8b42b1b7ff20b2497801a871aec2f88be86ff";
    let seed_sha = "50a8767074c65a9e119675c8fa43f5854a35eb35e9e46772e333243189e509d1";
    let baseline = reviewed_json(
        &folder.join("qualification-result.json"),
        15_321,
        result_sha,
    )?;
    let seed = reviewed_json(&folder.join("sdk-compatibility-seed.json"), 8_256, seed_sha)?;
    let expected = prepared_protected(&baseline, &seed)?;
    let original_before: Snapshot =
        serde_json::from_value(baseline["sourceBefore"].clone()).map_err(|e| e.to_string())?;
    if snapshot(Path::new(ORIGINAL))? != original_before {
        return Err("The first audit's original source changed.".into());
    }
    check_files(Path::new(SOURCE), &expected)?;
    Ok(
        json!({"schemaVersion":1,"originalSource":ORIGINAL,"preparedSource":SOURCE,
        "target":TARGET,"failedResultSha256":result_sha,"seedReceiptSha256":seed_sha,
        "originalSourcePreserved":true,"originalProtectedFileCount":50,
        "reviewedOpenxrBefore":OPENXR_BEFORE,"reviewedOpenxrPrepared":OPENXR_PREPARED,
        "measuredRepairAllowsOpenxrChanges":false,"releaseAcceptance":false}),
    )
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
            | "Assets/Editor/UnitySdkCompatibilitySeed.cs"
            | "Assets/Editor/UnitySdkCompatibilitySeed.cs.meta"
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
        ("visualScriptingVersion", VS),
        ("urpVersion", URP_VERSION),
        ("inputSystemVersion", INPUT_SYSTEM_VERSION),
        ("sdkReadinessState", "Done"),
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
        "malformedNodePayloadRejected",
    ] {
        if sdk[key] != true {
            return Err(format!("SDK qualification remains incomplete: {key}"));
        }
    }
    if hub["sdkReadyDone"] != true
        || hub["nodesBuiltForThisVersion"] != true
        || hub["nodeDatabaseVerified"] != true
        || hub["preservedVisualScriptingSelections"] != true
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
        "visualScriptingVersion":VS,"sdkReadinessState":"Done","sdkReadyDone":true,
        "nodesBuiltForThisVersion":true,"nodeDatabaseVerified":true,
        "urpVersion":URP_VERSION,"inputSystemVersion":INPUT_SYSTEM_VERSION,
        "preservedVisualScriptingSelections":true,"nodeCount":10,"creatorNodeCount":3}),
        json!({"phase":"reloaded","unityVersion":EDITOR_VERSION,"creatorSdkVersion":SDK,
        "creatorSdkSource":"Registry","visualScriptingSource":"Registry",
        "visualScriptingVersion":VS,"sdkReadinessState":"Done","sdkReadyDone":true,
        "nodesBuiltForThisVersion":true,"nodeDatabaseExists":true,"customTypePreserved":true,
        "customAssemblyPreserved":true,"markerUnchanged":true,"malformedNodePayloadRejected":true}),
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
fn test_validator_uses_the_same_closed_pair_template_without_enabling_policy() {
    assert_eq!(CREATOR_SDK_VERSION, "4.0.14");
    assert_eq!(
        validator()
            .strip_prefix("#define CREATOR_SETUP_SDK4022_VS1912_CANDIDATE\n")
            .unwrap()
            .replace("\"4.0.22\"", "\"4.0.14\"")
            .replace("\"1.9.12\"", "\"1.9.1\""),
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
    let prepared_seed = SEED
        .split("public static void Seed()")
        .nth(1)
        .unwrap()
        .split("public static void ConfigureExisting()")
        .next()
        .unwrap();
    for forbidden in [
        ".Add(",
        ".Clear(",
        ".Save(",
        "UnitBase.",
        "AssetDatabase.SaveAssets",
        "Codebase.UpdateSettings",
    ] {
        assert!(
            !prepared_seed.contains(forbidden),
            "Prepared seed must only verify: {forbidden}"
        );
    }
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
fn candidate_clears_only_genuine_stamp_before_second_build_and_checks_swallowed_errors() {
    let script = validator();
    let start = script
        .find("private static void ConfigureCandidateAfterLoader()")
        .unwrap();
    let finish = script
        .find("private static void FinishCandidateConfiguration()")
        .unwrap();
    let setup = &script[start..finish];
    let sdk = setup
        .find("VsNodeGeneration.SetVSTypesAndAssemblies()")
        .unwrap();
    let stamp = setup
        .find("candidateSdkStamp = EditorUserSettings.GetConfigValue(CandidateStampKey)")
        .unwrap();
    let clear = setup.find("ClearCandidateStamp();").unwrap();
    let restore = setup
        .find("foreach (var assembly in candidateAssemblies)")
        .unwrap();
    let save = setup
        .find("config.SaveProjectSettingsAsset(true);")
        .unwrap();
    let delay = setup
        .find("EditorApplication.delayCall += FinishCandidateConfiguration;")
        .unwrap();
    assert!(sdk < stamp && stamp < clear && clear < restore && restore < save && save < delay);
    let finish = &script[finish..script.find("private static void FailCandidate(").unwrap()];
    let rebuild = finish.find("UnitBase.Rebuild();").unwrap();
    let database = finish.find("ReadCandidateNodeDatabase();").unwrap();
    let errors = finish.find("RequireNoCandidateErrors();").unwrap();
    let restore = finish
        .find("EditorUserSettings.SetConfigValue(CandidateStampKey, candidateSdkStamp);")
        .unwrap();
    assert!(rebuild < database && database < errors && errors < restore);
    assert!(script.contains("Application.logMessageReceivedThreaded += CandidateLog;"));
    assert!(script.contains("LogType.Error || type == LogType.Exception || type == LogType.Assert"));
    assert!(script.contains("database.ExecuteScalar<string>(\"PRAGMA quick_check\") != \"ok\""));
    assert!(script.contains("var option = row.ToOption();"));
    assert!(script.contains("option == null || option.unitType == null"));
    assert!(script.contains("var unit = option.unit;"));
    assert!(script.contains("unit == null || unit.GetType() != option.unitType"));
    assert!(!script.contains("OptionsHash("));
    assert!(!script.contains("EditorPrefs.Set"));
}

#[test]
fn candidate_payload_regression_is_guarded_in_memory_and_required_on_existing_reload() {
    let script = validator();
    assert!(script.contains("foreach (var row in rows) VerifyCandidateNodeRow(row);"));
    let body = &script[script
        .find("internal static void VerifyCandidateNodeRow(")
        .unwrap()
        ..script
            .find("private static void FinishCandidateConfiguration()")
            .unwrap()];
    assert!(body.find("row.ToOption()").unwrap() < body.find("option.unit;").unwrap());
    assert!(body.contains("unit.GetType() != option.unitType"));
    assert_eq!(
        SEED.matches("AssertMalformedNodePayloadRejected(").count(),
        2,
    );
    let helper = &SEED[SEED
        .find("public static void AssertMalformedNodePayloadRejected(")
        .unwrap()..SEED.find("private static string Hash(").unwrap()];
    for required in [
        "RequireFixture();",
        "VerifyCandidateNodeRow(original);",
        "new UnitOptionRow()",
        "property.SetValue(malformed, property.GetValue(original))",
        "malformed.unit = \"{\";",
        "malformed.ToOption()",
        "VerifyCandidateNodeRow(malformed)",
        "System.Runtime.Serialization.SerializationException",
        "original.unit != originalPayload",
    ] {
        assert!(helper.contains(required), "{required}");
    }
    for forbidden in [
        "SQLiteConnection",
        "File.Write",
        "SetConfigValue",
        "Rebuild(",
    ] {
        assert!(!helper.contains(forbidden), "{forbidden}");
    }
    let reload = &SEED[SEED
        .find("private static void FinishReloadQualification()")
        .unwrap()
        ..SEED
            .find("public static void AssertMalformedNodePayloadRejected(")
            .unwrap()];
    let negative = reload
        .find("AssertMalformedNodePayloadRejected(row);")
        .unwrap();
    let evidence = reload.find("malformedNodePayloadRejected = true;").unwrap();
    let capture = reload.find("Capture(\"reloaded\");").unwrap();
    let validate = reload.find("ProjectSetupValidator.Validate();").unwrap();
    assert!(negative < evidence && evidence < capture && capture < validate);
    assert!(reload.contains("SQLiteOpenFlags.ReadOnly"));
    assert!(SEED.contains("EditorApplication.delayCall += FinishReloadQualification;"));
    let start = &SEED[SEED.find("public static void Validate()").unwrap()
        ..SEED
            .find("private static void FinishReloadQualification()")
            .unwrap()];
    assert!(
        start
            .find("logMessageReceivedThreaded += ReloadLog")
            .unwrap()
            < start
                .find("RunClassConstructor(typeof(UnitBase).TypeHandle)")
                .unwrap()
    );
    assert!(start.contains("UnityAPI.ProcessDelegates();"));
    assert!(start.contains("reloadClock.Elapsed.TotalSeconds >= 30"));
    assert!(SEED.contains("malformedNodePayloadRejected = malformedNodePayloadRejected"));
}

#[test]
fn missing_or_false_malformed_decoder_evidence_cannot_qualify() {
    let (hub, sdk) = qualified_receipts();
    assert!(qualify(&hub, &sdk).is_ok());
    let mut missing = sdk.clone();
    missing
        .as_object_mut()
        .unwrap()
        .remove("malformedNodePayloadRejected");
    assert!(qualify(&hub, &missing).is_err());
    let mut rejected = sdk;
    rejected["malformedNodePayloadRejected"] = json!(false);
    assert!(qualify(&hub, &rejected).is_err());
}

#[test]
fn candidate_waits_for_fifo_loader_without_toggling_automatic_updates() {
    let script = validator();
    let initialize = script
        .find("RunClassConstructor(typeof(UnitBase).TypeHandle)")
        .unwrap();
    let barrier = script.find("BackgroundWorker.Schedule(").unwrap();
    let wait = script
        .find("private static void WaitForCandidateLoader()")
        .unwrap();
    assert!(initialize < barrier && barrier < wait);
    let body = &script[wait..script
        .find("private static void ConfigureCandidateAfterLoader()")
        .unwrap()];
    assert!(body.contains("UnityAPI.ProcessDelegates();"));
    assert!(body.contains("candidateLoaderClock.Elapsed.TotalSeconds >= 30"));
    assert!(
        body.find("Volatile.Read(ref candidateLoaderDone)").unwrap()
            < body
                .find("EditorApplication.delayCall += candidateAfterLoader;")
                .unwrap()
    );
    assert!(!script.contains("updateNodesAutomatically ="));
    assert!(!body.contains("UnitBase.Rebuild"));
    assert!(script.contains("EditorApplication.update -= WaitForCandidateLoader;"));
}

#[test]
fn candidate_reopen_and_configuration_observe_delayed_loader_errors() {
    let script = validator();
    let begin = &script[script
        .find("private static void Configure(bool preserve)")
        .unwrap()
        ..script
            .find("private static void FinishConfiguration()")
            .unwrap()];
    assert!(
        begin.find("BeginCandidateErrorWatch();").unwrap()
            < begin
                .find("VSUsageUtility.isVisualScriptingUsed = true;")
                .unwrap()
    );
    let entry = &script[script.find("public static void Validate()").unwrap()
        ..script
            .find("private static void ValidateReloaded()")
            .unwrap()];
    assert!(
        entry.find("BeginCandidateErrorWatch();").unwrap()
            < entry
                .find("QueueAfterCandidateLoader(ValidateReloaded);")
                .unwrap()
    );
    let continuation = &script[script
        .find("private static void ConfigureCandidateAfterLoader()")
        .unwrap()
        ..script
            .find("private static void CheckCandidateSelectionsSaved()")
            .unwrap()];
    assert!(
        continuation.find("RequireNoCandidateErrors();").unwrap()
            < continuation
                .find("VsNodeGeneration.SetVSTypesAndAssemblies()")
                .unwrap()
    );
    let reloaded = &script[script
        .find("private static void ValidateReloaded()")
        .unwrap()..];
    assert!(
        reloaded.find("RequireNoCandidateErrors();").unwrap()
            < reloaded.find("ReadCandidateNodeDatabase();").unwrap()
    );
    assert!(script.contains("EditorApplication.delayCall -= candidateAfterLoader;"));
    assert!(script
        .contains("QueueAfterCandidateLoader(EditorApplication.CallbackFunction continuation)"));
}

#[test]
fn candidate_preserves_only_exact_nullable_project_stamp_before_mutation() {
    let script = validator();
    let configure = &script[script
        .find("private static void Configure(bool preserve)")
        .unwrap()
        ..script
            .find("private static void FinishConfiguration()")
            .unwrap()];
    assert!(
        configure.find("WriteCandidateStampBeforeImage();").unwrap()
            < configure
                .find("VSUsageUtility.isVisualScriptingUsed = true;")
                .unwrap()
    );
    let receipt = &script[script
        .find("private static void WriteCandidateStampBeforeImage()")
        .unwrap()
        ..script
            .find("private static void RequireCandidatePair()")
            .unwrap()];
    for required in [
        "sdk4022-node-stamp-before.json",
        "FileMode.CreateNew",
        "file.Flush(true);",
        "File.ReadAllBytes(path).SequenceEqual(bytes)",
        "apiValueWasNull = candidateStampBeforeValue == null",
        "value = candidateStampBeforeValue ?? \"\"",
        "restorationPerformed = false",
    ] {
        assert!(receipt.contains(required), "{required}");
    }
    assert!(!receipt.contains("SetConfigValue"));
    assert!(!script.contains("EditorUserSettings.asset"));
    assert!(script.contains(
        "EditorUserSettings.GetConfigValue(CandidateStampKey) != candidateStampBeforeValue"
    ));
    let loader = &script[script
        .find("private static void RequireCandidateLoaderReady()")
        .unwrap()
        ..script
            .find("private static void ConfigureCandidateAfterLoader()")
            .unwrap()];
    assert!(loader.contains("candidateLoaderClock.Elapsed.TotalSeconds >= 30"));
}

#[test]
fn newer_sdk_members_are_excluded_from_legacy_compilation() {
    let script = validation_script();
    let mut active = true;
    let mut compiled = String::new();
    for line in script.lines() {
        match line.trim() {
            "#if CREATOR_SETUP_SDK4022_VS1912_CANDIDATE" => {
                assert!(active);
                active = false;
            }
            "#else" => active = !active,
            "#endif" => active = true,
            _ if active => {
                compiled.push_str(line);
                compiled.push('\n');
            }
            _ => {}
        }
    }
    assert!(active);
    for newer in [
        "BS.SDKEditor.Setup",
        "NodesBuiltForThisVersion",
        "CandidateStampKey",
        "BackgroundWorker.Schedule",
        "ReadCandidateNodeDatabase",
    ] {
        assert!(
            !compiled.contains(newer),
            "Legacy compilation contains {newer}"
        );
    }
    assert!(compiled.contains("if (preserveSelections) UnitBase.Rebuild();"));
    assert!(compiled.contains("result.creatorSdkVersion == \"4.0.14\""));
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
            "CREATOR_SETUP_SDK_COMPATIBILITY_PREPARED_BASELINE_REVIEWED".into(),
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
fn existing_pair_manifest_is_read_only_and_unknown_fields_survive() {
    let original = json!({"dependencies": {"com.sidequest.creator-sdk": "4.0.22", "com.unity.visualscripting": "1.9.12", "com.unity.render-pipelines.universal": "17.3.0", "com.unity.inputsystem": "1.20.0", "other": "file:unchanged"}, "scopedRegistries": [{"custom": true}], "unknown": {"preserve": 7}});
    let before = serde_json::to_vec(&original).unwrap();
    existing_pair(&original).unwrap();
    assert_eq!(serde_json::to_vec(&original).unwrap(), before);
    for name in [
        "com.sidequest.creator-sdk",
        "com.unity.visualscripting",
        "com.unity.render-pipelines.universal",
        "com.unity.inputsystem",
    ] {
        let mut wrong = original.clone();
        wrong["dependencies"][name] = json!("unreviewed");
        assert!(existing_pair(&wrong).is_err());
    }
    let mut old = original.clone();
    old["dependencies"]["com.sidequest.creator-sdk"] = json!("4.0.14");
    old["dependencies"]["com.unity.visualscripting"] = json!("1.9.1");
    assert!(
        existing_pair(&old).is_err(),
        "This run is not an SDK upgrade test"
    );
}

#[test]
fn prepared_baseline_allows_only_the_exact_reviewed_openxr_hash_change() {
    let failure = format!("Protected file changed: {OPENXR}");
    let mut files: Snapshot = (0..49)
        .map(|i| (format!("Assets/Authored-{i}.asset"), "a".repeat(64)))
        .collect();
    files.insert(OPENXR.into(), OPENXR_BEFORE.into());
    let baseline = json!({"schemaVersion":1,"source":ORIGINAL,"target":SOURCE,
        "sourcePreserved":true,"protectedFilesPreserved":false,"packageChecksPassed":false,
        "qualificationPassed":false,"releaseAcceptance":false,"sourceCheckError":null,
        "error":failure,"protectedFilesCheckError":failure,"protectedFiles":files});
    let seed = json!({"phase":"seed","unityVersion":EDITOR_VERSION,"creatorSdkVersion":SDK,
        "visualScriptingVersion":VS,"creatorSdkSource":"Registry","visualScriptingSource":"Registry",
        "customTypePreserved":true,"customAssemblyPreserved":true,"nodeDatabaseExists":true,
        "markerUnchanged":true,"sdkReadyDone":false,"nodesBuiltForThisVersion":false,
        "sdkReadinessState":"NeedsFix","releaseAcceptance":false});
    let approved = prepared_protected(&baseline, &seed).unwrap();
    assert_eq!(approved.len(), 50);
    assert_eq!(approved[OPENXR], OPENXR_PREPARED);
    for (name, hash) in &files {
        if name != OPENXR {
            assert_eq!(&approved[name], hash);
        }
    }
    for (key, value) in [
        ("sourcePreserved", json!(false)),
        ("source", json!(SOURCE)),
        ("target", json!(TARGET)),
        ("error", json!("different failure")),
        ("protectedFilesCheckError", json!("another asset")),
        ("packageChecksPassed", json!(true)),
    ] {
        let mut wrong = baseline.clone();
        wrong[key] = value;
        assert!(prepared_protected(&wrong, &seed).is_err(), "{key}");
    }
    for (key, value) in [
        ("visualScriptingVersion", json!("1.9.1")),
        ("creatorSdkVersion", json!("4.0.14")),
        ("customTypePreserved", json!(false)),
        ("customAssemblyPreserved", json!(false)),
        ("creatorSdkSource", json!("Embedded")),
        ("markerUnchanged", json!(false)),
    ] {
        let mut wrong = seed.clone();
        wrong[key] = value;
        assert!(prepared_protected(&baseline, &wrong).is_err(), "{key}");
    }
    for hash in [OPENXR_PREPARED, "unreviewed"] {
        let mut wrong = baseline.clone();
        wrong["protectedFiles"][OPENXR] = json!(hash);
        assert!(prepared_protected(&wrong, &seed).is_err());
    }
    let mut wrong = baseline.clone();
    wrong["protectedFiles"]
        .as_object_mut()
        .unwrap()
        .remove(OPENXR);
    assert!(prepared_protected(&wrong, &seed).is_err());
    let mut wrong = baseline.clone();
    wrong["protectedFiles"]["Assets/Extra.asset"] = json!("b".repeat(64));
    assert!(prepared_protected(&wrong, &seed).is_err());
}

#[test]
fn reviewed_receipts_and_measured_assets_refuse_any_byte_drift() {
    let root = tempfile::tempdir().unwrap();
    let receipt = root.path().join("receipt.json");
    let bytes = b"{\"reviewed\":true}";
    fs::write(&receipt, bytes).unwrap();
    let hash = format!("{:x}", Sha256::digest(bytes));
    assert_eq!(
        reviewed_json(&receipt, bytes.len(), &hash).unwrap()["reviewed"],
        true
    );
    assert!(reviewed_json(&receipt, bytes.len() + 1, &hash).is_err());
    fs::write(&receipt, b"{\"reviewed\":null}").unwrap();
    assert!(reviewed_json(&receipt, bytes.len(), &hash).is_err());
    for name in ["Authored.asset", "OpenXR.asset"] {
        let file = root.path().join(name);
        fs::write(&file, b"prepared exact bytes").unwrap();
        let expected = Snapshot::from([(name.to_owned(), digest(&file).unwrap())]);
        check_files(root.path(), &expected).unwrap();
        fs::write(&file, b"unapproved repair change").unwrap();
        assert!(check_files(root.path(), &expected).is_err(), "{name}");
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
    assert!(excluded("Assets/Editor/UnitySdkCompatibilitySeed.cs"));
    assert!(excluded("Assets/Editor/UnitySdkCompatibilitySeed.cs.meta"));
    assert!(!excluded("Assets/Authored/UnitySdkCompatibilitySeed.cs"));
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
    let prepared_review = review_prepared_source().unwrap();
    let copied: Snapshot = source_before
        .iter()
        .filter(|(name, _)| !excluded(name))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let manifest = fs::read(source.join("Packages/manifest.json")).unwrap();
    existing_pair(&serde_json::from_slice(&manifest).unwrap()).unwrap();
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
    write_new(
        &status.join("prepared-baseline-review.json"),
        &serde_json::to_vec_pretty(&prepared_review).unwrap(),
    )
    .unwrap();
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
            review_prepared_source()?;
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
