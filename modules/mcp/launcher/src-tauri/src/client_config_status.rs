//! Read-only evidence: a named entry is not proof that an AI app loaded it.
use crate::{LEGACY_MCP_CLIENT_ID, MCP_CLIENT_ID};
use serde_json::Value;
use std::path::Path;

pub(crate) fn json_entries(config: &Value, key: &str) -> Result<bool, ()> {
    let root = config.as_object().ok_or(())?;
    let Some(servers) = root.get(key) else {
        return Ok(false);
    };
    let servers = servers.as_object().ok_or(())?;
    let mut present = false;
    for id in [MCP_CLIENT_ID, LEGACY_MCP_CLIENT_ID] {
        if let Some(entry) = servers.get(id) {
            entry.as_object().ok_or(())?;
            present = true;
        }
    }
    Ok(present)
}

pub(crate) fn toml_entries(text: &str) -> Result<bool, ()> {
    let doc = text.parse::<toml_edit::Document>().map_err(|_| ())?;
    let Some(servers) = doc.get("mcp_servers") else {
        return Ok(false);
    };
    let servers = servers.as_table_like().ok_or(())?;
    let mut present = false;
    for id in [MCP_CLIENT_ID, LEGACY_MCP_CLIENT_ID] {
        if let Some(entry) = servers.get(id) {
            entry.as_table_like().ok_or(())?;
            present = true;
        }
    }
    Ok(present)
}

pub(crate) fn json_servers(text: &str) -> Result<bool, ()> {
    json_entries(&serde_json::from_str(text).map_err(|_| ())?, "mcpServers")
}

pub(crate) fn antigravity_servers(text: &str) -> Result<bool, ()> {
    if text.trim().is_empty() {
        Ok(false)
    } else {
        json_servers(text)
    }
}

pub(crate) fn allow_claude_account_setup(project: &Path) -> Result<(), String> {
    if !project.is_absolute() {
        return Err("Choose a Unity project first.".into());
    }
    match from_file(&project.join(".mcp.json"), |text| {
        crate::jsonc::parse_unambiguous(text).map_err(|_| ())?;
        json_servers(text)
    }) {
        Ok(false) => Ok(()),
        Ok(true) => Err("Claude Code already has settings for this project. Use its project connection instead.".into()),
        Err(()) => Err("Hub couldn't check this project's Claude settings. Your account connection was left alone.".into()),
    }
}

pub(crate) fn from_file(
    path: &Path,
    parse: impl FnOnce(&str) -> Result<bool, ()>,
) -> Result<bool, ()> {
    match crate::settings_backup::read_text(path).map_err(|_| ())? {
        Some(text) => parse(&text),
        None => Ok(false),
    }
}

pub(crate) fn project_claude_setup(project: &Path) -> (&'static str, &'static str) {
    if !project.is_absolute() {
        return ("unchecked", "unknown");
    }
    match crate::settings_backup::read_text(&project.join(".mcp.json")) {
        Ok(None) => ("notFound", "unknown"),
        Ok(Some(text)) => {
            let result = project_entry(&text, project, |command| {
                // Only inspect Hub's own verified router; never execute a project command.
                let Ok(router) =
                    creator_hub_mcp_router::Store::installed().and_then(|s| s.router())
                else {
                    return false;
                };
                crate::client_migration::same_router_path(
                    command,
                    &router.command.to_string_lossy(),
                )
            })
            .unwrap_or(("unreadable", "unknown"));
            #[cfg(all(windows, feature = "integrated-service"))]
            if result == ("present", "differentProjectPath")
                && crate::client_migration::project_connection::can_review_pins(&text, project)
            {
                return ("present", "reviewableProjectPath");
            }
            #[cfg(all(windows, feature = "integrated-service"))]
            if result == ("present", "unknown")
                && crate::client_migration::project_connection::plan(&text, project).is_ok()
            {
                return ("present", "oldProjectRouter");
            }
            result
        }
        Err(_) => ("unreadable", "unknown"),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProjectPins {
    Compatible, // No explicit pins, or all explicit pins match.
    DifferentPath,
    Unverified,
}

pub(crate) fn static_project_path(value: &str) -> bool {
    if !Path::new(value).is_absolute()
        || value.contains(['$', '%', '{', '}'])
        || value.chars().any(char::is_control)
    {
        return false;
    }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        if !matches!(Path::new(value).components().next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_)))
            || value[2..].contains([':', '?', '*', '"', '<', '>', '|'])
        {
            return false;
        }
        return !value[2..]
            .split(['/', '\\'])
            .any(|s| s.ends_with(['.', ' ']));
    }
    #[cfg(not(windows))]
    !value.split('/').any(|s| matches!(s, "." | ".."))
}

pub(crate) fn project_pins(entry: &Value, project: &Path) -> ProjectPins {
    let Some(env) = entry.get("env") else {
        return ProjectPins::Compatible;
    };
    let Some(env) = env.as_object() else {
        return ProjectPins::Unverified;
    };
    let mut result = ProjectPins::Compatible;
    for (key, value) in env {
        if !key.eq_ignore_ascii_case("UNITY_PROJECT_PATH")
            && !key.eq_ignore_ascii_case("BANTER_PROJECT_PATH")
        {
            continue;
        }
        let Some(pin) = value.as_str() else {
            return ProjectPins::Unverified;
        };
        if !matches!(key.as_str(), "UNITY_PROJECT_PATH" | "BANTER_PROJECT_PATH")
            || !static_project_path(pin)
            || !project.to_str().is_some_and(static_project_path)
        {
            return ProjectPins::Unverified;
        }
        if Path::new(pin) == project {
            continue;
        }
        #[cfg(windows)]
        if pin
            .replace('\\', "/")
            .trim_end_matches('/')
            .eq_ignore_ascii_case(
                project
                    .to_string_lossy()
                    .replace('\\', "/")
                    .trim_end_matches('/'),
            )
        {
            // Case-sensitive Windows directories exist. Verify a spelling variant before accepting it.
            match (std::fs::canonicalize(pin), std::fs::canonicalize(project)) {
                (Ok(a), Ok(b)) if a == b => continue,
                (Ok(_), Ok(_)) => (),
                _ => return ProjectPins::Unverified,
            }
        }
        // Compare saved paths, not live targets. Do not follow an arbitrary external path.
        result = ProjectPins::DifferentPath;
    }
    result
}

fn project_entry(
    text: &str,
    project: &Path,
    known_router: impl FnOnce(&str) -> bool,
) -> Result<(&'static str, &'static str), ()> {
    let config: Value = serde_json::from_str(text).map_err(|_| ())?;
    crate::jsonc::parse_unambiguous(text).map_err(|_| ())?;
    if !json_entries(&config, "mcpServers")? {
        return Ok(("notFound", "unknown"));
    }
    let servers = config["mcpServers"].as_object().ok_or(())?;
    let mut owned = [MCP_CLIENT_ID, LEGACY_MCP_CLIENT_ID]
        .into_iter()
        .filter_map(|id| servers.get(id));
    let entry = owned.next().ok_or(())?;
    let unknown = ("present", "unknown");
    if owned.next().is_some()
        || entry.get("url").is_some()
        || entry
            .get("type")
            .is_some_and(|t| t.as_str() != Some("stdio"))
    {
        return Ok(unknown);
    }
    match project_pins(entry, project) {
        ProjectPins::DifferentPath => return Ok(("present", "differentProjectPath")),
        ProjectPins::Unverified => return Ok(("present", "unverifiedProjectPath")),
        ProjectPins::Compatible => (),
    }
    let Some(command) = entry["command"].as_str() else {
        return Ok(unknown);
    };
    let leaf = |path: &str| {
        path.rsplit(['/', '\\'])
            .next()
            .unwrap_or("")
            .to_ascii_lowercase()
    };
    match (leaf(command).as_str(), entry.get("args")) {
        ("creator-hub-mcp-router" | "creator-hub-mcp-router.exe", args)
            if args.is_none_or(|v| v.as_array().is_some_and(Vec::is_empty)) =>
        {
            Ok(if known_router(command) {
                ("present", "shared")
            } else {
                unknown
            })
        }
        ("node" | "node.exe", Some(Value::Array(args)))
            if args.len() == 1
                && args[0]
                    .as_str()
                    .is_some_and(|s| !s.starts_with('-') && leaf(s) == "creator-works-mcp.mjs") =>
        {
            Ok(("present", "direct"))
        }
        _ => Ok(unknown),
    }
}

#[cfg(test)]
fn project_claude(project: &Path) -> &'static str {
    project_claude_setup(project).0
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn project_connection_prevents_account_setup_even_when_unreadable() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path();
        let path = project.join(".mcp.json");
        assert!(allow_claude_account_setup(project).is_ok());
        for (text, allowed) in [
            (r#"{"mcpServers":{"unrelated":{}}}"#, true),
            (r#"{"mcpServers":{"creator-works":{}}}"#, false),
            (r#"{"mcpServers":{"banter":{}}}"#, false),
            (
                r#"{"mcpServers":{"creator-works":{}},"mcpServers":{}}"#,
                false,
            ),
            ("damaged", false),
        ] {
            std::fs::write(&path, text).unwrap();
            assert_eq!(allow_claude_account_setup(project).is_ok(), allowed);
            assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
        }
    }
    #[test]
    fn only_recognised_project_commands_get_a_route_label() {
        let router = "C:/Hub/creator-hub-mcp-router.exe";
        for (entry, route) in [
            (serde_json::json!({"command":router}), "shared"),
            (
                serde_json::json!({"command":router,"args":["different"]}),
                "unknown",
            ),
            (
                serde_json::json!({"command":"C:/Other/creator-hub-mcp-router.exe"}),
                "unknown",
            ),
            (
                serde_json::json!({"command":"node","args":["C:/Old/creator-works-mcp.mjs"]}),
                "direct",
            ),
            (
                serde_json::json!({"command":"wrapper","args":["C:/Old/creator-works-mcp.mjs"]}),
                "unknown",
            ),
            (
                serde_json::json!({"command":router,"url":"custom:example"}),
                "unknown",
            ),
        ] {
            let text = serde_json::json!({"mcpServers":{MCP_CLIENT_ID:entry}}).to_string();
            assert_eq!(
                project_entry(&text, Path::new("unused"), |s| s == router),
                Ok(("present", route))
            );
        }
        let both = serde_json::json!({"mcpServers":{MCP_CLIENT_ID:{"command":router},LEGACY_MCP_CLIENT_ID:{}}});
        assert_eq!(
            project_entry(&both.to_string(), Path::new("unused"), |_| panic!(
                "ambiguous commands must not be checked"
            )),
            Ok(("present", "unknown"))
        );
    }
    #[test]
    fn copied_claude_file_is_not_shared_until_both_project_paths_match() {
        use serde_json::json;
        let tmp = tempfile::tempdir().unwrap();
        let original = tmp.path().join("Original");
        let copy = tmp.path().join("Copy");
        for dir in [&original, &copy] {
            std::fs::create_dir(dir).unwrap();
        }
        let router = "verified/creator-hub-mcp-router.exe";
        let fixture = |env| {
            json!({"mcpServers":{
                "creator-works":{"command":router,"args":[],"env":env},
                "unrelated":{"env":{"UNITY_PROJECT_PATH":"ignored"}}
            }})
            .to_string()
        };
        let original_text =
            fixture(json!({"UNITY_PROJECT_PATH":original,"BANTER_PROJECT_PATH":original}));
        std::fs::write(original.join(".mcp.json"), &original_text).unwrap();
        let path = copy.join(".mcp.json");
        std::fs::copy(original.join(".mcp.json"), &path).unwrap();
        let classify = |text: &str, dir: &Path| project_entry(text, dir, |s| s == router).unwrap();
        assert_eq!(classify(&original_text, &original), ("present", "shared"));
        assert_eq!(
            project_claude_setup(&copy),
            ("present", "differentProjectPath")
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original_text);
        assert!(allow_claude_account_setup(&copy).is_err());
        for (env, route) in [
            (
                json!({"UNITY_PROJECT_PATH":original}),
                "differentProjectPath",
            ),
            (
                json!({"BANTER_PROJECT_PATH":original}),
                "differentProjectPath",
            ),
            (
                json!({"UNITY_PROJECT_PATH":copy,"BANTER_PROJECT_PATH":original}),
                "differentProjectPath",
            ),
            (
                json!({"UNITY_PROJECT_PATH":original,"BANTER_PROJECT_PATH":copy}),
                "differentProjectPath",
            ),
            (
                json!({"UNITY_PROJECT_PATH":"relative","BANTER_PROJECT_PATH":copy}),
                "unverifiedProjectPath",
            ),
            (
                json!({"UNITY_PROJECT_PATH":original,"BANTER_PROJECT_PATH":"${CUSTOM}"}),
                "unverifiedProjectPath",
            ),
            (
                json!({"UNITY_PROJECT_PATH":format!("{}/%NAME%", copy.display())}),
                "unverifiedProjectPath",
            ),
            (
                json!({"BANTER_PROJECT_PATH":false}),
                "unverifiedProjectPath",
            ),
            (json!({"UNITY_PROJECT_PATH":null}), "unverifiedProjectPath"),
            (json!({"UNITY_PROJECT_PATH":""}), "unverifiedProjectPath"),
            (
                json!({"UNITY_PROJECT_PATH":copy,"unity_project_path":copy}),
                "unverifiedProjectPath",
            ),
            (json!([]), "unverifiedProjectPath"),
            (json!({"BANTER_PROJECT_PATH":copy}), "shared"),
            (
                json!({"UNITY_PROJECT_PATH":format!("{}/", copy.display()).replace('\\',"/")}),
                "shared",
            ),
        ] {
            let text = fixture(env);
            assert_eq!(classify(&text, &copy), ("present", route), "{text}");
        }
        let duplicate = original_text.replace(
            "\"UNITY_PROJECT_PATH\":",
            "\"UNITY_PROJECT_PATH\":false,\"UNITY_PROJECT_PATH\":",
        );
        assert!(project_entry(&duplicate, &original, |_| true).is_err());
        let direct = original_text
            .replace(router, "node")
            .replace("\"args\":[]", "\"args\":[\"creator-works-mcp.mjs\"]");
        assert_eq!(classify(&direct, &original), ("present", "direct"));
        assert_eq!(
            classify(&direct, &copy),
            ("present", "differentProjectPath")
        );

        // Simulate the user correcting only the copied file; inspection makes no edits.
        std::fs::write(
            &path,
            fixture(json!({"UNITY_PROJECT_PATH":copy,"BANTER_PROJECT_PATH":copy})),
        )
        .unwrap();
        assert_eq!(
            classify(&std::fs::read_to_string(path).unwrap(), &copy),
            ("present", "shared")
        );
        assert_eq!(
            std::fs::read_to_string(original.join(".mcp.json")).unwrap(),
            original_text
        );
        assert_eq!(std::fs::read_dir(copy).unwrap().count(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn non_literal_windows_paths_never_establish_a_folder_match() {
        for path in [
            r"C:Unity",
            r"\Unity",
            r"\\host\share\Unity",
            r"\\?\C:\Unity",
            r"C:\Unity\..\Other",
            r"C:\Unity\.\Copy",
            r"C:\Unity\Copy.",
            r"C:\Unity\Copy ",
            r"C:\Unity\Copy:alternate",
            r"C:\Unity\${'$'}{PROJECT}",
        ] {
            assert!(!static_project_path(path), "{path}");
        }
        let tmp = tempfile::tempdir().unwrap();
        let folder = tmp.path().join("MixedCase");
        std::fs::create_dir(&folder).unwrap();
        let alias = tmp.path().join("mixedcase");
        let entry = serde_json::json!({"env":{"UNITY_PROJECT_PATH":alias}});
        assert_eq!(
            project_pins(&entry, &folder) == ProjectPins::Compatible,
            std::fs::canonicalize(alias).ok() == Some(std::fs::canonicalize(folder).unwrap())
        );
    }

    #[test]
    fn distinguishes_absent_present_and_unreadable_without_modifying_project_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".mcp.json");
        assert_eq!(project_claude(dir.path()), "notFound");
        for (source, status) in [
            (
                r#"{"mcpServers":{"other":{"env":{"secret":"private"}}}}"#,
                "notFound",
            ),
            (
                r#"{"mcpServers":{"creator-works":{"command":"do-not-execute"}}}"#,
                "present",
            ),
            (
                r#"{"mcpServers":{"banter":{"url":"fixture:not-a-connection-test"}}}"#,
                "present",
            ),
            (
                r#"{"mcpServers":{"creator-works":{},"banter":null}}"#,
                "unreadable",
            ),
            (r#"{"mcpServers":[]}"#, "unreadable"),
            ("[", "unreadable"),
        ] {
            std::fs::write(&path, source).unwrap();
            assert_eq!(project_claude(dir.path()), status);
            assert_eq!(std::fs::read(&path).unwrap(), source.as_bytes());
        }
        std::fs::write(
            &path,
            vec![b' '; crate::settings_backup::MAX_BYTES as usize + 1],
        )
        .unwrap();
        assert_eq!(project_claude(dir.path()), "unreadable");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn invalid_user_files_are_not_missing_entries() {
        assert_eq!(toml_entries("[broken"), Err(()));
        assert_eq!(toml_entries("mcp_servers = []"), Err(()));
        assert_eq!(toml_entries("[mcp_servers.other]"), Ok(false));
        assert_eq!(toml_entries("[mcp_servers.banter]"), Ok(true));
        assert_eq!(json_servers("null"), Err(()));
        assert_eq!(json_servers("  "), Err(()));
        assert_eq!(antigravity_servers("  "), Ok(false));
        assert_eq!(antigravity_servers("broken"), Err(()));
        assert_eq!(json_servers(r#"{"projects":{}}"#), Ok(false));
    }

    #[cfg(windows)]
    #[test]
    fn locked_project_config_is_unknown_not_absent_and_rechecks_after_release() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".mcp.json");
        let bytes = br#"{"mcpServers":{"creator-works":{"command":"fixture"}}}"#;
        std::fs::write(&path, bytes).unwrap();
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        assert_eq!(project_claude(dir.path()), "unreadable");
        drop(lock);
        assert_eq!(project_claude(dir.path()), "present");
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
}
