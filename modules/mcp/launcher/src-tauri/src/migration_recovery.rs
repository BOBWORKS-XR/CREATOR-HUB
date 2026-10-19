//! Immutable local write-ahead evidence. Locks serialize Hub, not other editors.
use crate::settings_backup as storage;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io;
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
};

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[path = "unix_publication.rs"]
mod unix_publication;

const SCHEMA: u32 = 1;
const MAX_FILES: usize = 16;

pub(crate) struct ReviewedWrite {
    client: String,
    path: PathBuf,
    before: Vec<u8>,
    after: Vec<u8>,
}

impl ReviewedWrite {
    /// Caller owns schema/ownership review and explicit approval (also for product settings).
    pub(crate) fn new(client: &str, path: &Path, before: &[u8], after: &[u8]) -> Self {
        Self {
            client: client.into(),
            path: path.into(),
            before: before.into(),
            after: after.into(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Entry {
    client: String,
    path: PathBuf,
    before_sha256: String,
    after_sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Pending {
    schema: u32,
    files: Vec<Entry>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) enum Status {
    Ready,
    Applied,
    ExternalChange,
    PublicationConflict,
    Unknown,
    Unsupported,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Outcome {
    schema: u32,
    status: Status,
    native_error: Option<i32>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Intent {
    schema: u32,
    before_sha256: String,
    after_sha256: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeResult {
    schema: u32,
    success: bool,
    error: Option<i32>,
}

#[derive(Debug, Serialize)]
pub(crate) struct FileReport {
    pub client: String,
    pub path: PathBuf,
    pub status: Status,
    pub before_image: PathBuf,
    pub after_image: PathBuf,
    pub before_backup: PathBuf,
    pub displaced: PathBuf,
    /// May hold proposed bytes OR actual displaced bytes after an interrupted Unix swap.
    pub stage: PathBuf,
}

#[derive(Debug, Serialize)]
pub(crate) struct Report {
    pub journal: PathBuf,
    pub files: Vec<FileReport>,
    /// True only with a completed record AND matching current evidence, not client acceptance.
    pub completed: bool,
    /// Valid completed history stays historical after a later approved setup.
    /// This does not claim the current settings still equal this old after-image.
    pub historical_completed: bool,
}

struct Lock(File);
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

pub(crate) struct Transaction {
    directory: PathBuf,
    pending: Pending,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Boundary {
    BeforeImage(usize),
    AfterImage(usize),
    Pending,
    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    Stage(usize),
    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    Intent(usize),
    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    BeforePublish(usize),
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    Swapped(usize),
    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    Published(usize),
    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    NativeRecorded(usize),
    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    DisplacedSealed(usize),
    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    Captured(usize),
    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    Outcome(usize),
    Completed,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn encode(value: &impl Serialize) -> Result<Vec<u8>, String> {
    serde_json::to_vec(value).map_err(|_| "Cannot encode migration evidence.".into())
}
fn record<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>, String> {
    storage::read_bytes(path)?
        .map(|bytes| {
            serde_json::from_slice(&bytes).map_err(|_| {
                "Corrupt migration evidence; retain all files and inspect manually.".into()
            })
        })
        .transpose()
}
fn put(path: &Path, value: &impl Serialize) -> Result<(), String> {
    storage::durable_image(path, &encode(value)?)
}
fn lock(root: &Path) -> Result<Lock, String> {
    storage::private_directory(root)?;
    let path = root.join("hub.lock");
    storage::reject_links(&path)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(3); // cooperative Hub writers may open; no deletion of the lock.
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(&path)
        .map_err(|_| "Cannot open Hub migration lock.")?;
    file.try_lock_exclusive()
        .map_err(|_| "Another Hub migration is active; no changes were attempted.")?;
    Ok(Lock(file))
}

fn canonical_target(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir) || c.as_os_str() == "..")
    {
        return Err("Migration requires absolute, unambiguous existing file paths.".into());
    }
    storage::reject_links(path)?;
    let canonical = fs::canonicalize(path).map_err(|_| "Migration target is unavailable.")?;
    if !canonical.is_file() {
        return Err("Migration target must be a regular file.".into());
    }
    #[cfg(windows)]
    if canonical.to_string_lossy().starts_with(r"\\?\UNC\") {
        return Err("Network settings migration is not supported.".into());
    }
    Ok(canonical)
}

fn canonical_scope_target_with(
    path: &Path,
    resolve: impl Fn(&Path) -> io::Result<PathBuf>,
) -> Result<PathBuf, String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir) || c.as_os_str() == "..")
    {
        return Err("Recovery scope requires absolute, unambiguous paths.".into());
    }
    storage::reject_links(path)?;
    let canonical = match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file() {
                return Err("Recovery scope target must be a regular file.".into());
            }
            // Match prepare's whole-file resolution. Windows can redirect a
            // file without redirecting its parent directory (MSIX app data).
            let canonical = resolve(path).map_err(|_| "Cannot resolve recovery scope target.")?;
            if !canonical.is_file() {
                return Err("Recovery scope target must be a regular file.".into());
            }
            canonical
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            // Missing leaves remain classifiable; never create a target or use
            // the journal itself to choose an alternate destination.
            resolve(path.parent().ok_or("Recovery scope path has no parent.")?)
                .map_err(|_| "Recovery scope parent is unavailable.")?
                .join(
                    path.file_name()
                        .ok_or("Recovery scope path has no filename.")?,
                )
        }
        Err(_) => return Err("Cannot inspect recovery scope target.".into()),
    };
    #[cfg(windows)]
    if canonical.to_string_lossy().starts_with(r"\\?\UNC\") {
        return Err("Network settings migration is not supported.".into());
    }
    Ok(canonical)
}

fn canonical_scope_target(path: &Path) -> Result<PathBuf, String> {
    canonical_scope_target_with(path, |path| fs::canonicalize(path))
}

impl Transaction {
    pub(crate) fn prepare(root: &Path, writes: Vec<ReviewedWrite>) -> Result<Self, String> {
        Self::prepare_with(root, writes, &mut |_| Ok(()))
    }

    fn prepare_with(
        root: &Path,
        writes: Vec<ReviewedWrite>,
        hook: &mut impl FnMut(Boundary) -> Result<(), String>,
    ) -> Result<Self, String> {
        if !root.is_absolute() || writes.is_empty() || writes.len() > MAX_FILES {
            return Err("Invalid migration storage or file count (1..16 required).".into());
        }
        let mut files = Vec::new();
        let mut images = Vec::new();
        let mut already_after = Vec::new();
        // Check every member before retaining any evidence. No new settings files are created.
        for write in writes {
            if write.client.is_empty()
                || write.client.len() > 256
                || write.client.chars().any(char::is_control)
                || write.before == write.after
                || write.after.len() as u64 > storage::MAX_BYTES
            {
                return Err("Invalid reviewed migration image or label.".into());
            }
            let path = canonical_target(&write.path)?;
            if files.iter().any(|entry: &Entry| entry.path == path) {
                return Err("Duplicate migration targets require review.".into());
            }
            let current = storage::read_bytes(&path)?;
            let matches_after = current.as_deref() == Some(&write.after);
            if current.as_deref() != Some(&write.before) && !matches_after {
                return Err(
                    "Settings changed after review; review again. Nothing was changed.".into(),
                );
            }
            already_after.push(matches_after);
            files.push(Entry {
                client: write.client,
                path,
                before_sha256: digest(&write.before),
                after_sha256: digest(&write.after),
            });
            images.push((write.before, write.after));
        }
        let pending = Pending {
            schema: SCHEMA,
            files,
        };
        let id = digest(&encode(&pending)?);
        let _lock = lock(root)?;
        let root = fs::canonicalize(root).map_err(|_| "Cannot resolve migration storage.")?;
        let directory = root.join(&id);
        // An unresolved overlapping transaction cannot be bypassed with a new operation ID.
        for child in fs::read_dir(&root).map_err(|_| "Cannot enumerate migration evidence.")? {
            let child = child
                .map_err(|_| "Cannot inspect migration evidence.")?
                .path();
            if child.file_name().is_some_and(|name| name == "hub.lock") || child == directory {
                continue;
            }
            storage::reject_links(&child)?;
            if !child.is_dir() {
                return Err("Unknown migration storage entry; inspect manually.".into());
            }
            let old: Pending = record(&child.join("pending.json"))?
                .ok_or("Incomplete migration preparation; inspect retained files manually.")?;
            if old.schema != SCHEMA
                || child.file_name().and_then(|name| name.to_str())
                    != Some(digest(&encode(&old)?).as_str())
            {
                return Err("Unknown earlier journal identity; inspect manually.".into());
            }
            let completed = record::<Pending>(&child.join("completed.json"))?;
            if completed
                .as_ref()
                .is_some_and(|completed| completed != &old)
            {
                return Err("Corrupt earlier completion evidence; inspect manually.".into());
            }
            if old
                .files
                .iter()
                .any(|old| pending.files.iter().any(|new| new.path == old.path))
                && completed.is_none()
            {
                return Err(
                    "An earlier migration for these settings requires recovery review.".into(),
                );
            }
        }
        let existing = record::<Pending>(&directory.join("pending.json"))?;
        if let Some(existing) = &existing {
            if existing != &pending {
                return Err("Migration identity collision; no changes attempted.".into());
            }
        }
        if already_after.iter().any(|after| *after) && existing.is_none() {
            return Err("Matching target bytes without an existing journal do not prove migration; no adoption attempted.".into());
        }
        storage::private_directory(&directory)?;
        let transaction = Self { directory, pending };
        if existing.is_some() {
            transaction.validate()?;
            for (index, after) in already_after.iter().enumerate() {
                if *after && transaction.status(index)? != Status::Applied {
                    return Err("Matching target bytes lack proven publication evidence; recovery review required.".into());
                }
            }
        }
        for (index, (before, after)) in images.into_iter().enumerate() {
            let entry = &transaction.pending.files[index];
            storage::retain_image(&entry.path, &before)?;
            storage::durable_image(&transaction.image(index, "before"), &before)?;
            hook(Boundary::BeforeImage(index))?;
            storage::durable_image(&transaction.image(index, "after"), &after)?;
            hook(Boundary::AfterImage(index))?;
        }
        put(
            &transaction.directory.join("pending.json"),
            &transaction.pending,
        )?;
        hook(Boundary::Pending)?;
        Ok(transaction)
    }

    /// Explicit scope is mandatory. The journal is local evidence, not authorization.
    /// Missing targets are allowed for read-only classification, never recreated.
    pub(crate) fn open(directory: &Path, expected_paths: &[PathBuf]) -> Result<Self, String> {
        storage::reject_links(directory)?;
        let directory =
            fs::canonicalize(directory).map_err(|_| "Migration journal is unavailable.")?;
        let pending: Pending = record(&directory.join("pending.json"))?
            .ok_or("Incomplete migration preparation; inspect manually.")?;
        if pending.schema != SCHEMA
            || pending.files.is_empty()
            || pending.files.len() > MAX_FILES
            || directory.file_name().and_then(|s| s.to_str())
                != Some(digest(&encode(&pending)?).as_str())
        {
            return Err("Invalid migration journal identity.".into());
        }
        let expected: Vec<_> = expected_paths
            .iter()
            .map(|path| canonical_scope_target(path))
            .collect::<Result<_, String>>()?;
        if expected.len() != pending.files.len()
            || pending
                .files
                .iter()
                .any(|entry| !expected.contains(&entry.path))
            || expected.iter().any(|path| {
                pending
                    .files
                    .iter()
                    .filter(|entry| entry.path == *path)
                    .count()
                    != 1
            })
        {
            return Err("Recovery scope does not match the reviewed journal.".into());
        }
        let transaction = Self { directory, pending };
        transaction.validate()?;
        Ok(transaction)
    }

    /// A central batch journal may use a subset of independently known client
    /// paths. No path in its manifest grants authority outside that allowlist.
    pub(crate) fn open_allowlisted(
        directory: &Path,
        allowed_paths: &[PathBuf],
    ) -> Result<Self, String> {
        storage::reject_links(directory)?;
        let pending: Pending = record(&directory.join("pending.json"))?
            .ok_or("Incomplete migration preparation; inspect manually.")?;
        if pending.files.is_empty()
            || pending.files.len() > MAX_FILES
            || allowed_paths.len() > MAX_FILES
        {
            return Err("Invalid recovery scope size.".into());
        }
        let mut allowed = Vec::new();
        for path in allowed_paths {
            storage::reject_links(path)?;
            let parent = path.parent().ok_or("Recovery scope path has no parent.")?;
            if !parent.exists() {
                continue;
            }
            allowed.push(canonical_scope_target(path)?);
        }
        let mut selected = Vec::new();
        for entry in pending.files {
            let path = allowed
                .iter()
                .find(|path| **path == entry.path)
                .ok_or("Recovery journal includes an unapproved settings path.")?;
            selected.push(path.clone());
        }
        Self::open(directory, &selected)
    }

    fn image(&self, index: usize, kind: &str) -> PathBuf {
        self.directory.join(format!("{index}.{kind}.bin"))
    }
    fn evidence(&self, index: usize, kind: &str) -> PathBuf {
        self.directory.join(format!("{index}.{kind}.json"))
    }
    fn capture(&self, index: usize) -> PathBuf {
        self.pending.files[index]
            .path
            .parent()
            .unwrap()
            .join(format!(
                ".creator-hub-migration-{}-{index}",
                self.directory.file_name().unwrap().to_string_lossy()
            ))
    }
    fn displaced(&self, index: usize) -> Result<PathBuf, String> {
        let capture = self.capture(index);
        let raw = capture.join("displaced.bin");
        let retained = capture.join("retained.bin");
        storage::reject_links(&raw)?;
        storage::reject_links(&retained)?;
        if raw.exists() && retained.exists() {
            return Err("Two displaced images require manual recovery review.".into());
        }
        Ok(if retained.exists() { retained } else { raw })
    }
    fn intent(&self, index: usize) -> Intent {
        let entry = &self.pending.files[index];
        Intent {
            schema: SCHEMA,
            before_sha256: entry.before_sha256.clone(),
            after_sha256: entry.after_sha256.clone(),
        }
    }
    fn validate(&self) -> Result<(), String> {
        storage::reject_links(&self.directory)?;
        for (index, entry) in self.pending.files.iter().enumerate() {
            if entry.client.is_empty()
                || entry.client.len() > 256
                || entry.client.chars().any(char::is_control)
                || !entry.path.is_absolute()
                || entry.before_sha256 == entry.after_sha256
            {
                return Err("Invalid reviewed migration member.".into());
            }
            storage::reject_links(&entry.path)?;
            for (kind, hash) in [
                ("before", &entry.before_sha256),
                ("after", &entry.after_sha256),
            ] {
                let bytes = storage::read_bytes(&self.image(index, kind))?
                    .ok_or("Missing retained migration image.")?;
                if digest(&bytes) != *hash {
                    return Err(
                        "Retained migration image is corrupt; no settings were changed.".into(),
                    );
                }
            }
            if let Some(intent) = record::<Intent>(&self.evidence(index, "intent"))? {
                if intent != self.intent(index) {
                    return Err("Publication intent does not match the review.".into());
                }
            }
            if let Some(outcome) = record::<Outcome>(&self.evidence(index, "outcome"))? {
                if outcome.schema != SCHEMA || outcome.status == Status::Ready {
                    return Err("Invalid migration outcome.".into());
                }
            }
            if let Some(native) = record::<NativeResult>(&self.evidence(index, "native"))? {
                if native.schema != SCHEMA || native.success && native.error.is_some() {
                    return Err("Invalid native publication evidence.".into());
                }
            }
            let before = storage::read_bytes(&self.image(index, "before"))?.unwrap();
            let backup = entry
                .path
                .parent()
                .unwrap()
                .join(".creator-hub-settings-backups")
                .join(format!(
                    "{}.{}.bak",
                    entry.path.file_name().unwrap().to_string_lossy(),
                    entry.before_sha256
                ));
            if storage::read_bytes(&backup)?.as_deref() != Some(&before) {
                return Err("Retained before-image backup is unavailable or changed.".into());
            }
        }
        Ok(())
    }

    fn status(&self, index: usize) -> Result<Status, String> {
        let entry = &self.pending.files[index];
        let Ok(current) = storage::read_bytes(&entry.path) else {
            return Ok(Status::Unknown);
        };
        let current_hash = current.as_deref().map(digest);
        let Ok(displaced_path) = self.displaced(index) else {
            return Ok(Status::Unknown);
        };
        let Ok(displaced) = storage::read_bytes(&displaced_path) else {
            return Ok(Status::Unknown);
        };
        let displaced_hash = displaced.as_deref().map(digest);
        let intent = record::<Intent>(&self.evidence(index, "intent"))?;
        let outcome = record::<Outcome>(&self.evidence(index, "outcome"))?;
        let stage = self.capture(index).join("stage.bin");
        if intent.is_some() && (storage::reject_links(&stage).is_err() || stage.exists()) {
            return Ok(Status::Unknown);
        }
        if let Some(outcome) = outcome {
            if outcome.status != Status::Applied {
                return Ok(outcome.status);
            }
            if intent.is_none() {
                return Ok(Status::Unknown);
            }
            if displaced_hash.as_ref() != Some(&entry.before_sha256) {
                return Ok(Status::Unknown);
            }
            return Ok(if current_hash.as_ref() == Some(&entry.after_sha256) {
                Status::Applied
            } else {
                Status::ExternalChange
            });
        }
        if intent.is_none() {
            if displaced.is_some() {
                return Ok(Status::Unknown);
            }
            return Ok(if current_hash.as_ref() == Some(&entry.before_sha256) {
                Status::Ready
            } else {
                Status::ExternalChange
            });
        }
        if record::<NativeResult>(&self.evidence(index, "native"))?
            .is_some_and(|native| !native.success)
        {
            return Ok(Status::Unknown);
        }
        if let Some(hash) = displaced_hash {
            if hash != entry.before_sha256 {
                return Ok(Status::PublicationConflict);
            }
            if current_hash.as_ref() == Some(&entry.after_sha256) {
                return Ok(Status::Applied);
            }
            return Ok(Status::Unknown);
        }
        // Intent without displaced evidence is not permission to retry, even if bytes look old.
        Ok(Status::Unknown)
    }

    fn inspect_unlocked(&self) -> Result<Report, String> {
        self.validate()?;
        let mut files = Vec::new();
        for (index, entry) in self.pending.files.iter().enumerate() {
            let before = storage::read_bytes(&self.image(index, "before"))?.unwrap();
            let name = entry.path.file_name().unwrap().to_string_lossy();
            files.push(FileReport {
                client: entry.client.clone(),
                path: entry.path.clone(),
                status: self.status(index)?,
                before_image: self.image(index, "before"),
                after_image: self.image(index, "after"),
                before_backup: entry
                    .path
                    .parent()
                    .unwrap()
                    .join(".creator-hub-settings-backups")
                    .join(format!("{name}.{}.bak", digest(&before))),
                displaced: self
                    .displaced(index)
                    .unwrap_or_else(|_| self.capture(index).join("displaced.bin")),
                stage: self.capture(index).join("stage.bin"),
            });
        }
        let completed = record::<Pending>(&self.directory.join("completed.json"))?;
        if completed
            .as_ref()
            .is_some_and(|record| record != &self.pending)
        {
            return Err("Invalid completion evidence.".into());
        }
        Ok(Report {
            journal: self.directory.clone(),
            historical_completed: completed.is_some(),
            completed: completed.is_some()
                && files.iter().all(|file| file.status == Status::Applied),
            files,
        })
    }

    /// Read-only with respect to every config and journal record (except cooperative lock file).
    pub(crate) fn inspect(&self) -> Result<Report, String> {
        let _lock = lock(self.directory.parent().unwrap())?;
        self.inspect_unlocked()
    }

    /// Renewed review may finish Ready members and record proven interrupted publication.
    /// Unknown/conflicting outcomes never restore, recreate or retry a client file.
    pub(crate) fn resume(&self, approve: impl FnOnce(&Report) -> bool) -> Result<Report, String> {
        self.resume_with(approve, &mut |_| Ok(())).map_err(|error| {
            format!(
                "{error} Retain migration evidence at {}. No automatic rollback was attempted.",
                self.directory.display()
            )
        })
    }

    fn resume_with(
        &self,
        approve: impl FnOnce(&Report) -> bool,
        hook: &mut impl FnMut(Boundary) -> Result<(), String>,
    ) -> Result<Report, String> {
        let _lock = lock(self.directory.parent().unwrap())?;
        let report = self.inspect_unlocked()?;
        if !approve(&report) {
            return Ok(report);
        }
        // Do not continue a partially applied batch when any member has changed externally.
        if report
            .files
            .iter()
            .any(|file| !matches!(file.status, Status::Ready | Status::Applied))
        {
            self.finish_outcomes()?;
            return self.inspect_unlocked();
        }
        for index in 0..self.pending.files.len() {
            match self.status(index)? {
                Status::Ready => self.publish(index, hook)?,
                Status::Applied => {
                    self.flush_evidence(index)?;
                    self.outcome(index, Status::Applied, None)?;
                }
                _ => break,
            }
            if self.status(index)? != Status::Applied {
                break;
            }
        }
        self.finish_outcomes()?;
        if self
            .inspect_unlocked()?
            .files
            .iter()
            .all(|file| file.status == Status::Applied)
        {
            put(&self.directory.join("completed.json"), &self.pending)?;
            hook(Boundary::Completed)?;
        }
        self.inspect_unlocked()
    }

    fn outcome(
        &self,
        index: usize,
        status: Status,
        native_error: Option<i32>,
    ) -> Result<(), String> {
        let path = self.evidence(index, "outcome");
        if record::<Outcome>(&path)?.is_some() {
            return Ok(());
        }
        put(
            &path,
            &Outcome {
                schema: SCHEMA,
                status,
                native_error,
            },
        )
    }
    fn finish_outcomes(&self) -> Result<(), String> {
        let mut statuses = Vec::new();
        for index in 0..self.pending.files.len() {
            let status = self.status(index)?;
            statuses.push(status);
            if status != Status::Ready {
                if status == Status::Unknown
                    && record::<Intent>(&self.evidence(index, "intent"))?.is_none()
                {
                    continue; // A busy pre-publication read does not create a terminal write outcome.
                }
                if status == Status::Applied {
                    self.flush_evidence(index)?;
                }
                self.outcome(index, status, None)?;
            }
        }
        // A new immutable snapshot on each changed outcome; no in-place journal updates.
        let bytes = encode(&statuses)?;
        storage::durable_image(
            &self
                .directory
                .join(format!("outcome-{}.json", digest(&bytes))),
            &bytes,
        )
    }

    fn flush_evidence(&self, index: usize) -> Result<(), String> {
        let displaced = self.displaced(index)?;
        for path in [&self.pending.files[index].path, &displaced] {
            storage::reject_links(path)?;
            let file = storage::protected_options()
                .write(true)
                .open(path)
                .map_err(|_| "Cannot reserve published evidence for flush; no retry attempted.")?;
            file.sync_all()
                .map_err(|_| "Cannot flush publication evidence; retain journal for recovery.")?;
        }
        self.seal_displaced(index)?;
        Ok(())
    }

    fn seal_displaced(&self, index: usize) -> Result<(), String> {
        let raw = self.capture(index).join("displaced.bin");
        if raw.exists() {
            let file = storage::protected_options()
                .write(true)
                .open(&raw)
                .map_err(|_| "Displaced settings are retained but cannot be reserved for flush.")?;
            file.sync_all()
                .map_err(|_| "Cannot flush displaced settings; recovery required.")?;
            drop(file);
            storage::durable_move(&raw, &self.capture(index).join("retained.bin"))
                .map_err(|_| "Cannot seal displaced settings; all recovery files were retained.")?;
        }
        Ok(())
    }

    fn publish(
        &self,
        index: usize,
        hook: &mut impl FnMut(Boundary) -> Result<(), String>,
    ) -> Result<(), String> {
        #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
        {
            let _ = hook;
            self.outcome(index, Status::Unsupported, None)?;
            Ok(())
        }
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            let entry = &self.pending.files[index];
            let capture = self.capture(index);
            storage::private_directory(&capture)?;
            let stage = capture.join("stage.bin");
            let displaced = capture.join("displaced.bin");
            if fs::symlink_metadata(&displaced).is_ok()
                || fs::symlink_metadata(capture.join("retained.bin")).is_ok()
            {
                return Err("Unexplained displaced file; no publication attempted.".into());
            }
            let after = storage::read_bytes(&self.image(index, "after"))?.unwrap();
            storage::durable_image(&stage, &after)?;
            hook(Boundary::Stage(index))?;
            if storage::read_bytes(&entry.path)?
                .as_deref()
                .map(digest)
                .as_ref()
                != Some(&entry.before_sha256)
            {
                self.outcome(index, Status::ExternalChange, None)?;
                return Ok(());
            }
            let mut publisher = unix_publication::Capture::prepare(
                &entry.path,
                &stage,
                &displaced,
                &entry.after_sha256,
            )
            .map_err(|error| {
                format!("Cannot prepare Unix capture ({error}); no publication attempted.")
            })?;
            put(&self.evidence(index, "intent"), &self.intent(index))?;
            hook(Boundary::Intent(index))?;
            hook(Boundary::BeforePublish(index))?;
            let result = match publisher.exchange() {
                Ok(()) => {
                    hook(Boundary::Swapped(index))?;
                    publisher.retain()
                }
                Err(error) => Err(error),
            };
            let native_error = result.as_ref().err().and_then(std::io::Error::raw_os_error);
            hook(Boundary::Published(index))?;
            put(
                &self.evidence(index, "native"),
                &NativeResult {
                    schema: SCHEMA,
                    success: result.is_ok(),
                    error: native_error,
                },
            )?;
            hook(Boundary::NativeRecorded(index))?;
            let status = self.status(index)?;
            if fs::symlink_metadata(&displaced).is_ok_and(|metadata| metadata.is_file()) {
                self.seal_displaced(index)?;
            }
            hook(Boundary::DisplacedSealed(index))?;
            if status == Status::Applied {
                self.flush_evidence(index)?;
            }
            hook(Boundary::Captured(index))?;
            self.outcome(index, status, native_error)?;
            hook(Boundary::Outcome(index))?;
            Ok(())
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            let entry = &self.pending.files[index];
            let capture = self.capture(index);
            storage::private_directory(&capture)?;
            let stage = capture.join("stage.bin");
            let displaced = capture.join("displaced.bin");
            if storage::read_bytes(&displaced)?.is_some() {
                return Err("Unexplained displaced file; no publication attempted.".into());
            }
            let after = storage::read_bytes(&self.image(index, "after"))?.unwrap();
            storage::durable_image(&stage, &after)?;
            hook(Boundary::Stage(index))?;
            storage::reject_links(&entry.path)?;
            // This denies writers to THIS object, not replacement of its pathname.
            let mut guarded = OpenOptions::new()
                .read(true)
                .share_mode(1 | 4)
                .open(&entry.path)
                .map_err(|_| {
                    "Cannot reserve client settings; retained journal is ready for review."
                })?;
            if digest(&storage::read(&mut guarded)?) != entry.before_sha256 {
                self.outcome(index, Status::ExternalChange, None)?;
                return Ok(());
            }
            put(&self.evidence(index, "intent"), &self.intent(index))?;
            hook(Boundary::Intent(index))?;
            hook(Boundary::BeforePublish(index))?;
            // No fallbacks. In particular, never rename over a failed or missing target.
            let result = replace_with_capture(&entry.path, &stage, &displaced);
            let native_error = result.as_ref().err().and_then(io::Error::raw_os_error);
            hook(Boundary::Published(index))?;
            drop(guarded);
            put(
                &self.evidence(index, "native"),
                &NativeResult {
                    schema: SCHEMA,
                    success: result.is_ok(),
                    error: native_error,
                },
            )?;
            hook(Boundary::NativeRecorded(index))?;
            let status = self.status(index)?;
            // Displaced bytes are never deleted, including on native failure/conflict.
            if displaced.is_file() {
                self.seal_displaced(index)?;
            }
            hook(Boundary::DisplacedSealed(index))?;
            if status == Status::Applied {
                self.flush_evidence(index)?;
            }
            hook(Boundary::Captured(index))?;
            // A failed native call with apparently matching bytes is still an unknown outcome.
            self.outcome(
                index,
                if result.is_err() && status == Status::Applied {
                    Status::Unknown
                } else {
                    status
                },
                native_error,
            )?;
            hook(Boundary::Outcome(index))?;
            Ok(())
        }
    }
}

#[cfg(windows)]
fn replace_with_capture(destination: &Path, stage: &Path, displaced: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    let (destination, stage, displaced) = (wide(destination), wide(stage), wide(displaced));
    // REPLACEFILE_WRITE_THROUGH is documented as unsupported. Use explicit flushes.
    if unsafe {
        ReplaceFileW(
            destination.as_ptr(),
            stage.as_ptr(),
            displaced.as_ptr(),
            0,
            std::ptr::null(),
            std::ptr::null(),
        )
    } == 0
    {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
#[path = "migration_recovery_tests.rs"]
mod tests;
