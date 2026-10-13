//! Pure, bounded removal-dependency inspection. No discovery, filesystem calls,
//! rewrites, recovery, retention verification, or uninstall authorization.
//!
//! The caller supplies every effective scope (including alternate JSON/JSONC,
//! project, profile, inline, and managed sources), or uses Coverage::Unknown.
//! Absent means caller-verified absence, not an unreadable or undiscovered file.
//! verified_router must come from native signature/hash verification. This
//! module compares its path; it does not authenticate that caller assertion.
//! Empty blockers describe only these supplied documents and known fields.
//! Opaque options, inherited client environment, links, running clients, and
//! installer policy require independent live proof before removal.
//! Root integration needs the existing MCP parser dependency toml_edit=0.20.2.

#[allow(dead_code)]
#[path = "../modules/mcp/launcher/src-tauri/src/jsonc.rs"]
mod jsonc;

use serde::Serialize;
use serde_json::{Map, Value};
use std::path::{Component, Path, PathBuf};

const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_DOCUMENTS: usize = 32;
const MAX_ENTRIES: usize = 2048;
const MAX_BLOCKERS: usize = 256;
const OWNER: &str = "CREATOR_WORKS_CONFIG_OWNER";
const CONFIG_OVERRIDES: [&str; 2] = ["CREATOR_WORKS_LAUNCHER_CONFIG", "BANTWORKS_LAUNCHER_CONFIG"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Client {
    Codex,
    ClaudeCode,
    ClaudeDesktop,
    Antigravity,
    OpenCode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigFormat {
    CodexToml,
    McpJson,
    OpenCodeJson,
    OpenCodeJsonc,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Coverage {
    /// Caller assertion covering all effective sources for the declared client.
    EffectiveScopesSupplied,
    Unknown,
}

enum Parsed {
    Json(Value),
    Toml(Box<toml_edit::Document>),
}

/// Construct through parse_document so duplicate keys cannot disappear in Value.
/// Deliberately not Debug/Serialize: the parsed document may contain secrets.
pub struct ParsedDocument {
    format: ConfigFormat,
    document: Parsed,
}

pub enum DocumentContent<'a> {
    Bytes(&'a [u8]),
    Parsed(&'a ParsedDocument),
    Absent,
}

pub struct ConfigDocument<'a> {
    /// Public scope/file metadata supplied by the caller, never document content.
    pub label: &'a str,
    pub format: ConfigFormat,
    pub content: DocumentContent<'a>,
}

pub struct Inspection<'a> {
    pub client: Client,
    pub coverage: Coverage,
    pub documents: &'a [ConfigDocument<'a>],
    pub removal_roots: &'a [PathBuf],
    pub verified_router: &'a Path,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParseFailure {
    Oversized,
    Invalid,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BlockerKind {
    UnknownScopes,
    InvalidRemovalRoots,
    InvalidRouterPath,
    RetainedRouterRemoved,
    InvalidDocument,
    TooManyEntries,
    InstalledCommand,
    UnverifiedCreatorRoute,
    InvalidTransport,
    InvalidEnvironment,
    LauncherConfigRemoved,
    UnresolvedLauncherConfig,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Blocker {
    pub client: Client,
    pub kind: BlockerKind,
    pub label: String,
    /// Structural ordinal path: no server names, project keys, or field values.
    pub location: String,
}

pub fn parse_document(format: ConfigFormat, bytes: &[u8]) -> Result<ParsedDocument, ParseFailure> {
    if bytes.len() > MAX_BYTES {
        return Err(ParseFailure::Oversized);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| ParseFailure::Invalid)?;
    let document = match format {
        ConfigFormat::CodexToml => {
            Parsed::Toml(Box::new(text.parse().map_err(|_| ParseFailure::Invalid)?))
        }
        ConfigFormat::McpJson | ConfigFormat::OpenCodeJson | ConfigFormat::OpenCodeJsonc => {
            if format != ConfigFormat::OpenCodeJsonc {
                serde_json::from_str::<Value>(text).map_err(|_| ParseFailure::Invalid)?;
            }
            Parsed::Json(jsonc::parse_unambiguous(text).map_err(|_| ParseFailure::Invalid)?)
        }
    };
    Ok(ParsedDocument { format, document })
}

fn format_matches(client: Client, format: ConfigFormat) -> bool {
    match client {
        Client::Codex => format == ConfigFormat::CodexToml,
        Client::OpenCode => matches!(
            format,
            ConfigFormat::OpenCodeJson | ConfigFormat::OpenCodeJsonc
        ),
        _ => format == ConfigFormat::McpJson,
    }
}

// Lexical only. No canonicalize/stat/exists, variable expansion, or shell parsing.
fn path_key(path: &Path) -> Option<String> {
    let text = path.to_str()?;
    if !path.is_absolute()
        || path.components().any(|c| matches!(c, Component::ParentDir))
        || text.chars().any(char::is_control)
        || text.starts_with("\\\\")
        || text.starts_with("//")
    {
        return None;
    }
    let normalized: PathBuf = path.components().collect();
    let text = normalized.to_str()?;
    Some(if cfg!(windows) {
        text.replace('\\', "/")
            .trim_end_matches('/')
            .to_ascii_lowercase()
    } else {
        text.trim_end_matches('/').to_owned()
    })
}

fn removed(key: &str, roots: &[String]) -> bool {
    roots
        .iter()
        .any(|root| key == root || key.starts_with(&format!("{root}/")))
}

struct Inspector {
    client: Client,
    blockers: Vec<Blocker>,
    label: String,
    roots: Vec<String>,
    router: String,
    entries: usize,
}

impl Inspector {
    fn block(&mut self, kind: BlockerKind, location: &str) {
        if self.blockers.len() == MAX_BLOCKERS {
            return;
        }
        let kind = if self.blockers.len() == MAX_BLOCKERS - 1 {
            BlockerKind::TooManyEntries
        } else {
            kind
        };
        self.blockers.push(Blocker {
            client: self.client,
            kind,
            label: self.label.clone(),
            location: location.into(),
        });
    }

    fn servers(&mut self, value: &Value, location: &str, opencode: bool) {
        let Some(servers) = value.as_object() else {
            self.block(BlockerKind::InvalidDocument, location);
            return;
        };
        for (index, (id, entry)) in servers.iter().enumerate() {
            self.entries += 1;
            if self.entries > MAX_ENTRIES {
                self.block(BlockerKind::TooManyEntries, location);
                return;
            }
            self.entry(id, entry, &format!("{location}[entry#{index}]"), opencode);
        }
    }

    fn entry(&mut self, id: &str, entry: &Value, location: &str, opencode: bool) {
        let Some(entry) = entry.as_object() else {
            self.block(BlockerKind::InvalidDocument, location);
            return;
        };
        let env_name = if opencode { "environment" } else { "env" };
        let argv = command(entry, opencode);
        let mut relevant = matches!(id.to_ascii_lowercase().as_str(), "creator-works" | "banter")
            || entry
                .get(env_name)
                .and_then(Value::as_object)
                .is_some_and(|env| env.contains_key(OWNER));
        // Look at command/argv only, not arbitrary nested options or their strings.
        for name in ["command", "args"] {
            for (index, value) in strings(entry.get(name)).into_iter().enumerate() {
                relevant |= creator_command(value);
                if path_key(Path::new(value)).is_some_and(|key| removed(&key, &self.roots)) {
                    relevant = true;
                    self.block(
                        BlockerKind::InstalledCommand,
                        &format!("{location}.{name}[value#{index}]"),
                    );
                }
            }
        }
        relevant |= argv
            .as_ref()
            .and_then(|args| args.first())
            .and_then(|s| path_key(Path::new(s)))
            .is_some_and(|key| key == self.router);
        if let Some(env) = entry.get(env_name).and_then(Value::as_object) {
            relevant |= env.keys().any(|key| {
                CONFIG_OVERRIDES
                    .iter()
                    .any(|name| key.eq_ignore_ascii_case(name))
            });
        }
        if !relevant {
            return;
        }
        let routed = argv.as_ref().is_some_and(|args| {
            args.len() == 1 && path_key(Path::new(args[0])).as_deref() == Some(&self.router)
        });
        if !routed {
            self.block(
                BlockerKind::UnverifiedCreatorRoute,
                &format!("{location}.command"),
            );
        }
        let transport_ok = if opencode {
            entry.get("type").and_then(Value::as_str) == Some("local")
        } else {
            entry
                .get("type")
                .is_none_or(|value| value.as_str() == Some("stdio"))
        };
        if !transport_ok || entry.contains_key("url") {
            self.block(
                BlockerKind::InvalidTransport,
                &format!("{location}.transport"),
            );
        }
        if let Some(env) = entry.get(env_name) {
            self.environment(env, &format!("{location}.{env_name}"));
        }
    }

    fn environment(&mut self, value: &Value, location: &str) {
        let Some(env) = value.as_object() else {
            self.block(BlockerKind::InvalidEnvironment, location);
            return;
        };
        let mut keys = std::collections::HashSet::new();
        for (index, (name, value)) in env.iter().enumerate() {
            let upper = name.to_ascii_uppercase();
            let at = format!("{location}[field#{index}]");
            if !keys.insert(upper.clone())
                || !value.is_string()
                || ["NODE_OPTIONS", "NODE_PATH"].contains(&upper.as_str())
            {
                self.block(BlockerKind::InvalidEnvironment, &at);
            }
            if CONFIG_OVERRIDES.contains(&upper.as_str()) {
                if name != &upper {
                    self.block(BlockerKind::InvalidEnvironment, &at);
                }
                match value
                    .as_str()
                    .filter(|value| {
                        !["${", "{env:", "{file:", "%"]
                            .iter()
                            .any(|marker| value.contains(marker))
                    })
                    .and_then(|value| path_key(Path::new(value)))
                {
                    Some(key) if removed(&key, &self.roots) => {
                        self.block(BlockerKind::LauncherConfigRemoved, &at)
                    }
                    None => self.block(BlockerKind::UnresolvedLauncherConfig, &at),
                    _ => {}
                }
            }
        }
    }

    fn json(&mut self, value: &Value, client: Client) {
        let Some(root) = value.as_object() else {
            self.block(BlockerKind::InvalidDocument, "$");
            return;
        };
        let key = if client == Client::OpenCode {
            "mcp"
        } else {
            "mcpServers"
        };
        if let Some(servers) = root.get(key) {
            self.servers(servers, key, client == Client::OpenCode);
        }
        if client == Client::ClaudeCode {
            if let Some(projects) = root.get("projects") {
                let Some(projects) = projects.as_object() else {
                    self.block(BlockerKind::InvalidDocument, "projects");
                    return;
                };
                if projects.len() > MAX_ENTRIES {
                    self.block(BlockerKind::TooManyEntries, "projects");
                    return;
                }
                for (index, project) in projects.values().enumerate() {
                    let at = format!("projects[scope#{index}].mcpServers");
                    if !project.is_object() {
                        self.block(BlockerKind::InvalidDocument, &at);
                    } else if let Some(servers) = project.get("mcpServers") {
                        self.servers(servers, &at, false);
                    }
                }
            }
        }
    }

    fn toml(&mut self, document: &toml_edit::Document) {
        let Some(servers) = document.get("mcp_servers") else {
            return;
        };
        let Some(servers) = servers.as_table_like() else {
            self.block(BlockerKind::InvalidDocument, "mcp_servers");
            return;
        };
        for (index, (id, item)) in servers.iter().enumerate() {
            self.entries += 1;
            let at = format!("mcp_servers[entry#{index}]");
            if self.entries > MAX_ENTRIES {
                self.block(BlockerKind::TooManyEntries, "mcp_servers");
                return;
            }
            let Some(table) = item.as_table_like() else {
                self.block(BlockerKind::InvalidDocument, &at);
                continue;
            };
            let mut entry = Map::new();
            for name in ["command", "args", "env", "type", "url"] {
                if let Some(item) = table.get(name) {
                    entry.insert(name.into(), toml_value(item, 0));
                }
            }
            self.entry(id, &Value::Object(entry), &at, false);
        }
    }
}

fn toml_value(item: &toml_edit::Item, depth: usize) -> Value {
    if depth > 8 {
        return Value::Null;
    }
    if let Some(text) = item.as_str() {
        return Value::String(text.into());
    }
    if let Some(table) = item.as_table_like() {
        return Value::Object(
            table
                .iter()
                .map(|(key, value)| (key.into(), toml_value(value, depth + 1)))
                .collect(),
        );
    }
    if let Some(array) = item.as_array() {
        return Value::Array(
            array
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(|value| Value::String(value.into()))
                        .unwrap_or(Value::Null)
                })
                .collect(),
        );
    }
    Value::Null
}

fn strings(value: Option<&Value>) -> Vec<&str> {
    match value {
        Some(Value::String(value)) => vec![value],
        Some(Value::Array(values)) => values.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    }
}

fn command(entry: &Map<String, Value>, opencode: bool) -> Option<Vec<&str>> {
    if opencode {
        return entry
            .get("command")?
            .as_array()?
            .iter()
            .map(Value::as_str)
            .collect();
    }
    let mut command = vec![entry.get("command")?.as_str()?];
    let args: Option<Vec<_>> = entry
        .get("args")?
        .as_array()?
        .iter()
        .map(Value::as_str)
        .collect();
    command.extend(args?);
    Some(command)
}

fn creator_command(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    [
        "creator-works-mcp.mjs",
        "banter-mcp.mjs",
        "creator-hub-mcp-router",
    ]
    .iter()
    .any(|name| lower.contains(name))
}

/// Negative findings only. The return value never authorizes cleanup.
pub fn inspect(input: Inspection<'_>) -> Vec<Blocker> {
    let mut inspector = Inspector {
        client: input.client,
        blockers: Vec::new(),
        label: "scope".into(),
        roots: Vec::new(),
        router: String::new(),
        entries: 0,
    };
    if input.coverage == Coverage::Unknown
        || input.documents.is_empty()
        || input.documents.len() > MAX_DOCUMENTS
    {
        inspector.block(BlockerKind::UnknownScopes, "$");
    }
    for root in input.removal_roots.iter().take(32) {
        match path_key(root) {
            Some(key) if root.parent().is_some() && !key.is_empty() => inspector.roots.push(key),
            _ => inspector.block(BlockerKind::InvalidRemovalRoots, "$"),
        }
    }
    if input.removal_roots.is_empty() || input.removal_roots.len() > 32 {
        inspector.block(BlockerKind::InvalidRemovalRoots, "$");
    }
    if let Some(router) = path_key(input.verified_router) {
        if removed(&router, &inspector.roots) {
            inspector.block(BlockerKind::RetainedRouterRemoved, "$");
        }
        inspector.router = router;
    } else {
        inspector.block(BlockerKind::InvalidRouterPath, "$");
    }
    for (index, document) in input.documents.iter().take(MAX_DOCUMENTS).enumerate() {
        inspector.label =
            if document.label.len() <= 512 && !document.label.chars().any(char::is_control) {
                document.label.into()
            } else {
                format!("document#{index}")
            };
        if !format_matches(input.client, document.format) {
            inspector.block(BlockerKind::InvalidDocument, "$");
            continue;
        }
        let parsed;
        let value = match &document.content {
            DocumentContent::Absent => continue,
            DocumentContent::Parsed(value) if value.format == document.format => *value,
            DocumentContent::Bytes(bytes) => match parse_document(document.format, bytes) {
                Ok(value) => {
                    parsed = value;
                    &parsed
                }
                Err(_) => {
                    inspector.block(BlockerKind::InvalidDocument, "$");
                    continue;
                }
            },
            _ => {
                inspector.block(BlockerKind::InvalidDocument, "$");
                continue;
            }
        };
        match &value.document {
            Parsed::Json(value) => inspector.json(value, input.client),
            Parsed::Toml(value) => inspector.toml(value),
        }
    }
    inspector.blockers.sort();
    inspector.blockers.dedup();
    inspector.blockers
}

#[cfg(test)]
#[path = "legacy-dependencies.test.rs"]
mod tests;
