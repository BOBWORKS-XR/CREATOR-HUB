use std::{path::Path, sync::Mutex};

use serde::{Deserialize, Serialize};

use crate::{manager, platform};

const MAX_RECORD_BYTES: u64 = 2048;
static PREFERENCES_MUTEX: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Flags {
    pub preview: Option<bool>,
    pub auto_download: Option<bool>,
    pub restore_hosted_views: Option<bool>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PreferenceKey {
    Preview,
    AutoDownload,
    RestoreHostedViews,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    schema_version: u32,
    #[serde(default)]
    preview: Option<bool>,
    #[serde(default)]
    auto_download: Option<bool>,
    #[serde(default)]
    restore_hosted_views: Option<bool>,
}

fn read_flags(path: &Path) -> Result<Option<Flags>, String> {
    platform::reject_links(path)?;
    if !path
        .try_exists()
        .map_err(|_| "Cannot inspect the saved Hub preferences.")?
    {
        return Ok(None);
    }
    let record: Record = serde_json::from_slice(&manager::bounded_read(path, MAX_RECORD_BYTES)?)
        .map_err(|_| {
            "The saved Hub preferences use an invalid or unsupported format; they were kept."
        })?;
    if record.schema_version != 1 {
        return Err(
            "The saved Hub preferences belong to an unsupported app version; they were kept."
                .into(),
        );
    }
    Ok(Some(Flags {
        preview: record.preview,
        auto_download: record.auto_download,
        restore_hosted_views: record.restore_hosted_views,
    }))
}

fn recorded(path: &Path) -> Result<Option<Flags>, String> {
    let _lock = PREFERENCES_MUTEX
        .lock()
        .map_err(|_| "Hub preference storage is unavailable.")?;
    read_flags(path)
}

fn save(path: &Path, key: PreferenceKey, value: bool) -> Result<(), String> {
    // Keep the entire read-modify-write and readback inside one process lock.
    let _lock = PREFERENCES_MUTEX
        .lock()
        .map_err(|_| "Hub preference storage is unavailable.")?;
    let mut flags = read_flags(path)?.unwrap_or_default();
    match key {
        PreferenceKey::Preview => flags.preview = Some(value),
        PreferenceKey::AutoDownload => flags.auto_download = Some(value),
        PreferenceKey::RestoreHostedViews => flags.restore_hosted_views = Some(value),
    }
    let bytes = serde_json::to_vec(&Record {
        schema_version: 1,
        preview: flags.preview,
        auto_download: flags.auto_download,
        restore_hosted_views: flags.restore_hosted_views,
    })
    .map_err(|_| "Cannot prepare the Hub preferences.")?;
    manager::atomic_write(path, &bytes)?;
    if read_flags(path)? != Some(flags) {
        return Err(
            "The Hub preferences could not be verified; the change was not confirmed.".into(),
        );
    }
    Ok(())
}

#[tauri::command]
pub fn hub_preferences_status() -> Result<Option<Flags>, String> {
    recorded(&manager::child_dir("preferences")?.join("hub-preferences.json"))
}

#[tauri::command]
pub fn set_hub_preference(key: PreferenceKey, value: bool) -> Result<(), String> {
    save(
        &manager::child_dir("preferences")?.join("hub-preferences.json"),
        key,
        value,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, sync::Arc, sync::Barrier, thread};

    #[test]
    fn missing_record_is_none_without_creating_a_file_or_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("preferences.json");
        assert_eq!(recorded(&path).unwrap(), None);
        assert!(!path.exists());
        assert_eq!(
            serde_json::to_value(Flags::default()).unwrap(),
            serde_json::json!({"preview": null, "autoDownload": null, "restoreHostedViews": null})
        );
    }

    #[test]
    fn false_survives_new_reads_and_unset_flags_stay_null() {
        for key in [
            PreferenceKey::Preview,
            PreferenceKey::AutoDownload,
            PreferenceKey::RestoreHostedViews,
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("preferences.json");
            save(&path, key, false).unwrap();
            let flags = recorded(&path).unwrap().unwrap();
            let expected = match key {
                PreferenceKey::Preview => Flags {
                    preview: Some(false),
                    ..Flags::default()
                },
                PreferenceKey::AutoDownload => Flags {
                    auto_download: Some(false),
                    ..Flags::default()
                },
                PreferenceKey::RestoreHostedViews => Flags {
                    restore_hosted_views: Some(false),
                    ..Flags::default()
                },
            };
            assert_eq!(flags, expected);
            assert_eq!(recorded(&path).unwrap(), Some(expected));
            let record: serde_json::Value =
                serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            assert_eq!(record["schemaVersion"], 1);
        }
    }

    #[test]
    fn partial_record_initialization_preserves_existing_and_unset_flags() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("preferences.json");
        fs::write(&path, br#"{"schemaVersion":1,"preview":false}"#).unwrap();
        assert_eq!(
            recorded(&path).unwrap(),
            Some(Flags {
                preview: Some(false),
                ..Flags::default()
            })
        );
        save(&path, PreferenceKey::AutoDownload, false).unwrap();
        assert_eq!(
            recorded(&path).unwrap(),
            Some(Flags {
                preview: Some(false),
                auto_download: Some(false),
                restore_hosted_views: None,
            })
        );
    }

    #[test]
    fn changing_one_flag_preserves_both_other_flags() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("preferences.json");
        save(&path, PreferenceKey::Preview, false).unwrap();
        save(&path, PreferenceKey::AutoDownload, false).unwrap();
        save(&path, PreferenceKey::RestoreHostedViews, true).unwrap();
        save(&path, PreferenceKey::AutoDownload, true).unwrap();
        assert_eq!(
            recorded(&path).unwrap(),
            Some(Flags {
                preview: Some(false),
                auto_download: Some(true),
                restore_hosted_views: Some(true),
            })
        );
    }

    #[test]
    fn rapid_mutations_remain_readable_and_keep_unrelated_flags() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("preferences.json");
        save(&path, PreferenceKey::Preview, false).unwrap();
        for index in 0..64 {
            let value = index % 2 == 0;
            save(&path, PreferenceKey::AutoDownload, value).unwrap();
            assert_eq!(
                recorded(&path).unwrap(),
                Some(Flags {
                    preview: Some(false),
                    auto_download: Some(value),
                    restore_hosted_views: None,
                })
            );
        }
    }

    #[test]
    fn concurrent_read_modify_writes_do_not_lose_other_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = Arc::new(dir.path().join("preferences.json"));
        let barrier = Arc::new(Barrier::new(3));
        let workers: Vec<_> = [
            PreferenceKey::Preview,
            PreferenceKey::AutoDownload,
            PreferenceKey::RestoreHostedViews,
        ]
        .into_iter()
        .map(|key| {
            let path = Arc::clone(&path);
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                for index in 0..32 {
                    barrier.wait();
                    save(&path, key, index % 2 == 0).unwrap();
                    assert!(recorded(&path).unwrap().is_some());
                }
            })
        })
        .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(
            recorded(&path).unwrap(),
            Some(Flags {
                preview: Some(false),
                auto_download: Some(false),
                restore_hosted_views: Some(false),
            })
        );
    }

    #[test]
    fn malformed_future_and_unknown_fields_are_not_read_or_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("preferences.json");
        for bytes in [
            b"not-json".as_slice(),
            b"{".as_slice(),
            b"null".as_slice(),
            b"[]".as_slice(),
            br#"{"preview":false}"#.as_slice(),
            br#"{"schemaVersion":2,"autoDownload":false}"#.as_slice(),
            br#"{"schemaVersion":1,"newPreference":true}"#.as_slice(),
            br#"{"schemaVersion":1,"autoDownload":"false"}"#.as_slice(),
            br#"{"schemaVersion":1,"auto-download":false}"#.as_slice(),
            br#"{"schemaVersion":1,"preview":false,"preview":true}"#.as_slice(),
        ] {
            fs::write(&path, bytes).unwrap();
            assert!(recorded(&path).is_err());
            assert!(save(&path, PreferenceKey::AutoDownload, true).is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
            assert!(!path.with_extension("pending").exists());
        }
    }

    #[test]
    fn size_bound_accepts_2048_bytes_but_refuses_2049_without_overwriting() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("preferences.json");
        let mut bytes = br#"{"schemaVersion":1,"autoDownload":false}"#.to_vec();
        bytes.resize(MAX_RECORD_BYTES as usize, b' ');
        fs::write(&path, &bytes).unwrap();
        assert_eq!(recorded(&path).unwrap().unwrap().auto_download, Some(false));
        bytes.push(b' ');
        fs::write(&path, &bytes).unwrap();
        assert!(recorded(&path).is_err());
        assert!(save(&path, PreferenceKey::Preview, true).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert!(!path.with_extension("pending").exists());
    }

    #[test]
    fn invalid_enum_keys_cannot_reach_the_writer() {
        for (json, expected) in [
            (r#""preview""#, PreferenceKey::Preview),
            (r#""auto-download""#, PreferenceKey::AutoDownload),
            (
                r#""restore-hosted-views""#,
                PreferenceKey::RestoreHostedViews,
            ),
        ] {
            assert_eq!(
                std::mem::discriminant(&serde_json::from_str::<PreferenceKey>(json).unwrap()),
                std::mem::discriminant(&expected)
            );
        }
        for json in [r#""autoDownload""#, r#""unknown""#, "null", "true"] {
            assert!(serde_json::from_str::<PreferenceKey>(json).is_err());
        }
    }

    #[test]
    fn write_failure_is_not_reported_as_success_and_keeps_beforeimage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("preferences.json");
        save(&path, PreferenceKey::AutoDownload, false).unwrap();
        let before = fs::read(&path).unwrap();
        fs::create_dir(path.with_extension("pending")).unwrap();
        assert!(save(&path, PreferenceKey::AutoDownload, true).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(recorded(&path).unwrap().unwrap().auto_download, Some(false));
        let missing_parent = dir.path().join("missing").join("preferences.json");
        assert!(save(&missing_parent, PreferenceKey::Preview, false).is_err());
        assert!(!missing_parent.exists());
    }

    #[cfg(unix)]
    #[test]
    fn linked_record_and_parent_are_refused_without_changing_beforeimage() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("original.json");
        save(&original, PreferenceKey::AutoDownload, false).unwrap();
        let before = fs::read(&original).unwrap();
        let linked = dir.path().join("preferences.json");
        std::os::unix::fs::symlink(&original, &linked).unwrap();
        assert!(recorded(&linked).is_err());
        assert!(save(&linked, PreferenceKey::AutoDownload, true).is_err());
        let parent = dir.path().join("linked-parent");
        std::os::unix::fs::symlink(dir.path(), &parent).unwrap();
        let through_parent = parent.join("original.json");
        assert!(recorded(&through_parent).is_err());
        assert!(save(&through_parent, PreferenceKey::Preview, true).is_err());
        assert_eq!(fs::read(&original).unwrap(), before);
    }

    #[cfg(windows)]
    #[test]
    fn junction_parent_is_refused_without_changing_beforeimage() {
        use std::{os::windows::process::CommandExt, process::Command};
        let dir = tempfile::tempdir().unwrap();
        let original_dir = dir.path().join("original");
        fs::create_dir(&original_dir).unwrap();
        let original = original_dir.join("preferences.json");
        save(&original, PreferenceKey::AutoDownload, false).unwrap();
        let before = fs::read(&original).unwrap();
        let linked_dir = dir.path().join("linked");
        let linked = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&linked_dir)
            .arg(&original_dir)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(
            linked.status.success(),
            "Cannot create disposable junction fixture"
        );
        let path = linked_dir.join("preferences.json");
        assert!(recorded(&path).is_err());
        assert!(save(&path, PreferenceKey::AutoDownload, true).is_err());
        assert_eq!(fs::read(&original).unwrap(), before);
        fs::remove_dir(&linked_dir).unwrap();
    }
}
