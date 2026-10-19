//! Offline, user-scoped registration. Only signed inventory bytes can become
//! the stable selector. Recovery is explicit and never alters Hub selection.
use super::*;
use crate::store::host::HostSession;

pub const SELECTOR_ENTRYPOINT: &str = "usr/libexec/creator-hub-portable-selector";
const DIRECTORY: &str = "activation-v1";
const TOOL: &str = "creator-hub-portable-selector";
const SERVICE: &str = "com.creatorworks.hub.Host.service";
const OWNER: &str = "owner.json";
const PENDING: &str = "pending.json";
const TOOL_LIMIT: u64 = 32 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Owner {
    schema_version: u32,
    generation: String,
    version: String,
    selector_sha256: String,
    selector_size: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Transition {
    schema_version: u32,
    before: Option<Owner>,
    after: Option<Owner>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Images {
    tool: Option<Vec<u8>>,
    service: Option<Vec<u8>>,
    owner: Option<Vec<u8>>,
}

/// Read-only review of exact registration before-images and a signed target.
pub struct RegistrationReview {
    root: PathBuf,
    service: PathBuf,
    transition: Transition,
    before: Images,
}

impl RegistrationReview {
    pub fn service_path(&self) -> &Path {
        &self.service
    }
    pub fn selector_path(&self) -> PathBuf {
        self.root.join(DIRECTORY).join(TOOL)
    }
    pub fn selector_sha256(&self) -> Option<&str> {
        self.transition
            .after
            .as_ref()
            .map(|v| v.selector_sha256.as_str())
    }
    pub fn previous_selector_sha256(&self) -> Option<&str> {
        self.transition
            .before
            .as_ref()
            .map(|v| v.selector_sha256.as_str())
    }
    pub fn package_version(&self) -> Option<&str> {
        self.transition.after.as_ref().map(|v| v.version.as_str())
    }
    pub fn removes_registration(&self) -> bool {
        self.transition.after.is_none()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegistrationChoice {
    KeepCurrent,
    ApplyReviewed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegistrationOutcome {
    Declined,
    Unchanged,
    Applied,
}

/// Private fields bind recovery to the exact journal and observed file images.
pub struct RegistrationRecovery {
    root: PathBuf,
    service: PathBuf,
    journal: Vec<u8>,
    observed: Images,
}

impl RegistrationRecovery {
    pub fn service_path(&self) -> &Path {
        &self.service
    }
    pub fn selector_path(&self) -> PathBuf {
        self.root.join(DIRECTORY).join(TOOL)
    }
    pub fn observed_selector_sha256(&self) -> Option<String> {
        self.observed.tool.as_deref().map(digest)
    }
    pub fn before_selector_sha256(&self) -> Result<Option<String>> {
        Ok(transition(&self.journal)?.before.map(|v| v.selector_sha256))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegistrationRecoveryChoice {
    KeepPending,
    RestoreBefore,
}

impl Store {
    /// The package must inventory the fixed selector, independently of AppRun.
    /// Installation/selection is separately reviewed with review_install and
    /// install_reviewed; apply_registration requires that retained generation.
    pub fn review_registration(
        &self,
        session: &HostSession,
        package: &VerifiedPackage,
    ) -> Result<RegistrationReview> {
        disk::admit()?;
        no_global_registration()?;
        self.review_registration_with(session, Some(package), &production_verify)
    }

    pub fn review_unregister(&self, session: &HostSession) -> Result<RegistrationReview> {
        disk::admit()?;
        self.review_registration_with(session, None, &production_verify)
    }

    fn review_registration_with(
        &self,
        session: &HostSession,
        package: Option<&VerifiedPackage>,
        verifier: &Verifier,
    ) -> Result<RegistrationReview> {
        let service = self.registration_paths(session)?;
        let _lock = disk::lock(&self.root.join("transaction.lock"))?;
        self.no_registration_recovery()?;
        let before = self.registration_images(&service)?;
        let previous = self.owned_registration(&service, &before, verifier)?;
        let after = package.map(|p| package_owner(p, verifier)).transpose()?;
        Ok(RegistrationReview {
            root: self.root.clone(),
            service,
            transition: Transition {
                schema_version: 1,
                before: previous,
                after,
            },
            before,
        })
    }

    /// Decline is read-only. A failure after journaling requires explicit
    /// recovery; it does not roll back a separately committed Hub installation.
    pub fn apply_registration(
        &self,
        session: &HostSession,
        review: &RegistrationReview,
        choice: RegistrationChoice,
        cancelled: impl Fn() -> bool,
    ) -> Result<RegistrationOutcome> {
        if choice == RegistrationChoice::KeepCurrent {
            return Ok(RegistrationOutcome::Declined);
        }
        disk::admit()?;
        if review.transition.after.is_some() {
            no_global_registration()?;
        }
        self.apply_registration_with(session, review, &cancelled, &|_| Ok(()), &production_verify)
    }

    fn apply_registration_with(
        &self,
        session: &HostSession,
        review: &RegistrationReview,
        cancelled: &dyn Fn() -> bool,
        checkpoint: &dyn Fn(&str) -> Result<()>,
        verifier: &Verifier,
    ) -> Result<RegistrationOutcome> {
        let service = self.registration_paths(session)?;
        let _lock = disk::lock(&self.root.join("transaction.lock"))?;
        require(
            review.root == self.root && review.service == service,
            "Registration review belongs to another native session/store",
        )?;
        self.no_registration_recovery()?;
        require(
            self.registration_images(&service)? == review.before,
            "Registration changed after review; nothing overwritten",
        )?;
        self.owned_registration(&service, &review.before, verifier)?;
        if let Some(owner) = &review.transition.after {
            let selected = self.snapshot_with(verifier)?;
            require(
                selected.as_ref().is_some_and(|s| {
                    s.selection().generation == owner.generation
                        && s.selection().version == owner.version
                }),
                "Install and select the exact reviewed signed package before registration",
            )?;
        }
        let after = self.owner_images(&service, review.transition.after.as_ref(), verifier)?;
        if review.before == after {
            return Ok(RegistrationOutcome::Unchanged);
        }
        cancel(cancelled)?;
        let directory = self.root.join(DIRECTORY);
        ensure_directory(&directory)?;
        // Parents are user-scoped and never removed, even on cancellation.
        let dbus = service.parent().unwrap().parent().unwrap();
        ensure_directory(dbus)?;
        ensure_directory(service.parent().unwrap())?;
        let journal = encode(&review.transition)?;
        atomic_new_record_with_directory_flush(&directory.join(PENDING), &journal, &|parent| {
            checkpoint("registration-journal-published-before-directory-flush")?;
            disk::sync_dir(parent)
        })?;
        let result = (|| {
            checkpoint("registration-journaled")?;
            cancel(cancelled)?;
            self.write_images(&service, &review.before, &after, checkpoint)?;
            require(
                self.registration_images(&service)? == after,
                "Registration readback differs",
            )?;
            checkpoint("registration-verified")?;
            remove_pending(&directory, &journal)
        })();
        result.map_err(|_| Error { kind: ErrorKind::OutcomeUnknown, message: "Registration interrupted; review its retained journal before retrying. Hub selection and settings were not rolled back." })?;
        Ok(RegistrationOutcome::Applied)
    }

    pub fn registration_recovery(
        &self,
        session: &HostSession,
    ) -> Result<Option<RegistrationRecovery>> {
        disk::admit()?;
        self.registration_recovery_with(session, &production_verify)
    }

    fn registration_recovery_with(
        &self,
        session: &HostSession,
        verifier: &Verifier,
    ) -> Result<Option<RegistrationRecovery>> {
        let service = self.registration_paths(session)?;
        let _lock = disk::lock(&self.root.join("transaction.lock"))?;
        let Some(journal) = self.registration_journal()? else {
            return Ok(None);
        };
        let transition = transition(&journal)?;
        let before = self.owner_images(&service, transition.before.as_ref(), verifier)?;
        let after = self.owner_images(&service, transition.after.as_ref(), verifier)?;
        let observed = self.registration_images(&service)?;
        known_intermediate(&observed, &before, &after)?;
        Ok(Some(RegistrationRecovery {
            root: self.root.clone(),
            service,
            journal,
            observed,
        }))
    }

    /// Restores registration before-images only, never deployment selection.
    /// Foreign/changed files and a changed review/journal refuse all writes.
    pub fn recover_registration(
        &self,
        session: &HostSession,
        review: &RegistrationRecovery,
        choice: RegistrationRecoveryChoice,
    ) -> Result<()> {
        if choice == RegistrationRecoveryChoice::KeepPending {
            return Ok(());
        }
        disk::admit()?;
        if transition(&review.journal)?.before.is_some() {
            no_global_registration()?;
        }
        self.recover_registration_with(session, review, &|_| Ok(()), &production_verify)
    }

    fn recover_registration_with(
        &self,
        session: &HostSession,
        review: &RegistrationRecovery,
        checkpoint: &dyn Fn(&str) -> Result<()>,
        verifier: &Verifier,
    ) -> Result<()> {
        let service = self.registration_paths(session)?;
        let _lock = disk::lock(&self.root.join("transaction.lock"))?;
        require(
            review.root == self.root && review.service == service,
            "Recovery belongs to another native session/store",
        )?;
        require(
            self.registration_journal()?.as_deref() == Some(review.journal.as_slice())
                && self.registration_images(&service)? == review.observed,
            "Recovery evidence changed; retained without writes",
        )?;
        let transition = transition(&review.journal)?;
        let before = self.owner_images(&service, transition.before.as_ref(), verifier)?;
        let after = self.owner_images(&service, transition.after.as_ref(), verifier)?;
        known_intermediate(&review.observed, &before, &after)?;
        (|| {
            self.write_images(&service, &review.observed, &before, checkpoint)?;
            require(
                self.registration_images(&service)? == before,
                "Registration recovery readback differs",
            )?;
            remove_pending(&self.root.join(DIRECTORY), &review.journal)
        })().map_err(|_| Error { kind: ErrorKind::OutcomeUnknown, message: "Registration recovery was interrupted; keep the journal and review again. No deployment selection or settings were rolled back." })
    }

    /// Version comes from a production-verified selection, never this crate's
    /// version or an inherited command-line hint. The lease rechecks the store.
    pub fn selected_activation(&self, session: &HostSession) -> Result<crate::LaunchLease> {
        disk::admit()?;
        self.selected_activation_with(session, &production_verify)
    }

    fn selected_activation_with(
        &self,
        session: &HostSession,
        verifier: &Verifier,
    ) -> Result<crate::LaunchLease> {
        self.registration_paths(session)?;
        self.no_registration_recovery()?;
        let selected = self
            .snapshot_with(verifier)?
            .ok_or_else(|| refused("No verified Hub generation is selected"))?;
        self.activation_lease_with(
            &Expected::linux_x86_64(&selected.selection().version)?,
            verifier,
        )
    }

    /// Fixed selector binary entrypoint. Checks the signed owner receipt and
    /// exact running stable image before spawning AppRun; no D-Bus RPC is added.
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    pub fn activate_registered(&self, session: &HostSession) -> Result<std::process::Child> {
        disk::admit()?;
        no_global_registration()?;
        let service = self.registration_paths(session)?;
        {
            let _lock = disk::lock(&self.root.join("transaction.lock"))?;
            self.no_registration_recovery()?;
            let images = self.registration_images(&service)?;
            require(
                self.owned_registration(&service, &images, &production_verify)?
                    .is_some(),
                "No owned native selector registration",
            )?;
            let tool = self.root.join(DIRECTORY).join(TOOL);
            require(
                std::env::current_exe().ok().as_deref() == Some(tool.as_path()),
                "Activation must run the exact registered stable selector",
            )?;
            let (named, _) = disk::hold_regular(&tool, TOOL_LIMIT, true)?;
            let actual = fs::File::open("/proc/self/exe")
                .map_err(|_| refused("Cannot inspect running selector"))?;
            require(
                super::host::same_file(&named, &actual)?,
                "Running selector differs from signed registered image",
            )?;
        }
        self.selected_activation(session)?.spawn(session)
    }

    fn registration_paths(&self, session: &HostSession) -> Result<PathBuf> {
        self.checked()?;
        require(
            self.root == session.store_path(),
            "Registration must use this native session's fixed store",
        )?;
        let data = self
            .root
            .parent()
            .ok_or_else(|| refused("Native data directory missing"))?;
        disk::metadata(data, true, None, true)?;
        service_bytes(&self.root.join(DIRECTORY).join(TOOL))?;
        let directory = self.root.join(DIRECTORY);
        if fs::symlink_metadata(&directory).is_ok() {
            disk::metadata(&directory, true, Some(0o700), true)?;
        } else {
            disk::unlinked(&directory)?;
        }
        let service = data.join("dbus-1/services").join(SERVICE);
        disk::unlinked(&service)?;
        Ok(service)
    }

    fn registration_journal(&self) -> Result<Option<Vec<u8>>> {
        optional_record(&self.root.join(DIRECTORY).join(PENDING))
    }

    fn no_registration_recovery(&self) -> Result<()> {
        require(
            optional_record(&self.root.join("pending.json"))?.is_none(),
            "Review Hub deployment recovery first",
        )?;
        if self.registration_journal()?.is_some() {
            return Err(Error {
                kind: ErrorKind::RecoveryRequired,
                message: "Review pending native registration recovery first",
            });
        }
        Ok(())
    }

    fn registration_images(&self, service: &Path) -> Result<Images> {
        Ok(Images {
            tool: optional_file(&self.root.join(DIRECTORY).join(TOOL), TOOL_LIMIT, 0o555)?,
            service: optional_file(service, 8192, 0o644)?,
            owner: optional_file(&self.root.join(DIRECTORY).join(OWNER), RECORD_LIMIT, 0o600)?,
        })
    }

    fn owned_registration(
        &self,
        service: &Path,
        images: &Images,
        verifier: &Verifier,
    ) -> Result<Option<Owner>> {
        let owner: Option<Owner> = images.owner.as_deref().map(decode).transpose()?;
        require(
            *images == self.owner_images(service, owner.as_ref(), verifier)?,
            "Unknown or changed registration files; not adopted or overwritten",
        )?;
        Ok(owner)
    }

    fn owner_images(
        &self,
        _service: &Path,
        owner: Option<&Owner>,
        verifier: &Verifier,
    ) -> Result<Images> {
        let Some(owner) = owner else {
            return Ok(Images {
                tool: None,
                service: None,
                owner: None,
            });
        };
        require(
            owner.schema_version == 1 && hex(&owner.generation, 64),
            "Invalid signed selector owner record",
        )?;
        let manifest = self.generation(
            &owner.generation,
            &Expected::linux_x86_64(&owner.version)?,
            verifier,
        )?;
        let bytes = disk::read_regular(
            &self
                .root
                .join("generations")
                .join(&owner.generation)
                .join("AppDir")
                .join(SELECTOR_ENTRYPOINT),
            TOOL_LIMIT,
            true,
        )?;
        selector_bytes(&manifest, &bytes)?;
        require(
            owner.selector_size == bytes.len() as u64 && owner.selector_sha256 == digest(&bytes),
            "Selector owner differs from signed package",
        )?;
        Ok(Images {
            tool: Some(bytes),
            service: Some(service_bytes(&self.root.join(DIRECTORY).join(TOOL))?),
            owner: Some(encode(owner)?),
        })
    }

    fn write_images(
        &self,
        service: &Path,
        before: &Images,
        after: &Images,
        checkpoint: &dyn Fn(&str) -> Result<()>,
    ) -> Result<()> {
        let tool = self.root.join(DIRECTORY).join(TOOL);
        let owner = self.root.join(DIRECTORY).join(OWNER);
        // Disable activation before removal, publish it after installing the tool.
        if after.service.is_none() {
            replace_exact(service, before.service.as_deref(), None, 0o644)?;
            checkpoint("registration-service")?;
        }
        replace_exact(&tool, before.tool.as_deref(), after.tool.as_deref(), 0o555)?;
        checkpoint("registration-tool")?;
        if after.service.is_some() {
            replace_exact(
                service,
                before.service.as_deref(),
                after.service.as_deref(),
                0o644,
            )?;
            checkpoint("registration-service")?;
        }
        replace_exact(
            &owner,
            before.owner.as_deref(),
            after.owner.as_deref(),
            0o600,
        )?;
        checkpoint("registration-owner")
    }
}

fn package_owner(package: &VerifiedPackage, verifier: &Verifier) -> Result<Owner> {
    let manifest = signed_manifest(
        &package.bytes,
        &package.signature,
        &Expected::linux_x86_64(&package.manifest.version)?,
        verifier,
    )?;
    let bytes = package
        .contents
        .get(SELECTOR_ENTRYPOINT)
        .ok_or_else(|| refused("Signed package does not inventory the native selector"))?;
    selector_bytes(&manifest, bytes)?;
    Ok(Owner {
        schema_version: 1,
        generation: package.generation(),
        version: manifest.version,
        selector_sha256: digest(bytes),
        selector_size: bytes.len() as u64,
    })
}

fn selector_bytes(manifest: &Manifest, bytes: &[u8]) -> Result<()> {
    require(
        matches!(manifest.entries.get(SELECTOR_ENTRYPOINT), Some(Entry::File { mode: 0o755, size, sha256 }) if *size == bytes.len() as u64 && *sha256 == digest(bytes))
            && (20..=TOOL_LIMIT).contains(&(bytes.len() as u64))
            && bytes[..7] == *b"\x7fELF\x02\x01\x01"
            && bytes[18..20] == [0x3e, 0],
        "A separately inventoried signed x86_64 selector is required",
    )
}

fn service_bytes(tool: &Path) -> Result<Vec<u8>> {
    let text = tool
        .to_str()
        .ok_or_else(|| refused("UTF-8 native activation path required"))?;
    // Refuse ambiguous Exec syntax instead of introducing shell/desktop quoting.
    require(
        text.len() <= 4096
            && text.starts_with('/')
            && text
                .split('/')
                .skip(1)
                .all(|v| !v.is_empty() && v != "." && v != "..")
            && text
                .bytes()
                .all(|v| v.is_ascii_alphanumeric() || b"/._-".contains(&v)),
        "Native activation path requires safe unquoted ASCII components",
    )?;
    Ok(
        format!("[D-BUS Service]\nName=com.creatorworks.hub.Host\nExec={text} activate\n")
            .into_bytes(),
    )
}

fn optional_file(path: &Path, limit: u64, mode: u32) -> Result<Option<Vec<u8>>> {
    disk::unlinked(path)?;
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(refused("Cannot inspect native registration")),
        Ok(_) => {
            disk::metadata(path, false, Some(mode), true)?;
            disk::read_regular(path, limit, true).map(Some)
        }
    }
}

fn ensure_directory(path: &Path) -> Result<()> {
    if fs::symlink_metadata(path).is_ok() {
        disk::metadata(path, true, None, true).map(|_| ())
    } else {
        disk::create_dir(path)?;
        disk::sync_dir(
            path.parent()
                .ok_or_else(|| refused("Registration parent missing"))?,
        )
    }
}

fn encode(value: &impl Serialize) -> Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(|_| refused("Cannot encode registration evidence"))
}

fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    let value =
        serde_json::from_slice(bytes).map_err(|_| refused("Malformed registration evidence"))?;
    Ok(value)
}

fn transition(bytes: &[u8]) -> Result<Transition> {
    let value: Transition = decode(bytes)?;
    require(
        value.schema_version == 1 && encode(&value)? == bytes,
        "Unknown or noncanonical registration journal",
    )?;
    Ok(value)
}

fn known_intermediate(actual: &Images, before: &Images, after: &Images) -> Result<()> {
    require(
        [
            (&actual.tool, &before.tool, &after.tool),
            (&actual.service, &before.service, &after.service),
            (&actual.owner, &before.owner, &after.owner),
        ]
        .iter()
        .all(|(a, b, c)| a == b || a == c),
        "Recovery contains unknown file images; retained without writes",
    )
}

fn replace_exact(
    path: &Path,
    before: Option<&[u8]>,
    after: Option<&[u8]>,
    mode: u32,
) -> Result<()> {
    let limit = TOOL_LIMIT;
    require(
        optional_file(path, limit, mode)?.as_deref() == before,
        "Registration before-image changed; not overwritten",
    )?;
    if before == after {
        return Ok(());
    }
    let parent = path
        .parent()
        .ok_or_else(|| refused("Registration parent missing"))?;
    if let Some(bytes) = after {
        let mut staged = tempfile::Builder::new()
            .prefix(".activation-")
            .tempfile_in(parent)
            .map_err(|_| refused("Cannot stage native registration"))?;
        disk::set_mode(staged.path(), 0o600)?;
        staged
            .write_all(bytes)
            .and_then(|_| staged.as_file().sync_all())
            .map_err(|_| refused("Cannot flush native registration"))?;
        disk::set_mode(staged.path(), mode)?;
        staged
            .as_file()
            .sync_all()
            .map_err(|_| refused("Cannot flush registration permissions"))?;
        require(
            optional_file(path, limit, mode)?.as_deref() == before,
            "Registration changed during staging",
        )?;
        if before.is_none() {
            staged
                .persist_noclobber(path)
                .map_err(|_| refused("Existing registration was kept"))?;
        } else {
            staged
                .persist(path)
                .map_err(|_| refused("Cannot replace reviewed owned registration"))?;
        }
    } else {
        fs::remove_file(path).map_err(|_| refused("Cannot remove exact owned registration"))?;
    }
    disk::sync_dir(parent)
}

fn no_global_registration() -> Result<()> {
    for path in [
        "/usr/bin/creator-hub",
        "/usr/share/dbus-1/services/com.creatorworks.hub.Host.service",
        "/usr/local/share/dbus-1/services/com.creatorworks.hub.Host.service",
    ] {
        match fs::symlink_metadata(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
            _ => return Err(refused("An existing global Hub installation/activation needs separate review; no user override was installed")),
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "registration_tests.rs"]
mod tests;
