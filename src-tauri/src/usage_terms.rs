use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use crate::{manager, platform};

const POLICY_VERSION: &str = "2026-09-28-v1";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Acceptance {
    schema_version: u32,
    policy_version: String,
    accepted_at_ms: u64,
}

fn recorded(path: &Path) -> Result<bool, String> {
    platform::reject_links(path)?;
    if !path
        .try_exists()
        .map_err(|_| "Cannot inspect the terms acknowledgement.")?
    {
        return Ok(false);
    }
    let saved: Acceptance =
        serde_json::from_slice(&manager::bounded_read(path, 2048)?).map_err(|_| {
            "The saved terms acknowledgement is invalid. Please review the terms again."
        })?;
    if saved.schema_version != 1 || saved.policy_version != POLICY_VERSION {
        return Err("The saved acknowledgement belongs to an unsupported policy or app version. Open the newer app; this record was kept.".into());
    }
    Ok(saved.accepted_at_ms > 0)
}

fn save(path: &Path, policy_version: &str, accepted: bool) -> Result<(), String> {
    if !accepted || policy_version != POLICY_VERSION {
        return Err("Accept the current terms before continuing.".into());
    }
    platform::reject_links(path)?;
    if path
        .try_exists()
        .map_err(|_| "Cannot inspect the terms acknowledgement.")?
    {
        let bytes = manager::bounded_read(path, 2048)?;
        // A corrupt write can be retried after explicit consent, but a different
        // app's well-formed schema or policy must never be silently downgraded.
        if serde_json::from_slice::<serde_json::Value>(&bytes).is_ok() {
            let previous: Acceptance = serde_json::from_slice(&bytes).map_err(|_| {
                "The saved acknowledgement uses an unsupported format; it was kept."
            })?;
            if previous.schema_version != 1 || previous.policy_version != POLICY_VERSION {
                return Err("The saved acknowledgement belongs to an unsupported policy or app version; it was kept.".into());
            }
        }
    }
    let accepted_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Cannot record the acknowledgement time.")?
        .as_millis()
        .try_into()
        .map_err(|_| "Cannot record the acknowledgement time.")?;
    manager::atomic_write(
        path,
        &serde_json::to_vec(&Acceptance {
            schema_version: 1,
            policy_version: policy_version.into(),
            accepted_at_ms,
        })
        .map_err(|_| "Cannot prepare the terms acknowledgement.")?,
    )?;
    if !recorded(path)? {
        return Err("The acknowledgement could not be verified; the app remains locked.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn usage_terms_status() -> Result<bool, String> {
    recorded(&manager::child_dir("consent")?.join("hub-usage-terms.json"))
}

#[tauri::command]
pub fn accept_usage_terms(policy_version: String, accepted: bool) -> Result<(), String> {
    save(
        &manager::child_dir("consent")?.join("hub-usage-terms.json"),
        &policy_version,
        accepted,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acceptance_survives_a_new_read_without_browser_storage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("terms.json");
        assert!(!recorded(&path).unwrap());
        save(&path, POLICY_VERSION, true).unwrap();
        assert!(recorded(&path).unwrap());
        save(&path, POLICY_VERSION, true).unwrap();
        assert!(recorded(&path).unwrap());
    }

    #[test]
    fn rejection_and_old_policy_do_not_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("terms.json");
        assert!(save(&path, POLICY_VERSION, false).is_err());
        assert!(save(&path, "old-policy", true).is_err());
        assert!(!path.exists());
        std::fs::write(
            &path,
            br#"{"schemaVersion":1,"policyVersion":"old-policy","acceptedAtMs":1}"#,
        )
        .unwrap();
        assert!(recorded(&path).is_err());
    }

    #[test]
    fn malformed_and_oversized_records_never_count_as_acceptance() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("terms.json");
        std::fs::write(&path, b"not-json").unwrap();
        assert!(recorded(&path).is_err());
        save(&path, POLICY_VERSION, true).unwrap();
        assert!(recorded(&path).unwrap());
        std::fs::write(&path, vec![b' '; 2049]).unwrap();
        assert!(recorded(&path).is_err());
        assert!(save(&path, POLICY_VERSION, true).is_err());
    }

    #[test]
    fn future_policy_or_schema_cannot_be_downgraded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("terms.json");
        for bytes in [
            br#"{"schemaVersion":1,"policyVersion":"future-policy","acceptedAtMs":1}"#.as_slice(),
            br#"{"schemaVersion":2,"policyVersion":"2026-09-28-v1","acceptedAtMs":1}"#.as_slice(),
            br#"{"schemaVersion":2,"policyVersion":"future-policy","acceptedAtMs":1,"newField":true}"#.as_slice(),
        ] {
            std::fs::write(&path, bytes).unwrap();
            assert!(recorded(&path).is_err());
            assert!(save(&path, POLICY_VERSION, true).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
    }

    #[test]
    fn write_failure_is_not_acceptance() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing-parent").join("terms.json");
        assert!(save(&path, POLICY_VERSION, true).is_err());
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn linked_records_are_not_read_or_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("original.json");
        let linked = dir.path().join("terms.json");
        save(&original, POLICY_VERSION, true).unwrap();
        let before = std::fs::read(&original).unwrap();
        std::os::unix::fs::symlink(&original, &linked).unwrap();
        assert!(recorded(&linked).is_err());
        assert!(save(&linked, POLICY_VERSION, true).is_err());
        assert_eq!(std::fs::read(original).unwrap(), before);
    }
}
