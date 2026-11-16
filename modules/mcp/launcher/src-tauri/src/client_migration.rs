//! Reviewed client edits with durable recovery; not the product installer transaction.
use crate::{client_ownership, jsonc, settings_backup};
use serde_json::Value;
use std::path::{Path, PathBuf};

const LAUNCHER_CONFIG: &str = "CREATOR_WORKS_LAUNCHER_CONFIG";

#[path = "migration_recovery.rs"]
pub(crate) mod recovery;

#[cfg(test)]
#[path = "client_migration_render_tests.rs"]
mod render_tests;

#[derive(Clone, Copy)]
pub(crate) enum Format {
    Codex,
    Json,
    OpenCode,
}

pub(crate) struct Plan {
    pub client: String,
    path: PathBuf,
    before: String,
    after: String,
    pub old_node: String,
    pub old_server: String,
    pub project: Option<String>,
}

fn target(path: &Path) -> Result<String, String> {
    if !path.is_absolute() || !path.is_file() {
        return Err("The retained Hub runtime is unavailable. No client was changed.".into());
    }
    settings_backup::reject_links(path)?;
    crate::normalized_existing_path(path.to_path_buf())
        .to_str()
        .map(str::to_owned)
        .ok_or("Runtime paths must be UTF-8.".into())
}

fn same_router_path(command: &str, expected: &str) -> bool {
    // Ordinary Windows setup writes forward slashes; do not adopt a different path.
    if cfg!(windows) {
        command.replace('\\', "/") == expected.replace('\\', "/")
    } else {
        command == expected
    }
}

fn verify_retained_router(command: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        creator_hub_mcp_router::Store::verify_retained_router_command(command)
    }
    #[cfg(not(windows))]
    {
        let _ = command;
        Err("Relocated router review is only available on Windows. Nothing was changed.".into())
    }
}

fn reviewable(value: &str) -> Result<(), String> {
    if value.len() > 4096 || value.chars().any(char::is_control) {
        return Err(
            "Client values cannot be shown safely in the review. Nothing was changed.".into(),
        );
    }
    Ok(())
}

fn safe_environment<'a>(keys: impl Iterator<Item = &'a str>) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for key in keys {
        let normalized = key.to_ascii_uppercase();
        if !seen.insert(normalized.clone())
            || ["NODE_OPTIONS", "NODE_PATH"].contains(&normalized.as_str())
            || normalized == client_ownership::OWNER_KEY && key != client_ownership::OWNER_KEY
            || normalized == LAUNCHER_CONFIG && key != LAUNCHER_CONFIG
        {
            return Err("Node overrides or ambiguous environment keys require manual review. Nothing was changed.".into());
        }
    }
    Ok(())
}

fn legacy_shape(node: &str, server: &str) -> Result<(), String> {
    reviewable(node)?;
    reviewable(server)?;
    for path in [Path::new(node), Path::new(server)] {
        if !path.is_absolute() {
            return Err(
                "Custom or relative client commands require manual review. Nothing was changed."
                    .into(),
            );
        }
        settings_backup::reject_links(path)?;
    }
    let node_name = Path::new(node).file_name().and_then(|s| s.to_str());
    let server_name = Path::new(server).file_name().and_then(|s| s.to_str());
    if !matches!(node_name, Some("node" | "node.exe"))
        || !matches!(
            server_name,
            Some("creator-works-mcp.mjs" | "banter-mcp.mjs")
        )
    {
        return Err("Custom client commands require manual review. Nothing was changed.".into());
    }
    Ok(())
}

fn set_toml(table: &mut dyn toml_edit::TableLike, key: &str, value: impl Into<toml_edit::Value>) {
    let mut value = value.into();
    if let Some(previous) = table.get(key).and_then(toml_edit::Item::as_value) {
        *value.decor_mut() = previous.decor().clone();
    }
    table.insert(key, toml_edit::Item::Value(value));
}

fn edit_toml_router_command(
    source: &str,
    old_literal: &str,
    new_literal: &str,
    expected: &str,
) -> Result<String, String> {
    // This toml_edit version duplicates root trivia for dotted keys on output.
    // Locate the literal in the original, then reparse to prove the exact edit.
    let expected = expected.parse::<toml_edit::Document>().map_err(|_| "Invalid expected TOML edit.")?;
    let mut result = None;
    for (index, (start, _)) in source.match_indices(old_literal).enumerate() {
        if index == 64 {
            return Err("Ambiguous TOML command requires manual review. Nothing was changed.".into());
        }
        let mut candidate = source.to_owned();
        candidate.replace_range(start..start + old_literal.len(), new_literal);
        if candidate.parse::<toml_edit::Document>().is_ok_and(|doc| same_toml(doc.as_item(), expected.as_item())) {
            if result.is_some() {
                return Err("Ambiguous TOML command requires manual review. Nothing was changed.".into());
            }
            result = Some(candidate);
        }
    }
    result.ok_or("TOML command edit could not be verified. Nothing was changed.".into())
}

fn same_toml(left: &toml_edit::Item, right: &toml_edit::Item) -> bool {
    if let (Some(left), Some(right)) = (left.as_table_like(), right.as_table_like()) {
        return left.len() == right.len() && left.iter().all(|(key, value)| {
            right.get(key).is_some_and(|other| same_toml(value, other))
        });
    }
    if let (Some(left), Some(right)) = (left.as_array_of_tables(), right.as_array_of_tables()) {
        return left.len() == right.len() && left.iter().zip(right.iter()).all(|(left, right)| {
            same_toml(&toml_edit::Item::Table(left.clone()), &toml_edit::Item::Table(right.clone()))
        });
    }
    match (left.as_value(), right.as_value()) {
        (Some(left), Some(right)) => same_toml_value(left, right),
        _ => left.is_none() && right.is_none(),
    }
}

fn same_toml_value(left: &toml_edit::Value, right: &toml_edit::Value) -> bool {
    use toml_edit::Value;
    match (left, right) {
        (Value::String(left), Value::String(right)) => left.value() == right.value(),
        (Value::Integer(left), Value::Integer(right)) => left.value() == right.value(),
        (Value::Float(left), Value::Float(right)) => left.value().to_bits() == right.value().to_bits(),
        (Value::Boolean(left), Value::Boolean(right)) => left.value() == right.value(),
        (Value::Datetime(left), Value::Datetime(right)) => left.value() == right.value(),
        (Value::Array(left), Value::Array(right)) => left.len() == right.len()
            && left.iter().zip(right.iter()).all(|(left, right)| same_toml_value(left, right)),
        (Value::InlineTable(_), Value::InlineTable(_)) => same_toml(
            &toml_edit::Item::Value(left.clone()), &toml_edit::Item::Value(right.clone())),
        _ => false,
    }
}

fn pin_toml_config(source: &str, id: &str, config: &str) -> Result<String, String> {
    let mut doc = source.parse::<toml_edit::Document>().map_err(|_| "Invalid TOML pin input.")?;
    let env_item = &mut doc["mcp_servers"][id]["env"];
    let config = env_item.get("BANTWORKS_LAUNCHER_CONFIG")
        .and_then(toml_edit::Item::as_str).unwrap_or(config).to_owned();
    if let Some(env) = env_item.as_inline_table_mut() {
        let before = env.to_string();
        env.insert(LAUNCHER_CONFIG, config.into());
        let after = env.to_string();
        return edit_toml_router_command(source, &before, &after, &doc.to_string());
    }
    let env = env_item.as_table_like_mut().ok_or("Invalid TOML pin environment.")?;
    let owner = match env.get(client_ownership::OWNER_KEY).and_then(toml_edit::Item::as_value) {
        Some(toml_edit::Value::String(value)) => value.display_repr().into_owned(),
        _ => return Err("Missing TOML pin ownership.".into()),
    };
    env.insert(LAUNCHER_CONFIG, toml_edit::value(config.clone()));
    let newline = if source.contains("\r\n") { "\r\n" } else { "\n" };
    let literal = toml_edit::Value::from(config).to_string();
    let expected = doc;
    let mut result = None;
    let mut positions = std::collections::HashSet::new();
    for (index, (start, _)) in source.match_indices(&owner).enumerate() {
        if index == 64 { return Err("Ambiguous TOML environment requires manual review.".into()); }
        let start = source[..start].rfind('\n').map_or(0, |at| at + 1);
        if !positions.insert(start) { continue; }
        for key in [LAUNCHER_CONFIG.to_owned(), format!("mcp_servers.{}.env.{LAUNCHER_CONFIG}", toml_edit::Key::new(id))] {
            let mut candidate = source.to_owned();
            candidate.insert_str(start, &format!("{key} = {literal}{newline}"));
            if candidate.parse::<toml_edit::Document>().is_ok_and(|doc| same_toml(doc.as_item(), expected.as_item())) {
                if result.is_some() { return Err("Ambiguous TOML environment requires manual review.".into()); }
                result = Some(candidate);
            }
        }
    }
    result.ok_or("TOML configuration pin could not be verified. Nothing was changed.".into())
}

// The existing JSONC parser validates semantics and ambiguity. These ranges only
// locate edits in that validated source, so unrelated fields/comments stay byte-exact.
struct JsonRanges {
    members: Vec<(String, std::ops::Range<usize>)>,
    close: usize,
}
fn json_trivia(source: &str, mut at: usize) -> usize {
    let bytes = source.as_bytes();
    loop {
        while bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
            at += 1;
        }
        if bytes.get(at..at + 2) == Some(b"//") {
            while bytes.get(at).is_some_and(|byte| *byte != b'\n') {
                at += 1;
            }
        } else if bytes.get(at..at + 2) == Some(b"/*") {
            at += 2;
            while at < bytes.len() && bytes.get(at..at + 2) != Some(b"*/") {
                at += 1;
            }
            at += 2;
        } else {
            return at;
        }
    }
}
fn json_string_end(source: &str, mut at: usize) -> usize {
    at += 1;
    let bytes = source.as_bytes();
    while at < bytes.len() {
        match bytes[at] {
            b'\\' => at += 2,
            b'"' => return at + 1,
            _ => at += 1,
        }
    }
    at
}
fn json_value_end(source: &str, start: usize) -> usize {
    let bytes = source.as_bytes();
    if bytes[start] == b'"' {
        return json_string_end(source, start);
    }
    if matches!(bytes[start], b'{' | b'[') {
        let mut depth = 0;
        let mut at = start;
        while at < bytes.len() {
            at = json_trivia(source, at);
            match bytes[at] {
                b'"' => {
                    at = json_string_end(source, at);
                    continue;
                }
                b'{' | b'[' => depth += 1,
                b'}' | b']' => {
                    depth -= 1;
                    if depth == 0 {
                        return at + 1;
                    }
                }
                _ => {}
            }
            at += 1;
        }
        return at;
    }
    let mut at = start;
    while bytes.get(at).is_some_and(|byte| {
        !byte.is_ascii_whitespace() && !matches!(byte, b',' | b'}' | b']' | b'/')
    }) {
        at += 1;
    }
    at
}
fn json_object(source: &str, start: usize) -> Result<JsonRanges, String> {
    let bytes = source.as_bytes();
    if bytes.get(start) != Some(&b'{') {
        return Err("Reviewed JSON object has changed shape.".into());
    }
    let mut at = start + 1;
    let mut members = Vec::new();
    loop {
        at = json_trivia(source, at);
        if bytes.get(at) == Some(&b'}') {
            return Ok(JsonRanges { members, close: at });
        }
        if bytes.get(at) != Some(&b'"') {
            return Err("Cannot locate reviewed JSON member.".into());
        }
        let end = json_string_end(source, at);
        let key = serde_json::from_str(&source[at..end]).map_err(|_| "Cannot decode JSON key.")?;
        at = json_trivia(source, end);
        if bytes.get(at) != Some(&b':') {
            return Err("Cannot locate reviewed JSON value.".into());
        }
        at = json_trivia(source, at + 1);
        let end = json_value_end(source, at);
        members.push((key, at..end));
        at = json_trivia(source, end);
        if bytes.get(at) == Some(&b',') {
            at += 1;
        }
    }
}
fn json_member(object: &JsonRanges, key: &str) -> Result<std::ops::Range<usize>, String> {
    object
        .members
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, range)| range.clone())
        .ok_or("Cannot locate reviewed client entry.".into())
}
fn json_comments(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut at = 0;
    let mut comments = String::new();
    while at < bytes.len() {
        if bytes[at] == b'"' {
            at = json_string_end(source, at);
        } else if bytes.get(at..at + 2) == Some(b"//") || bytes.get(at..at + 2) == Some(b"/*") {
            let end = json_trivia(source, at);
            comments.push('\n');
            comments.push_str(&source[at..end]);
            comments.push('\n');
            at = end;
        } else {
            at += 1;
        }
    }
    comments
}
fn json_insert(
    source: &str,
    object: &JsonRanges,
    members: &[(&str, &Value)],
    edits: &mut Vec<(std::ops::Range<usize>, String)>,
) -> Result<(), String> {
    if members.is_empty() { return Ok(()); }
    let newline = if source.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let indent_at = |at: usize| {
        let start = source[..at].rfind('\n').map_or(0, |index| index + 1);
        source[start..at]
            .chars()
            .take_while(|c| matches!(c, ' ' | '\t'))
            .collect::<String>()
    };
    let close_indent = indent_at(object.close);
    let indent = object
        .members
        .last()
        .map(|(_, range)| indent_at(range.start))
        .unwrap_or_else(|| format!("{close_indent}  "));
    let members = members.iter().map(|(key, value)| {
        let key = serde_json::to_string(key).map_err(|_| "Cannot encode JSON key.")?;
        let value = serde_json::to_string(value).map_err(|_| "Cannot encode JSON value.")?;
        Ok(format!("{key}: {value}"))
    }).collect::<Result<Vec<_>, &str>>()?.join(&format!(",{newline}{indent}"));
    edits.push((
        object.close..object.close,
        format!("{newline}{indent}{members}{newline}{close_indent}"),
    ));
    if let Some((_, last)) = object.members.last() {
        if source.as_bytes().get(json_trivia(source, last.end)) != Some(&b',') {
            edits.push((last.end..last.end, ",".into()));
        }
    }
    Ok(())
}
fn edit_json_entry(
    source: &str,
    servers_key: &str,
    id: &str,
    env_key: &str,
    entry: &Value,
) -> Result<String, String> {
    let root = json_object(source, json_trivia(source, 0))?;
    let servers = json_object(source, json_member(&root, servers_key)?.start)?;
    let object = json_object(source, json_member(&servers, id)?.start)?;
    let mut edits = Vec::new();
    for key in ["command", "args"] {
        if let Some(value) = entry.get(key) {
            let range = json_member(&object, key)?;
            if jsonc::parse(&source[range.clone()])? == *value {
                continue;
            }
            let mut text =
                serde_json::to_string(value).map_err(|_| "Cannot encode client value.")?;
            // Removed legacy arguments may have internal comments. Keep them at the
            // changed array, even when the router's argument list becomes empty.
            if value.is_array() {
                let comments = json_comments(&source[range.clone()]);
                text.insert_str(text.len() - 1, &comments);
            }
            edits.push((range, text));
        }
    }
    if let Ok(range) = json_member(&object, env_key) {
        let env = json_object(source, range.start)?;
        let members: Vec<_> = [client_ownership::OWNER_KEY, LAUNCHER_CONFIG].into_iter()
            .filter(|key| json_member(&env, key).is_err())
            .filter_map(|key| entry[env_key].get(key).map(|value| (key, value)))
            .collect();
        json_insert(source, &env, &members, &mut edits)?;
    } else {
        json_insert(source, &object, &[(env_key, &entry[env_key])], &mut edits)?;
    }
    edits.sort_by_key(|edit| std::cmp::Reverse(edit.0.start));
    let mut after = source.to_owned();
    for (range, text) in edits {
        after.replace_range(range, &text);
    }
    Ok(after)
}

impl Plan {
    pub(crate) fn review(
        client: &str,
        path: &Path,
        format: Format,
        node: &Path,
        server: &Path,
    ) -> Result<Option<Self>, String> {
        Self::review_target(client, path, format, node, Some(server))
    }
    #[allow(dead_code)] // Retained for the unpinned compatibility/test caller.
    pub(crate) fn review_router(
        client: &str,
        path: &Path,
        format: Format,
        router: &Path,
    ) -> Result<Option<Self>, String> {
        Self::review_target(client, path, format, router, None)
    }
    pub(crate) fn review_router_with_config(
        client: &str,
        path: &Path,
        format: Format,
        router: &Path,
        launcher_config: &Path,
    ) -> Result<Option<Self>, String> {
        Self::review_target_inner(
            client, path, format, router, None, Some(launcher_config),
            #[cfg(test)]
            verify_retained_router,
        )
    }
    fn review_target(
        client: &str,
        path: &Path,
        format: Format,
        node: &Path,
        server: Option<&Path>,
    ) -> Result<Option<Self>, String> {
        Self::review_target_inner(
            client,
            path,
            format,
            node,
            server,
            None,
            #[cfg(test)]
            verify_retained_router,
        )
    }

    fn review_target_inner(
        client: &str,
        path: &Path,
        format: Format,
        node: &Path,
        server: Option<&Path>,
        launcher_config: Option<&Path>,
        #[cfg(test)] verify_router: impl Fn(&Path) -> Result<(), String>,
    ) -> Result<Option<Self>, String> {
        #[cfg(not(test))]
        let verify_router = verify_retained_router;
        if !path.is_absolute() {
            return Err("Client settings require an absolute path.".into());
        }
        if let Some(config) = launcher_config {
            crate::managed_settings_path::physical(config)?;
        }
        let Some(before) = settings_backup::read_text(path)? else {
            return Ok(None);
        };
        let node = target(node)?;
        let managed = server.is_none();
        let server = server.map(target).transpose()?.unwrap_or_default();
        let (after, old_node, old_server, project) = match format {
            Format::Codex => {
                let mut doc = before
                    .parse::<toml_edit::Document>()
                    .map_err(|_| "Invalid Codex TOML. Nothing was changed.")?;
                let Some(servers) = doc.get_mut("mcp_servers") else {
                    return Ok(None);
                };
                let servers = servers
                    .as_table_like_mut()
                    .ok_or("Client MCP servers must be an object.")?;
                let ids: Vec<_> = [crate::MCP_CLIENT_ID, crate::LEGACY_MCP_CLIENT_ID]
                    .into_iter()
                    .filter(|id| servers.contains_key(id))
                    .collect();
                if ids.is_empty() {
                    return Ok(None);
                }
                if ids.len() != 1 {
                    return Err(
                        "Two Creator/Banter entries require manual review. Neither was changed."
                            .into(),
                    );
                }
                let entry = servers
                    .get_mut(ids[0])
                    .unwrap()
                    .as_table_like_mut()
                    .ok_or("Client entry must be a table.")?;
                let owner = entry
                    .get("env")
                    .and_then(toml_edit::Item::as_table_like)
                    .and_then(|env| env.get(client_ownership::OWNER_KEY));
                let owned =
                    owner.and_then(toml_edit::Item::as_str) == Some(client_ownership::OWNER);
                let needs_pin = launcher_config.is_some() && entry.get("env")
                    .and_then(toml_edit::Item::as_table_like)
                    .is_none_or(|env| !env.contains_key(LAUNCHER_CONFIG));
                if owned
                    && (!managed
                        || !needs_pin && entry.get("command").and_then(toml_edit::Item::as_str)
                            .is_some_and(|command| same_router_path(command, &node))
                            && entry
                                .get("args")
                                .and_then(toml_edit::Item::as_array)
                                .is_some_and(|args| args.is_empty()))
                {
                    return Ok(None);
                }
                if owner.is_some() && !owned {
                    return Err("A different owner is recorded. Nothing was changed.".into());
                }
                let old_node = entry
                    .get("command")
                    .and_then(toml_edit::Item::as_str)
                    .ok_or("Custom client command requires manual review.")?
                    .to_owned();
                let args = entry
                    .get("args")
                    .and_then(toml_edit::Item::as_array)
                    .ok_or("Custom client arguments require manual review.")?;
                let relocated = managed && owned && args.is_empty();
                let command_literal = if relocated && !same_router_path(&old_node, &node) {
                    match entry.get("command").and_then(toml_edit::Item::as_value) {
                        Some(toml_edit::Value::String(value)) => Some(value.display_repr().into_owned()),
                        _ => unreachable!(),
                    }
                } else {
                    None
                };
                let old_server = if managed && owned && args.is_empty() {
                    reviewable(&old_node)?;
                    verify_router(Path::new(&old_node))?;
                    String::new()
                } else {
                    if args.len() != 1 {
                        return Err("Custom client arguments require manual review.".into());
                    }
                    let server = args
                        .get(0)
                        .and_then(toml_edit::Value::as_str)
                        .ok_or("Custom client arguments require manual review.")?
                        .to_owned();
                    legacy_shape(&old_node, &server)?;
                    server
                };
                let mut args = args.clone();
                if managed && !args.is_empty() {
                    let value = args.get(0).unwrap();
                    let trivia = format!(
                        "{}{}{}",
                        value
                            .decor()
                            .prefix()
                            .and_then(|raw| raw.as_str())
                            .unwrap_or(""),
                        value
                            .decor()
                            .suffix()
                            .and_then(|raw| raw.as_str())
                            .unwrap_or(""),
                        args.trailing().as_str().unwrap_or("")
                    );
                    args.clear();
                    args.set_trailing_comma(false);
                    args.set_trailing(trivia);
                } else if !managed {
                    args.replace(0, server);
                }
                if relocated && command_literal.is_some() {
                    let previous = entry.get_mut("command").unwrap().as_value_mut().unwrap();
                    let mut value = toml_edit::Value::from(node.clone());
                    *value.decor_mut() = previous.decor().clone();
                    *previous = value;
                } else if !relocated {
                    set_toml(entry, "command", node.clone());
                    set_toml(entry, "args", args);
                }
                if entry.get("env").is_none() {
                    entry.insert("env", toml_edit::Item::Table(toml_edit::Table::new()));
                }
                let env = entry
                    .get_mut("env")
                    .unwrap()
                    .as_table_like_mut()
                    .ok_or("Client environment must be an object.")?;
                safe_environment(env.iter().map(|(key, _)| key))?;
                let project = env
                    .get("UNITY_PROJECT_PATH")
                    .and_then(toml_edit::Item::as_str)
                    .map(str::to_owned);
                if !relocated {
                    set_toml(env, client_ownership::OWNER_KEY, client_ownership::OWNER);
                }
                let rendered = doc.to_string();
                let mut after = if relocated {
                    if let Some(literal) = command_literal {
                        edit_toml_router_command(&before, &literal, &toml_edit::Value::from(node).to_string(), &rendered)?
                    } else {
                        before.clone()
                    }
                } else {
                    rendered
                };
                if managed && needs_pin {
                    after = pin_toml_config(&after, ids[0], &crate::managed_settings_path::physical(launcher_config.unwrap())?)?;
                }
                (after, old_node, old_server, project)
            }
            Format::Json | Format::OpenCode => {
                if matches!(format, Format::Json) {
                    serde_json::from_str::<Value>(&before)
                        .map_err(|_| "Invalid client JSON. Nothing was changed.")?;
                }
                let mut config = jsonc::parse_unambiguous(&before)?;
                let key = if matches!(format, Format::OpenCode) {
                    "mcp"
                } else {
                    "mcpServers"
                };
                let env_key = if matches!(format, Format::OpenCode) {
                    "environment"
                } else {
                    "env"
                };
                if !config.is_object() {
                    return Err("Client settings must be an object.".into());
                }
                let Some(servers) = config.get_mut(key) else {
                    return Ok(None);
                };
                let servers = servers
                    .as_object_mut()
                    .ok_or("Client MCP servers must be an object.")?;
                let ids: Vec<_> = [crate::MCP_CLIENT_ID, crate::LEGACY_MCP_CLIENT_ID]
                    .into_iter()
                    .filter(|id| servers.contains_key(*id))
                    .collect();
                if ids.is_empty() {
                    return Ok(None);
                }
                if ids.len() != 1 {
                    return Err(
                        "Two Creator/Banter entries require manual review. Neither was changed."
                            .into(),
                    );
                }
                let id = ids[0];
                let entry = servers.get_mut(id).unwrap();
                if !entry.is_object() {
                    return Err("Client entry must be an object.".into());
                }
                let owner = entry
                    .get(env_key)
                    .and_then(|env| env.get(client_ownership::OWNER_KEY));
                let owned = owner == Some(&Value::String(client_ownership::OWNER.into()));
                let needs_pin = launcher_config.is_some() && entry[env_key].get(LAUNCHER_CONFIG).is_none();
                let routed = if matches!(format, Format::OpenCode) {
                    entry["command"].as_array().is_some_and(|command| command.len() == 1
                        && command[0].as_str().is_some_and(|command| same_router_path(command, &node)))
                } else {
                    entry["command"].as_str().is_some_and(|command| same_router_path(command, &node))
                        && entry["args"] == serde_json::json!([])
                };
                if owned && (!managed || routed && !needs_pin) {
                    return Ok(None);
                }
                if owner.is_some() && !owned {
                    return Err("A different owner is recorded. Nothing was changed.".into());
                }
                let (old_node, old_server) = if matches!(format, Format::OpenCode) {
                    if entry["type"] != "local" {
                        return Err("Non-local OpenCode entries require manual review.".into());
                    }
                    let command = entry["command"]
                        .as_array()
                        .ok_or("Custom client arguments require manual review.")?;
                    if managed && owned && command.len() == 1 {
                        (command[0].as_str(), None)
                    } else if command.len() == 2 {
                        (command[0].as_str(), Some(command[1].as_str()))
                    } else {
                        return Err("Custom client arguments require manual review.".into());
                    }
                } else {
                    let args = entry["args"]
                        .as_array()
                        .ok_or("Custom client arguments require manual review.")?;
                    if managed && owned && args.is_empty() {
                        (entry["command"].as_str(), None)
                    } else if args.len() == 1 {
                        (entry["command"].as_str(), Some(args[0].as_str()))
                    } else {
                        return Err("Custom client arguments require manual review.".into());
                    }
                };
                let old_node = old_node
                    .ok_or("Custom client command requires manual review.")?
                    .to_owned();
                let old_server = if let Some(server) = old_server {
                    let server = server
                        .ok_or("Custom client arguments require manual review.")?
                        .to_owned();
                    legacy_shape(&old_node, &server)?;
                    server
                } else {
                    reviewable(&old_node)?;
                    verify_router(Path::new(&old_node))?;
                    String::new()
                };
                if routed {
                    // A config-only pin keeps the current command spelling intact.
                } else if matches!(format, Format::OpenCode) {
                    entry["command"] = if managed {
                        serde_json::json!([node])
                    } else {
                        serde_json::json!([node, server])
                    };
                } else {
                    entry["command"] = Value::String(node);
                    entry["args"] = if managed {
                        serde_json::json!([])
                    } else {
                        serde_json::json!([server])
                    };
                }
                if entry.get(env_key).is_none() {
                    entry[env_key] = serde_json::json!({});
                }
                let env = entry[env_key]
                    .as_object_mut()
                    .ok_or("Client environment must be an object.")?;
                safe_environment(env.keys().map(String::as_str))?;
                let project = env
                    .get("UNITY_PROJECT_PATH")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                env.insert(
                    client_ownership::OWNER_KEY.into(),
                    Value::String(client_ownership::OWNER.into()),
                );
                if managed && needs_pin {
                    let config = match env.get("BANTWORKS_LAUNCHER_CONFIG").and_then(Value::as_str) {
                        Some(config) => config.to_owned(),
                        None => crate::managed_settings_path::physical(launcher_config.unwrap())?,
                    };
                    env.insert(LAUNCHER_CONFIG.into(), Value::String(config));
                }
                let entry = entry.clone();
                let after = edit_json_entry(&before, key, id, env_key, &entry)?;
                if jsonc::parse_unambiguous(&after)? != config {
                    return Err("Client edit could not be verified. Nothing was changed.".into());
                }
                (after, old_node, old_server, project)
            }
        };
        if let Some(project) = &project {
            reviewable(project)?;
        }
        Ok(Some(Self {
            client: client.into(),
            path: path.into(),
            before,
            after,
            old_node,
            old_server,
            project,
        }))
    }

    pub(crate) fn apply(
        self,
        approve: impl FnOnce(&Self) -> bool,
    ) -> Result<Option<PathBuf>, String> {
        if !approve(&self) {
            return Ok(None);
        }
        if settings_backup::read_text(&self.path)?.as_deref() != Some(&self.before) {
            return Err(
                "Client settings changed after review. Nothing was changed; review again.".into(),
            );
        }
        let root = self.path.parent().unwrap().join(".creator-hub-migrations");
        let write = self.reviewed_write();
        let transaction = recovery::Transaction::prepare(&root, vec![write])?;
        let report = transaction.resume(|_| true)?;
        if !report.completed {
            return Err(format!("Migration requires recovery review at {} ({:?}). All retained files were kept; no restore or write retry was attempted.", report.journal.display(), report.files[0].status));
        }
        Ok(Some(report.files[0].before_backup.clone()))
    }

    /// For an explicitly approved batch that also includes reviewed product-settings adapters.
    pub(crate) fn reviewed_write(&self) -> recovery::ReviewedWrite {
        recovery::ReviewedWrite::new(
            &self.client,
            &self.path,
            self.before.as_bytes(),
            self.after.as_bytes(),
        )
    }

    /// Approval covers the whole list; missing clients are not synthesized or required.
    pub(crate) fn apply_reviewed(
        plans: &[Self],
        journal_root: &Path,
        approve: impl FnOnce(&[Self]) -> bool,
    ) -> Result<Option<recovery::Report>, String> {
        if plans.is_empty() || !approve(plans) {
            return Ok(None);
        }
        let writes = plans.iter().map(Self::reviewed_write).collect();
        recovery::Transaction::prepare(journal_root, writes)?
            .resume(|_| true)
            .map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[cfg(windows)]
    #[test]
    fn approved_router_conversion_preserves_settings_and_is_idempotent() {
        let f = Fixture::new();
        let router = f.root.join(if cfg!(windows) {
            "creator-hub-mcp-router.exe"
        } else {
            "creator-hub-mcp-router"
        });
        fs::write(&router, b"fixture, never executed").unwrap();
        for owned in [false, true] {
            let mut entry = f.old_entry();
            if owned {
                entry["env"][client_ownership::OWNER_KEY] =
                    serde_json::json!(client_ownership::OWNER);
            }
            let original = serde_json::json!({"preferences":{"keep":true},"mcpServers":{"other":{"command":"preserve"},"creator-works":entry}}).to_string();
            let path = f.root.join("router-client.json");
            fs::write(&path, &original).unwrap();
            let review = || Plan::review_router("Fixture", &path, Format::Json, &router).unwrap();
            assert!(review().unwrap().apply(|_| false).unwrap().is_none());
            assert_eq!(fs::read_to_string(&path).unwrap(), original);
            let backup = review().unwrap().apply(|_| true).unwrap().unwrap();
            assert_eq!(fs::read_to_string(backup).unwrap(), original);
            let result: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            assert_eq!(
                result["mcpServers"]["creator-works"]["args"],
                serde_json::json!([])
            );
            assert_eq!(result["mcpServers"]["creator-works"]["timeout"], 37);
            assert_eq!(
                result["mcpServers"]["creator-works"]["env"]["CUSTOM"],
                "keep"
            );
            assert_eq!(result["mcpServers"]["other"]["command"], "preserve");
            assert!(client_ownership::guard_json(&result, None, false).unwrap());
            assert!(review().is_none());
        }
    }

    struct Fixture {
        _directory: tempfile::TempDir,
        root: PathBuf,
        node: PathBuf,
        server: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().canonicalize().unwrap();
            let node = root.join(if cfg!(windows) { "node.exe" } else { "node" });
            let server = root.join("creator-works-mcp.mjs");
            fs::write(&node, b"fixture, never executed").unwrap();
            fs::write(&server, b"fixture, never executed").unwrap();
            Self {
                _directory: directory,
                root,
                node,
                server,
            }
        }
        fn old_entry(&self) -> Value {
            serde_json::json!({"command":self.root.join("legacy").join(if cfg!(windows) { "node.exe" } else { "node" }),
                "args":[self.root.join("legacy/banter-mcp.mjs")], "timeout":37,
                "env":{"UNITY_PROJECT_PATH":"preserve the user's project", "CUSTOM":"keep", "CREATOR_WORKS_TOOL_GROUPS":"read"}})
        }
        fn review(&self, format: Format, content: &str) -> (PathBuf, Option<Plan>) {
            let path = self.root.join("client-config");
            fs::write(&path, content).unwrap();
            let plan =
                Plan::review("Fixture client", &path, format, &self.node, &self.server).unwrap();
            (path, plan)
        }
    }

    #[test]
    fn fresh_profiles_and_owned_entries_are_noop_without_backups_or_consent() {
        let f = Fixture::new();
        let path = f.root.join("missing.json");
        assert!(
            Plan::review("Fixture", &path, Format::Json, &f.node, &f.server)
                .unwrap()
                .is_none()
        );
        assert!(!path.exists());
        for format in [Format::Json, Format::OpenCode, Format::Codex] {
            let (path, plan) = f.review(
                format,
                if matches!(format, Format::Codex) {
                    "model='keep'\n"
                } else {
                    "{}\n"
                },
            );
            assert!(plan.is_none());
            assert!(path.exists());
            assert!(!f.root.join(".creator-hub-settings-backups").exists());
        }
        let mut entry = f.old_entry();
        entry["env"][client_ownership::OWNER_KEY] = Value::String(client_ownership::OWNER.into());
        let (_, plan) = f.review(
            Format::Json,
            &serde_json::json!({"mcpServers":{"creator-works":entry}}).to_string(),
        );
        assert!(plan.is_none());
    }

    #[test]
    fn cancel_and_stale_approval_never_overwrite_client_settings() {
        let f = Fixture::new();
        let original =
            serde_json::json!({"mcpServers":{"creator-works":f.old_entry()}}).to_string();
        let (path, plan) = f.review(Format::Json, &original);
        assert!(plan.unwrap().apply(|_| false).unwrap().is_none());
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        assert!(!f.root.join(".creator-hub-settings-backups").exists());
        let (_, plan) = f.review(Format::Json, &original);
        let error = plan
            .unwrap()
            .apply(|_| {
                fs::write(&path, b"user edited while reviewing").unwrap();
                true
            })
            .unwrap_err();
        assert!(error.contains("changed after review"));
        assert_eq!(fs::read(&path).unwrap(), b"user edited while reviewing");
    }

    #[cfg(windows)]
    #[test]
    fn approved_json_connection_keeps_project_other_servers_and_exact_before_image() {
        let f = Fixture::new();
        let entry = f.old_entry();
        let original = format!("{{\r\n  \"preferences\":{{\"keep\":true}},\r\n  \"mcpServers\":{{\"other\":{{\"command\":\"keep\"}},\"creator-works\":{entry}}}\r\n}}\r\n");
        let (path, plan) = f.review(Format::Json, &original);
        let backup = plan
            .unwrap()
            .apply(|p| {
                assert_eq!(p.project.as_deref(), Some("preserve the user's project"));
                true
            })
            .unwrap()
            .unwrap();
        assert_eq!(fs::read(&backup).unwrap(), original.as_bytes());
        let after: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(after["preferences"]["keep"], true);
        assert_eq!(after["mcpServers"]["other"]["command"], "keep");
        let migrated = &after["mcpServers"]["creator-works"];
        assert_eq!(
            migrated["command"],
            crate::normalized_existing_path(f.node.clone())
                .to_str()
                .unwrap()
        );
        assert_eq!(
            migrated["env"]["UNITY_PROJECT_PATH"],
            entry["env"]["UNITY_PROJECT_PATH"]
        );
        assert_eq!(migrated["env"]["CUSTOM"], "keep");
        assert_eq!(migrated["timeout"], 37);
        assert!(client_ownership::guard_json(&after, None, false).unwrap());
        assert!(
            Plan::review("Fixture", &path, Format::Json, &f.node, &f.server)
                .unwrap()
                .is_none()
        );
        assert_eq!(fs::read(&backup).unwrap(), original.as_bytes());
    }

    #[cfg(windows)]
    #[test]
    fn toml_quoted_dotted_and_inline_forms_keep_custom_fields_and_other_servers() {
        let f = Fixture::new();
        let node = f
            .root
            .join("old")
            .join(if cfg!(windows) { "node.exe" } else { "node" })
            .to_string_lossy()
            .into_owned();
        let server = f
            .root
            .join("old/creator-works-mcp.mjs")
            .to_string_lossy()
            .into_owned();
        for entry in [
            format!("[mcp_servers.'creator-works']\ncommand='{node}'\nargs=['{server}']\ntimeout=37\n[mcp_servers.'creator-works'.env]\nUNITY_PROJECT_PATH='keep'\n"),
            format!("mcp_servers = {{ creator-works = {{ command='{node}', args=['{server}'], timeout=37, env={{UNITY_PROJECT_PATH='keep'}} }}, other={{command='preserve'}} }}\n"),
            format!("mcp_servers.'creator-works'.command='{node}'\nmcp_servers.'creator-works'.args=['{server}']\nmcp_servers.'creator-works'.timeout=37\nmcp_servers.'creator-works'.env.UNITY_PROJECT_PATH='keep'\n"),
        ] {
            let original = format!("# exact unrelated comment\nmodel='keep'\n{entry}");
            let (path, plan) = f.review(Format::Codex, &original);
            let backup = plan.unwrap().apply(|_| true).unwrap().unwrap();
            assert_eq!(fs::read(&backup).unwrap(), original.as_bytes());
            let after = fs::read_to_string(&path).unwrap();
            assert!(after.starts_with("# exact unrelated comment\nmodel='keep'\n"));
            let doc = after.parse::<toml_edit::Document>().unwrap();
            assert_eq!(doc["mcp_servers"]["creator-works"]["timeout"].as_integer(), Some(37));
            assert_eq!(doc["mcp_servers"]["creator-works"]["env"]["UNITY_PROJECT_PATH"].as_str(), Some("keep"));
            assert!(client_ownership::guard_toml(&after, None).unwrap());
        }
    }

    #[cfg(windows)]
    #[test]
    fn opencode_comments_and_existing_environment_survive_migration() {
        let f = Fixture::new();
        let old = f.old_entry();
        let entry = serde_json::json!({"type":"local", "command":[old["command"],old["args"][0]],"environment":old["env"],"enabled":false});
        let original = format!("{{\n // keep this comment\n \"mcp\":{{\"banter\":{entry},\"other\":{{\"type\":\"remote\",\"url\":\"https://example.invalid\"}},}},\n}}\n");
        let (path, plan) = f.review(Format::OpenCode, &original);
        plan.unwrap().apply(|_| true).unwrap();
        let after = fs::read_to_string(path).unwrap();
        assert!(after.contains("// keep this comment"));
        let config = jsonc::parse(&after).unwrap();
        assert_eq!(config["mcp"]["banter"]["enabled"], false);
        assert_eq!(
            config["mcp"]["banter"]["environment"]["UNITY_PROJECT_PATH"],
            old["env"]["UNITY_PROJECT_PATH"]
        );
        assert!(client_ownership::guard_json(&config, None, true).unwrap());
    }

    #[test]
    fn ambiguous_foreign_custom_or_injected_entries_are_refused_unchanged() {
        let f = Fixture::new();
        let original = f.old_entry();
        let mut cases = vec![
            serde_json::json!({"mcpServers":{"creator-works":original,"banter":original}})
                .to_string(),
            "{\"mcpServers\":[],\"mcpServers\":{}}".into(),
            "{\"mcpServers\":[]}".into(),
            "[]".into(),
            "invalid JSON".into(),
        ];
        for changed in [
            serde_json::json!({"command":"custom","args":["custom"]}),
            serde_json::json!({"command":original["command"],"args":[original["args"][0],"extra"]}),
        ] {
            cases.push(serde_json::json!({"mcpServers":{"creator-works":changed}}).to_string());
        }
        for (key, value) in [
            (client_ownership::OWNER_KEY, serde_json::json!(17)),
            ("NODE_OPTIONS", serde_json::json!("--require custom")),
            ("NODE_PATH", serde_json::json!("custom")),
        ] {
            let mut entry = original.clone();
            entry["env"][key] = value;
            cases.push(serde_json::json!({"mcpServers":{"creator-works":entry}}).to_string());
        }
        for content in cases {
            let path = f.root.join("refuse.json");
            fs::write(&path, &content).unwrap();
            assert!(
                Plan::review("Fixture", &path, Format::Json, &f.node, &f.server).is_err(),
                "{content}"
            );
            assert_eq!(fs::read_to_string(path).unwrap(), content);
            assert!(!f.root.join(".creator-hub-settings-backups").exists());
        }
    }

    #[test]
    fn a_changed_backup_blocks_publication_and_is_not_overwritten() {
        let f = Fixture::new();
        let original =
            serde_json::json!({"mcpServers":{"creator-works":f.old_entry()}}).to_string();
        let (path, plan) = f.review(Format::Json, &original);
        settings_backup::retain(&path).unwrap();
        let backup = fs::read_dir(f.root.join(".creator-hub-settings-backups"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        fs::write(&backup, b"preserve changed backup").unwrap();
        assert!(plan.unwrap().apply(|_| true).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), original);
        assert_eq!(fs::read(backup).unwrap(), b"preserve changed backup");
    }

    #[test]
    fn environment_casing_and_unsafe_review_text_require_manual_review() {
        for key in ["node_options", "Node_Path", "creator_works_config_owner"] {
            assert!(safe_environment([key].into_iter()).is_err());
        }
        assert!(safe_environment(["PATH", "Path"].into_iter()).is_err());
        assert!(reviewable("project\nmisleading review text").is_err());
        assert!(reviewable(&"x".repeat(4097)).is_err());
        assert!(reviewable("a normal project path").is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn migrated_server_paths_use_the_existing_node_compatible_normalizer() {
        let f = Fixture::new();
        let namespaced = f.server.canonicalize().unwrap();
        assert!(namespaced.to_string_lossy().starts_with(r"\\?\"));
        assert_eq!(
            target(&namespaced).unwrap(),
            crate::normalized_existing_path(f.server.clone())
                .to_str()
                .unwrap()
        );
        let original =
            serde_json::json!({"mcpServers":{"creator-works":f.old_entry()}}).to_string();
        let (_, plan) = f.review(Format::Json, &original);
        let after: Value = serde_json::from_str(&plan.unwrap().after).unwrap();
        assert!(!after["mcpServers"]["creator-works"]["args"][0]
            .as_str()
            .unwrap()
            .starts_with(r"\\?\"));
    }

    #[cfg(windows)]
    #[test]
    fn a_locked_client_file_preserves_its_original_bytes_and_backup() {
        use std::os::windows::fs::OpenOptionsExt;
        let f = Fixture::new();
        let original =
            serde_json::json!({"mcpServers":{"creator-works":f.old_entry()}}).to_string();
        let (path, plan) = f.review(Format::Json, &original);
        let _held = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        assert!(plan.unwrap().apply(|_| true).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        let backups = f.root.join(".creator-hub-settings-backups");
        let backup = fs::read_dir(backups)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(fs::read_to_string(backup).unwrap(), original);
    }
}
