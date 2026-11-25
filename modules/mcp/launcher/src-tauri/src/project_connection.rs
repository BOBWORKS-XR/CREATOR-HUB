//! Windows project-scoped Claude repair. Never write the user's account config.
use super::{
    json_insert, json_member, json_object, json_trivia, recovery, safe_environment,
    same_router_path,
};
use crate::{
    client_config_status::{project_pins, static_project_path, ProjectPins},
    client_ownership, jsonc, settings_backup as storage,
};
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
    if !local_project(Path::new(command))
        || Path::new(command).file_name().and_then(|s| s.to_str())
            != Some("creator-hub-mcp-router.exe")
    {
        return Err(KEEP.into());
    }
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
    if !static_project_path(project)
        || project_pins(entry, Path::new(project)) != ProjectPins::Compatible
    {
        return Err("The saved project path does not match this folder or could not be verified. Review this project's .mcp.json; Hub left it alone.".into());
    }
    if let Some(env) = entry.get("env") {
        let env = env.as_object().ok_or(KEEP)?;
        safe_environment(env.keys().map(String::as_str))?;
        for (k, value) in env {
            let v = value.as_str().ok_or(KEEP)?;
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

#[derive(PartialEq, Eq)]
struct PinRepair {
    previous: String,
    keys: Vec<&'static str>,
    after: String,
}

fn pin_repair(
    text: &str,
    project: &Path,
    verified_router: impl FnOnce(&str) -> bool,
) -> Result<PinRepair, String> {
    if text.len() > 256 * 1024 || !local_project(project) {
        return Err(KEEP.into());
    }
    let mut data: Value = serde_json::from_str(text).map_err(|_| KEEP)?;
    jsonc::parse_unambiguous(text)?;
    let (id, entry) = connection_entry(&data)?;
    let id = id.to_owned();
    if project_pins(entry, project) != ProjectPins::DifferentPath
        || entry
            .as_object()
            .ok_or(KEEP)?
            .keys()
            .any(|k| !matches!(k.as_str(), "command" | "type" | "args" | "env"))
    {
        return Err(KEEP.into());
    }
    let env = entry["env"].as_object().ok_or(KEEP)?;
    safe_environment(env.keys().map(String::as_str))?;
    if env.values().any(|v| !v.is_string())
        || env
            .get(client_ownership::OWNER_KEY)
            .is_some_and(|v| v != client_ownership::OWNER)
    {
        return Err(KEEP.into());
    }
    let keys: Vec<_> = ["UNITY_PROJECT_PATH", "BANTER_PROJECT_PATH"]
        .into_iter()
        .filter(|k| env.contains_key(*k))
        .collect();
    let old = Path::new(env[*keys.first().ok_or(KEEP)?].as_str().ok_or(KEEP)?);
    if keys
        .iter()
        .any(|k| env[*k].as_str().map(Path::new) != Some(old))
        || !verified_router(entry["command"].as_str().ok_or(KEEP)?)
    {
        return Err(KEEP.into());
    }
    storage::reject_links(project)?;
    storage::reject_links(old)?;
    if !crate::is_valid_unity_project(project) || !crate::is_valid_unity_project(old) {
        return Err(KEEP.into());
    }
    let previous = display_path(old)?;
    let target = display_path(project)?;
    if previous == target || !static_project_path(&target) {
        return Err(KEEP.into());
    }

    let root = json_object(text, json_trivia(text, 0))?;
    let servers = json_object(text, json_member(&root, "mcpServers")?.start)?;
    let object = json_object(text, json_member(&servers, &id)?.start)?;
    let env = json_object(text, json_member(&object, "env")?.start)?;
    let mut ranges = Vec::new();
    for key in &keys {
        ranges.push(json_member(&env, key)?);
        data["mcpServers"][&id]["env"][*key] = json!(target);
    }
    ranges.sort_by_key(|r| std::cmp::Reverse(r.start));
    let mut after = text.to_owned();
    for r in ranges {
        after.replace_range(r, &json!(target).to_string());
    }
    if serde_json::from_str::<Value>(&after).map_err(|_| KEEP)? != data {
        return Err(KEEP.into());
    }
    Ok(PinRepair {
        previous,
        keys,
        after,
    })
}

fn installed_pin_repair(text: &str, project: &Path) -> Result<PinRepair, String> {
    pin_repair(text, project, |command| {
        let path = Path::new(command);
        if !local_project(path)
            || path.file_name().and_then(|s| s.to_str()) != Some("creator-hub-mcp-router.exe")
        {
            return false;
        }
        creator_hub_mcp_router::Store::installed()
            .and_then(|store| store.router())
            .is_ok_and(|router| same_router_path(command, &router.command.to_string_lossy()))
    })
}

pub(crate) fn can_review_pins(text: &str, project: &Path) -> bool {
    installed_pin_repair(text, project).is_ok()
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
    let repair = installed_pin_repair(&before, project).ok();
    let (after, message, accept) = if let Some(r) = &repair {
        (r.after.clone(), format!("Change the folder Claude Code uses?\n\nCurrent folder: {}\nNew folder: {label}\n\nHub will back up {label}/.mcp.json and change only {}. The other folder and your account settings will not change. Keep the current folder if you chose it intentionally.", r.previous, r.keys.join(" and ")), "Use this folder")
    } else {
        (plan(&before, project)?, format!("Update Claude Code for this Unity project?\n\n{label}\n\nHub will back up this project's connection file, then point it to Hub's MCP. Your other projects and account settings stay as they are."), "Update this project")
    };
    if !app
        .dialog()
        .message(message)
        .title("Review this project connection")
        .buttons(MessageDialogButtons::OkCancelCustom(
            accept.into(),
            "Not now".into(),
        ))
        .blocking_show()
    {
        return Ok(json!({"status":"cancelled"}));
    }
    if !crate::is_valid_unity_project(project)
        || match repair {
            Some(r) => installed_pin_repair(&before, project)? != r,
            None => plan(&before, project)? != after,
        }
    {
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
            json!({"UNITY_PROJECT_PATH":project, "BANTER_PROJECT_PATH":"C:/Other"}),
            json!({"UNITY_PROJECT_PATH":"C:/Other", "BANTER_PROJECT_PATH":project}),
            json!({"UNITY_PROJECT_PATH":project, "BANTER_PROJECT_PATH":null}),
            json!({"BANTER_PROJECT_PATH":"${CUSTOM}"}),
            json!({"unity_project_path":project}),
            json!({"NODE_OPTIONS":"custom"}),
            json!({"CREATOR_WORKS_CONFIG_OWNER":"different"}),
        ] {
            assert!(render(&fixture(env), project, V1, V2).is_err());
        }
        let base = fixture(json!({}));
        assert!(render(&base, "C:/Projects/${CUSTOM}", V1, V2).is_err());
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
    fn reviewed_copy_repair_changes_only_existing_pins_and_backs_up_exact_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("Original");
        let copy = tmp.path().join("Copy");
        for dir in [&old, &copy] {
            for child in ["Assets", "Packages", "ProjectSettings"] {
                std::fs::create_dir_all(dir.join(child)).unwrap();
            }
        }
        let from = display_path(&old).unwrap();
        let to = display_path(&copy).unwrap();
        let file = copy.join(".mcp.json");
        for env in [
            json!({"UNITY_PROJECT_PATH":from}),
            json!({"BANTER_PROJECT_PATH":from}),
            json!({"UNITY_PROJECT_PATH":from,"BANTER_PROJECT_PATH":from,"OTHER_VALUE":"keep"}),
        ] {
            let before = format!("  {}\r\n", fixture(env.clone()).replace(V1, V2));
            std::fs::write(old.join(".mcp.json"), &before).unwrap();
            std::fs::write(&file, &before).unwrap();
            assert!(pin_repair(&before, &copy, |_| false).is_err());
            let r = pin_repair(&before, &copy, |command| command == V2).unwrap();
            assert_eq!(r.previous, from);
            assert_eq!(
                r.keys.len(),
                env.as_object()
                    .unwrap()
                    .keys()
                    .filter(|k| k.ends_with("_PROJECT_PATH"))
                    .count()
            );
            assert_eq!(r.after, before.replace(&from, &to));
            assert_eq!(std::fs::read_to_string(&file).unwrap(), before); // Review alone (or Cancel).
            let backup = commit(&copy, &tmp.path().join("backups"), &before, &r.after).unwrap();
            assert_eq!(std::fs::read_to_string(backup).unwrap(), before);
            assert_eq!(std::fs::read_to_string(&file).unwrap(), r.after);
            assert_eq!(
                std::fs::read_to_string(old.join(".mcp.json")).unwrap(),
                before
            );
            assert!(pin_repair(&r.after, &copy, |_| true).is_err());
        }
        for env in [
            json!({"UNITY_PROJECT_PATH":from,"BANTER_PROJECT_PATH":to}),
            json!({"UNITY_PROJECT_PATH":from,"BANTER_PROJECT_PATH":"${CUSTOM}"}),
            json!({"BANTER_PROJECT_PATH":tmp.path().join("missing")}),
            json!({"UNITY_PROJECT_PATH":from,"NODE_OPTIONS":"custom"}),
            json!({"unity_project_path":from}),
            json!({"UNITY_PROJECT_PATH":from,"CREATOR_WORKS_CONFIG_OWNER":"other"}),
        ] {
            assert!(pin_repair(&fixture(env), &copy, |_| true).is_err());
        }
        let custom = fixture(json!({"UNITY_PROJECT_PATH":from}))
            .replace("\"args\":[]", "\"args\":[],\"custom\":true");
        assert!(pin_repair(&custom, &copy, |_| true).is_err());
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
