//! Read-only native inventory for the standalone-removal dependency gate.
//!
//! Integration: declare this module, promote toml_edit = "=0.20.2" to a
//! production dependency, then call snapshot(removal_roots, signed_router_command).
//! Inspect its report and invoke its recheck in the native removal preflight.
//! inspect()/Inventory::check() and check() are also available for diagnostics.
//! No Tauri command or Deserialize input is exposed. Targets MUST be derived
//! independently by native installation provenance and signed-router checks,
//! never from a frontend path, saved review, detection flag, or migration count.
//!
//! Paths follow modules/mcp/launcher/src-tauri/src/{main,claude_desktop}.rs and
//! modules/mcp/scripts/cli/setup-lib.mjs. Both native and Unix CLI paths are read
//! (they differ). OpenCode's JSON sibling and documented global/custom/inline
//! sources are included: https://opencode.ai/docs/config/ . CODEX_HOME follows
//! modules/mcp/scripts/smoke-creator-hub-info.mjs. No directory recursion, client
//! execution, network, dedicated credential/transcript reads, config writes,
//! or backups. Allowed config files may contain secrets; their bytes stay private.
//!
//! Ordinary-file absence is NOT effective-scope completeness. Project/profile,
//! plugin/managed/remote sources and other processes' launch environments remain
//! unresolved. In particular, CLAUDE_CONFIG_DIR and OPENCODE_CONFIG_DIR do not
//! establish a complete effective config in this source; do not guess a filename.
//! This bounded inventory therefore keeps removal refused even if every ordinary
//! file is absent or routed. An empty dependency list never authorizes removal.
//! Rechecking is a freshness guard, not an atomic uninstall transaction or proof
//! against ancestor replacement, hard-link aliases, or concurrent client launch.

#[allow(dead_code)]
#[path = "../../native/legacy-dependencies.rs"]
mod dependencies;

pub use dependencies::{Blocker, Client};
#[cfg(test)]
use dependencies::BlockerKind;
use dependencies::{ConfigDocument, ConfigFormat, Coverage, DocumentContent, Inspection};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs::{self, OpenOptions},
    io::{self, Read},
    path::{Component, Path, PathBuf},
};

const CLIENTS: [Client; 5] = [
    Client::Codex,
    Client::ClaudeCode,
    Client::ClaudeDesktop,
    Client::Antigravity,
    Client::OpenCode,
];
const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 16 * 1024 * 1024;
const MAX_SCOPES: usize = 24;
// Query only these names, never enumerate environment variables or credentials.
const ENV: [&str; 15] = [
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "XDG_CONFIG_HOME",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_CONFIG_CONTENT",
    "CREATOR_WORKS_LAUNCHER_CONFIG",
    "BANTWORKS_LAUNCHER_CONFIG",
    "NODE_OPTIONS",
    "NODE_PATH",
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Os {
    Windows,
    Mac,
    Linux,
    Unsupported,
}

// Private, non-serializable native context. Tests supply disposable contexts,
// not environment mutations or the user's configuration directories.
#[derive(Clone, PartialEq, Eq)]
struct Context {
    os: Os,
    home: Option<PathBuf>,
    config: Option<PathBuf>,
    env: BTreeMap<&'static str, OsString>,
}

impl Context {
    fn current() -> Self {
        let env: BTreeMap<_, _> = ENV
            .into_iter()
            .filter_map(|name| std::env::var_os(name).map(|value| (name, value)))
            .collect();
        Self {
            os: if cfg!(windows) {
                Os::Windows
            } else if cfg!(target_os = "macos") {
                Os::Mac
            } else if cfg!(target_os = "linux") {
                Os::Linux
            } else {
                Os::Unsupported
            },
            home: dirs::home_dir(),
            config: dirs::config_dir(),
            env,
        }
    }

    fn env_path(&self, key: &str) -> Result<Option<PathBuf>, IssueKind> {
        self.env
            .get(key)
            .map(|value| {
                let path = PathBuf::from(value);
                checked_key(&path).map(|_| path)
            })
            .transpose()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IssueKind {
    UnsupportedPlatform,
    MissingNativeRoot,
    UnknownProjectScopes,
    UnknownProfileScopes,
    UnknownManagedScopes,
    UnknownPluginScopes,
    UnknownLaunchEnvironment,
    UnknownAlternateContext,
    InvalidPath,
    ForbiddenScope,
    LinkedPath,
    Unreadable,
    NonRegularFile,
    Oversized,
    InventoryLimit,
    InvalidDocument,
    ChangedSinceInspection,
    InvalidRemovalTargets,
    RemovedConfiguration,
    UnresolvedEnvironment,
    RemovedEnvironmentDependency,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub client: Option<Client>,
    // Static metadata only: no paths, names, env values, or parse/OS errors.
    pub scope: &'static str,
    pub kind: IssueKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ScopeState {
    Present,
    Absent,
    Refused,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeSummary {
    pub client: Client,
    pub scope: &'static str,
    pub state: ScopeState,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryReport {
    pub scopes: Vec<ScopeSummary>,
    pub unresolved: Vec<Issue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckReport {
    pub inventory: InventoryReport,
    pub blockers: Vec<Blocker>,
    /// Negative gate only. False would still not authorize uninstall/retention.
    pub requires_retention: bool,
}

/// Native-only borrowed inputs; this type intentionally cannot be deserialized.
/// This module checks path shape, filesystem type, links, overlap and retention
/// boundaries, NOT installer provenance or the router's signature/hash identity.
#[derive(Clone, Copy)]
pub struct NativeRemovalTargets<'a> {
    pub removal_roots: &'a [PathBuf],
    pub verified_router: &'a Path,
}

#[derive(PartialEq, Eq)]
enum Image {
    Absent,
    Bytes(Vec<u8>),
    Refused(IssueKind),
}

struct Scope {
    client: Client,
    label: &'static str,
    format: ConfigFormat,
    path: Option<PathBuf>,
    image: Image,
}

/// Opaque snapshot; never Debug/Serialize because config bytes may hold secrets.
pub struct Inventory {
    context: Context,
    scopes: Vec<Scope>,
    issues: Vec<Issue>,
    bytes: usize,
}

/// Opaque, immutable native dependency plan, bound to the original native roots
/// and signed Router.command. No config bytes or target paths are serialized.
pub struct DependencySnapshot {
    inventory: Inventory,
    removal_roots: Vec<PathBuf>,
    router: PathBuf,
    report: CheckReport,
}

/// Capture a native removal plan's dependencies. This never approves removal.
/// Use the independently inspected Plan.root() values and verified Router.command.
pub fn snapshot(removal_roots: &[PathBuf], verified_router: &Path) -> DependencySnapshot {
    DependencySnapshot::capture(
        inspect(),
        NativeRemovalTargets {
            removal_roots,
            verified_router,
        },
        &Context::current(),
    )
}

impl DependencySnapshot {
    fn capture(inventory: Inventory, targets: NativeRemovalTargets<'_>, current: &Context) -> Self {
        let report = inventory.check_context(targets, current);
        Self {
            inventory,
            // Retain an invalid over-limit sentinel, not an unbounded copy.
            removal_roots: targets.removal_roots.iter().take(33).cloned().collect(),
            router: targets.verified_router.to_owned(),
            report,
        }
    }

    pub fn report(&self) -> &CheckReport {
        &self.report
    }

    /// Final negative gate for remove_after_native_review's preflight callback.
    /// Rechecks exact captured bytes AND every captured absent ordinary document,
    /// as well as the native env/root context. Never Ok with Unknown coverage,
    /// blockers, unreadable files, new/changed/deleted configs or changed context.
    /// Other unresolved sources cannot be enumerated; they remain refusal reasons.
    /// The parent must separately recheck signed router identity and native Plans.
    pub fn recheck(&self) -> Result<(), CheckReport> {
        self.recheck_context(&Context::current())
    }

    fn recheck_context(&self, current: &Context) -> Result<(), CheckReport> {
        let report = self.inventory.check_context(
            NativeRemovalTargets {
                removal_roots: &self.removal_roots,
                verified_router: &self.router,
            },
            current,
        );
        if report.requires_retention {
            Err(report)
        } else {
            Ok(())
        }
    }
}

/// Read finite source-established ordinary config scopes in the native process.
/// Does not inspect work-account configs, transcripts, auth files or credentials.
pub fn inspect() -> Inventory {
    Inventory::inspect_context(Context::current())
}

/// Fresh native negative check; does not reuse a persisted or frontend inventory.
pub fn check(targets: NativeRemovalTargets<'_>) -> CheckReport {
    inspect().check(targets)
}

impl Inventory {
    fn issue(&mut self, client: Option<Client>, scope: &'static str, kind: IssueKind) {
        self.issues.push(Issue {
            client,
            scope,
            kind,
        });
    }

    fn file(&mut self, client: Client, label: &'static str, format: ConfigFormat, path: PathBuf) {
        if self.scopes.iter().any(|scope| {
            scope.client == client && scope.path.as_ref().is_some_and(|known| same(known, &path))
        }) {
            return;
        }
        self.add(
            client,
            label,
            format,
            Some(path.clone()),
            read_config(&path),
        );
    }

    fn add(
        &mut self,
        client: Client,
        label: &'static str,
        format: ConfigFormat,
        path: Option<PathBuf>,
        mut image: Image,
    ) {
        if self.scopes.len() >= MAX_SCOPES {
            self.issue(Some(client), label, IssueKind::InventoryLimit);
            return;
        }
        if let Image::Bytes(bytes) = &image {
            if bytes.len() > MAX_BYTES || self.bytes + bytes.len() > MAX_TOTAL_BYTES {
                image = Image::Refused(IssueKind::InventoryLimit);
            } else {
                self.bytes += bytes.len();
                if dependencies::parse_document(format, bytes).is_err() {
                    self.issue(Some(client), label, IssueKind::InvalidDocument);
                }
            }
        }
        if let Image::Refused(kind) = image {
            self.issue(Some(client), label, kind);
        }
        self.scopes.push(Scope {
            client,
            label,
            format,
            path,
            image,
        });
    }

    fn pair(&mut self, root: &Path, json_label: &'static str, jsonc_label: &'static str) {
        self.file(
            Client::OpenCode,
            json_label,
            ConfigFormat::OpenCodeJson,
            root.join("opencode.json"),
        );
        self.file(
            Client::OpenCode,
            jsonc_label,
            ConfigFormat::OpenCodeJsonc,
            root.join("opencode.jsonc"),
        );
    }

    fn inspect_context(context: Context) -> Self {
        let mut result = Self {
            context: context.clone(),
            scopes: vec![],
            issues: vec![],
            bytes: 0,
        };
        if context.os == Os::Unsupported {
            result.issue(None, "operating-system", IssueKind::UnsupportedPlatform);
            return result;
        }
        // No positive coverage assertion: absence in our process says nothing
        // about a client launched from another shell, project, profile or policy.
        for client in CLIENTS {
            result.issue(
                Some(client),
                "client-launch-environment",
                IssueKind::UnknownLaunchEnvironment,
            );
            result.issue(
                Some(client),
                "managed-or-remote-sources",
                IssueKind::UnknownManagedScopes,
            );
        }
        for client in [
            Client::Codex,
            Client::ClaudeCode,
            Client::Antigravity,
            Client::OpenCode,
        ] {
            result.issue(
                Some(client),
                "project-sources",
                IssueKind::UnknownProjectScopes,
            );
            result.issue(
                Some(client),
                "plugin-sources",
                IssueKind::UnknownPluginScopes,
            );
        }
        result.issue(
            Some(Client::Codex),
            "selected-profiles",
            IssueKind::UnknownProfileScopes,
        );
        if let Some(home) = &context.home {
            result.file(
                Client::Codex,
                "native-user",
                ConfigFormat::CodexToml,
                home.join(".codex/config.toml"),
            );
            result.file(
                Client::ClaudeCode,
                "native-user-and-local-projects",
                ConfigFormat::McpJson,
                home.join(".claude.json"),
            );
            result.file(
                Client::Antigravity,
                "native-and-cli-user",
                ConfigFormat::McpJson,
                home.join(".gemini/config/mcp_config.json"),
            );
            // OpenCode documents this global location; also inspect the location
            // that Creator's native setup actually wrote on Windows/macOS.
            result.pair(
                &home.join(".config/opencode"),
                "documented-user/opencode.json",
                "documented-user/opencode.jsonc",
            );
        } else {
            result.issue(None, "native-home", IssueKind::MissingNativeRoot);
        }
        if let Some(config) = &context.config {
            result.pair(
                &config.join("opencode"),
                "native-user/opencode.json",
                "native-user/opencode.jsonc",
            );
            if context.os != Os::Linux {
                result.file(
                    Client::ClaudeDesktop,
                    "native-user",
                    ConfigFormat::McpJson,
                    config.join("Claude/claude_desktop_config.json"),
                );
            }
        } else {
            result.issue(None, "native-config-root", IssueKind::MissingNativeRoot);
        }
        if context.os == Os::Linux {
            result.issue(
                Some(Client::ClaudeDesktop),
                "native-user",
                IssueKind::UnsupportedPlatform,
            );
        }
        let cli_config = if context.os == Os::Windows {
            context.env_path("APPDATA").map(|path| {
                path.or_else(|| {
                    context
                        .home
                        .as_ref()
                        .map(|home| home.join("AppData/Roaming"))
                })
            })
        } else {
            context
                .env_path("XDG_CONFIG_HOME")
                .map(|path| path.or_else(|| context.home.as_ref().map(|home| home.join(".config"))))
        };
        match cli_config {
            Ok(Some(root)) => {
                result.pair(
                    &root.join("opencode"),
                    "cli-user/opencode.json",
                    "cli-user/opencode.jsonc",
                );
                if context.os != Os::Windows {
                    result.file(
                        Client::Codex,
                        "cli-xdg-user",
                        ConfigFormat::CodexToml,
                        root.join("codex/config.toml"),
                    );
                }
            }
            Ok(None) => result.issue(None, "cli-config-root", IssueKind::MissingNativeRoot),
            Err(kind) => result.issue(None, "cli-config-root", kind),
        }
        // Windows setup-lib also accepts USERPROFILE separately from os.homedir.
        if context.os == Os::Windows {
            match context.env_path("USERPROFILE") {
                Ok(Some(home)) => {
                    result.file(
                        Client::Codex,
                        "cli-userprofile",
                        ConfigFormat::CodexToml,
                        home.join(".codex/config.toml"),
                    );
                    result.file(
                        Client::ClaudeCode,
                        "cli-userprofile",
                        ConfigFormat::McpJson,
                        home.join(".claude.json"),
                    );
                    result.file(
                        Client::Antigravity,
                        "cli-userprofile",
                        ConfigFormat::McpJson,
                        home.join(".gemini/config/mcp_config.json"),
                    );
                }
                Err(kind) => result.issue(None, "cli-userprofile", kind),
                _ => {}
            }
        }
        match context.env_path("CODEX_HOME") {
            Ok(Some(root)) => result.file(
                Client::Codex,
                "process-CODEX_HOME",
                ConfigFormat::CodexToml,
                root.join("config.toml"),
            ),
            Err(kind) => result.issue(Some(Client::Codex), "process-CODEX_HOME", kind),
            _ => {}
        }
        match context.env_path("OPENCODE_CONFIG") {
            Ok(Some(path)) => {
                let format = match path.extension().and_then(|ext| ext.to_str()) {
                    Some("json") => Some(ConfigFormat::OpenCodeJson),
                    Some("jsonc") => Some(ConfigFormat::OpenCodeJsonc),
                    _ => None,
                };
                if let Some(format) = format {
                    result.file(Client::OpenCode, "process-OPENCODE_CONFIG", format, path);
                } else {
                    result.issue(
                        Some(Client::OpenCode),
                        "process-OPENCODE_CONFIG",
                        IssueKind::UnknownAlternateContext,
                    );
                }
            }
            Err(kind) => result.issue(Some(Client::OpenCode), "process-OPENCODE_CONFIG", kind),
            _ => {}
        }
        if let Some(value) = context.env.get("OPENCODE_CONFIG_CONTENT") {
            let image = match value.to_str() {
                Some(text) if text.len() <= MAX_BYTES => Image::Bytes(text.as_bytes().to_vec()),
                Some(_) => Image::Refused(IssueKind::Oversized),
                None => Image::Refused(IssueKind::InvalidDocument),
            };
            result.add(
                Client::OpenCode,
                "process-OPENCODE_CONFIG_CONTENT",
                ConfigFormat::OpenCodeJsonc,
                None,
                image,
            );
        }
        for (key, client) in [
            ("CLAUDE_CONFIG_DIR", Client::ClaudeCode),
            ("OPENCODE_CONFIG_DIR", Client::OpenCode),
        ] {
            if context.env.contains_key(key) {
                let kind = context
                    .env_path(key)
                    .err()
                    .unwrap_or(IssueKind::UnknownAlternateContext);
                result.issue(Some(client), key, kind);
            }
        }
        result
    }

    pub fn report(&self) -> InventoryReport {
        let mut unresolved = self.issues.clone();
        unresolved.sort();
        unresolved.dedup();
        InventoryReport {
            scopes: self
                .scopes
                .iter()
                .map(|scope| ScopeSummary {
                    client: scope.client,
                    scope: scope.label,
                    state: match scope.image {
                        Image::Absent => ScopeState::Absent,
                        Image::Bytes(_) => ScopeState::Present,
                        Image::Refused(_) => ScopeState::Refused,
                    },
                })
                .collect(),
            unresolved,
        }
    }

    /// Rechecks native context and exact config bytes, then feeds the pure guard.
    /// Parent must still retain stores/resources and verify running-client and
    /// uninstaller provenance/approval immediately before any removal.
    pub fn check(&self, targets: NativeRemovalTargets<'_>) -> CheckReport {
        self.check_context(targets, &Context::current())
    }

    fn check_context(&self, targets: NativeRemovalTargets<'_>, current: &Context) -> CheckReport {
        let mut report = self.report();
        let mut add_issue = |client, scope, kind| {
            report.unresolved.push(Issue {
                client,
                scope,
                kind,
            })
        };
        if &self.context != current {
            add_issue(None, "native-context", IssueKind::ChangedSinceInspection);
        }
        for scope in &self.scopes {
            if let Some(path) = &scope.path {
                if read_config(path) != scope.image {
                    add_issue(
                        Some(scope.client),
                        scope.label,
                        IssueKind::ChangedSinceInspection,
                    );
                }
            }
        }
        let valid_targets = self.valid_targets(&targets);
        if !valid_targets {
            add_issue(
                None,
                "native-removal-targets",
                IssueKind::InvalidRemovalTargets,
            );
        }
        let mut blockers = vec![];
        if valid_targets {
            for scope in &self.scopes {
                if scope
                    .path
                    .as_ref()
                    .is_some_and(|path| under_any(path, targets.removal_roots))
                {
                    add_issue(
                        Some(scope.client),
                        scope.label,
                        IssueKind::RemovedConfiguration,
                    );
                }
            }
            for key in ["CREATOR_WORKS_LAUNCHER_CONFIG", "BANTWORKS_LAUNCHER_CONFIG"] {
                match self.context.env_path(key) {
                    Ok(Some(path)) if under_any(&path, targets.removal_roots) => {
                        add_issue(None, key, IssueKind::RemovedEnvironmentDependency)
                    }
                    Err(_) => add_issue(None, key, IssueKind::UnresolvedEnvironment),
                    _ => {}
                }
            }
            for key in ["NODE_OPTIONS", "NODE_PATH"] {
                if self.context.env.contains_key(key) {
                    add_issue(None, key, IssueKind::UnresolvedEnvironment);
                }
            }
            for client in CLIENTS {
                let documents: Vec<_> = self
                    .scopes
                    .iter()
                    .filter(|scope| scope.client == client)
                    .filter_map(|scope| {
                        let content = match &scope.image {
                            Image::Absent => DocumentContent::Absent,
                            Image::Bytes(bytes) => DocumentContent::Bytes(bytes),
                            Image::Refused(_) => return None,
                        };
                        Some(ConfigDocument {
                            label: scope.label,
                            format: scope.format,
                            content,
                        })
                    })
                    .collect();
                blockers.extend(dependencies::inspect(Inspection {
                    client,
                    coverage: Coverage::Unknown,
                    documents: &documents,
                    removal_roots: targets.removal_roots,
                    verified_router: targets.verified_router,
                }));
            }
        }
        report.unresolved.sort();
        report.unresolved.dedup();
        blockers.sort();
        blockers.dedup();
        let requires_retention = !report.unresolved.is_empty() || !blockers.is_empty();
        CheckReport {
            inventory: report,
            blockers,
            requires_retention,
        }
    }

    fn valid_targets(&self, targets: &NativeRemovalTargets<'_>) -> bool {
        let roots = targets.removal_roots;
        if roots.is_empty() || roots.len() > 32 || checked_key(targets.verified_router).is_err() {
            return false;
        }
        if no_links(targets.verified_router).is_err()
            || !fs::symlink_metadata(targets.verified_router).is_ok_and(|meta| meta.is_file())
            || under_any(targets.verified_router, roots)
        {
            return false;
        }
        for (index, root) in roots.iter().enumerate() {
            if checked_key(root).is_err()
                || root.parent().is_none()
                || no_links(root).is_err()
                || !fs::symlink_metadata(root).is_ok_and(|meta| meta.is_dir())
                || roots[..index]
                    .iter()
                    .any(|other| within(root, other) || within(other, root))
                || [self.context.home.as_ref(), self.context.config.as_ref()]
                    .into_iter()
                    .flatten()
                    .any(|retained| within(retained, root))
            {
                return false;
            }
        }
        true
    }
}

fn forbidden(path: &Path) -> bool {
    path.components().any(|part| {
        part.as_os_str().to_str().is_some_and(|text| {
            text.eq_ignore_ascii_case(".codex-work")
                || [
                    "auth.json",
                    ".credentials.json",
                    "credentials.json",
                    "credentials",
                    "mcp_oauth_tokens.json",
                ]
                .iter()
                .any(|name| text.eq_ignore_ascii_case(name))
        })
    })
}

fn checked_key(path: &Path) -> Result<String, IssueKind> {
    let text = path.to_str().ok_or(IssueKind::InvalidPath)?;
    if forbidden(path) {
        return Err(IssueKind::ForbiddenScope);
    }
    if !path.is_absolute()
        || text.len() > 8192
        || text.starts_with("\\\\")
        || text.starts_with("//")
        || text.chars().any(char::is_control)
        || ["${", "{env:", "{file:", "%"]
            .iter()
            .any(|marker| text.contains(marker))
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(IssueKind::InvalidPath);
    }
    #[cfg(windows)]
    if path.components().any(|part| match part {
        Component::Normal(name) => name
            .to_str()
            .is_none_or(|name| name.contains(':') || name.ends_with(['.', ' '])),
        Component::Prefix(prefix) => !matches!(prefix.kind(), std::path::Prefix::Disk(_)),
        _ => false,
    }) {
        return Err(IssueKind::InvalidPath);
    }
    let normalized: PathBuf = path.components().collect();
    let text = normalized.to_str().ok_or(IssueKind::InvalidPath)?;
    Ok(if cfg!(windows) {
        text.replace('\\', "/")
            .trim_end_matches('/')
            .to_ascii_lowercase()
    } else {
        text.trim_end_matches('/').to_owned()
    })
}

fn same(a: &Path, b: &Path) -> bool {
    matches!((checked_key(a), checked_key(b)), (Ok(a), Ok(b)) if a == b)
}

fn within(path: &Path, root: &Path) -> bool {
    matches!((checked_key(path), checked_key(root)), (Ok(path), Ok(root)) if path == root || path.starts_with(&format!("{root}/")))
}

fn under_any(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| within(path, root))
}

fn no_links(path: &Path) -> Result<(), IssueKind> {
    checked_key(path)?;
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) => {
                #[allow(unused_mut)]
                let mut linked = meta.file_type().is_symlink();
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    linked |= meta.file_attributes() & 0x400 != 0;
                }
                if linked {
                    return Err(IssueKind::LinkedPath);
                }
                if ancestor != path && !meta.is_dir() {
                    return Err(IssueKind::NonRegularFile);
                }
                // Resolve existing aliases only for exclusion checks, not for
                // dependency matching or following unknown configuration files.
                let resolved = ancestor.canonicalize().map_err(|_| IssueKind::Unreadable)?;
                if forbidden(&resolved) {
                    return Err(IssueKind::ForbiddenScope);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err(IssueKind::Unreadable),
        }
    }
    Ok(())
}

fn read_config(path: &Path) -> Image {
    let read = || -> Result<Image, IssueKind> {
        no_links(path)?;
        match fs::symlink_metadata(path) {
            Ok(meta) if !meta.is_file() => return Err(IssueKind::NonRegularFile),
            Ok(meta) if meta.len() > MAX_BYTES as u64 => return Err(IssueKind::Oversized),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Image::Absent),
            Err(_) => return Err(IssueKind::Unreadable),
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // Share read only; open the reparse point itself, never its target.
            options.share_mode(1).custom_flags(0x0020_0000);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
        }
        let mut file = options.open(path).map_err(|_| IssueKind::Unreadable)?;
        no_links(path)?;
        let meta = file.metadata().map_err(|_| IssueKind::Unreadable)?;
        if !meta.is_file() {
            return Err(IssueKind::NonRegularFile);
        }
        if meta.len() > MAX_BYTES as u64 {
            return Err(IssueKind::Oversized);
        }
        let mut bytes = Vec::new();
        file.by_ref()
            .take(MAX_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| IssueKind::Unreadable)?;
        if bytes.len() > MAX_BYTES {
            return Err(IssueKind::Oversized);
        }
        let after = file.metadata().map_err(|_| IssueKind::Unreadable)?;
        if after.len() != bytes.len() as u64
            || meta.len() != after.len()
            || meta.modified().ok() != after.modified().ok()
        {
            return Err(IssueKind::ChangedSinceInspection);
        }
        no_links(path)?;
        Ok(Image::Bytes(bytes))
    };
    read().unwrap_or_else(Image::Refused)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Fixture {
        _temp: tempfile::TempDir,
        context: Context,
        old: PathBuf,
        router: PathBuf,
    }

    impl Fixture {
        fn new(os: Os) -> Self {
            let temp = tempfile::tempdir().unwrap();
            let base = temp.path().to_path_buf();
            #[cfg(unix)]
            let base = base.canonicalize().unwrap();
            let home = base.join("home");
            let config = base.join("config");
            let old = base.join("old-install");
            let router = base.join("retained/creator-hub-mcp-router");
            for directory in [&home, &config, &old, router.parent().unwrap()] {
                fs::create_dir_all(directory).unwrap();
            }
            fs::write(&router, b"native-verified-fixture").unwrap();
            Self {
                context: Context {
                    os,
                    home: Some(home),
                    config: Some(config),
                    env: BTreeMap::new(),
                },
                old,
                router,
                _temp: temp,
            }
        }

        fn home(&self, suffix: &str) -> PathBuf {
            self.context.home.as_ref().unwrap().join(suffix)
        }

        fn config(&self, suffix: &str) -> PathBuf {
            self.context.config.as_ref().unwrap().join(suffix)
        }

        fn write(&self, path: &Path, text: impl AsRef<[u8]>) {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }

        fn inventory(&self) -> Inventory {
            Inventory::inspect_context(self.context.clone())
        }

        fn check(&self, inventory: &Inventory) -> CheckReport {
            inventory.check_context(
                NativeRemovalTargets {
                    removal_roots: std::slice::from_ref(&self.old),
                    verified_router: &self.router,
                },
                &self.context,
            )
        }

        fn old_json(&self) -> String {
            json!({"mcpServers":{"private-renamed-server":{"command":self.old.join("node"),"args":[self.old.join("server.mjs")]}}}).to_string()
        }

        fn old_opencode(&self) -> String {
            json!({"mcp":{"private-renamed-server":{"type":"local","command":[self.old.join("node"),self.old.join("server.mjs")]}}}).to_string()
        }

        fn old_toml(&self) -> String {
            format!(
                "[mcp_servers.private-renamed-server]\ncommand='{}'\nargs=['{}']\n",
                self.old.join("node").display(),
                self.old.join("server.mjs").display()
            )
        }
    }

    fn issue(report: &CheckReport, kind: IssueKind) -> bool {
        report
            .inventory
            .unresolved
            .iter()
            .any(|issue| issue.kind == kind)
    }

    fn blocked(report: &CheckReport, client: Client, kind: BlockerKind) -> bool {
        report
            .blockers
            .iter()
            .any(|blocker| blocker.client == client && blocker.kind == kind)
    }

    #[test]
    fn empty_ordinary_scopes_never_mean_effective_dependencies_absent() {
        for os in [Os::Windows, Os::Mac, Os::Linux] {
            let f = Fixture::new(os);
            let report = f.check(&f.inventory());
            assert!(report.requires_retention);
            assert!(report
                .inventory
                .scopes
                .iter()
                .all(|scope| scope.state == ScopeState::Absent));
            for client in CLIENTS {
                assert!(blocked(&report, client, BlockerKind::UnknownScopes));
            }
            assert!(issue(&report, IssueKind::UnknownProjectScopes));
            assert!(issue(&report, IssueKind::UnknownLaunchEnvironment));
        }
    }

    #[test]
    fn renamed_routes_are_found_in_all_native_clients() {
        let f = Fixture::new(Os::Windows);
        for (path, text) in [
            (f.home(".codex/config.toml"), f.old_toml()),
            (f.home(".claude.json"), f.old_json()),
            (f.home(".gemini/config/mcp_config.json"), f.old_json()),
            (f.config("Claude/claude_desktop_config.json"), f.old_json()),
            (
                f.config("opencode/opencode.jsonc"),
                format!("// retained comment\n{}", f.old_opencode()),
            ),
        ] {
            f.write(&path, text);
        }
        let report = f.check(&f.inventory());
        for client in CLIENTS {
            assert!(
                blocked(&report, client, BlockerKind::InstalledCommand),
                "{client:?}"
            );
        }
        let serialized = serde_json::to_string(&report).unwrap();
        assert!(!serialized.contains("private-renamed-server"));
        assert!(!serialized.contains(&f.old.to_string_lossy().to_string()));
    }

    #[test]
    fn claude_nested_local_projects_are_checked_without_reading_project_paths() {
        let f = Fixture::new(Os::Windows);
        let nested = json!({"projects":{"secret-project-path":{"mcpServers":{"renamed":{"command":f.old.join("node"),"args":[]}}}}}).to_string();
        f.write(&f.home(".claude.json"), nested);
        let report = f.check(&f.inventory());
        assert!(report
            .blockers
            .iter()
            .any(|blocker| blocker.kind == BlockerKind::InstalledCommand
                && blocker.location.starts_with("projects[scope#0]")));
        assert!(!serde_json::to_string(&report)
            .unwrap()
            .contains("secret-project-path"));
        assert!(issue(&report, IssueKind::UnknownProjectScopes));
    }

    #[test]
    fn json_sibling_is_inspected_even_when_jsonc_is_already_routed() {
        let f = Fixture::new(Os::Windows);
        f.write(&f.config("opencode/opencode.json"), f.old_opencode());
        f.write(
            &f.config("opencode/opencode.jsonc"),
            json!({"mcp":{"creator-works":{"type":"local","command":[f.router]}}}).to_string(),
        );
        let report = f.check(&f.inventory());
        assert!(blocked(
            &report,
            Client::OpenCode,
            BlockerKind::InstalledCommand
        ));
        assert!(report.requires_retention);
    }

    #[test]
    fn unix_cli_xdg_and_native_codex_paths_are_both_inspected() {
        for os in [Os::Mac, Os::Linux] {
            let mut f = Fixture::new(os);
            let xdg = f.home("custom-xdg");
            f.context
                .env
                .insert("XDG_CONFIG_HOME", xdg.clone().into_os_string());
            f.write(&f.home(".codex/config.toml"), "model='unrelated'");
            f.write(&xdg.join("codex/config.toml"), f.old_toml());
            f.write(&xdg.join("opencode/opencode.json"), f.old_opencode());
            let inventory = f.inventory();
            assert_eq!(
                inventory
                    .scopes
                    .iter()
                    .filter(|scope| scope.client == Client::Codex)
                    .count(),
                2
            );
            let report = f.check(&inventory);
            assert!(blocked(
                &report,
                Client::Codex,
                BlockerKind::InstalledCommand
            ));
            assert!(blocked(
                &report,
                Client::OpenCode,
                BlockerKind::InstalledCommand
            ));
        }
    }

    #[test]
    fn windows_cli_userprofile_and_appdata_contexts_are_not_lost() {
        let mut f = Fixture::new(Os::Windows);
        let other_home = f.home("alternate-home");
        let other_config = f.home("alternate-roaming");
        f.context
            .env
            .insert("USERPROFILE", other_home.clone().into_os_string());
        f.context
            .env
            .insert("APPDATA", other_config.clone().into_os_string());
        f.write(&other_home.join(".claude.json"), f.old_json());
        f.write(
            &other_config.join("opencode/opencode.jsonc"),
            f.old_opencode(),
        );
        let report = f.check(&f.inventory());
        assert!(blocked(
            &report,
            Client::ClaudeCode,
            BlockerKind::InstalledCommand
        ));
        assert!(blocked(
            &report,
            Client::OpenCode,
            BlockerKind::InstalledCommand
        ));
    }

    #[test]
    fn codex_home_override_is_inspected_without_scanning_its_directory() {
        let mut f = Fixture::new(Os::Windows);
        let custom = f.home("custom-codex");
        f.context
            .env
            .insert("CODEX_HOME", custom.clone().into_os_string());
        f.write(&custom.join("config.toml"), f.old_toml());
        f.write(&custom.join("auth.json"), "credential-sentinel");
        let inventory = f.inventory();
        assert!(inventory.scopes.iter().all(|scope| scope
            .path
            .as_ref()
            .is_none_or(|path| path.file_name().unwrap() != "auth.json")));
        assert!(blocked(
            &f.check(&inventory),
            Client::Codex,
            BlockerKind::InstalledCommand
        ));
        assert_eq!(
            fs::read(custom.join("auth.json")).unwrap(),
            b"credential-sentinel"
        );
    }

    #[test]
    fn alternate_opencode_filename_and_inline_config_are_inspected() {
        for inline in [false, true] {
            let mut f = Fixture::new(Os::Windows);
            if inline {
                f.context
                    .env
                    .insert("OPENCODE_CONFIG_CONTENT", f.old_opencode().into());
            } else {
                let alternate = f.home("custom/renamed-client-config.jsonc");
                f.write(&alternate, format!("// alternate\n{}", f.old_opencode()));
                f.context
                    .env
                    .insert("OPENCODE_CONFIG", alternate.into_os_string());
            }
            assert!(blocked(
                &f.check(&f.inventory()),
                Client::OpenCode,
                BlockerKind::InstalledCommand
            ));
        }
    }

    #[test]
    fn unresolved_alternate_directories_and_unknown_extensions_refuse() {
        for key in [
            "CLAUDE_CONFIG_DIR",
            "OPENCODE_CONFIG_DIR",
            "OPENCODE_CONFIG",
        ] {
            let mut f = Fixture::new(Os::Windows);
            f.context
                .env
                .insert(key, f.home("alternate/no-known-extension").into_os_string());
            let report = f.check(&f.inventory());
            assert!(issue(&report, IssueKind::UnknownAlternateContext));
            assert!(report.requires_retention);
        }
    }

    #[test]
    fn work_account_and_credential_paths_are_refused_before_read() {
        for (key, suffix) in [
            ("CODEX_HOME", ".codex-work"),
            ("CODEX_HOME", "nested/.CODEX-WORK"),
            ("OPENCODE_CONFIG", ".codex-work/config.json"),
            ("OPENCODE_CONFIG", "auth.json"),
            ("OPENCODE_CONFIG", ".credentials.json"),
        ] {
            let mut f = Fixture::new(Os::Windows);
            f.context.env.insert(key, f.home(suffix).into_os_string());
            let inventory = f.inventory();
            assert!(inventory
                .issues
                .iter()
                .any(|issue| issue.kind == IssueKind::ForbiddenScope));
            assert!(inventory
                .scopes
                .iter()
                .filter(|scope| matches!(scope.image, Image::Bytes(_)))
                .all(|scope| scope
                    .path
                    .as_ref()
                    .is_none_or(|path| checked_key(path).is_ok())));
        }
    }

    #[test]
    fn relative_empty_and_expanding_environment_paths_are_not_absence() {
        for value in [
            OsString::new(),
            OsString::from("relative"),
            OsString::from("${HOME}/config"),
        ] {
            let mut f = Fixture::new(Os::Linux);
            f.context.env.insert("CODEX_HOME", value.clone());
            f.context.env.insert("XDG_CONFIG_HOME", value);
            let report = f.check(&f.inventory());
            assert!(issue(&report, IssueKind::InvalidPath));
            assert!(report.requires_retention);
        }
    }

    #[test]
    fn corrupt_duplicate_and_oversized_documents_refuse() {
        for bytes in [
            b"secret invalid config".to_vec(),
            b"{\"mcpServers\":{},\"mcpServers\":{}}".to_vec(),
            vec![b' '; MAX_BYTES + 1],
        ] {
            let f = Fixture::new(Os::Windows);
            f.write(&f.home(".claude.json"), bytes);
            let report = f.check(&f.inventory());
            assert!(
                issue(&report, IssueKind::InvalidDocument) || issue(&report, IssueKind::Oversized)
            );
            assert!(report.requires_retention);
            assert!(!serde_json::to_string(&report)
                .unwrap()
                .contains("secret invalid config"));
        }
    }

    #[test]
    fn directories_are_not_classified_as_absent_configs() {
        let f = Fixture::new(Os::Windows);
        fs::create_dir_all(f.home(".claude.json")).unwrap();
        let report = f.check(&f.inventory());
        assert!(issue(&report, IssueKind::NonRegularFile));
        assert!(report
            .inventory
            .scopes
            .iter()
            .any(|scope| scope.client == Client::ClaudeCode && scope.state == ScopeState::Refused));
    }

    #[test]
    fn file_ancestors_are_refused_instead_of_absent() {
        let f = Fixture::new(Os::Windows);
        f.write(&f.home(".codex"), "not-a-directory");
        let report = f.check(&f.inventory());
        assert!(issue(&report, IssueKind::NonRegularFile));
        assert!(report
            .inventory
            .scopes
            .iter()
            .any(|scope| scope.client == Client::Codex && scope.state == ScopeState::Refused));
    }

    #[test]
    fn present_excluded_files_never_enter_the_inventory() {
        for suffix in [
            ".codex-work/config.json",
            "nested/.CODEX-WORK/config.json",
            "auth.json",
            "credentials.json",
        ] {
            let mut f = Fixture::new(Os::Windows);
            let path = f.home(suffix);
            f.write(&path, "excluded-private-sentinel");
            f.context
                .env
                .insert("OPENCODE_CONFIG", path.clone().into_os_string());
            let inventory = f.inventory();
            assert!(inventory
                .issues
                .iter()
                .any(|issue| issue.kind == IssueKind::ForbiddenScope));
            assert!(inventory
                .scopes
                .iter()
                .all(|scope| scope.path.as_ref() != Some(&path)));
            assert!(!serde_json::to_string(&f.check(&inventory))
                .unwrap()
                .contains("excluded-private-sentinel"));
            assert_eq!(fs::read(&path).unwrap(), b"excluded-private-sentinel");
        }
    }

    #[test]
    fn routed_all_clients_still_refuse_unresolved_effective_contexts() {
        let f = Fixture::new(Os::Windows);
        let routed =
            json!({"mcpServers":{"creator-works":{"command":f.router,"args":[],"env":{}}}})
                .to_string();
        f.write(
            &f.home(".codex/config.toml"),
            format!(
                "[mcp_servers.creator-works]\ncommand='{}'\nargs=[]\n",
                f.router.display()
            ),
        );
        for path in [
            f.home(".claude.json"),
            f.home(".gemini/config/mcp_config.json"),
            f.config("Claude/claude_desktop_config.json"),
        ] {
            f.write(&path, &routed);
        }
        f.write(
            &f.config("opencode/opencode.jsonc"),
            json!({"mcp":{"creator-works":{"type":"local","command":[f.router]}}}).to_string(),
        );
        let report = f.check(&f.inventory());
        assert!(report
            .blockers
            .iter()
            .all(|blocker| blocker.kind == BlockerKind::UnknownScopes));
        assert!(report.requires_retention);
    }

    #[test]
    fn config_inside_removal_root_refuses_even_without_mcp_entries() {
        let mut f = Fixture::new(Os::Windows);
        let path = f.old.join("custom.json");
        f.write(&path, "{}");
        f.context
            .env
            .insert("OPENCODE_CONFIG", path.into_os_string());
        assert!(issue(
            &f.check(&f.inventory()),
            IssueKind::RemovedConfiguration
        ));
    }

    #[test]
    fn changed_new_and_deleted_configs_invalidate_snapshot() {
        for mode in [0, 1, 2] {
            let f = Fixture::new(Os::Windows);
            let path = f.home(".claude.json");
            if mode != 0 {
                f.write(&path, "{}");
            }
            let inventory = f.inventory();
            if mode == 2 {
                fs::remove_file(&path).unwrap();
            } else {
                f.write(&path, f.old_json());
            }
            assert!(issue(
                &f.check(&inventory),
                IssueKind::ChangedSinceInspection
            ));
            if mode != 2 {
                assert!(blocked(
                    &f.check(&f.inventory()),
                    Client::ClaudeCode,
                    BlockerKind::InstalledCommand
                ));
            }
        }
    }

    #[test]
    fn native_context_changes_invalidate_even_absent_snapshot() {
        let mut f = Fixture::new(Os::Windows);
        let inventory = f.inventory();
        f.context
            .env
            .insert("OPENCODE_CONFIG_CONTENT", f.old_opencode().into());
        assert!(issue(
            &f.check(&inventory),
            IssueKind::ChangedSinceInspection
        ));
    }

    #[test]
    fn bound_snapshot_recheck_refuses_unknown_coverage_without_freshness_changes() {
        let f = Fixture::new(Os::Windows);
        let snapshot = DependencySnapshot::capture(
            f.inventory(),
            NativeRemovalTargets {
                removal_roots: std::slice::from_ref(&f.old),
                verified_router: &f.router,
            },
            &f.context,
        );
        assert!(snapshot.report().requires_retention);
        let report = snapshot.recheck_context(&f.context).unwrap_err();
        assert!(!issue(&report, IssueKind::ChangedSinceInspection));
        assert!(blocked(&report, Client::Codex, BlockerKind::UnknownScopes));
    }

    #[test]
    fn bound_snapshot_recheck_catches_new_sibling_and_preserves_initial_report() {
        let f = Fixture::new(Os::Windows);
        f.write(&f.config("opencode/opencode.jsonc"), "{}");
        let snapshot = DependencySnapshot::capture(
            f.inventory(),
            NativeRemovalTargets {
                removal_roots: std::slice::from_ref(&f.old),
                verified_router: &f.router,
            },
            &f.context,
        );
        f.write(&f.config("opencode/opencode.json"), f.old_opencode());
        let report = snapshot.recheck_context(&f.context).unwrap_err();
        assert!(issue(&report, IssueKind::ChangedSinceInspection));
        assert!(!issue(snapshot.report(), IssueKind::ChangedSinceInspection));
        assert!(report
            .inventory
            .unresolved
            .iter()
            .any(|issue| issue.scope == "native-user/opencode.json"
                && issue.kind == IssueKind::ChangedSinceInspection));
    }

    #[test]
    fn bound_snapshot_recheck_catches_new_environment_document() {
        let mut f = Fixture::new(Os::Windows);
        let snapshot = DependencySnapshot::capture(
            f.inventory(),
            NativeRemovalTargets {
                removal_roots: std::slice::from_ref(&f.old),
                verified_router: &f.router,
            },
            &f.context,
        );
        f.context
            .env
            .insert("OPENCODE_CONFIG_CONTENT", f.old_opencode().into());
        assert!(issue(
            &snapshot.recheck_context(&f.context).unwrap_err(),
            IssueKind::ChangedSinceInspection
        ));
    }

    #[test]
    fn launcher_overrides_are_checked_behind_routed_nested_entry() {
        let f = Fixture::new(Os::Windows);
        let source = json!({"projects":{"private-project":{"mcpServers":{"renamed":{"command":f.router,"args":[],"env":{"BANTWORKS_LAUNCHER_CONFIG":f.old.join("launcher-config.json")}}}}}}).to_string();
        f.write(&f.home(".claude.json"), source);
        assert!(blocked(
            &f.check(&f.inventory()),
            Client::ClaudeCode,
            BlockerKind::LauncherConfigRemoved
        ));
    }

    #[test]
    fn inherited_current_process_launcher_and_node_overrides_refuse() {
        for key in [
            "CREATOR_WORKS_LAUNCHER_CONFIG",
            "BANTWORKS_LAUNCHER_CONFIG",
            "NODE_OPTIONS",
            "NODE_PATH",
        ] {
            let mut f = Fixture::new(Os::Windows);
            f.context
                .env
                .insert(key, f.old.join("private-setting.json").into_os_string());
            let report = f.check(&f.inventory());
            assert!(
                issue(&report, IssueKind::RemovedEnvironmentDependency)
                    || issue(&report, IssueKind::UnresolvedEnvironment)
            );
            assert!(!serde_json::to_string(&report)
                .unwrap()
                .contains("private-setting"));
        }
    }

    #[test]
    fn native_removal_roots_are_independent_of_configured_paths_and_invalid_roots_refuse() {
        let f = Fixture::new(Os::Windows);
        let inventory = f.inventory();
        for roots in [
            vec![],
            vec![PathBuf::from("relative")],
            vec![f.home("")],
            vec![f.old.clone(), f.old.clone()],
            vec![f.old.clone(), f.old.join("child")],
            vec![f.router.clone()],
            vec![f.home("missing-root")],
        ] {
            let report = inventory.check_context(
                NativeRemovalTargets {
                    removal_roots: &roots,
                    verified_router: &f.router,
                },
                &f.context,
            );
            assert!(issue(&report, IssueKind::InvalidRemovalTargets));
            assert!(report.requires_retention);
        }
    }

    #[test]
    fn missing_removed_and_non_file_router_paths_refuse() {
        let f = Fixture::new(Os::Windows);
        let removed_router = f.old.join("router");
        f.write(&removed_router, "fixture");
        let inventory = f.inventory();
        for router in [
            f.home("missing-router"),
            f.old.clone(),
            removed_router,
            PathBuf::from("relative"),
        ] {
            let report = inventory.check_context(
                NativeRemovalTargets {
                    removal_roots: std::slice::from_ref(&f.old),
                    verified_router: &router,
                },
                &f.context,
            );
            assert!(issue(&report, IssueKind::InvalidRemovalTargets));
        }
    }

    #[test]
    fn containment_respects_component_boundaries() {
        let f = Fixture::new(Os::Windows);
        assert!(within(&f.old.join("node"), &f.old));
        assert!(!within(
            &f.old.with_file_name("old-install-sibling/node"),
            &f.old
        ));
        assert!(checked_key(&f.old.join("../retained")).is_err());
    }

    #[test]
    fn canonical_and_cli_paths_are_deduplicated_not_server_names() {
        let mut f = Fixture::new(Os::Windows);
        f.context
            .env
            .insert("CODEX_HOME", f.home(".codex").into_os_string());
        f.context
            .env
            .insert("USERPROFILE", f.home("").into_os_string());
        f.context.env.insert(
            "APPDATA",
            f.context.config.clone().unwrap().into_os_string(),
        );
        let inventory = f.inventory();
        assert_eq!(
            inventory
                .scopes
                .iter()
                .filter(|scope| scope.client == Client::Codex)
                .count(),
            1
        );
        f.write(&f.home(".claude.json"), json!({"mcpServers":{"one":{"command":f.old.join("node"),"args":[]},"two":{"command":f.old.join("node"),"args":[]}}}).to_string());
        assert_eq!(
            f.check(&f.inventory())
                .blockers
                .iter()
                .filter(|blocker| blocker.client == Client::ClaudeCode
                    && blocker.kind == BlockerKind::InstalledCommand)
                .count(),
            2
        );
    }

    #[test]
    fn unknown_project_files_profiles_and_plugins_are_not_silently_cleared() {
        let f = Fixture::new(Os::Windows);
        for suffix in [
            "project/.mcp.json",
            "project/.agents/mcp_config.json",
            "project/.codex/config.toml",
            ".codex/renamed-profile.config.toml",
            "project/.opencode/opencode.json",
        ] {
            f.write(&f.home(suffix), f.old_json());
        }
        let report = f.check(&f.inventory());
        assert!(issue(&report, IssueKind::UnknownProjectScopes));
        assert!(issue(&report, IssueKind::UnknownProfileScopes));
        assert!(issue(&report, IssueKind::UnknownPluginScopes));
        assert!(report.requires_retention);
    }

    #[test]
    fn read_only_repeated_inspection_preserves_bytes_and_creates_no_backups() {
        let f = Fixture::new(Os::Windows);
        let path = f.home(".claude.json");
        let before = f.old_json();
        f.write(&path, &before);
        for _ in 0..2 {
            assert!(f.check(&f.inventory()).requires_retention);
            assert_eq!(fs::read(&path).unwrap(), before.as_bytes());
        }
        assert_eq!(fs::read_dir(f.home("")).unwrap().count(), 1);
        assert_eq!(fs::read_dir(f.config("")).unwrap().count(), 0);
    }

    #[test]
    fn unsupported_os_and_missing_native_roots_refuse() {
        let mut f = Fixture::new(Os::Unsupported);
        assert!(issue(
            &f.check(&f.inventory()),
            IssueKind::UnsupportedPlatform
        ));
        f.context.os = Os::Windows;
        f.context.home = None;
        f.context.config = None;
        assert!(issue(
            &f.check(&f.inventory()),
            IssueKind::MissingNativeRoot
        ));
    }

    #[test]
    fn inventory_count_and_total_byte_limits_are_explicit_refusals() {
        let f = Fixture::new(Os::Windows);
        let mut inventory = f.inventory();
        for _ in 0..MAX_SCOPES {
            inventory.add(
                Client::OpenCode,
                "bounded-inline",
                ConfigFormat::OpenCodeJson,
                None,
                Image::Bytes(vec![b' '; MAX_BYTES]),
            );
        }
        assert!(inventory.scopes.len() <= MAX_SCOPES);
        assert!(inventory.bytes <= MAX_TOTAL_BYTES);
        assert!(issue(&f.check(&inventory), IssueKind::InventoryLimit));
    }

    #[cfg(windows)]
    #[test]
    fn unreadable_reserved_config_is_not_absent() {
        use std::os::windows::fs::OpenOptionsExt;
        let f = Fixture::new(Os::Windows);
        let path = f.home(".claude.json");
        f.write(&path, "{}");
        let _reservation = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        let report = f.check(&f.inventory());
        assert!(issue(&report, IssueKind::Unreadable));
        assert!(report
            .inventory
            .scopes
            .iter()
            .any(|scope| scope.client == Client::ClaudeCode && scope.state == ScopeState::Refused));
    }

    #[cfg(windows)]
    #[test]
    fn windows_junction_ancestor_is_refused_even_with_missing_leaf() {
        let f = Fixture::new(Os::Windows);
        let link = f.home(".codex");
        let output = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&f.old)
            .output()
            .unwrap();
        assert!(output.status.success());
        let inventory = f.inventory();
        assert!(issue(&f.check(&inventory), IssueKind::LinkedPath));
        // Remove only this disposable junction, never the target directory.
        fs::remove_dir(&link).unwrap();
        assert!(f.old.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn unix_link_ancestor_and_fifo_are_refused_without_opening_targets() {
        let f = Fixture::new(Os::Linux);
        std::os::unix::fs::symlink(&f.old, f.home(".codex")).unwrap();
        assert!(issue(&f.check(&f.inventory()), IssueKind::LinkedPath));
        let fifo = f.home(".claude.json");
        let name = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(matches!(
            read_config(&fifo),
            Image::Refused(IssueKind::NonRegularFile)
        ));
    }
}
