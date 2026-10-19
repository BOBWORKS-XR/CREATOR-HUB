//! Internal Hub API. This does not create an application, window or child backend.
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

pub struct DirectEvents;

/// Call only after native approval, on Hub's blocking operation worker.
/// This caches a registry helper, not AI CLI consent or a Pipeline installation.
pub fn prepare_project_helper() -> Result<std::path::PathBuf, String> {
    let _operation = crate::lifecycle::LIFECYCLE.command()?;
    crate::hub::prepare_missing_project_helper(&|_| {})
}

pub fn initialize(app: &tauri::AppHandle) -> Result<(), String> {
    if app.manage(DirectEvents) {
        Ok(())
    } else {
        Err("Project Setup is already initialized in Hub.".into())
    }
}

pub(crate) fn emit(app: &tauri::AppHandle, name: &str, payload: impl serde::Serialize) {
    let _ = app.emit(
        "feature-event",
        json!({ "feature": "setup", "name": name, "payload": payload }),
    );
}

fn validate(command: &str, args: &Value) -> Result<(), String> {
    if !crate::hosted::COMMANDS.contains(&command) {
        return Err("Unsupported Project Setup operation.".into());
    }
    if !args.is_object()
        || serde_json::to_vec(args)
            .map_err(|_| "Invalid Project Setup arguments.")?
            .len()
            > 60_000
    {
        return Err("Invalid or oversized Project Setup arguments.".into());
    }
    Ok(())
}

/// Call from a blocking worker while Hub retains its native operation lease.
pub fn call(app: &tauri::AppHandle, command: &str, args: Value) -> Result<Value, String> {
    if app.try_state::<DirectEvents>().is_none() {
        return Err("Project Setup is not initialized in this Hub.".into());
    }
    validate(command, &args)?;
    crate::hosted::dispatch(app, command, args)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finite_operations_refuse_unknown_and_non_object_requests() {
        for command in crate::hosted::COMMANDS {
            assert!(validate(command, &json!({})).is_ok());
        }
        for command in ["initialize", "exec", "download_community_package", ""] {
            assert!(validate(command, &json!({})).is_err());
        }
        for args in [Value::Null, json!([]), json!("path"), json!(1)] {
            assert!(validate("get_recipe", &args).is_err());
        }
        assert!(validate("get_recipe", &json!({"extra": "x".repeat(60_000)})).is_err());
    }

    #[test]
    fn recipe_has_the_existing_serialized_contract() {
        assert_eq!(
            serde_json::to_value(crate::get_recipe().unwrap()).unwrap(),
            serde_json::to_value(crate::logic::recipe()).unwrap()
        );
    }

    #[test]
    fn inspection_preserves_path_errors_and_project_contents() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");
        assert_eq!(
            tauri::async_runtime::block_on(crate::inspect_project(
                missing.to_string_lossy().into_owned()
            ))
            .unwrap_err(),
            crate::repair::inspect(&missing).unwrap_err()
        );
        let sentinel = dir.path().join("keep.txt");
        std::fs::write(&sentinel, b"unchanged").unwrap();
        assert!(crate::repair::inspect(dir.path()).is_err());
        assert_eq!(std::fs::read(&sentinel).unwrap(), b"unchanged");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
