//! Snapshot-bound publication for ordinary client setup.

use std::{fs, path::Path};

pub(crate) fn protected() -> bool {
    cfg!(windows) && option_env!("CREATOR_HUB_INTERNAL_MODULE") == Some("1")
}

pub(crate) fn snapshot(path: &Path) -> Result<Option<String>, String> {
    if protected() {
        return crate::settings_backup::read_text(path);
    }
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Cannot read client settings: {error}")),
    }
}

/// The caller has already parsed/validated ownership and approved ordinary setup.
pub(crate) fn commit(
    client: &str,
    path: &Path,
    before: Option<&[u8]>,
    after: &str,
) -> Result<(), String> {
    #[cfg(windows)]
    if protected() {
        crate::client_recovery_ui::require_no_pending_adjacent(path)?;
        return commit_reviewed_with(
            client,
            path,
            before,
            after,
            &crate::client_recovery_ui::central_root()?,
            &mut |_| Ok(()),
        );
    }
    #[cfg(not(windows))]
    let _ = (client, before);
    crate::settings_backup::retain(path)?;
    crate::atomic_write(path, after)
}

#[cfg(windows)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Boundary {
    Prepared,
    CreateStaged,
    Created,
}

#[cfg(windows)]
fn commit_reviewed_with(
    client: &str,
    path: &Path,
    before: Option<&[u8]>,
    after: &str,
    root: &Path,
    hook: &mut impl FnMut(Boundary) -> Result<(), String>,
) -> Result<(), String> {
    use crate::client_migration::recovery::{ReviewedWrite, Transaction};
    use crate::settings_backup as storage;
    if after.len() as u64 > storage::MAX_BYTES {
        return Err("Client settings exceed 2 MiB. Nothing was published.".into());
    }
    let Some(before) = before else {
        return create_new_with(path, after.as_bytes(), hook);
    };
    if before == after.as_bytes() {
        return if storage::read_bytes(path)?.as_deref() == Some(before) {
            Ok(()) // No filesystem publication is needed or authorized.
        } else {
            Err("Client settings changed during setup. Review again before retrying.".into())
        };
    }
    let transaction = Transaction::prepare(
        root,
        vec![ReviewedWrite::new(client, path, before, after.as_bytes())],
    )?;
    let prepared = transaction.inspect()?;
    hook(Boundary::Prepared).map_err(|error| {
        format!(
            "{error} Retain setup evidence at {}.",
            prepared.journal.display()
        )
    })?;
    let report = transaction.resume(|_| true)?;
    if !report.completed {
        return Err(format!(
            "Client setup did not complete: {:?}. Retain recovery evidence at {}. The target may already contain the proposed change; no automatic rollback or retry was attempted.",
            report.files.iter().map(|file| file.status).collect::<Vec<_>>(),
            report.journal.display()
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn create_new_with(
    path: &Path,
    after: &[u8],
    hook: &mut impl FnMut(Boundary) -> Result<(), String>,
) -> Result<(), String> {
    use crate::settings_backup as storage;
    use std::{io::Write, os::windows::ffi::OsStrExt};
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("Client setup requires an absolute, unambiguous path.".into());
    }
    storage::reject_links(path)?;
    let parent = path
        .parent()
        .ok_or("Client settings have no parent folder.")?;
    let parent = fs::canonicalize(parent).map_err(|_| "Client settings folder is unavailable.")?;
    if !parent.is_dir() || parent.to_string_lossy().starts_with(r"\\?\UNC\") {
        return Err("Client setup requires a local settings folder.".into());
    }
    let path = parent.join(
        path.file_name()
            .ok_or("Client settings have no file name.")?,
    );
    if storage::read_bytes(&path)?.is_some() {
        return Err("Client settings appeared during setup. Review them before retrying.".into());
    }
    let temporary = parent.join(format!(".creator-hub-setup-{}.tmp", uuid::Uuid::new_v4()));
    let staged = storage::StagedFile::write(&temporary, |file| {
        file.write_all(after)?;
        file.sync_all()
    })
    .map_err(|_| "Cannot stage new client settings. Nothing was published.")?;
    hook(Boundary::CreateStaged)?;
    storage::reject_links(&path)?;
    // MoveFileExW without REPLACE_EXISTING/COPY_ALLOWED is create-if-absent on
    // this volume. A preceding absence check is not used as authority to replace.
    staged.publish(|source| {
        let source: Vec<_> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }).map_err(|error| format!("New client settings were not confirmed ({error}). An appeared file was not replaced; inspect {} before retrying.", path.display()))?;
    hook(Boundary::Created).map_err(|error| {
        format!(
            "{error} New settings may already exist at {}; no rollback was attempted.",
            path.display()
        )
    })?;
    if storage::read_bytes(&path)?.as_deref() != Some(after) {
        return Err(
            "Client settings changed after creation. No rollback or retry was attempted.".into(),
        );
    }
    Ok(())
}

#[cfg(all(test, windows))]
pub(crate) fn commit_fixture(
    client: &str,
    path: &Path,
    before: Option<&[u8]>,
    after: &str,
    root: &Path,
) -> Result<(), String> {
    commit_reviewed_with(client, path, before, after, root, &mut |_| Ok(()))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::client_migration::recovery::{Status, Transaction};
    use std::io::Write;

    struct Fixture {
        _temporary: tempfile::TempDir,
        path: std::path::PathBuf,
        journals: std::path::PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let temporary = tempfile::tempdir().unwrap();
            let root = temporary.path().canonicalize().unwrap();
            Self {
                _temporary: temporary,
                path: root.join("config"),
                journals: root.join("journals"),
            }
        }
        fn commit(&self, before: Option<&[u8]>, after: &str) -> Result<(), String> {
            commit_fixture("Fixture", &self.path, before, after, &self.journals)
        }
        fn journal(&self) -> std::path::PathBuf {
            fs::read_dir(&self.journals)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .find(|path| path.is_dir())
                .unwrap()
        }
    }

    fn channel() -> crate::ProjectChannel {
        crate::ProjectChannel {
            id: "fixture".into(),
            name: "Fixture".into(),
            unity_project_path: "C:/disposable/project".into(),
            scene_path: None,
            enabled: true,
            extra: Default::default(),
        }
    }

    fn proposed(client: &str, original: &str) -> String {
        let channel = channel();
        match client {
            "codex" => {
                crate::build_codex_mcp_config(original, &channel, "node", "server.mjs", "core")
                    .unwrap()
            }
            "opencode" => {
                let built = crate::build_opencode_mcp_config(
                    serde_json::json!({"mcp":{}}),
                    &channel,
                    "node",
                    "server.mjs",
                    "core",
                )
                .unwrap();
                crate::jsonc::update_managed_entry(
                    original,
                    "mcp",
                    crate::MCP_CLIENT_ID,
                    crate::LEGACY_MCP_CLIENT_ID,
                    &built["mcp"][crate::MCP_CLIENT_ID],
                )
                .unwrap()
            }
            client => {
                let original = serde_json::from_str(original).unwrap();
                let built = if client == "claude" {
                    crate::build_claude_mcp_config(original, &channel, "node", "server.mjs", "core")
                        .unwrap()
                } else {
                    crate::build_antigravity_mcp_config(
                        original,
                        &channel,
                        "node",
                        "server.mjs",
                        "core",
                    )
                    .unwrap()
                };
                serde_json::to_string_pretty(&built).unwrap()
            }
        }
    }

    #[test]
    fn refuses_concurrent_edit_between_parse_and_ordinary_publication() {
        for name in ["claude", "codex", "antigravity", "opencode"] {
            let f = Fixture::new();
            let original = if name == "codex" {
                "# keep comment\r\nmodel='keep'\r\n"
            } else if name == "opencode" {
                "{ // keep comment\r\n\"mcp\":{\"other\":{\"enabled\":false}}}\r\n"
            } else {
                "{\"preferences\":{\"keep\":true}}\r\n"
            };
            fs::write(&f.path, original).unwrap();
            let before = snapshot(&f.path).unwrap().unwrap();
            let after = proposed(name, &before);
            let external = format!("{original} "); // An exact-byte edit, even if semantically unchanged.
            let edited = f.path.clone();
            let bytes = external.clone();
            std::thread::spawn(move || fs::write(edited, bytes).unwrap())
                .join()
                .unwrap();
            assert!(f.commit(Some(before.as_bytes()), &after).is_err(), "{name}");
            assert_eq!(fs::read_to_string(&f.path).unwrap(), external, "{name}");
            assert!(!f.journals.exists());
        }
    }

    #[test]
    fn replacement_after_preparation_is_kept_and_classified_not_applied() {
        let f = Fixture::new();
        fs::write(&f.path, "before\r\n").unwrap();
        let edited = f.path.clone();
        let result = commit_reviewed_with(
            "Fixture",
            &f.path,
            Some(b"before\r\n"),
            "after\n",
            &f.journals,
            &mut |at| {
                if at == Boundary::Prepared {
                    let edited = edited.clone();
                    std::thread::spawn(move || {
                        let replacement = edited.with_extension("external");
                        fs::write(&replacement, "external\r\n").unwrap();
                        fs::rename(replacement, edited).unwrap();
                    })
                    .join()
                    .unwrap();
                }
                Ok(())
            },
        );
        assert!(result.unwrap_err().contains("ExternalChange"));
        assert_eq!(fs::read(&f.path).unwrap(), b"external\r\n");
        let report = Transaction::open(&f.journal(), std::slice::from_ref(&f.path))
            .unwrap()
            .inspect()
            .unwrap();
        assert!(!report.completed);
        assert!(!report.historical_completed);
        assert_eq!(report.files[0].status, Status::ExternalChange);
        assert_eq!(
            fs::read(&report.files[0].before_image).unwrap(),
            b"before\r\n"
        );
        assert_eq!(fs::read(&report.files[0].after_image).unwrap(), b"after\n");
    }

    #[test]
    fn exact_images_and_successful_setup_are_idempotent() {
        for name in ["claude", "codex", "antigravity", "opencode"] {
            let f = Fixture::new();
            let original = if name == "codex" {
                "# exact comment\r\nmodel='keep'\r\n[mcp_servers.other]\r\ncommand='keep'\r\nenabled=false\r\n"
            } else if name == "opencode" {
                "{ // exact comment\r\n\"mcp\":{\"other\":{\"enabled\":false,\"environment\":{\"CUSTOM\":\"keep\"}}}}\r\n"
            } else {
                "{\"preferences\":{\"keep\":true},\"mcpServers\":{\"other\":{\"disabled\":true,\"env\":{\"CUSTOM\":\"keep\"}}}}\r\n"
            };
            fs::write(&f.path, original).unwrap();
            let after = proposed(name, original);
            f.commit(Some(original.as_bytes()), &after).unwrap();
            f.commit(Some(original.as_bytes()), &after).unwrap();
            assert_eq!(fs::read_to_string(&f.path).unwrap(), after);
            assert!(after.contains("keep"));
            if matches!(name, "codex" | "opencode") {
                assert!(after.contains("exact comment"));
            }
            let report = Transaction::open(&f.journal(), std::slice::from_ref(&f.path))
                .unwrap()
                .inspect()
                .unwrap();
            assert!(report.completed);
            let file = &report.files[0];
            for image in [&file.before_image, &file.before_backup, &file.displaced] {
                assert_eq!(fs::read(image).unwrap(), original.as_bytes());
            }
            assert_eq!(fs::read(&file.after_image).unwrap(), after.as_bytes());
        }
    }

    #[test]
    fn absent_creation_never_replaces_a_file_appearing_at_native_boundary() {
        for external in ["external\r\n", "proposed\n"] {
            let f = Fixture::new();
            assert!(snapshot(&f.path).unwrap().is_none());
            let edited = f.path.clone();
            let result = commit_reviewed_with(
                "Fixture",
                &f.path,
                None,
                "proposed\n",
                &f.journals,
                &mut |at| {
                    if at == Boundary::CreateStaged {
                        let edited = edited.clone();
                        std::thread::spawn(move || {
                            let mut file = fs::OpenOptions::new()
                                .write(true)
                                .create_new(true)
                                .open(edited)
                                .unwrap();
                            file.write_all(external.as_bytes()).unwrap();
                            file.sync_all().unwrap();
                        })
                        .join()
                        .unwrap();
                    }
                    Ok(())
                },
            );
            assert!(result.is_err());
            assert_eq!(fs::read_to_string(&f.path).unwrap(), external);
            assert_eq!(fs::read_dir(f.path.parent().unwrap()).unwrap().count(), 1);
        }
    }

    #[test]
    fn empty_existing_snapshot_is_not_absence_and_missing_existing_is_not_recreated() {
        let f = Fixture::new();
        fs::write(&f.path, "").unwrap();
        assert_eq!(snapshot(&f.path).unwrap(), Some(String::new()));
        fs::remove_file(&f.path).unwrap();
        assert!(f.commit(Some(b""), "after").is_err());
        assert!(!f.path.exists());
        f.commit(None, "after").unwrap();
        assert_eq!(fs::read_to_string(&f.path).unwrap(), "after");
        assert!(f.commit(None, "after").is_err()); // Equal bytes are not adoption authority.
    }

    #[test]
    fn interrupted_preparation_keeps_exact_images_for_explicit_recovery() {
        let f = Fixture::new();
        fs::write(&f.path, "before").unwrap();
        let result = commit_reviewed_with(
            "Fixture",
            &f.path,
            Some(b"before"),
            "after",
            &f.journals,
            &mut |at| {
                assert_eq!(at, Boundary::Prepared);
                Err("injected interruption".into())
            },
        );
        assert!(result.unwrap_err().contains("Retain setup evidence"));
        assert_eq!(fs::read_to_string(&f.path).unwrap(), "before");
        let transaction = Transaction::open(&f.journal(), std::slice::from_ref(&f.path)).unwrap();
        let report = transaction.inspect().unwrap();
        assert_eq!(report.files[0].status, Status::Ready);
        assert_eq!(fs::read(&report.files[0].before_image).unwrap(), b"before");
        assert_eq!(fs::read(&report.files[0].after_image).unwrap(), b"after");
        assert!(!transaction.resume(|_| false).unwrap().completed);
        assert_eq!(fs::read_to_string(&f.path).unwrap(), "before");
        assert!(transaction.resume(|_| true).unwrap().completed);
    }

    #[test]
    fn creation_faults_never_rollback_or_retry_a_published_file() {
        for boundary in [Boundary::CreateStaged, Boundary::Created] {
            let f = Fixture::new();
            let result =
                commit_reviewed_with("Fixture", &f.path, None, "after", &f.journals, &mut |at| {
                    if at == boundary {
                        Err("injected interruption".into())
                    } else {
                        Ok(())
                    }
                });
            assert!(result.is_err());
            if boundary == Boundary::CreateStaged {
                assert!(!f.path.exists());
                assert_eq!(fs::read_dir(f.path.parent().unwrap()).unwrap().count(), 0);
            } else {
                assert_eq!(fs::read_to_string(&f.path).unwrap(), "after");
                assert!(f.commit(None, "after").is_err());
                assert_eq!(fs::read_to_string(&f.path).unwrap(), "after");
            }
        }
    }

    #[test]
    fn unchanged_snapshot_is_a_noop_but_stale_noop_and_oversize_refuse() {
        let f = Fixture::new();
        fs::write(&f.path, "before").unwrap();
        f.commit(Some(b"before"), "before").unwrap();
        assert!(!f.journals.exists());
        fs::write(&f.path, "external").unwrap();
        assert!(f.commit(Some(b"before"), "before").is_err());
        assert_eq!(fs::read_to_string(&f.path).unwrap(), "external");
        assert!(f
            .commit(
                Some(b"external"),
                &"x".repeat(crate::settings_backup::MAX_BYTES as usize + 1)
            )
            .is_err());
        assert_eq!(fs::read_to_string(&f.path).unwrap(), "external");
    }

    #[test]
    fn subsequent_success_preserves_history_but_old_report_is_not_current_completion() {
        let f = Fixture::new();
        fs::write(&f.path, "before").unwrap();
        f.commit(Some(b"before"), "first setup").unwrap();
        let earlier = f.journal();
        f.commit(Some(b"first setup"), "second setup").unwrap();
        assert_eq!(fs::read_to_string(&f.path).unwrap(), "second setup");
        let report = Transaction::open(&earlier, std::slice::from_ref(&f.path))
            .unwrap()
            .inspect()
            .unwrap();
        assert!(earlier.join("completed.json").is_file());
        assert!(!report.completed);
        assert!(report.historical_completed);
        assert_eq!(report.files[0].status, Status::ExternalChange);
        assert_eq!(fs::read(&report.files[0].before_image).unwrap(), b"before");
        assert_eq!(
            fs::read(&report.files[0].after_image).unwrap(),
            b"first setup"
        );
    }
}

#[cfg(test)]
mod standalone_tests {
    use super::*;

    #[test]
    fn standalone_publication_does_not_enter_unsupported_recovery() {
        if protected() {
            return;
        }
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().canonicalize().unwrap().join("config");
        assert!(snapshot(&path).unwrap().is_none());
        commit("Fixture", &path, None, "before").unwrap();
        commit("Fixture", &path, Some(b"before"), "after").unwrap();
        assert_eq!(snapshot(&path).unwrap().as_deref(), Some("after"));
        assert!(!path
            .parent()
            .unwrap()
            .join(".creator-hub-migrations")
            .exists());
    }
}
