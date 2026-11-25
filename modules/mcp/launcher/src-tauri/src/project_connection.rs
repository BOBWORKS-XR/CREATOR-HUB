//! Windows project-scoped Claude repair. Never write the user's account config.
use super::{
    json_insert, json_member, json_object, json_trivia, recovery, safe_environment,
    same_router_path,
};
use crate::{client_ownership, jsonc, settings_backup as storage};
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};

const KEEP: &str = "Hub can't safely update this project connection. Your existing setup was kept.";

fn local_project(path: &Path) -> bool {
    use std::path::Prefix;
    matches!(path.components().next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
        && path.is_absolute()
        && !path.components().any(|p| p == Component::ParentDir)
        && path
            .to_str()
            .is_some_and(|s| !s.chars().any(char::is_control))
}

fn display_path(path: &Path) -> Result<String, String> {
    let path = crate::normalized_existing_path(path.to_owned());
    let s = path.to_str().ok_or(KEEP)?.replace('\\', "/");
    if !path.is_absolute() || s.starts_with("//") || s.chars().any(char::is_control) {
        return Err(KEEP.into());
    }
    Ok(s)
}

// Compare to a path Hub derived itself before inspecting either signed executable.
fn trusted_routes(command: &str) -> Result<(PathBuf, creator_hub_mcp_router::Router), String> {
    let base = creator_hub_mcp_router::Store::installed_base()?;
    let scope = PathBuf::from("mcp-route-v1").join(format!("windows-{}", std::env::consts::ARCH));
    let file = "creator-hub-mcp-router.exe";
    let old = [
        dirs::data_local_dir().ok_or(KEEP)?.join("creator-hub"),
        base.clone(),
    ]
    .into_iter()
    .map(|p| p.join(&scope).join("router-v1").join(file))
    .find(|p| p.to_str().is_some_and(|s| same_router_path(command, s)))
    .ok_or(KEEP)?;
    creator_hub_mcp_router::Store::verify_retained_router_command(&old)?;
    let store = creator_hub_mcp_router::Store::installed()?;
    let router = store.router()?;
    if router.command != base.join(scope).join("router-v2").join(file) {
        return Err(KEEP.into());
    }
    store.resolve()?; // Verify the active runtime too, without launching it.
    Ok((old, router))
}

fn connection_entry(data: &Value) -> Result<(&str, &Value), String> {
    let servers = data["mcpServers"].as_object().ok_or(KEEP)?;
    let mut found = [crate::MCP_CLIENT_ID, crate::LEGACY_MCP_CLIENT_ID]
        .into_iter()
        .filter_map(|id| servers.get(id).map(|e| (id, e)));
    let (id, entry) = found.next().ok_or(KEEP)?;
    if found.next().is_some()
        || !entry.is_object()
        || entry.get("url").is_some()
        || entry.get("type").is_some_and(|v| v != "stdio")
        || entry
            .get("args")
            .is_some_and(|v| !v.as_array().is_some_and(Vec::is_empty))
    {
        return Err(KEEP.into());
    }
    Ok((id, entry))
}

fn render(text: &str, project: &str, old: &str, new: &str) -> Result<String, String> {
    let mut expected: Value = serde_json::from_str(text).map_err(|_| KEEP)?;
    jsonc::parse_unambiguous(text)?;
    let (id, entry) = connection_entry(&expected)?;
    let id = id.to_owned();
    if !same_router_path(entry["command"].as_str().ok_or(KEEP)?, old) {
        return Err(KEEP.into());
    }
    if let Some(env) = entry.get("env") {
        let env = env.as_object().ok_or(KEEP)?;
        safe_environment(env.keys().map(String::as_str))?;
        for (k, value) in env {
            let v = value.as_str().ok_or(KEEP)?;
            if k.eq_ignore_ascii_case("UNITY_PROJECT_PATH")
                || k.eq_ignore_ascii_case("BANTER_PROJECT_PATH")
            {
                if !matches!(k.as_str(), "UNITY_PROJECT_PATH" | "BANTER_PROJECT_PATH")
                    || !same_router_path(v.trim_end_matches(['/', '\\']), project)
                {
                    return Err("This connection names a different project or uses a custom project path. Hub left it alone.".into());
                }
            }
            if k == client_ownership::OWNER_KEY && v != client_ownership::OWNER {
                return Err(KEEP.into());
            }
        }
    }
    let root = json_object(text, json_trivia(text, 0))?;
    let servers = json_object(text, json_member(&root, "mcpServers")?.start)?;
    let object = json_object(text, json_member(&servers, &id)?.start)?;
    let mut edits = vec![(json_member(&object, "command")?, json!(new).to_string())];
    if entry
        .get("env")
        .and_then(|e| e.get("UNITY_PROJECT_PATH"))
        .is_none()
    {
        if entry.get("env").is_some() {
            let env = json_object(text, json_member(&object, "env")?.start)?;
            json_insert(
                text,
                &env,
                &[("UNITY_PROJECT_PATH", &json!(project))],
                &mut edits,
            )?;
        } else {
            json_insert(
                text,
                &object,
                &[("env", &json!({"UNITY_PROJECT_PATH":project}))],
                &mut edits,
            )?;
        }
        expected["mcpServers"][&id]["env"]["UNITY_PROJECT_PATH"] = json!(project);
    }
    expected["mcpServers"][&id]["command"] = json!(new);
    edits.sort_by_key(|(range, _)| std::cmp::Reverse(range.start));
    let mut result = text.to_owned();
    for (range, replacement) in edits {
        result.replace_range(range, &replacement);
    }
    if serde_json::from_str::<Value>(&result).map_err(|_| KEEP)? != expected {
        return Err(KEEP.into());
    }
    Ok(result)
}

pub(crate) fn plan(text: &str, project: &Path) -> Result<String, String> {
    if text.len() > 256 * 1024 || !local_project(project) {
        return Err(KEEP.into());
    }
    let data: Value = serde_json::from_str(text).map_err(|_| KEEP)?;
    let command = connection_entry(&data)?.1["command"].as_str().ok_or(KEEP)?;
    let (old, router) = trusted_routes(command)?;
    render(
        text,
        &display_path(project)?,
        old.to_str().ok_or(KEEP)?,
        &display_path(&router.command)?,
    )
}

fn commit(project: &Path, backups: &Path, before: &str, after: &str) -> Result<PathBuf, String> {
    let path = project.join(".mcp.json");
    if storage::read_text(&path)?.as_deref() != Some(before) {
        return Err("This project connection changed. Check it again.".into());
    }
    let tx = recovery::Transaction::prepare(
        backups,
        vec![recovery::ReviewedWrite::new(
            recovery::PROJECT_CONNECTION,
            &path,
            before.as_bytes(),
            after.as_bytes(),
        )],
    )?;
    let report = tx.resume(|_| true)?;
    if !report.completed || storage::read_text(&path)?.as_deref() != Some(after) {
        return Err(format!("Hub could not confirm the change. Keep the backup at {} and check the connection before trying again.", report.journal.display()));
    }
    Ok(report.files[0].before_backup.clone())
}

pub(crate) fn review(app: &tauri::AppHandle, project: &Path) -> Result<Value, String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    if !local_project(project) {
        return Err(KEEP.into());
    }
    storage::reject_links(project)?;
    let label = display_path(project)?;
    if !crate::is_valid_unity_project(project) {
        return Err(KEEP.into());
    }
    let before = storage::read_text(&project.join(".mcp.json"))?.ok_or(KEEP)?;
    let after = plan(&before, project)?;
    if !app.dialog().message(format!("Update Claude Code for this Unity project?\n\n{label}\n\nHub will back up this project's connection file, then point it to Hub's MCP. Your other projects and account settings stay as they are."))
        .title("Update this project connection").buttons(MessageDialogButtons::OkCancelCustom("Update this project".into(), "Not now".into())).blocking_show() {
        return Ok(json!({"status":"cancelled"}));
    }
    if !crate::is_valid_unity_project(project) || plan(&before, project)? != after {
        return Err(KEEP.into());
    }
    let root = creator_hub_mcp_router::Store::installed_base()?.join("project-connection-backups");
    let backup = commit(project, &root, &before, &after)?;
    Ok(json!({"status":"updated","backup":backup}))
}

#[cfg(test)]
mod tests {
    use super::*;
    const V1: &str = "C:/Old/router-v1/creator-hub-mcp-router.exe";
    const V2: &str = "C:/Hub/router-v2/creator-hub-mcp-router.exe";
    fn fixture(env: Value) -> String {
        json!({"mcpServers":{"creator-works":{"command":V1,"args":[],"env":env},
            "other":{"command":"leave alone","env":{"private":"fixture only"}}}})
        .to_string()
    }
    #[test]
    fn two_projects_keep_their_own_settings_and_exact_backups() {
        let tmp = tempfile::tempdir().unwrap();
        let backups = tmp.path().join("private-hub-data");
        for name in ["First Project", "Second Project"] {
            let dir = tmp.path().join(name);
            std::fs::create_dir(&dir).unwrap();
            let pin = display_path(&dir).unwrap();
            let before = format!(
                "  {}\r\n",
                fixture(json!({"UNITY_PROJECT_PATH":pin,"OTHER_VALUE":"untouched"}))
            );
            std::fs::write(dir.join(".mcp.json"), &before).unwrap();
            let after = render(&before, &pin, V1, V2).unwrap();
            assert_eq!(after, before.replace(V1, V2));
            let saved = commit(&dir, &backups, &before, &after).unwrap();
            assert_eq!(std::fs::read_to_string(saved).unwrap(), before);
            assert_eq!(
                std::fs::read_to_string(dir.join(".mcp.json")).unwrap(),
                after
            );
            assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
            assert!(render(&after, &pin, V1, V2).is_err());
        }
        assert!(!tmp.path().join(".claude.json").exists());
    }
    #[test]
    fn pin_missing_project_without_reformatting_other_entries() {
        let project = "C:/Example";
        for b in [
            fixture(json!({})),
            fixture(json!({"BANTER_PROJECT_PATH":project})),
            format!("{{ \"mcpServers\": {{\"banter\": {{\"command\":\"{V1}\"}}}} }}\r\n"),
        ] {
            let a = render(&b, project, V1, V2).unwrap();
            let value: Value = serde_json::from_str(&a).unwrap();
            let (_, e) = connection_entry(&value).unwrap();
            assert_eq!(e["env"]["UNITY_PROJECT_PATH"], project);
            assert_eq!(e["command"], V2);
        }
        for env in [
            json!({"UNITY_PROJECT_PATH":"C:/Wrong"}),
            json!({"BANTER_PROJECT_PATH":"${CUSTOM}"}),
            json!({"unity_project_path":project}),
            json!({"NODE_OPTIONS":"custom"}),
            json!({"CREATOR_WORKS_CONFIG_OWNER":"different"}),
        ] {
            assert!(render(&fixture(env), project, V1, V2).is_err());
        }
        let base = fixture(json!({}));
        for b in [
            base.replace(V1, "custom"),
            base.replace("\"args\":[]", "\"args\":[\"--custom\"]"),
            base.replace("\"creator-works\":", "\"banter\":{},\"creator-works\":"),
            base.replace("\"command\":", "\"command\":\"duplicate\",\"command\":"),
        ] {
            assert!(render(&b, project, V1, V2).is_err());
        }
    }
    #[test]
    fn changed_since_review_does_not_write_or_back_up_the_wrong_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        let before = fixture(json!({}));
        let after = render(&before, "C:/Example", V1, V2).unwrap();
        let path = tmp.path().join(".mcp.json");
        let backups = tmp.path().join("private-hub-data");
        std::fs::write(&path, "changed elsewhere").unwrap();
        assert!(commit(tmp.path(), &backups, &before, &after).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "changed elsewhere");
        assert!(!backups.exists());
    }

    #[test]
    #[cfg(feature = "integrated-service")]
    #[ignore = "requires existing verified v1 and active v2 routers; reads them without running or changing either"]
    fn recognises_installed_signed_routes_and_updates_only_a_throwaway_file() {
        let old = dirs::data_local_dir()
            .unwrap()
            .join("creator-hub/mcp-route-v1")
            .join(format!("windows-{}", std::env::consts::ARCH))
            .join("router-v1/creator-hub-mcp-router.exe");
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("Example Creator Project");
        std::fs::create_dir(&project).unwrap();
        for dir in ["Assets", "Packages", "ProjectSettings"] {
            std::fs::create_dir(project.join(dir)).unwrap();
        }
        let pin = display_path(&project).unwrap();
        let before = json!({"mcpServers":{"creator-works":{"command":old,"env":{"UNITY_PROJECT_PATH":pin}},"other":{"command":"untouched"}}}).to_string();
        let file = project.join(".mcp.json");
        std::fs::write(&file, &before).unwrap();
        assert_eq!(
            crate::client_config_status::project_claude_setup(&project),
            ("present", "oldProjectRouter")
        );
        let after = plan(&before, &project).unwrap();
        let backup = commit(&project, &temp.path().join("backups"), &before, &after).unwrap();
        assert_eq!(std::fs::read_to_string(backup).unwrap(), before);
        assert_eq!(
            crate::client_config_status::project_claude_setup(&project),
            ("present", "shared")
        );
        let value: Value = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
        assert_eq!(
            value["mcpServers"]["creator-works"]["env"]["UNITY_PROJECT_PATH"],
            pin
        );
        assert_eq!(value["mcpServers"]["other"]["command"], "untouched");
        assert!(plan(&after, &project).is_err());
    }

    #[test]
    #[ignore = "requires scratch folders on two separate Windows volumes"]
    fn second_drive_project_without_library_keeps_backup_off_project() {
        let project = tempfile::tempdir().unwrap();
        let tmp =
            tempfile::tempdir_in(std::env::var_os("CREATOR_TEST_SECOND_VOLUME").unwrap()).unwrap();
        let backups = tmp.path().join("backups");
        let prefix = |p: &Path| {
            std::fs::canonicalize(p)
                .unwrap()
                .components()
                .next()
                .unwrap()
                .as_os_str()
                .to_owned()
        };
        assert_ne!(prefix(project.path()), prefix(tmp.path()));
        let pin = display_path(project.path()).unwrap();
        let before = fixture(json!({"UNITY_PROJECT_PATH":pin}));
        let after = render(&before, &pin, V1, V2).unwrap();
        let config = project.path().join(".mcp.json");
        std::fs::write(&config, &before).unwrap();
        let saved = commit(project.path(), &backups, &before, &after).unwrap();
        assert!(saved.starts_with(std::fs::canonicalize(&backups).unwrap()));
        assert_eq!(std::fs::read_to_string(saved).unwrap(), before);
        assert_eq!(std::fs::read_to_string(config).unwrap(), after);
        assert!(!project
            .path()
            .join(".creator-hub-settings-backups")
            .exists());
    }
}
