//! Protect the existing shared launcher store; do not introduce a Hub settings copy.
use crate::{client_migration::recovery, settings_backup as storage};
#[cfg(any(unix, test))]
#[path = "../../../../../native/convergence-server-unix.rs"]
mod unix_server;
use serde::Serialize;
use sha2::{Digest, Sha256};
#[cfg(any(unix, test))]
use std::{cell::RefCell, collections::BTreeMap};
use std::{
    fs::{self, File},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

const MAX_CONFIG: usize = 256 * 1024;
static LOADED: Mutex<Option<Snapshot>> = Mutex::new(None);

#[derive(Clone)]
struct Paths {
    current: PathBuf,
    legacy: PathBuf,
    journal: PathBuf,
}
impl Paths {
    fn new(base: &Path) -> Result<Self, String> {
        if !base.is_absolute()
            || base.components().any(|part| part == Component::ParentDir)
            || base.to_string_lossy().starts_with("\\\\")
            || base.to_string_lossy().starts_with("//")
            || base.to_string_lossy().chars().any(char::is_control)
        {
            return Err("Product settings require an unambiguous local config directory.".into());
        }
        storage::reject_links(base)?;
        let current = base
            .join(crate::APP_CONFIG_DIR)
            .join("launcher-config.json");
        Ok(Self {
            journal: current
                .parent()
                .unwrap()
                .join(".creator-hub-product-settings"),
            current,
            legacy: base
                .join(crate::LEGACY_APP_CONFIG_DIR)
                .join("launcher-config.json"),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Snapshot {
    current: Option<Vec<u8>>,
    legacy: Option<Vec<u8>>,
}
fn config(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let Some(bytes) = storage::read_bytes(path)? else {
        return Ok(None);
    };
    validate_config(&bytes)?;
    Ok(Some(bytes))
}
fn validate_config(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_CONFIG {
        return Err("Product settings exceed the existing 256 KiB preview limit.".into());
    }
    let config: crate::LauncherConfig = serde_json::from_slice(bytes)
        .map_err(|_| "Invalid product settings; originals were left unchanged.")?;
    if config.channels.len() > 256 {
        return Err("Product settings exceed the existing 256-channel preview limit.".into());
    }
    crate::jsonc::parse_unambiguous(
        std::str::from_utf8(bytes)
            .map_err(|_| "Invalid product settings; originals were left unchanged.")?,
    )?;
    Ok(())
}
fn settings_equivalent(current: &[u8], legacy: &[u8]) -> Result<bool, String> {
    let parse = |bytes: &[u8]| {
        // Compare full documents, not defaulted structs. Strict JSON/type/size
        // validation must precede the duplicate-key-safe JSONC parser.
        validate_config(bytes)?;
        crate::jsonc::parse_unambiguous(
            std::str::from_utf8(bytes).map_err(|_| "Invalid MCP settings.")?,
        )
    };
    Ok(parse(current)? == parse(legacy)?)
}
fn snapshot(paths: &Paths) -> Result<Snapshot, String> {
    let current = config(&paths.current)?;
    let legacy = if current.is_none() {
        config(&paths.legacy)?
    } else {
        None
    };
    Ok(Snapshot { current, legacy })
}
fn inventory(paths: &Paths) -> Result<Snapshot, String> {
    Ok(Snapshot {
        current: config(&paths.current)?,
        legacy: config(&paths.legacy)?,
    })
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Status {
    None,
    Current,
    LegacyOnly,
    Identical,
    Conflict,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Report {
    pub status: Status,
    pub current_path: PathBuf,
    pub legacy_path: PathBuf,
    pub evidence_path: PathBuf,
    pub backups: Vec<PathBuf>,
    pub recovery: Vec<recovery::Report>,
}

/// Service-only native consent receipt; approval does not imply recovery completed.
#[derive(Serialize)]
pub(crate) struct ReviewReceipt {
    #[serde(flatten)]
    report: Report,
    approved: bool,
}

fn backup_path(path: &Path, bytes: &[u8]) -> PathBuf {
    path.parent()
        .unwrap()
        .join(".creator-hub-settings-backups")
        .join(format!(
            "{}.{:x}.bak",
            path.file_name().unwrap().to_string_lossy(),
            Sha256::digest(bytes)
        ))
}
fn transactions(paths: &Paths) -> Result<Vec<recovery::Transaction>, String> {
    storage::reject_links(&paths.journal)?;
    let entries = match fs::read_dir(&paths.journal) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err("Cannot inspect product settings recovery evidence.".into()),
    };
    let mut result = Vec::new();
    for entry in entries {
        let path = entry
            .map_err(|_| "Cannot inspect product settings receipt.")?
            .path();
        if path.file_name().is_some_and(|name| name == "hub.lock") {
            continue;
        }
        if result.len() >= 32 {
            return Err("Too many product settings journals; inspect manually.".into());
        }
        // A journal cannot select destinations: both established stores are independently derived.
        result.push(recovery::Transaction::open_allowlisted(
            &path,
            &[paths.current.clone(), paths.legacy.clone()],
        )?);
    }
    Ok(result)
}
fn inspect_paths(paths: &Paths) -> Result<Report, String> {
    let saved = inventory(paths)?;
    let status = match (&saved.current, &saved.legacy) {
        (None, None) => Status::None,
        (Some(_), None) => Status::Current,
        (None, Some(_)) => Status::LegacyOnly,
        (Some(a), Some(b)) if settings_equivalent(a, b)? => Status::Identical,
        (Some(_), Some(_)) => Status::Conflict,
    };
    let mut backups = Vec::new();
    for (path, bytes) in [
        (&paths.current, &saved.current),
        (&paths.legacy, &saved.legacy),
    ] {
        if let Some(bytes) = bytes {
            let backup = backup_path(path, bytes);
            if let Some(retained) = storage::read_bytes(&backup)? {
                if retained != *bytes {
                    return Err("A product settings backup differs; inspect manually.".into());
                }
                backups.push(backup);
            }
        }
    }
    let recovery = transactions(paths)?
        .into_iter()
        .map(|transaction| transaction.inspect())
        .collect::<Result<_, _>>()?;
    Ok(Report {
        status,
        current_path: paths.current.clone(),
        legacy_path: paths.legacy.clone(),
        evidence_path: paths.journal.clone(),
        backups,
        recovery,
    })
}
pub(super) fn inspect(base: &Path) -> Result<Report, String> {
    inspect_paths(&Paths::new(base)?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ServerTransition {
    pub changed: bool,
    pub server: PathBuf,
}

#[derive(Debug, PartialEq, Eq)]
struct ServerWrite {
    path: PathBuf,
    before: Vec<u8>,
    after: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
struct ServerReview {
    writes: Vec<ServerWrite>,
    requires_replacement: bool,
}

fn server_review(
    paths: &Paths,
    saved: &Snapshot,
    server: &Path,
    recognized: impl Fn(&Path) -> Result<bool, String>,
) -> Result<ServerReview, String> {
    let requires_replacement = std::cell::Cell::new(false);
    // This stages a reviewed replacement, not trust in or execution of the old
    // server. Publication still requires the explicit native decision below.
    let writes = server_writes(paths, saved, server, |path| {
        if !recognized(path).unwrap_or(false) {
            requires_replacement.set(true);
        }
        Ok(true)
    })?;
    Ok(ServerReview {
        writes,
        requires_replacement: requires_replacement.get(),
    })
}

fn finish_server_review(
    paths: &Paths,
    before: &Snapshot,
    server: &Path,
    review: &ServerReview,
    approved: bool,
    recognized: impl Fn(&Path) -> Result<bool, String>,
) -> Result<ServerTransition, String> {
    if !approved {
        return Err("Server-path migration was cancelled; settings and old apps were kept.".into());
    }
    if inventory(paths)? != *before {
        return Err("MCP settings changed during review; nothing was overwritten.".into());
    }
    if server_review(paths, before, server, recognized)? != *review {
        return Err("The previous MCP server changed during review. Review it again; settings and old apps were kept.".into());
    }
    if review.writes.is_empty() {
        return Ok(ServerTransition {
            changed: false,
            server: server.to_path_buf(),
        });
    }
    preserve(paths, before)?;
    let transaction = recovery::Transaction::prepare(
        &paths.journal,
        review
            .writes
            .iter()
            .map(|write| {
                recovery::ReviewedWrite::new(
                    "MCP retained server path",
                    &write.path,
                    &write.before,
                    &write.after,
                )
            })
            .collect(),
    )?;
    if !transaction.resume(|_| true)?.completed {
        return Err("Server-path migration needs recovery review. Old apps were kept.".into());
    }
    for write in &review.writes {
        if storage::read_bytes(&write.path)?.as_deref() != Some(write.after.as_slice()) {
            return Err(
                "MCP settings changed after publication; inspect the retained recovery records."
                    .into(),
            );
        }
    }
    Ok(ServerTransition {
        changed: true,
        server: server.to_path_buf(),
    })
}

fn server_writes(
    paths: &Paths,
    saved: &Snapshot,
    server: &Path,
    recognized: impl Fn(&Path) -> Result<bool, String>,
) -> Result<Vec<ServerWrite>, String> {
    if matches!((&saved.current, &saved.legacy), (Some(a), Some(b)) if !settings_equivalent(a, b)?)
    {
        return Err("MCP settings conflict; the server path and old apps were kept.".into());
    }
    let target = server
        .to_str()
        .ok_or("The verified server path cannot be represented.")?;
    let mut writes = Vec::new();
    for (path, bytes) in [
        (&paths.current, &saved.current),
        (&paths.legacy, &saved.legacy),
    ] {
        let Some(before) = bytes else { continue };
        let mut value = crate::jsonc::parse_unambiguous(
            std::str::from_utf8(before).map_err(|_| "Invalid MCP settings; original kept.")?,
        )?;
        let object = value
            .as_object_mut()
            .ok_or("Invalid MCP settings; original kept.")?;
        let previous = match object.get("mcp_server_path") {
            None => "",
            Some(serde_json::Value::String(previous)) => previous.as_str(),
            _ => return Err("Invalid saved MCP server path; original kept.".into()),
        };
        if previous == target {
            continue;
        }
        if !previous.is_empty() && !recognized(Path::new(previous))? {
            return Err(
                "The saved MCP server is custom or unverified. Its path and old apps were kept."
                    .into(),
            );
        }
        object.insert(
            "mcp_server_path".into(),
            serde_json::Value::String(target.into()),
        );
        let after =
            serde_json::to_vec_pretty(&value).map_err(|_| "Cannot stage the MCP server path.")?;
        if after.len() > MAX_CONFIG {
            return Err("MCP settings would exceed their size limit; original kept.".into());
        }
        writes.push(ServerWrite {
            path: path.clone(),
            before: before.clone(),
            after,
        });
    }
    Ok(writes)
}

#[cfg(not(unix))]
fn official_previous_server(path: &Path) -> Result<bool, String> {
    // This hash is the server from the byte-verified published 2.7.7 Windows
    // installer. Other versions/platform payloads remain unverified, not guessed.
    const SHA: &str = "8d7cbe21d3b3691d6b1aa052846d6ee36f4274c18bd4228c6d4a73583be74149";
    if !cfg!(windows) {
        return Ok(false);
    }
    let expected = dirs::data_local_dir()
        .ok_or("Local app data is unavailable.")?
        .join("Creator Works MCP/server/creator-works-mcp.mjs");
    storage::reject_links(path)?;
    storage::reject_links(&expected)?;
    if crate::normalized_existing_path(path.to_path_buf())
        != crate::normalized_existing_path(expected)
    {
        return Ok(false);
    }
    let bytes = storage::read_bytes(path)?
        .ok_or("The previous MCP server is missing; old apps were kept.")?;
    Ok(bytes.len() == 1_221_209 && format!("{:x}", Sha256::digest(&bytes)) == SHA)
}

// Extracted independently from every checksum-verified public v2.7.7 Unix asset:
// DEB db47aed5f5acd4e00e8e0782361444de228c4181eeea4970f90116f1f16cf10b
// RPM 9217fbdfd814d168b2b501bf6bb82661dfcf0482b95b4a67b285d29391dcfa75
// AppImage 75829fe6def919eb5ff9cc9560d4211e86d316069dfa3c6fc652df3c8fbb09de
// ARM DMG e4e8ac91938cc32f53c8390003ad6eed0d577d46931083c3182d87df66e5ba78
// Intel DMG ef6efca28df84da4f5ea01f4bcee24e8ae77964d84b65c3b9a808fbdb755a79e
// https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/releases/tag/v2.7.7
#[cfg(any(unix, test))]
const UNIX_277_SERVER_BYTES: usize = 1_221_209;
#[cfg(any(unix, test))]
const UNIX_277_SERVER_SHA: &str =
    "8d7cbe21d3b3691d6b1aa052846d6ee36f4274c18bd4228c6d4a73583be74149";

#[cfg(any(unix, test))]
fn unix_previous_paths(
    os: &str,
    native_data: &Path,
    native_home: Option<&Path>,
) -> Result<Vec<PathBuf>, String> {
    if !matches!(os, "linux" | "macos") {
        return Err("Previous MCP server review is unavailable on this Unix platform.".into());
    }
    // The public 2.7.7 launcher canonicalizes its native persistent cache root.
    // Never canonicalize the configured path or follow a cache leaf alias.
    let data = fs::canonicalize(native_data).unwrap_or_else(|_| native_data.to_path_buf());
    let mut paths = Vec::new();
    for directory in ["creator-works-mcp", "bantworks-mcp", "banter-mcp"] {
        for name in ["creator-works-mcp.mjs", "banter-mcp.mjs"] {
            paths.push(data.join(directory).join("server").join(name));
        }
    }
    if os == "linux" {
        paths.push(PathBuf::from(
            "/usr/lib/Creator Works MCP/server/creator-works-mcp.mjs",
        ));
    } else {
        let member = "Creator Works MCP.app/Contents/Resources/server/creator-works-mcp.mjs";
        paths.push(PathBuf::from("/Applications").join(member));
        if let Some(home) = native_home {
            paths.push(home.join("Applications").join(member));
        }
    }
    Ok(paths)
}

#[cfg(any(unix, test))]
struct UnixPreviousServers {
    paths: Vec<PathBuf>,
    bytes: usize,
    sha256: String,
    captured: RefCell<BTreeMap<PathBuf, unix_server::PreviousServerSnapshot>>,
}

#[cfg(any(unix, test))]
impl UnixPreviousServers {
    fn new(paths: Vec<PathBuf>, bytes: usize, sha256: &str) -> Self {
        Self {
            paths,
            bytes,
            sha256: sha256.to_owned(),
            captured: RefCell::new(BTreeMap::new()),
        }
    }

    #[cfg(unix)]
    fn native() -> Result<Self, String> {
        #[cfg(test)]
        {
            Err("Unit tests require explicit disposable previous-server paths.".into())
        }
        #[cfg(not(test))]
        {
            let data = dirs::data_local_dir()
                .or_else(dirs::data_dir)
                .ok_or("Native MCP data directory is unavailable.")?;
            let home = dirs::home_dir();
            Ok(Self::new(
                unix_previous_paths(std::env::consts::OS, &data, home.as_deref())?,
                UNIX_277_SERVER_BYTES,
                UNIX_277_SERVER_SHA,
            ))
        }
    }

    fn recognizes(&self, configured: &Path) -> Result<bool, String> {
        if let Some(previous) = self.captured.borrow().get(configured) {
            return previous.recognizes(configured);
        }
        let Some(expected) = self.paths.iter().find(|path| path.as_path() == configured) else {
            return Ok(false);
        };
        let previous =
            unix_server::PreviousServerSnapshot::inspect(unix_server::NativeServerPin {
                path: expected,
                bytes: self.bytes,
                sha256: &self.sha256,
            })?;
        let recognized = previous.recognizes(configured)?;
        if recognized {
            self.captured
                .borrow_mut()
                .insert(expected.clone(), previous);
        }
        Ok(recognized)
    }
}

// Native-only before-images. No serialized argument or saved preference can
// construct this authority; Root must obtain the service's native consent first.
pub(crate) struct ConvergenceSettings {
    paths: Paths,
    original: Snapshot,
    imported: Snapshot,
    server: PathBuf,
    review: ServerReview,
    #[cfg(unix)]
    previous: UnixPreviousServers,
}

impl ConvergenceSettings {
    pub(crate) fn inspect(server: &Path, imported: Option<&[u8]>) -> Result<Self, String> {
        let paths = Paths::new(&dirs::config_dir().ok_or("MCP config directory is unavailable.")?)?;
        if inspect_paths(&paths)?
            .recovery
            .iter()
            .any(|r| !r.completed && !r.historical_completed)
        {
            return Err("Review interrupted MCP settings changes before moving to Hub.".into());
        }
        let original = inventory(&paths)?;
        let mut expected = original.clone();
        if let Some(bytes) = imported {
            // Root's reviewed project merge updates both existing stores only.
            if original.current.is_none() || original.legacy.is_none() {
                return Err("Project import requires both original settings stores.".into());
            }
            let _: crate::LauncherConfig = serde_json::from_slice(bytes)
                .map_err(|_| "Invalid native project-import proposal.")?;
            expected.current = Some(bytes.to_vec());
            expected.legacy = Some(bytes.to_vec());
        }
        #[cfg(unix)]
        let previous = UnixPreviousServers::native()?;
        #[cfg(unix)]
        let recognized = |path: &Path| previous.recognizes(path);
        #[cfg(not(unix))]
        let recognized = official_previous_server;
        let review = server_review(&paths, &expected, server, recognized)?;
        Ok(Self {
            paths,
            original,
            imported: expected,
            server: server.into(),
            review,
            #[cfg(unix)]
            previous,
        })
    }

    pub(crate) fn recheck_original(&self) -> Result<(), String> {
        if inventory(&self.paths)? != self.original {
            return Err(
                "MCP settings changed during native review; nothing was overwritten.".into(),
            );
        }
        Ok(())
    }

    pub(crate) fn recheck_imported(&self) -> Result<(), String> {
        let actual = inventory(&self.paths)?;
        if let (Some(current), Some(legacy)) = (&self.imported.current, &self.imported.legacy) {
            if current == legacy {
                crate::service::verify_convergence_import(
                    current,
                    actual.current.as_deref(),
                    actual.legacy.as_deref(),
                )?;
            }
        }
        if actual != self.imported
            || inspect_paths(&self.paths)?
                .recovery
                .iter()
                .any(|r| !r.completed && !r.historical_completed)
        {
            return Err("Settings or recovery changed after the reviewed project import. No server write was started.".into());
        }
        Ok(())
    }

    pub(crate) fn apply(self, app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
        use tauri::Manager;
        require_writable()?;
        if app
            .try_state::<crate::managed_client::ManagedClient>()
            .is_none()
        {
            return Err("Native migration requires the verified managed route.".into());
        }
        let runtime = creator_hub_mcp_router::Store::installed()?.resolve()?;
        self.recheck_imported()?;
        if runtime.server != self.server
            || crate::normalized_existing_path(crate::default_mcp_server_path(app)?)
                != crate::normalized_existing_path(self.server.clone())
        {
            return Err("Settings, recovery or the signed runtime changed after consent. Old apps were kept.".into());
        }
        #[cfg(unix)]
        let recognized = |path: &Path| self.previous.recognizes(path);
        #[cfg(not(unix))]
        let recognized = official_previous_server;
        if server_review(&self.paths, &self.imported, &self.server, recognized)? != self.review {
            return Err("The previous MCP server changed after native consent.".into());
        }
        let result = if self.review.requires_replacement {
            // An unverified/custom server remains a separate explicit decision.
            native_review_server(app)?
        } else {
            finish_server_review(
                &self.paths,
                &self.imported,
                &self.server,
                &self.review,
                true,
                recognized,
            )?
        };
        serde_json::to_value(result).map_err(|_| "Cannot encode native server transition.".into())
    }
}

pub(crate) fn verified_previous_connection(node: &Path, server: &Path) -> Result<bool, String> {
    #[cfg(unix)]
    let recognized = UnixPreviousServers::native()?.recognizes(server)?;
    #[cfg(not(unix))]
    let recognized = official_previous_server(server)?;
    if !recognized {
        return Ok(false);
    }
    let Some(root) = server.parent() else {
        return Ok(false);
    };
    let expected_node = root
        .join("runtime")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    if crate::normalized_existing_path(node.into())
        != crate::normalized_existing_path(expected_node)
    {
        return Ok(false);
    }
    // A name/ownership marker alone never proves a previous publisher. Verify
    // the entire previous payload against this library's frozen runtime manifest.
    Ok(crate::hosted_payload::Root::verified(root.into()).is_ok())
}

pub(super) fn native_review_server(app: &tauri::AppHandle) -> Result<ServerTransition, String> {
    use tauri::Manager;
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    if !crate::settings_review_admission::enabled()
        || app
            .try_state::<crate::managed_client::ManagedClient>()
            .is_none()
    {
        return Err(
            "Server-path migration requires an admitted, signed managed MCP runtime.".into(),
        );
    }
    let runtime = creator_hub_mcp_router::Store::installed()?.resolve()?;
    if crate::normalized_existing_path(crate::default_mcp_server_path(app)?)
        != crate::normalized_existing_path(runtime.server.clone())
    {
        return Err("The signed MCP runtime changed; no settings were written.".into());
    }
    let paths = Paths::new(&dirs::config_dir().ok_or("MCP config directory is unavailable.")?)?;
    let report = inspect_paths(&paths)?;
    if report
        .recovery
        .iter()
        .any(|r| !r.completed && !r.historical_completed)
    {
        return Err(
            "Review interrupted MCP settings changes before moving the server path.".into(),
        );
    }
    let before = inventory(&paths)?;
    #[cfg(unix)]
    let previous = UnixPreviousServers::native()?;
    #[cfg(unix)]
    let recognized = |path: &Path| previous.recognizes(path);
    #[cfg(not(unix))]
    let recognized = official_previous_server;
    let review = server_review(&paths, &before, &runtime.server, recognized)?;
    if review.writes.is_empty() {
        return Ok(ServerTransition {
            changed: false,
            server: runtime.server,
        });
    }
    let (question, action) = if review.requires_replacement {
        ("The saved MCP server could not be verified as a supported previous build. Use the verified MCP runtime included with Hub instead?\n\nThis does not trust or run the old server. Existing AI-client entries are reviewed separately.", "Use Hub runtime")
    } else {
        (
            "Move the saved MCP server path to Hub's verified retained runtime?",
            "Move server path",
        )
    };
    let approved = app.dialog().message(format!(
        "{question}\n\nNew server: {}\n\nOnly this path changes. Project selection, options and unknown settings are preserved. Exact local backups and recovery records are kept. Old apps and AI clients are not stopped or removed by this step.", runtime.server.display()
    )).title("Keep MCP settings working in Hub").kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(action.into(), "Keep existing".into())).blocking_show();
    finish_server_review(
        &paths,
        &before,
        &runtime.server,
        &review,
        approved,
        recognized,
    )
}

// Only the owned form's load_config handler may renew this UI before-image.
// Background inspection/discovery/onboarding continues using read-only readers.
pub(super) fn load_form(app: &tauri::AppHandle) -> Result<crate::LauncherConfig, String> {
    if !crate::integration_context::protected_writers() {
        return crate::load_config(app.clone());
    }
    let paths =
        Paths::new(&dirs::config_dir().ok_or("Cannot locate MCP configuration directory.")?)?;
    let mut loaded = LOADED
        .lock()
        .map_err(|_| "Cannot reserve the loaded settings snapshot.")?;
    let saved = snapshot(&paths)?;
    let config = loaded_config(&saved, || crate::default_mcp_server_path(app))?;
    *loaded = Some(saved);
    Ok(config)
}

fn loaded_config(
    saved: &Snapshot,
    default_server: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<crate::LauncherConfig, String> {
    match saved.current.as_ref().or(saved.legacy.as_ref()) {
        Some(bytes) => {
            serde_json::from_slice(bytes).map_err(|_| "Invalid product settings.".into())
        }
        None => Ok(crate::default_launcher_config(default_server()?)),
    }
}

/// A single backend mutation's exact read snapshot; it never renews the UI form snapshot.
pub(crate) struct Operation {
    paths: Paths,
    before: Snapshot,
}

fn load_operation_at(
    paths: Paths,
    default_server: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<(crate::LauncherConfig, Operation), String> {
    let before = snapshot(&paths)?;
    let config = loaded_config(&before, default_server)?;
    Ok((config, Operation { paths, before }))
}

pub(crate) fn load_operation(
    app: &tauri::AppHandle,
) -> Result<(crate::LauncherConfig, Option<Operation>), String> {
    if !crate::integration_context::protected_writers() {
        return Ok((crate::load_config(app.clone())?, None));
    }
    let paths =
        Paths::new(&dirs::config_dir().ok_or("Cannot locate MCP configuration directory.")?)?;
    let (config, operation) = load_operation_at(paths, || crate::default_mcp_server_path(app))?;
    Ok((config, Some(operation)))
}

fn encoded_config(mut config: crate::LauncherConfig) -> Result<Vec<u8>, String> {
    if config.channels.len() > 256 {
        return Err(
            "Saved settings would exceed the existing channel limit. Nothing was saved.".into(),
        );
    }
    config.mcp_server_path = crate::validate_mcp_server_path(&config.mcp_server_path)?
        .to_string_lossy()
        .into_owned();
    config.tool_groups = crate::normalize_tool_groups(&config.tool_groups)?;
    serde_json::to_vec_pretty(&config).map_err(|_| "Cannot serialize product settings.".into())
}

fn require_writable() -> Result<(), String> {
    if cfg!(windows)
        || cfg!(all(unix, feature = "experimental-unix-hosting"))
        || cfg!(all(target_os = "linux", feature = "integrated-service"))
            && crate::integration_context::active()
    {
        Ok(())
    } else {
        Err("Production Unix writable settings remain disabled.".into())
    }
}

pub(crate) fn save_operation(
    config: crate::LauncherConfig,
    operation: Option<Operation>,
) -> Result<(), String> {
    if !crate::integration_context::protected_writers() {
        return crate::save_config(config);
    }
    require_writable()?;
    let operation = operation.ok_or("The backend mutation has no captured settings snapshot.")?;
    commit_operation(config, operation)
}

fn commit_operation(config: crate::LauncherConfig, operation: Operation) -> Result<(), String> {
    let after = encoded_config(config)?;
    save_snapshot(&operation.paths, &operation.before, &after).map(|_| ())
}

/// Existing schema/ownership approval belongs to the caller. This binds publication
/// to the exact parsed document, without renewing LOADED or selecting a new store.
pub(crate) fn commit_document(
    label: &str,
    path: &Path,
    before: Option<&[u8]>,
    after: &str,
) -> Result<(), String> {
    if !crate::integration_context::protected_writers() {
        return crate::atomic_write(path, after);
    }
    require_writable()?;
    commit_document_at(label, path, before, after.as_bytes())
}

fn commit_document_at(
    label: &str,
    path: &Path,
    before: Option<&[u8]>,
    after: &[u8],
) -> Result<(), String> {
    if !path.is_absolute() || path.components().any(|part| part == Component::ParentDir) {
        return Err("Settings publication requires an absolute, unambiguous path.".into());
    }
    if after.len() as u64 > storage::MAX_BYTES {
        return Err("Settings publication exceeds 2 MiB. Nothing was saved.".into());
    }
    if storage::read_bytes(path)?.as_deref() != before {
        return Err("Settings changed after they were read. Nothing was overwritten.".into());
    }
    if before == Some(after) {
        return Ok(());
    }
    let parent = path.parent().ok_or("Settings have no parent folder.")?;
    if let Some(before) = before {
        let transaction = recovery::Transaction::prepare(
            &parent.join(".creator-hub-product-settings"),
            vec![recovery::ReviewedWrite::new(label, path, before, after)],
        )?;
        let report = transaction.resume(|_| true)?;
        if !report.completed {
            return Err(format!(
                "Settings save needs recovery review at {}. No automatic rollback was attempted.",
                report.journal.display()
            ));
        }
    } else {
        storage::reject_links(parent)?;
        fs::create_dir_all(parent).map_err(|_| "Cannot create the existing settings folder.")?;
        let temporary = parent.join(format!(
            ".creator-hub-settings-{}.tmp",
            uuid::Uuid::new_v4()
        ));
        let staged = storage::StagedFile::write(&temporary, |file| {
            file.write_all(after)?;
            file.sync_all()
        })
        .map_err(|_| "Cannot stage new settings; originals were kept.")?;
        staged.publish(|source| storage::durable_move(source, path))
            .map_err(|_| "New settings publication was not confirmed. Recheck the target; an appeared file was not replaced.")?;
    }
    if storage::read_bytes(path)?.as_deref() != Some(after) {
        return Err(
            "Settings changed after publication. Inspect the retained evidence before retrying."
                .into(),
        );
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn commit_document_fixture(
    label: &str,
    path: &Path,
    before: Option<&[u8]>,
    after: &str,
) -> Result<(), String> {
    commit_document_at(label, path, before, after.as_bytes())
}

fn save_snapshot(paths: &Paths, loaded: &Snapshot, after: &[u8]) -> Result<Snapshot, String> {
    if after.len() > MAX_CONFIG {
        return Err(
            "Saved settings would exceed the existing preview limit. Nothing was saved.".into(),
        );
    }
    if snapshot(paths)? != *loaded {
        return Err("MCP product settings changed since this view loaded. Reload before saving; no settings were overwritten.".into());
    }
    if loaded.current.as_deref() == Some(after) {
        return Ok(loaded.clone());
    }
    let _source: Option<File> = if loaded.current.is_none() {
        // A first explicit save retains the selected legacy before-image, but performs no import
        // on opening the view. Hold its Windows source handle until publication finishes.
        if let Some(before) = &loaded.legacy {
            storage::reject_links(&paths.legacy)?;
            let mut source = storage::protected_options()
                .open(&paths.legacy)
                .map_err(|_| "Cannot reserve legacy settings. Nothing was saved.")?;
            if storage::read(&mut source)? != *before {
                return Err("Legacy settings changed. Reload before saving.".into());
            }
            storage::retain_image(&paths.legacy, before)?;
            Some(source)
        } else {
            None
        }
    } else {
        None
    };
    // The caller is admitted through native writable consent and its owned UI workflow.
    commit_document_at(
        "MCP launcher settings",
        &paths.current,
        loaded.current.as_deref(),
        after,
    )?;
    let fresh = snapshot(paths)?;
    if fresh.current.as_deref() != Some(after) {
        return Err("Saved settings changed after publication. Recheck the current file and retained evidence.".into());
    }
    Ok(fresh)
}
pub(super) fn save(config: crate::LauncherConfig) -> Result<(), String> {
    if !crate::integration_context::protected_writers() {
        return crate::save_config(config);
    }
    require_writable()?;
    let after = encoded_config(config)?;
    let paths =
        Paths::new(&dirs::config_dir().ok_or("Cannot locate MCP configuration directory.")?)?;
    let mut loaded = LOADED
        .lock()
        .map_err(|_| "Cannot reserve the loaded settings snapshot.")?;
    let before = loaded
        .as_ref()
        .ok_or("Load MCP settings before saving; no unreviewed overwrite is allowed.")?;
    *loaded = Some(save_snapshot(&paths, before, &after)?);
    Ok(())
}

pub(super) fn native_review(app: &tauri::AppHandle, base: &Path) -> Result<Report, String> {
    native_review_decision(app, base).map(|receipt| receipt.report)
}

pub(crate) fn native_review_decision(
    app: &tauri::AppHandle,
    base: &Path,
) -> Result<ReviewReceipt, String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    if !crate::settings_review_admission::enabled() {
        return Err(
            "Product settings review requires an admitted writable built-in Hub build.".into(),
        );
    }
    let paths = Paths::new(base)?;
    review_with(
        &paths,
        |report| {
            app.dialog().message(format!("Review the interrupted MCP settings save at {}?\n\nOnly an unchanged reviewed before-image can be resumed. Conflicting, unknown or changed outcomes are not rolled back or overwritten. Exact before/after images remain local. No AI client, Unity project, sign-in or installation is changed.", report.journal.display()))
            .title("Review MCP settings recovery").kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Review and resume".into(), "Keep unchanged".into())).blocking_show()
        },
        |paths| {
            app.dialog().message(format!("Keep exact local backups of these MCP settings?\n\nCurrent: {}\nLegacy (kept): {}\n\nCurrent settings remain preferred; legacy-only settings remain in their existing location. Different files are not merged, copied to a new Hub store or overwritten. Unknown fields, projects, terms and installed apps are unchanged.", paths.current.display(), paths.legacy.display()))
            .title("Preserve MCP product settings").kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Keep backups".into(), "Keep unchanged".into())).blocking_show()
        },
    )
}

fn review_with(
    paths: &Paths,
    mut approve_recovery: impl FnMut(&recovery::Report) -> bool,
    approve_backup: impl FnOnce(&Paths) -> bool,
) -> Result<ReviewReceipt, String> {
    let mut reviewed_recovery = false;
    let mut any_approved = false;
    let mut any_declined = false;
    for transaction in transactions(paths)? {
        let report = transaction.inspect()?;
        if report.historical_completed {
            continue;
        }
        reviewed_recovery = true;
        transaction.resume(|report| {
            let approved = approve_recovery(report);
            any_approved |= approved;
            any_declined |= !approved;
            approved
        })?;
    }
    if reviewed_recovery {
        return Ok(ReviewReceipt {
            report: inspect_paths(paths)?,
            approved: any_approved && !any_declined,
        });
    }
    let saved = inventory(paths)?;
    if saved.current.is_none() && saved.legacy.is_none() {
        return Ok(ReviewReceipt {
            report: inspect_paths(paths)?,
            approved: false,
        });
    }
    let approved = approve_backup(paths);
    if approved {
        preserve(paths, &saved)?;
    }
    Ok(ReviewReceipt {
        report: inspect_paths(paths)?,
        approved,
    })
}
fn preserve(paths: &Paths, reviewed: &Snapshot) -> Result<(), String> {
    let mut held = Vec::new();
    for (path, before) in [
        (&paths.current, &reviewed.current),
        (&paths.legacy, &reviewed.legacy),
    ] {
        if let Some(before) = before {
            storage::reject_links(path)?;
            let mut file = storage::protected_options()
                .open(path)
                .map_err(|_| "Cannot reserve product settings for backup.")?;
            if storage::read(&mut file)? != *before {
                return Err(
                    "Product settings changed during review. Nothing was overwritten.".into(),
                );
            }
            held.push(file);
        }
    }
    if inventory(paths)? != *reviewed {
        return Err("Product settings changed during review. Nothing was overwritten.".into());
    }
    for (path, before) in [
        (&paths.current, &reviewed.current),
        (&paths.legacy, &reviewed.legacy),
    ] {
        if let Some(before) = before {
            storage::retain_image(path, before)?;
        }
    }
    drop(held);
    Ok(())
}

#[cfg(test)]
#[path = "product_settings_tests.rs"]
mod tests;

#[cfg(test)]
mod convergence_tests {
    use super::*;

    fn imported_fixture(base: &Path) -> ConvergenceSettings {
        let paths = Paths::new(base).unwrap();
        fs::create_dir_all(paths.current.parent().unwrap()).unwrap();
        fs::create_dir_all(paths.legacy.parent().unwrap()).unwrap();
        let original = br#"{"channels":[],"auto_start":false,"future":"original"}"#;
        let imported = br#"{"channels":[],"auto_start":false,"future":"approved import"}"#;
        fs::write(&paths.current, original).unwrap();
        fs::write(&paths.legacy, original).unwrap();
        let saved = ConvergenceSettings {
            original: inventory(&paths).unwrap(),
            imported: Snapshot {
                current: Some(imported.to_vec()),
                legacy: Some(imported.to_vec()),
            },
            server: base.join("verified/creator-works-mcp.mjs"),
            review: ServerReview {
                writes: vec![],
                requires_replacement: false,
            },
            #[cfg(unix)]
            previous: UnixPreviousServers::new(vec![], 0, "fixture"),
            paths,
        };
        fs::write(&saved.paths.current, imported).unwrap();
        fs::write(&saved.paths.legacy, imported).unwrap();
        saved
    }

    #[test]
    fn mcp_settings_or_recovery_changed_during_exception_review_refuse_before_client_preparation() {
        for drift in ["current", "legacy", "recovery", "unchanged"] {
            let dir = tempfile::tempdir().unwrap();
            let base = dir.path().to_path_buf();
            let saved = imported_fixture(&base);
            assert!(saved.recheck_original().is_err());
            saved.recheck_imported().unwrap();
            let client = base.join("client.json");
            let router = base.join(if cfg!(windows) {
                "hub-router.exe"
            } else {
                "hub-router"
            });
            fs::write(&router, b"disposable parser target, never executed").unwrap();
            let before = serde_json::json!({"other":"kept", "mcpServers":{"creator-works":{
                "command":base.join(if cfg!(windows) { "old/runtime/node.exe" } else { "old/runtime/node" }),
                "args":[base.join("old/banter-mcp.mjs")], "env":{"CUSTOM":"kept"}
            }}}).to_string();
            fs::write(&client, &before).unwrap();
            let plan = crate::client_migration::Plan::review_router(
                "Fixture client",
                &client,
                crate::client_migration::Format::Json,
                &router,
            )
            .unwrap()
            .unwrap();
            // Simulate the synchronous native exception dialog returning after
            // an external editor changed valid MCP settings or recovery evidence.
            let approve_exception = || {
                match drift {
                    "current" => fs::write(
                        &saved.paths.current,
                        br#"{"channels":[],"auto_start":true,"future":"external"}"#,
                    )
                    .unwrap(),
                    "legacy" => fs::write(
                        &saved.paths.legacy,
                        br#"{"channels":[],"auto_start":true,"future":"external"}"#,
                    )
                    .unwrap(),
                    "recovery" => {
                        fs::create_dir_all(saved.paths.journal.join("unknown-operation")).unwrap();
                    }
                    _ => {}
                }
                true
            };
            assert!(approve_exception());
            let journal = base.join("client-migrations");
            let result = crate::apply_convergence_client_plans(&[plan], &journal, || {
                saved.recheck_imported()
            });
            if drift == "unchanged" {
                assert_eq!(result.unwrap()["status"], "migrated");
                let after: serde_json::Value =
                    serde_json::from_slice(&fs::read(&client).unwrap()).unwrap();
                assert_eq!(after["other"], "kept");
                assert_eq!(
                    after["mcpServers"]["creator-works"]["args"],
                    serde_json::json!([])
                );
            } else {
                assert!(result.is_err(), "drift: {drift}");
                assert_eq!(fs::read_to_string(&client).unwrap(), before);
                assert!(!journal.exists());
                assert!(!base.join(".creator-hub-settings-backups").exists());
                if drift == "current" {
                    assert!(fs::read_to_string(&saved.paths.current)
                        .unwrap()
                        .contains("external"));
                }
            }
        }
    }

    #[test]
    fn exception_client_path_rechecks_imported_settings_after_dialog_before_any_client_preparation()
    {
        let source = include_str!("lib.rs");
        let path = source
            .split("fn apply_convergence_clients(")
            .nth(1)
            .unwrap()
            .split("fn apply_convergence_client_plans(")
            .next()
            .unwrap();
        assert!(
            path.find(".blocking_show()").unwrap()
                < path.find("consent.recheck_imported_settings()").unwrap()
        );
        let leaf = source
            .split("fn apply_convergence_client_plans(")
            .nth(1)
            .unwrap()
            .split("pub fn run()")
            .next()
            .unwrap();
        assert!(
            leaf.find("recheck_settings()?").unwrap() < leaf.find("Plan::apply_reviewed(").unwrap()
        );
        assert!(!leaf.contains("recheck_clients"));
        let service = include_str!("service.rs");
        let check = service
            .split("pub(crate) fn recheck_imported_settings(")
            .nth(1)
            .unwrap()
            .split("/// Uses the existing ownership")
            .next()
            .unwrap();
        assert!(check.contains("self.review.settings.recheck_imported()?"));
        assert!(check.contains("require_no_convergence_recovery()"));
        assert!(!check.contains("recheck_original"));
    }

    #[test]
    fn consent_binds_original_and_exact_predicted_import_without_renewing_unrelated_changes() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path()).unwrap();
        fs::create_dir_all(paths.current.parent().unwrap()).unwrap();
        fs::create_dir_all(paths.legacy.parent().unwrap()).unwrap();
        let before = br#"{"channels":[],"auto_start":false,"future":"kept"}"#;
        let imported = br#"{"channels":[],"auto_start":false,"future":"reviewed import"}"#;
        fs::write(&paths.current, before).unwrap();
        fs::write(&paths.legacy, before).unwrap();
        let saved = ConvergenceSettings {
            original: inventory(&paths).unwrap(),
            imported: Snapshot {
                current: Some(imported.to_vec()),
                legacy: Some(imported.to_vec()),
            },
            server: dir.path().join("verified/creator-works-mcp.mjs"),
            review: ServerReview {
                writes: vec![],
                requires_replacement: false,
            },
            #[cfg(unix)]
            previous: UnixPreviousServers::new(vec![], 0, "fixture"),
            paths,
        };
        saved.recheck_original().unwrap();
        assert!(saved.recheck_imported().is_err());
        fs::write(&saved.paths.current, imported).unwrap();
        fs::write(&saved.paths.legacy, imported).unwrap();
        assert!(saved.recheck_original().is_err());
        saved.recheck_imported().unwrap();
        fs::write(&saved.paths.current, before).unwrap();
        assert!(saved.recheck_imported().is_err());
        assert_eq!(fs::read(&saved.paths.current).unwrap(), before);
        assert!(!saved.paths.journal.exists());
    }

    #[test]
    fn native_server_consent_still_checks_route_snapshots_recognition_and_replacement_review() {
        let source = include_str!("product_settings.rs");
        let apply = source
            .split("pub(crate) fn apply(self,")
            .nth(1)
            .unwrap()
            .split("pub(crate) fn verified_previous_connection")
            .next()
            .unwrap();
        for guard in [
            "require_writable()?",
            "ManagedClient",
            "Store::installed()",
            "self.recheck_imported()?",
            "server_review(",
            "self.review.requires_replacement",
            "native_review_server(app)?",
            "finish_server_review(",
        ] {
            assert!(apply.contains(guard), "missing guard: {guard}");
        }
        assert!(
            apply.find("self.recheck_imported()?").unwrap()
                < apply.find("finish_server_review(").unwrap()
        );
    }
}
