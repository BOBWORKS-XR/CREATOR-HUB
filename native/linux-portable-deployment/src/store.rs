use crate::{
    digest, filesystem as disk, hex, production_verify, refused, require, signed_manifest, Entry,
    Error, ErrorKind, Expected, Manifest, Result, VerifiedPackage, Verifier, MAX_FILE,
    MAX_MANIFEST, MAX_SIGNATURE,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

const MARKER: &[u8] = b"creator-hub-linux-portable-deployment-v1\n";
const RECORD_LIMIT: u64 = 16384;

#[path = "bootstrap.rs"]
pub(crate) mod bootstrap;
#[path = "host.rs"]
pub(crate) mod host;
#[path = "registration.rs"]
pub(crate) mod registration;
#[cfg(feature = "experimental-restart")]
#[path = "restart.rs"]
pub(crate) mod restart;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub schema_version: u32,
    pub generation: String,
    pub version: String,
    pub previous_generation: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelectionSnapshot {
    bytes: Vec<u8>,
    selection: Selection,
}
impl SelectionSnapshot {
    pub fn selection(&self) -> &Selection {
        &self.selection
    }
}

#[derive(Debug)]
pub enum Activation {
    Committed(SelectionSnapshot),
    Unchanged(SelectionSnapshot),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecoveryState {
    PreparedOldSelectionRetained,
    SelectionCommitted,
}

#[derive(Clone, Debug)]
pub struct Recovery {
    pub state: RecoveryState,
    pub current: Option<SelectionSnapshot>,
    pub previous: Option<SelectionSnapshot>,
    pub target_generation: String,
    pending: Vec<u8>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Transition {
    schema_version: u32,
    before: Option<Selection>,
    after: Selection,
}

pub struct Store {
    root: PathBuf,
}

impl Store {
    /// Exclusive new dedicated store only. Never adopt settings/runtime directories.
    pub fn create(root: &Path) -> Result<Self> {
        disk::admit()?;
        Self::create_inner(root)
    }
    pub fn open(root: &Path) -> Result<Self> {
        disk::admit()?;
        Self::open_inner(root)
    }

    fn create_inner(root: &Path) -> Result<Self> {
        Self::create_checkpointed(root, &|_| Ok(()))
    }

    pub(super) fn create_checkpointed(
        root: &Path,
        checkpoint: &dyn Fn(&str) -> Result<()>,
    ) -> Result<Self> {
        disk::create_dir(root)?;
        checkpoint("bootstrap-directory-created")?;
        disk::write_new(&root.join("store.id"), MARKER, 0o600)?;
        checkpoint("bootstrap-marker-written")?;
        disk::write_new(&root.join("transaction.lock"), b"", 0o600)?;
        checkpoint("bootstrap-lock-written")?;
        disk::create_dir(&root.join("generations"))?;
        checkpoint("bootstrap-generations-created")?;
        disk::create_dir(&root.join("history"))?;
        checkpoint("bootstrap-history-created")?;
        disk::sync_dir(root)?;
        disk::sync_dir(
            root.parent()
                .ok_or_else(|| refused("Store parent missing"))?,
        )?;
        Self::open_inner(root)
    }

    fn open_inner(root: &Path) -> Result<Self> {
        disk::metadata(root, true, Some(0o700), true)?;
        require(
            disk::read_regular(&root.join("store.id"), 128, true)? == MARKER,
            "Not a portable deployment store",
        )?;
        disk::metadata(&root.join("transaction.lock"), false, Some(0o600), true)?;
        disk::metadata(&root.join("generations"), true, Some(0o700), true)?;
        disk::metadata(&root.join("history"), true, Some(0o700), true)?;
        Ok(Self { root: root.into() })
    }

    fn checked(&self) -> Result<()> {
        Self::open_inner(&self.root).map(|_| ())
    }

    /// Stage only; neither this function nor the returned identifier selects or executes it.
    pub fn stage(&self, package: &VerifiedPackage, cancelled: impl Fn() -> bool) -> Result<String> {
        self.stage_with(package, &cancelled, &|_| Ok(()), &production_verify)
    }

    fn stage_with(
        &self,
        package: &VerifiedPackage,
        cancelled: &dyn Fn() -> bool,
        checkpoint: &dyn Fn(&str) -> Result<()>,
        verifier: &Verifier,
    ) -> Result<String> {
        self.checked()?;
        let _lock = disk::lock(&self.root.join("transaction.lock"))?;
        let expected = Expected::linux_x86_64(&package.manifest.version)?;
        signed_manifest(&package.bytes, &package.signature, &expected, verifier)?;
        cancel(cancelled)?;
        let generation = package.generation();
        let parent = self.root.join("generations");
        let target = parent.join(&generation);
        if fs::symlink_metadata(&target).is_ok() {
            self.generation(&generation, &expected, verifier)?;
            return Ok(generation);
        }
        let staging = tempfile::Builder::new()
            .prefix(".staging-")
            .tempdir_in(&parent)
            .map_err(|_| refused("Cannot reserve private generation staging"))?;
        disk::set_mode(staging.path(), 0o700)?;
        let appdir = staging.path().join("AppDir");
        disk::create_dir(&appdir)?;
        disk::write_new(&staging.path().join("manifest.json"), &package.bytes, 0o444)?;
        disk::write_new(
            &staging.path().join("manifest.minisig"),
            &package.signature,
            0o444,
        )?;
        checkpoint("metadata-staged")?;
        // Manifest parent entries are mandatory and sort before their children.
        for (name, entry) in &package.manifest.entries {
            cancel(cancelled)?;
            let path = appdir.join(name);
            match entry {
                Entry::Directory { .. } => disk::create_dir(&path)?,
                Entry::File { mode, .. } => {
                    disk::write_new(&path, &package.contents[name], mode & !0o222)?
                }
            }
            checkpoint("member-staged")?;
        }
        for (name, entry) in package.manifest.entries.iter().rev() {
            if matches!(entry, Entry::Directory { .. }) {
                disk::set_mode(&appdir.join(name), 0o555)?;
                disk::sync_dir(&appdir.join(name))?;
            }
        }
        disk::set_mode(&appdir, 0o555)?;
        disk::sync_dir(&appdir)?;
        disk::set_mode(staging.path(), 0o555)?;
        disk::sync_dir(staging.path())?;
        verify_tree(
            staging.path(),
            &package.manifest,
            &package.bytes,
            &package.signature,
        )?;
        checkpoint("generation-verified")?;
        cancel(cancelled)?;
        self.checked()?;
        require(
            fs::symlink_metadata(&target).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound),
            "Generation appeared during staging",
        )?;
        fs::rename(staging.path(), &target)
            .map_err(|_| refused("Cannot publish verified generation"))?;
        checkpoint("generation-published")?;
        disk::sync_dir(&parent)?;
        self.generation(&generation, &expected, verifier)?;
        Ok(generation)
    }

    pub fn snapshot(&self) -> Result<Option<SelectionSnapshot>> {
        self.snapshot_with(&production_verify)
    }

    fn snapshot_with(&self, verifier: &Verifier) -> Result<Option<SelectionSnapshot>> {
        self.checked()?;
        let Some(bytes) = optional_record(&self.root.join("current.json"))? else {
            return Ok(None);
        };
        let selection = parse_selection(&bytes)?;
        self.generation(
            &selection.generation,
            &Expected::linux_x86_64(&selection.version)?,
            verifier,
        )?;
        Ok(Some(SelectionSnapshot { bytes, selection }))
    }

    /// Compare-and-swap against the caller's reviewed snapshot. No default overwrite.
    pub fn activate(
        &self,
        generation: &str,
        expected: &Expected,
        previous: Option<&SelectionSnapshot>,
        cancelled: impl Fn() -> bool,
    ) -> Result<Activation> {
        self.activate_with(
            generation,
            expected,
            previous,
            &cancelled,
            &|_| Ok(()),
            &production_verify,
        )
    }

    fn activate_with(
        &self,
        generation: &str,
        expected: &Expected,
        previous: Option<&SelectionSnapshot>,
        cancelled: &dyn Fn() -> bool,
        checkpoint: &dyn Fn(&str) -> Result<()>,
        verifier: &Verifier,
    ) -> Result<Activation> {
        self.checked()?;
        let _lock = disk::lock(&self.root.join("transaction.lock"))?;
        require(
            optional_record(&self.root.join("pending.json"))?.is_none(),
            "Pending transaction requires explicit recovery review",
        )
        .map_err(|_| Error {
            kind: ErrorKind::RecoveryRequired,
            message: "Pending transaction requires explicit recovery review",
        })?;
        let before = self.snapshot_with(verifier)?;
        require(
            before.as_ref() == previous,
            "Current selection changed after review",
        )?;
        let target = self.generation(generation, expected, verifier)?;
        if let Some(old) = &before {
            if old.selection.generation == generation {
                return Ok(Activation::Unchanged(old.clone()));
            }
            require(
                semver::Version::parse(&target.version).unwrap()
                    > semver::Version::parse(&old.selection.version).unwrap(),
                "Downgrade or same-version replacement refused",
            )?;
            retain(
                &self
                    .root
                    .join("history")
                    .join(format!("selection-{}.json", digest(&old.bytes))),
                &old.bytes,
            )?;
        }
        cancel(cancelled)?;
        checkpoint("prior-retained")?;
        let selection = Selection {
            schema_version: 1,
            generation: generation.into(),
            version: target.version,
            previous_generation: before.as_ref().map(|s| s.selection.generation.clone()),
        };
        let bytes =
            serde_json::to_vec(&selection).map_err(|_| refused("Cannot encode selection"))?;
        let transition = serde_json::to_vec(&Transition {
            schema_version: 1,
            before: before.as_ref().map(|s| s.selection.clone()),
            after: selection.clone(),
        })
        .map_err(|_| refused("Cannot encode transition"))?;
        retain(
            &self
                .root
                .join("history")
                .join(format!("transaction-{}.json", digest(&transition))),
            &transition,
        )?;
        disk::sync_dir(&self.root.join("history"))?;
        atomic_new_record(&self.root.join("pending.json"), &transition)?;
        checkpoint("journal-synced")?;
        cancel(cancelled)?;
        let mut next = tempfile::Builder::new()
            .prefix(".selection-")
            .tempfile_in(&self.root)
            .map_err(|_| refused("Cannot reserve selection staging"))?;
        disk::set_mode(next.path(), 0o600)?;
        next.write_all(&bytes)
            .and_then(|_| next.as_file().sync_all())
            .map_err(|_| refused("Cannot flush selection staging"))?;
        checkpoint("selection-staged")?;
        cancel(cancelled)?;
        require(
            self.snapshot_with(verifier)? == before,
            "Current selection changed before commit",
        )?;
        self.generation(generation, expected, verifier)?;
        self.checked()?;
        checkpoint("before-commit")?;
        cancel(cancelled)?;
        // Same-filesystem replacement, matching the existing runtime store pattern.
        next.persist(self.root.join("current.json"))
            .map_err(|_| refused("Cannot atomically replace selection; inspect recovery"))?;
        let committed = || -> Result<()> {
            checkpoint("selection-committed")?;
            disk::sync_dir(&self.root)?;
            require(
                self.snapshot_with(verifier)?.as_ref().map(|s| &s.bytes) == Some(&bytes),
                "Committed selection changed",
            )?;
            checkpoint("current-synced")?;
            remove_pending(&self.root, &transition)?;
            Ok(())
        };
        committed().map_err(|_| Error {
            kind: ErrorKind::OutcomeUnknown,
            message: "Selection may be committed; inspect recovery, never retry blindly",
        })?;
        Ok(Activation::Committed(SelectionSnapshot {
            bytes,
            selection,
        }))
    }

    fn generation(&self, id: &str, expected: &Expected, verifier: &Verifier) -> Result<Manifest> {
        require(hex(id, 64), "Exact generation digest required")?;
        let root = self.root.join("generations").join(id);
        let bytes = disk::read_regular(&root.join("manifest.json"), MAX_MANIFEST as u64, true)?;
        let signature =
            disk::read_regular(&root.join("manifest.minisig"), MAX_SIGNATURE as u64, true)?;
        require(digest(&bytes) == id, "Generation metadata identity differs")?;
        let manifest = signed_manifest(&bytes, &signature, expected, verifier)?;
        verify_tree(&root, &manifest, &bytes, &signature)?;
        Ok(manifest)
    }

    pub fn recovery(&self) -> Result<Option<Recovery>> {
        self.recovery_with(&production_verify)
    }

    fn recovery_with(&self, verifier: &Verifier) -> Result<Option<Recovery>> {
        self.checked()?;
        let _lock = disk::lock(&self.root.join("transaction.lock"))?;
        self.recovery_unlocked(verifier)
    }

    fn recovery_unlocked(&self, verifier: &Verifier) -> Result<Option<Recovery>> {
        let Some(pending) = optional_record(&self.root.join("pending.json"))? else {
            return Ok(None);
        };
        let transition: Transition = serde_json::from_slice(&pending)
            .map_err(|_| refused("Invalid pending transaction; retained unchanged"))?;
        require(
            transition.schema_version == 1,
            "Unknown pending transaction schema",
        )?;
        let previous = transition
            .before
            .map(|selection| -> Result<_> {
                let bytes = serde_json::to_vec(&selection)
                    .map_err(|_| refused("Invalid previous selection"))?;
                parse_selection(&bytes)?;
                self.generation(
                    &selection.generation,
                    &Expected::linux_x86_64(&selection.version)?,
                    verifier,
                )?;
                Ok(SelectionSnapshot { bytes, selection })
            })
            .transpose()?;
        let after_bytes = serde_json::to_vec(&transition.after)
            .map_err(|_| refused("Invalid target selection"))?;
        parse_selection(&after_bytes)?;
        self.generation(
            &transition.after.generation,
            &Expected::linux_x86_64(&transition.after.version)?,
            verifier,
        )?;
        let current = self.snapshot_with(verifier)?;
        let state = if current == previous {
            RecoveryState::PreparedOldSelectionRetained
        } else if current.as_ref().is_some_and(|s| s.bytes == after_bytes) {
            RecoveryState::SelectionCommitted
        } else {
            return Err(refused(
                "Current selection matches neither transaction side; nothing adopted",
            ));
        };
        Ok(Some(Recovery {
            state,
            current,
            previous,
            target_generation: transition.after.generation,
            pending,
        }))
    }

    /// Acknowledge the observed commit state only. Never rollback, select target or execute.
    pub fn acknowledge_recovery(&self, reviewed: &Recovery) -> Result<()> {
        self.acknowledge_with(reviewed, &production_verify)
    }

    fn acknowledge_with(&self, reviewed: &Recovery, verifier: &Verifier) -> Result<()> {
        self.checked()?;
        let _lock = disk::lock(&self.root.join("transaction.lock"))?;
        let actual = self
            .recovery_unlocked(verifier)?
            .ok_or_else(|| refused("Pending transaction disappeared"))?;
        require(
            actual.pending == reviewed.pending
                && actual.current == reviewed.current
                && actual.state == reviewed.state,
            "Recovery state changed since review",
        )?;
        retain(
            &self
                .root
                .join("history")
                .join(format!("transaction-{}.json", digest(&actual.pending))),
            &actual.pending,
        )?;
        disk::sync_dir(&self.root.join("history"))?;
        remove_pending(&self.root, &actual.pending)
    }
}

fn cancel(cancelled: &dyn Fn() -> bool) -> Result<()> {
    if cancelled() {
        Err(Error {
            kind: ErrorKind::Cancelled,
            message: "Cancelled before selection commit; previous selection retained",
        })
    } else {
        Ok(())
    }
}

fn parse_selection(bytes: &[u8]) -> Result<Selection> {
    let selection: Selection = serde_json::from_slice(bytes)
        .map_err(|_| refused("Malformed selection; no fallback adopted"))?;
    require(
        selection.schema_version == 1
            && hex(&selection.generation, 64)
            && selection
                .previous_generation
                .as_deref()
                .is_none_or(|v| hex(v, 64) && v != selection.generation),
        "Invalid selection identity",
    )?;
    Expected::linux_x86_64(&selection.version)?;
    require(
        serde_json::to_vec(&selection).map_err(|_| refused("Cannot encode selection"))? == bytes,
        "Noncanonical selection record; kept unchanged",
    )?;
    Ok(selection)
}

fn optional_record(path: &Path) -> Result<Option<Vec<u8>>> {
    disk::unlinked(path)?;
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(refused("Cannot inspect selection record")),
        Ok(_) => {
            disk::metadata(path, false, Some(0o600), true)?;
            disk::read_regular(path, RECORD_LIMIT, true).map(Some)
        }
    }
}

fn retain(path: &Path, bytes: &[u8]) -> Result<()> {
    if fs::symlink_metadata(path).is_ok() {
        disk::metadata(path, false, Some(0o600), true)?;
        require(
            disk::read_regular(path, RECORD_LIMIT, true)? == bytes,
            "Historical record changed; not overwritten",
        )
    } else {
        atomic_new_record(path, bytes)
    }
}

fn atomic_new_record(path: &Path, bytes: &[u8]) -> Result<()> {
    atomic_new_record_with_directory_flush(path, bytes, &disk::sync_dir)
}

fn atomic_new_record_with_directory_flush(
    path: &Path,
    bytes: &[u8],
    flush_parent: &dyn Fn(&Path) -> Result<()>,
) -> Result<()> {
    disk::unlinked(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| refused("Record parent missing"))?;
    disk::metadata(parent, true, Some(0o700), true)?;
    let mut staged = tempfile::Builder::new()
        .prefix(".record-")
        .tempfile_in(parent)
        .map_err(|_| refused("Cannot reserve atomic record staging"))?;
    disk::set_mode(staged.path(), 0o600)?;
    staged
        .write_all(bytes)
        .and_then(|_| staged.as_file().sync_all())
        .map_err(|_| refused("Cannot flush atomic record"))?;
    staged
        .persist_noclobber(path)
        .map_err(|_| refused("Cannot publish new record; existing record kept"))?;
    // The name is already published: a failed directory flush is not a refusal
    // with unchanged state, even when no later transaction step has run.
    flush_parent(parent).map_err(|_| Error {
        kind: ErrorKind::OutcomeUnknown,
        message: "Record was published but its directory flush failed; review retained evidence before retrying",
    })
}

fn remove_pending(root: &Path, expected: &[u8]) -> Result<()> {
    require(
        optional_record(&root.join("pending.json"))?.as_deref() == Some(expected),
        "Pending transaction changed; retained",
    )?;
    fs::remove_file(root.join("pending.json"))
        .map_err(|_| refused("Cannot acknowledge pending transaction"))?;
    disk::sync_dir(root)
}

fn verify_tree(root: &Path, manifest: &Manifest, bytes: &[u8], signature: &[u8]) -> Result<()> {
    disk::metadata(root, true, Some(0o555), true)?;
    let names = fs::read_dir(root)
        .map_err(|_| refused("Cannot inspect generation"))?
        .take(4)
        .map(|v| v.map(|e| e.file_name()))
        .collect::<std::io::Result<BTreeSet<_>>>()
        .map_err(|_| refused("Cannot inspect generation entries"))?;
    require(
        names
            == ["AppDir", "manifest.json", "manifest.minisig"]
                .map(std::ffi::OsString::from)
                .into(),
        "Unexpected generation files",
    )?;
    for (name, expected) in [("manifest.json", bytes), ("manifest.minisig", signature)] {
        disk::metadata(&root.join(name), false, Some(0o444), true)?;
        require(
            disk::read_regular(&root.join(name), MAX_MANIFEST as u64, true)? == expected,
            "Retained generation metadata changed",
        )?;
    }
    let appdir = root.join("AppDir");
    disk::metadata(&appdir, true, Some(0o555), true)?;
    let mut pending = vec![(appdir.clone(), String::new())];
    let mut seen = BTreeSet::new();
    while let Some((directory, prefix)) = pending.pop() {
        for item in fs::read_dir(directory).map_err(|_| refused("Cannot inspect AppDir"))? {
            let item = item.map_err(|_| refused("Cannot inspect AppDir member"))?;
            let leaf = item
                .file_name()
                .into_string()
                .map_err(|_| refused("Noncanonical deployed name"))?;
            let name = if prefix.is_empty() {
                leaf
            } else {
                format!("{prefix}/{leaf}")
            };
            require(
                seen.len() < manifest.entries.len() && seen.insert(name.clone()),
                "Extra/duplicate deployed entry",
            )?;
            let entry = manifest
                .entries
                .get(&name)
                .ok_or_else(|| refused("Unlisted deployed file"))?;
            match entry {
                Entry::Directory { .. } => {
                    disk::metadata(&item.path(), true, Some(0o555), true)?;
                    pending.push((item.path(), name));
                }
                Entry::File { size, sha256, mode } => {
                    let info = disk::metadata(&item.path(), false, Some(mode & !0o222), true)?;
                    let data = disk::read_regular(&item.path(), MAX_FILE, true)?;
                    require(
                        info.len() == *size && digest(&data) == *sha256,
                        "Deployed file size/hash differs",
                    )?;
                    if name == crate::ENTRYPOINT {
                        require(
                            data.len() >= 20
                                && data[..7] == *b"\x7fELF\x02\x01\x01"
                                && data[18..20] == [0x3e, 0],
                            "Deployed entrypoint architecture differs",
                        )?;
                    }
                }
            }
        }
    }
    require(
        seen.len() == manifest.entries.len(),
        "Incomplete deployed tree",
    )
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
