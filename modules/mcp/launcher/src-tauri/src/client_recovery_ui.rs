//! Recovery locations are derived from known clients, never from UI paths.
use crate::client_migration::recovery::{Status, Transaction};
use serde::Serialize;
use std::{fs, path::Path};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Pending {
    clients: Vec<String>,
    client_name: String,
    central: bool,
    operation: String,
    can_resume: bool,
    message: String,
}

fn supported() -> bool {
    crate::settings_review_admission::enabled()
}

fn recovery_clients(os: &str) -> Result<&'static [&'static str], String> {
    match os {
        "linux" => Ok(&["codex", "claude", "antigravity", "opencode"]),
        "windows" | "macos" => Ok(&[
            "codex",
            "claude",
            "claudeDesktop",
            "antigravity",
            "opencode",
        ]),
        _ => Err("Client recovery is unavailable on this platform.".into()),
    }
}

fn operation_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn collect(client: &str, name: &str, path: &Path) -> Result<Vec<Pending>, String> {
    let root = path
        .parent()
        .ok_or("Client settings folder is unavailable.")?
        .join(".creator-hub-migrations");
    collect_root(&root, &[client.into()], name, &[path.to_path_buf()], false)
}

pub(crate) fn central_root() -> Result<std::path::PathBuf, String> {
    #[cfg(test)]
    {
        Err("Unit tests must use explicit disposable migration storage.".into())
    }
    #[cfg(not(test))]
    {
        Ok(dirs::data_local_dir()
            .ok_or("Local Hub data is unavailable.")?
            .join("creator-hub")
            .join("client-migrations-v1"))
    }
}

pub(crate) fn require_no_pending_adjacent(path: &Path) -> Result<(), String> {
    if !collect("client", "Client", path)?.is_empty() {
        return Err("A previous connection migration requires recovery review before setup. Current files and retained evidence were kept.".into());
    }
    Ok(())
}

fn collect_root(
    root: &Path,
    clients: &[String],
    name: &str,
    paths: &[std::path::PathBuf],
    central: bool,
) -> Result<Vec<Pending>, String> {
    crate::settings_backup::reject_links(root)?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut pending = Vec::new();
    for (index, entry) in fs::read_dir(root)
        .map_err(|_| "Cannot inspect retained migrations.")?
        .enumerate()
    {
        if index >= 128 {
            return Err("Too many retained migrations. No recovery was attempted.".into());
        }
        let entry = entry.map_err(|_| "Cannot inspect retained migration.")?;
        let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if id == "hub.lock" {
            continue;
        }
        if !operation_valid(&id) {
            return Err("Unexpected recovery storage. Keep the files for inspection.".into());
        }
        let result = if central {
            Transaction::open_allowlisted(&entry.path(), paths)
        } else {
            Transaction::open(&entry.path(), paths)
        }
        .and_then(|transaction| transaction.inspect());
        match result {
            Ok(report) if report.historical_completed => {}
            Ok(report) => {
                let can_resume = report
                    .files
                    .iter()
                    .all(|file| matches!(file.status, Status::Ready | Status::Applied));
                pending.push(Pending { clients: clients.into(), client_name: name.into(), central, operation: id, can_resume,
                    message: format!("Previous migration: {:?}. {}", report.files.iter().map(|file| file.status).collect::<Vec<_>>(),
                        if can_resume { "Review is required before completing it." } else { "The retained files need manual inspection; no automatic restoration is allowed." }) });
            }
            Err(error) => pending.push(Pending {
                clients: clients.into(),
                client_name: name.into(),
                central,
                operation: id,
                can_resume: false,
                message: error,
            }),
        }
    }
    pending.sort_by(|a, b| a.operation.cmp(&b.operation));
    Ok(pending)
}

#[tauri::command]
pub(crate) fn pending_client_recovery() -> Result<Vec<Pending>, String> {
    if !supported() {
        return Ok(Vec::new());
    }
    let mut records = Vec::new();
    let mut clients = Vec::new();
    let mut paths = Vec::new();
    for &client in recovery_clients(std::env::consts::OS)? {
        let (name, path, _) = crate::client_target(client)?;
        records.extend(collect(client, name, &path)?);
        clients.push(client.to_owned());
        paths.push(path);
    }
    records.extend(collect_root(
        &central_root()?,
        &clients,
        "Selected AI clients",
        &paths,
        true,
    )?);
    Ok(records)
}

#[tauri::command]
pub(crate) fn recover_client_connection(
    app: tauri::AppHandle,
    clients: Vec<String>,
    operation: String,
    central: bool,
) -> Result<serde_json::Value, String> {
    if !supported()
        || !operation_valid(&operation)
        || clients.is_empty()
        || clients.len() > 5
        || !central && clients.len() != 1
        || clients
            .iter()
            .enumerate()
            .any(|(index, id)| clients[..index].contains(id))
    {
        return Err("Recovery is unavailable or its scope is invalid. Nothing was changed.".into());
    }
    let paths = clients
        .iter()
        .map(|client| crate::client_target(client).map(|(_, path, _)| path))
        .collect::<Result<Vec<_>, _>>()?;
    let root = if central {
        central_root()?
    } else {
        paths[0]
            .parent()
            .ok_or("Client settings folder is unavailable.")?
            .join(".creator-hub-migrations")
    };
    let transaction = if central {
        Transaction::open_allowlisted(&root.join(operation), &paths)?
    } else {
        Transaction::open(&root.join(operation), &paths)?
    };
    let report = transaction.resume(|report| {
        if report.completed || report.files.iter().any(|file| !matches!(file.status, Status::Ready | Status::Applied)) { return false; }
        app.dialog().message(format!("Complete these previously reviewed connection changes?\n\nSettings: {}\nRecovery records: {}\n\nCurrent state: {:?}. Only exact unchanged reviewed files can be completed. Backups are retained. Changed or uncertain files are never restored or overwritten automatically. No AI app or Unity process will be stopped.", report.files.iter().map(|file|file.path.display().to_string()).collect::<Vec<_>>().join("\n"), report.journal.display(), report.files.iter().map(|file| file.status).collect::<Vec<_>>()))
            .title("Review interrupted MCP migration").kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Complete reviewed change".into(), "Keep current files".into())).blocking_show()
    })?;
    Ok(
        serde_json::json!({"clients": clients, "completed": report.completed, "journal": report.journal,
        "states": report.files.iter().map(|file| file.status).collect::<Vec<_>>() }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_recovery_inventory_excludes_only_unsupported_desktop() {
        assert_eq!(
            recovery_clients("linux").unwrap(),
            ["codex", "claude", "antigravity", "opencode"]
        );
    }

    #[test]
    fn windows_and_macos_recovery_inventory_keeps_all_five_clients() {
        for os in ["windows", "macos"] {
            assert_eq!(
                recovery_clients(os).unwrap(),
                [
                    "codex",
                    "claude",
                    "claudeDesktop",
                    "antigravity",
                    "opencode"
                ]
            );
        }
    }

    #[test]
    fn recovery_inventory_refuses_unknown_platforms() {
        for os in ["", "freebsd", "unknown"] {
            assert!(recovery_clients(os).is_err());
        }
        assert_eq!(
            recovery_clients(std::env::consts::OS).unwrap().len(),
            if cfg!(target_os = "linux") { 4 } else { 5 }
        );
    }

    #[test]
    fn supported_client_unknown_recovery_storage_still_refuses() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let config = base.join("settings.json");
        fs::write(&config, b"original").unwrap();
        fs::create_dir_all(base.join(".creator-hub-migrations/unrecognized")).unwrap();
        assert!(collect("codex", "Codex", &config)
            .err()
            .unwrap()
            .contains("Unexpected recovery storage"));
        assert_eq!(fs::read(config).unwrap(), b"original");
    }

    #[test]
    fn supported_client_uninspectable_recovery_storage_still_refuses() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let config = base.join("settings.json");
        fs::write(&config, b"original").unwrap();
        let root = base.join(".creator-hub-migrations");
        fs::write(&root, b"not a directory").unwrap();
        assert!(collect("codex", "Codex", &config)
            .err()
            .unwrap()
            .contains("Cannot inspect retained migrations"));
        assert_eq!(fs::read(config).unwrap(), b"original");
        assert_eq!(fs::read(root).unwrap(), b"not a directory");
    }

    #[test]
    fn unit_tests_cannot_select_the_real_client_recovery_store() {
        assert!(central_root()
            .unwrap_err()
            .contains("explicit disposable migration storage"));
    }
    #[test]
    fn ui_cannot_supply_a_path_as_a_recovery_identifier() {
        assert!(operation_valid(&"a".repeat(64)));
        for id in ["../other", "C:\\settings", "a/b", "", "DEADBEEF"] {
            assert!(!operation_valid(id));
        }
    }
    #[test]
    fn malformed_journal_is_visible_but_never_resumable_and_other_settings_are_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("settings.json");
        fs::write(&config, b"original").unwrap();
        let journal = dir
            .path()
            .join(".creator-hub-migrations")
            .join("a".repeat(64));
        fs::create_dir_all(journal).unwrap();
        let reports = collect("codex", "Codex", &config).unwrap();
        assert_eq!(reports.len(), 1);
        assert!(!reports[0].can_resume);
        assert!(require_no_pending_adjacent(&config).is_err());
        assert_eq!(fs::read(&config).unwrap(), b"original");
    }

    #[cfg(windows)]
    #[test]
    fn subsequent_successful_setup_does_not_turn_completed_history_into_pending_recovery() {
        use crate::client_migration::recovery::ReviewedWrite;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().canonicalize().unwrap().join("settings.json");
        fs::write(&path, b"before").unwrap();
        let root = path.parent().unwrap().join(".creator-hub-migrations");
        for (before, after) in [("before", "first"), ("first", "second")] {
            let transaction = Transaction::prepare(
                &root,
                vec![ReviewedWrite::new(
                    "Codex",
                    &path,
                    before.as_bytes(),
                    after.as_bytes(),
                )],
            )
            .unwrap();
            assert!(transaction.resume(|_| true).unwrap().completed);
        }
        assert!(collect("codex", "Codex", &path).unwrap().is_empty());
        require_no_pending_adjacent(&path).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
    }
}
