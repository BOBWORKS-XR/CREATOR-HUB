//! One-shot, bounded recovery of idle hosted views across a Hub update.
use crate::{catalog::AppId, hosted::Hosting, manager, platform};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager as _;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct View {
    pub app: AppId,
    pub path: PathBuf,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    schema_version: u32,
    from_version: String,
    to_version: String,
    created: u64,
    views: Vec<View>,
}

#[derive(Default)]
pub struct Restore(Mutex<Option<Vec<View>>>);

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn record_path() -> Result<PathBuf, String> {
    Ok(manager::child_dir("hub-updates")?.join("hosted-restore.json"))
}

fn validate(record: &Record, current: &str, time: u64) -> Result<(), String> {
    let invalid = || {
        "The saved app views cannot be restored automatically. Open the apps from Hub.".to_owned()
    };
    let from = semver::Version::parse(&record.from_version).map_err(|_| invalid())?;
    let to = semver::Version::parse(&record.to_version).map_err(|_| invalid())?;
    if record.schema_version != 1
        || to <= from
        || (current != record.from_version && current != record.to_version)
        || record.created > time
        || time - record.created > 24 * 60 * 60
        || record.views.len() > AppId::ALL.len()
        || record.views.iter().enumerate().any(|(i, v)| {
            !v.path.is_absolute()
                || record.views[..i]
                    .iter()
                    .any(|previous| previous.app == v.app)
        })
    {
        return Err(invalid());
    }
    Ok(())
}

fn consume(path: &Path, current: &str, time: u64) -> Result<Vec<View>, String> {
    platform::reject_links(path)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = manager::bounded_read(path, 16 * 1024);
    // Claim once before opening anything, including after installer cancellation.
    fs::remove_file(path).map_err(|_| "Cannot claim the saved app views. Nothing was reopened.")?;
    let record: Record = serde_json::from_slice(&data?)
        .map_err(|_| "Saved app views are invalid. Open the apps from Hub.")?;
    validate(&record, current, time)?;
    Ok(record.views)
}

impl Restore {
    pub fn remember(&self, views: Vec<View>, target: &str) -> Result<(), String> {
        let record = Record {
            schema_version: 1,
            from_version: env!("CARGO_PKG_VERSION").into(),
            to_version: target.into(),
            created: now(),
            views: views.clone(),
        };
        validate(&record, env!("CARGO_PKG_VERSION"), now())?;
        let mut pending = self
            .0
            .lock()
            .map_err(|_| "App restoration state unavailable.")?;
        manager::atomic_write(
            &record_path()?,
            &serde_json::to_vec(&record).map_err(|_| "Cannot record app views.")?,
        )?;
        // The same process can recover its views if the installer could not start.
        *pending = None;
        Ok(())
    }

    fn pending(&self) -> Result<Vec<View>, String> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| "App restoration state unavailable.")?;
        if state.is_none() {
            *state = Some(Vec::new());
            *state = Some(consume(&record_path()?, env!("CARGO_PKG_VERSION"), now())?);
        }
        Ok(state.as_ref().unwrap().clone())
    }

    fn completed(&self, app: AppId) -> Result<(), String> {
        if let Some(views) = self
            .0
            .lock()
            .map_err(|_| "App restoration state unavailable.")?
            .as_mut()
        {
            views.retain(|view| view.app != app);
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn pending_hosted_restore(handle: tauri::AppHandle) -> Result<Vec<AppId>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = handle.state::<manager::Manager>().begin()?;
        Ok(handle
            .state::<Restore>()
            .pending()?
            .iter()
            .map(|view| view.app)
            .collect())
    })
    .await
    .map_err(|_| "Could not read saved app views.")?
}

#[tauri::command]
pub async fn restore_hosted_app(
    handle: tauri::AppHandle,
    app: AppId,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = handle.state::<manager::Manager>().begin()?;
        let restore = handle.state::<Restore>();
        let view = restore
            .pending()?
            .into_iter()
            .find(|view| view.app == app)
            .ok_or("This app has no pending update restoration.")?;
        // Saved paths confer no authority. The current signed catalog selection
        // must still identify the same executable before it can be reopened.
        let (path, release) = handle
            .state::<manager::Manager>()
            .hosted_candidate(app)?
            .ok_or("The saved app is no longer a verified installed release.")?;
        if !platform::same_path(&path, &view.path) {
            return Err(
                "The saved app path changed. Open it from Hub to confirm the new selection.".into(),
            );
        }
        handle
            .state::<Hosting>()
            .start(&handle, app, &path, &release.executable_sha256)
    })
    .await
    .map_err(|_| "Could not reopen the saved app view.")?
}

#[tauri::command]
pub fn complete_hosted_restore(handle: tauri::AppHandle, app: AppId) -> Result<(), String> {
    handle.state::<Restore>().completed(app)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record() -> Record {
        Record {
            schema_version: 1,
            from_version: "0.1.5".into(),
            to_version: "0.1.6".into(),
            created: 100,
            views: vec![View {
                app: AppId::Setup,
                path: std::env::temp_dir().join("setup.exe"),
            }],
        }
    }
    #[test]
    fn only_the_source_or_target_build_can_restore_a_fresh_unique_plan() {
        assert!(validate(&record(), "0.1.5", 100).is_ok());
        assert!(validate(&record(), "0.1.6", 101).is_ok());
        for (version, time) in [
            ("0.1.4", 101),
            ("0.1.7", 101),
            ("0.1.6", 99),
            ("0.1.6", 86501),
        ] {
            assert!(validate(&record(), version, time).is_err());
        }
        let mut r = record();
        r.views.push(r.views[0].clone());
        assert!(validate(&r, "0.1.6", 101).is_err());
        r.views.pop();
        r.views[0].path = "relative.exe".into();
        assert!(validate(&r, "0.1.6", 101).is_err());
    }
    #[test]
    fn restoration_is_consumed_once_and_invalid_records_do_not_loop() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("resume.json");
        fs::write(&path, serde_json::to_vec(&record()).unwrap()).unwrap();
        assert_eq!(consume(&path, "0.1.6", 101).unwrap().len(), 1);
        assert!(consume(&path, "0.1.6", 101).unwrap().is_empty());
        for bytes in [b"invalid".to_vec(), vec![b' '; 16385]] {
            fs::write(&path, bytes).unwrap();
            assert!(consume(&path, "0.1.6", 101).is_err());
            assert!(!path.exists());
        }
    }
}
