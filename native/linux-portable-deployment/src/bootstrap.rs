//! First native installation only: reviewed identity and empty-store creation.
//! No download, settings import, package staging, selection or registration.
use super::*;
use crate::HostSession;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, ffi::OsStr, fs::File};

const GLOBAL_CONFLICTS: &[&str] = &[
    "/usr/bin/creator-hub",
    "/usr/share/dbus-1/services/com.creatorworks.hub.Host.service",
    "/usr/local/share/dbus-1/services/com.creatorworks.hub.Host.service",
];
const SELECTOR_LIMIT: u64 = 32 * 1024 * 1024;
const ORIGIN: &str = "bootstrap-origin.json";
const ORIGIN_LIMIT: u64 = 4096;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DirectoryIdentity {
    device: u64,
    inode: u64,
}

impl DirectoryIdentity {
    fn of(file: &File) -> Result<Self> {
        let metadata = file
            .metadata()
            .map_err(|_| refused("Cannot inspect bootstrap directory identity"))?;
        require(metadata.is_dir(), "Bootstrap identity must be a directory")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Ok(Self {
                device: metadata.dev(),
                inode: metadata.ino(),
            })
        }
        // Private Windows filesystem models cannot confer native authority:
        // every public admission and the publication primitive refuse Windows.
        #[cfg(not(unix))]
        {
            Ok(Self {
                device: 0,
                inode: 0,
            })
        }
    }
}

/// Local transaction evidence, not a publisher signature or same-UID attack
/// boundary. Publisher authority always comes from the external signed package.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Origin {
    schema_version: u32,
    purpose: String,
    generation: String,
    version: String,
    executable_sha256: String,
    directory: DirectoryIdentity,
    native_parent: DirectoryIdentity,
}

/// Opaque native capability; neither paths nor hashes supplied by a renderer
/// construct it. The signed sidecar is retained externally, not in Root bytes.
pub struct BootstrapReview {
    root: PathBuf,
    config: PathBuf,
    parent: File,
    image: File,
    pid: u32,
    expected: Expected,
    manifest: Vec<u8>,
    signature: Vec<u8>,
}

impl BootstrapReview {
    pub fn store_path(&self) -> &Path {
        &self.root
    }
    pub fn version(&self) -> &str {
        &self.expected.version
    }
    pub fn generation(&self) -> String {
        digest(&self.manifest)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReviewedBootstrapChoice {
    Cancel,
    CreateReviewedStore,
}

pub enum BootstrapOutcome {
    Cancelled,
    Created(Store),
}

pub struct BootstrapRecoveryReview {
    context: BootstrapReview,
    observed: EmptyState,
}

impl BootstrapRecoveryReview {
    pub fn store_path(&self) -> &Path {
        self.context.store_path()
    }
    pub fn version(&self) -> &str {
        self.context.version()
    }
    pub fn generation(&self) -> String {
        self.context.generation()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BootstrapRecoveryChoice {
    Keep,
    ConfirmPublishedEmptyStore,
}

pub enum BootstrapRecoveryOutcome {
    Kept,
    Recovered(Store),
}

/// Read-only recovery inspection, never marker-only adoption. The exact signed
/// package/Root image, canonical origin, physical directory identities and empty
/// store must all match. No writer lock, fsync, creation or replay occurs here.
pub fn review_bootstrap_recovery(
    session: &HostSession,
    package: &VerifiedPackage,
    expected: &Expected,
) -> Result<BootstrapRecoveryReview> {
    native_session(session)?;
    recovery_review_with(
        session,
        package,
        expected,
        current_image()?,
        &global_paths(),
        &production_verify,
    )
}

/// Keep returns before ANY native admission, filesystem read or write, including
/// after drift. Confirmation only rechecks/flushes an already published empty
/// store; it does not install, select, register, roll back or delete anything.
pub fn recover_bootstrap(
    session: &HostSession,
    review: &BootstrapRecoveryReview,
    choice: BootstrapRecoveryChoice,
) -> Result<BootstrapRecoveryOutcome> {
    if choice == BootstrapRecoveryChoice::Keep {
        return Ok(BootstrapRecoveryOutcome::Kept);
    }
    native_session(session)?;
    recover_with(
        session,
        review,
        &current_image,
        &global_paths(),
        &production_verify,
        &|_| Ok(()),
    )
}

/// Read-only, including on refusal. Requires an existing, owned native XDG data
/// parent; no parent creation, store adoption or writer-lock acquisition occurs.
pub fn review_bootstrap(
    session: &HostSession,
    package: &VerifiedPackage,
    expected: &Expected,
) -> Result<BootstrapReview> {
    native_session(session)?;
    review_with(
        session,
        package,
        expected,
        current_image()?,
        &global_paths(),
        &production_verify,
    )
}

/// Cancel is read-only even after drift. Created means ONLY an empty owned
/// store: the caller must separately review/install/register the bound package.
/// Cancellation before publication leaves the target absent; once published,
/// cancellation cannot turn a committed creation into a clean cancellation.
pub fn apply_bootstrap(
    session: &HostSession,
    review: &BootstrapReview,
    choice: ReviewedBootstrapChoice,
    cancelled: impl Fn() -> bool,
) -> Result<BootstrapOutcome> {
    if choice == ReviewedBootstrapChoice::Cancel {
        return Ok(BootstrapOutcome::Cancelled);
    }
    native_session(session)?;
    apply_with(
        session,
        review,
        &cancelled,
        &current_image,
        &global_paths(),
        &production_verify,
        &|_| Ok(()),
    )
}

fn global_paths() -> Vec<PathBuf> {
    GLOBAL_CONFLICTS.iter().map(PathBuf::from).collect()
}

fn native_session(session: &HostSession) -> Result<()> {
    disk::admit()?;
    let now = HostSession::capture()?;
    require(
        now.store_path() == session.store_path() && now.config_home() == session.config_home(),
        "Native bootstrap session changed",
    )
}

fn current_image() -> Result<File> {
    #[cfg(target_os = "linux")]
    {
        File::open("/proc/self/exe")
            .map_err(|_| refused("Cannot hold the running native Root image"))
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err(refused(
            "Bootstrap running-image authority requires native Linux",
        ))
    }
}

fn absent(path: &Path) -> Result<()> {
    disk::unlinked(path)?;
    require(
        fs::symlink_metadata(path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound),
        "Existing store or service was kept; bootstrap does not adopt or overwrite it",
    )
}

fn conflicts(root: &Path, globals: &[PathBuf]) -> Result<()> {
    absent(root)?;
    activation_conflicts(root, globals)
}

fn activation_conflicts(root: &Path, globals: &[PathBuf]) -> Result<()> {
    let parent = root
        .parent()
        .ok_or_else(|| refused("Native store parent unavailable"))?;
    absent(&parent.join("dbus-1/services/com.creatorworks.hub.Host.service"))?;
    for path in globals {
        require(
            fs::symlink_metadata(path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound),
            "Existing global Hub installation/activation kept; no user override created",
        )?;
    }
    Ok(())
}

fn hold_parent(root: &Path) -> Result<File> {
    let path = root
        .parent()
        .ok_or_else(|| refused("Native store parent unavailable"))?;
    let before = disk::metadata(path, true, None, true)?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x02000000).share_mode(1 | 2 | 4);
    }
    let file = options
        .open(path)
        .map_err(|_| refused("Cannot hold native data directory"))?;
    require(
        disk::same(
            &before,
            &file
                .metadata()
                .map_err(|_| refused("Cannot inspect native data directory"))?,
        ),
        "Native data directory changed during review",
    )?;
    Ok(file)
}

fn image_matches(image: &File, manifest: &Manifest) -> Result<()> {
    let Entry::File { size, sha256, .. } = &manifest.entries[crate::ENTRYPOINT] else {
        return Err(refused("Signed Root entry is not an ordinary file"));
    };
    let before = image
        .metadata()
        .map_err(|_| refused("Cannot inspect held Root image"))?;
    require(
        before.is_file() && before.len() == *size && *size <= MAX_FILE,
        "Running Root size differs from the exact signed version",
    )?;
    let mut hasher = Sha256::new();
    let mut offset = 0;
    let mut buffer = [0u8; 65536];
    while offset < *size {
        #[cfg(unix)]
        let count = {
            use std::os::unix::fs::FileExt;
            image.read_at(&mut buffer, offset)
        };
        #[cfg(windows)]
        let count = {
            use std::os::windows::fs::FileExt;
            image.seek_read(&mut buffer, offset)
        };
        let count = count.map_err(|_| refused("Cannot read held Root image"))?;
        require(
            count > 0 && offset + count as u64 <= *size,
            "Running Root changed while hashing",
        )?;
        hasher.update(&buffer[..count]);
        offset += count as u64;
    }
    require(
        format!("{:x}", hasher.finalize()) == *sha256
            && disk::same(
                &before,
                &image
                    .metadata()
                    .map_err(|_| refused("Cannot recheck Root image"))?,
            ),
        "Running Root bytes differ from the exact signed version",
    )
}

fn package_manifest(
    package: &VerifiedPackage,
    expected: &Expected,
    verifier: &Verifier,
) -> Result<Manifest> {
    let manifest = signed_manifest(&package.bytes, &package.signature, expected, verifier)?;
    super::host::require_runner(&manifest)?;
    super::host::host_profile(
        &manifest,
        package
            .contents
            .get(crate::HOST_PROFILE)
            .ok_or_else(|| refused("Signed portable host profile required for bootstrap"))?,
    )?;
    let selector = package
        .contents
        .get(crate::SELECTOR_ENTRYPOINT)
        .ok_or_else(|| refused("Signed package must inventory the fixed native selector"))?;
    require(
        matches!(manifest.entries.get(crate::SELECTOR_ENTRYPOINT),
        Some(Entry::File { mode: 0o755, size, sha256 })
            if (20..=SELECTOR_LIMIT).contains(size) && *size == selector.len() as u64 && *sha256 == digest(selector))
            && selector.len() >= 20
            && selector[..7] == *b"\x7fELF\x02\x01\x01"
            && selector[18..20] == [0x3e, 0],
        "Separately inventoried signed x86_64 selector required",
    )?;
    Ok(manifest)
}

fn review_with(
    session: &HostSession,
    package: &VerifiedPackage,
    expected: &Expected,
    image: File,
    globals: &[PathBuf],
    verifier: &Verifier,
) -> Result<BootstrapReview> {
    conflicts(session.store_path(), globals)?;
    let context = context_with(session, package, expected, image, globals, verifier)?;
    conflicts(session.store_path(), globals)?;
    Ok(context)
}

fn context_with(
    session: &HostSession,
    package: &VerifiedPackage,
    expected: &Expected,
    image: File,
    globals: &[PathBuf],
    verifier: &Verifier,
) -> Result<BootstrapReview> {
    let manifest = package_manifest(package, expected, verifier)?;
    let root = session.store_path();
    activation_conflicts(root, globals)?;
    let parent = hold_parent(root)?;
    image_matches(&image, &manifest)?;
    activation_conflicts(root, globals)?;
    require(
        super::host::same_file(&parent, &hold_parent(root)?)?,
        "Native data parent changed",
    )?;
    Ok(BootstrapReview {
        root: root.into(),
        config: session.config_home(),
        parent,
        image,
        pid: std::process::id(),
        expected: expected.clone(),
        manifest: package.bytes.clone(),
        signature: package.signature.clone(),
    })
}

fn recheck(
    session: &HostSession,
    review: &BootstrapReview,
    image: &File,
    globals: &[PathBuf],
    verifier: &Verifier,
) -> Result<Manifest> {
    absent(&review.root)?;
    recheck_context(session, review, image, globals, verifier)
}

fn recheck_context(
    session: &HostSession,
    review: &BootstrapReview,
    image: &File,
    globals: &[PathBuf],
    verifier: &Verifier,
) -> Result<Manifest> {
    require(
        session.store_path() == review.root
            && session.config_home() == review.config
            && std::process::id() == review.pid,
        "Bootstrap review belongs to another native session/process",
    )?;
    let manifest = signed_manifest(
        &review.manifest,
        &review.signature,
        &review.expected,
        verifier,
    )?;
    image_matches(image, &manifest)?;
    require(
        super::host::same_file(&review.image, image)?,
        "Running Root image changed after review",
    )?;
    activation_conflicts(&review.root, globals)?;
    require(
        super::host::same_file(&review.parent, &hold_parent(&review.root)?)?,
        "Native data parent changed after review",
    )?;
    Ok(manifest)
}

struct EmptyState {
    directory: File,
    metadata: BTreeMap<String, fs::Metadata>,
    origin: Vec<u8>,
}

impl EmptyState {
    fn matches(&self, other: &Self) -> Result<bool> {
        Ok(self.origin == other.origin
            && metadata_matches(&self.metadata, &other.metadata)
            && super::host::same_file(&self.directory, &other.directory)?)
    }
}

fn metadata_matches(
    first: &BTreeMap<String, fs::Metadata>,
    last: &BTreeMap<String, fs::Metadata>,
) -> bool {
    first.len() == last.len()
        && first.iter().all(|(name, before)| {
            last.get(name)
                .is_some_and(|after| disk::same(before, after))
        })
}

fn empty_metadata(root: &Path) -> Result<BTreeMap<String, fs::Metadata>> {
    let mut result = BTreeMap::new();
    for (name, directory) in [
        ("", true),
        ("store.id", false),
        ("transaction.lock", false),
        ("generations", true),
        ("history", true),
        (ORIGIN, false),
    ] {
        result.insert(
            name.into(),
            disk::metadata(
                &root.join(name),
                directory,
                Some(if directory { 0o700 } else { 0o600 }),
                true,
            )?,
        );
    }
    Ok(result)
}

fn receipt(root: &File, context: &BootstrapReview) -> Result<Vec<u8>> {
    let manifest: Manifest = serde_json::from_slice(&context.manifest)
        .map_err(|_| refused("Invalid reviewed bootstrap manifest"))?;
    let Entry::File { sha256, .. } = &manifest.entries[crate::ENTRYPOINT] else {
        return Err(refused("Signed bootstrap Root is not a file"));
    };
    let origin = Origin {
        schema_version: 1,
        purpose: "creator-hub-native-bootstrap".into(),
        generation: context.generation(),
        version: context.version().into(),
        executable_sha256: sha256.clone(),
        directory: DirectoryIdentity::of(root)?,
        native_parent: DirectoryIdentity::of(&context.parent)?,
    };
    serde_json::to_vec(&origin).map_err(|_| refused("Cannot encode bootstrap origin"))
}

/// Inspection is strictly read-only. Publication and explicit recovery do
/// their flushing separately, never during a recovery review.
fn inspect_empty(root: &Path, context: &BootstrapReview) -> Result<EmptyState> {
    let directory = hold_parent(&root.join("fixed-bootstrap-inspection"))?;
    let before = empty_metadata(root)?;
    Store::open_inner(root)?;
    let names: std::collections::BTreeSet<_> = fs::read_dir(root)
        .map_err(|_| refused("Cannot inspect initialized bootstrap store"))?
        .map(|entry| entry.map(|e| e.file_name()))
        .collect::<std::io::Result<_>>()
        .map_err(|_| refused("Cannot inspect bootstrap member"))?;
    require(
        names
            == [
                "store.id",
                "transaction.lock",
                "generations",
                "history",
                ORIGIN,
            ]
            .map(std::ffi::OsString::from)
            .into_iter()
            .collect(),
        "Only an origin-bound complete empty bootstrap store is accepted",
    )?;
    require(
        disk::read_regular(&root.join("transaction.lock"), 0, true)?.is_empty(),
        "Bootstrap lock is not empty",
    )?;
    for name in ["generations", "history"] {
        require(
            fs::read_dir(root.join(name))
                .map_err(|_| refused("Cannot inspect empty bootstrap directory"))?
                .next()
                .is_none(),
            "Bootstrap must not stage or adopt generation/history data",
        )?;
    }
    let bytes = disk::read_regular(&root.join(ORIGIN), ORIGIN_LIMIT, true)?;
    let origin: Origin = serde_json::from_slice(&bytes)
        .map_err(|_| refused("Malformed bootstrap origin; retained without adoption"))?;
    require(
        serde_json::to_vec(&origin).map_err(|_| refused("Invalid bootstrap origin"))? == bytes
            && bytes == receipt(&directory, context)?,
        "Bootstrap origin/version/package/directory identity differs; not adopted",
    )?;
    let after = empty_metadata(root)?;
    require(
        metadata_matches(&before, &after)
            && super::host::same_file(
                &directory,
                &hold_parent(&root.join("fixed-bootstrap-inspection"))?,
            )?,
        "Empty bootstrap store changed during inspection",
    )?;
    Ok(EmptyState {
        directory,
        metadata: after,
        origin: bytes,
    })
}

fn flush_empty(root: &Path) -> Result<()> {
    for name in ["store.id", "transaction.lock", ORIGIN] {
        let file = disk::hold_regular(&root.join(name), ORIGIN_LIMIT, true)?.0;
        #[cfg(unix)]
        file.sync_all()
            .map_err(|_| refused("Cannot flush empty bootstrap metadata"))?;
        // As with disk::sync_dir, non-Unix checks are pure private models;
        // public native admission and publication refuse those platforms.
        #[cfg(not(unix))]
        let _ = file;
    }
    for name in ["generations", "history", ""] {
        disk::sync_dir(&root.join(name))?;
    }
    Ok(())
}

/// Disarm tempfile's recursive pathname destructor before any checkpoints.
/// Failed/renamed staging is evidence, not an automatically adopted/deleted tree.
struct PrivateStaging {
    path: PathBuf,
    directory: File,
    published: bool,
}

impl PrivateStaging {
    fn create(parent: &Path) -> Result<Self> {
        let path = tempfile::Builder::new()
            .prefix(".creator-hub-bootstrap-")
            .tempdir_in(parent)
            .map_err(|_| refused("Cannot reserve private adjacent bootstrap staging"))?
            .keep();
        disk::set_mode(&path, 0o700)?;
        let directory = hold_parent(&path.join("store"))?;
        Ok(Self {
            path,
            directory,
            published: false,
        })
    }
    fn check_named(&self) -> Result<()> {
        require(
            super::host::same_file(&self.directory, &hold_parent(&self.path.join("store"))?)?,
            "Bootstrap staging directory was renamed/replaced; evidence retained",
        )
    }
}

impl Drop for PrivateStaging {
    fn drop(&mut self) {
        // No recursive removal and no pre-commit cleanup. Only the original,
        // still-named EMPTY container may be removed after successful rename.
        if self.published
            && self.check_named().is_ok()
            && fs::read_dir(&self.path).is_ok_and(|mut entries| entries.next().is_none())
        {
            let _ = fs::remove_dir(&self.path);
        }
    }
}

fn recovery_review_with(
    session: &HostSession,
    package: &VerifiedPackage,
    expected: &Expected,
    image: File,
    globals: &[PathBuf],
    verifier: &Verifier,
) -> Result<BootstrapRecoveryReview> {
    let context = context_with(session, package, expected, image, globals, verifier)?;
    let observed = inspect_empty(&context.root, &context)?;
    recheck_context(session, &context, &context.image, globals, verifier)?;
    require(
        observed.matches(&inspect_empty(&context.root, &context)?)?,
        "Bootstrap changed during recovery review",
    )?;
    Ok(BootstrapRecoveryReview { context, observed })
}

fn recover_with(
    session: &HostSession,
    review: &BootstrapRecoveryReview,
    image: &dyn Fn() -> Result<File>,
    globals: &[PathBuf],
    verifier: &Verifier,
    checkpoint: &dyn Fn(&str) -> Result<()>,
) -> Result<BootstrapRecoveryOutcome> {
    let context = &review.context;
    recheck_context(session, context, &image()?, globals, verifier)?;
    let _lock = disk::lock(&context.root.join("transaction.lock"))?;
    require(
        review
            .observed
            .matches(&inspect_empty(&context.root, context)?)?,
        "Bootstrap recovery evidence changed; retained without writes",
    )?;
    checkpoint("bootstrap-recovery-locked")?;
    recheck_context(session, context, &image()?, globals, verifier)?;
    require(
        review
            .observed
            .matches(&inspect_empty(&context.root, context)?)?,
        "Bootstrap changed before recovery flush",
    )?;
    (|| {
        checkpoint("bootstrap-recovery-before-flush")?;
        flush_empty(&context.root)?;
        context.parent.sync_all().map_err(|_| refused("Cannot flush recovered bootstrap parent"))?;
        checkpoint("bootstrap-recovery-flushed")?;
        require(review.observed.matches(&inspect_empty(&context.root, context)?)?, "Bootstrap changed during recovery flush")?;
        Store::open_inner(&context.root).map(BootstrapRecoveryOutcome::Recovered)
    })().map_err(|_| Error { kind: ErrorKind::OutcomeUnknown,
        message: "Empty-store recovery completion could not be confirmed. Keep its origin and metadata, review again explicitly; no package was selected or registered." })
}

fn apply_with(
    session: &HostSession,
    review: &BootstrapReview,
    cancelled: &dyn Fn() -> bool,
    image: &dyn Fn() -> Result<File>,
    globals: &[PathBuf],
    verifier: &Verifier,
    checkpoint: &dyn Fn(&str) -> Result<()>,
) -> Result<BootstrapOutcome> {
    cancel(cancelled)?;
    recheck(session, review, &image()?, globals, verifier)?;
    let parent = review.root.parent().unwrap();
    let mut staging = PrivateStaging::create(parent)?;
    let staged = staging.path.join("store");
    Store::create_checkpointed(&staged, checkpoint)?;
    staging.check_named()?;
    let origin_directory = hold_parent(&staged.join(ORIGIN))?;
    disk::write_new(
        &staged.join(ORIGIN),
        &receipt(&origin_directory, review)?,
        0o600,
    )?;
    checkpoint("bootstrap-origin-written")?;
    inspect_empty(&staged, review)?;
    flush_empty(&staged)?;
    checkpoint("bootstrap-store-complete")?;
    cancel(cancelled)?;
    recheck(session, review, &image()?, globals, verifier)?;
    checkpoint("bootstrap-before-publication")?;
    cancel(cancelled)?;
    staging.check_named()?;
    inspect_empty(&staged, review)?;
    // Last operation before the no-replace commit, including cancellation that
    // arrived during final image revalidation or the publication checkpoint.
    cancel(cancelled)?;
    publish(
        &staging.directory,
        OsStr::new("store"),
        &review.parent,
        review.root.file_name().unwrap(),
    )?;
    staging.published = true;
    // Publication is the commit boundary. Never delete the published store or
    // report a clean cancellation/refusal after this point, even on flush error.
    (|| {
        checkpoint("bootstrap-published-before-directory-flush")?;
        review.parent.sync_all().map_err(|_| refused("Cannot flush native store parent"))?;
        staging.directory.sync_all().map_err(|_| refused("Cannot flush bootstrap source parent"))?;
        checkpoint("bootstrap-parent-flushed")?;
        inspect_empty(&review.root, review)?;
        flush_empty(&review.root)?;
        Store::open_inner(&review.root).map(BootstrapOutcome::Created)
    })().map_err(|_| Error { kind: ErrorKind::OutcomeUnknown,
        message: "The empty native store was published but completion could not be confirmed. Keep it and inspect the fixed native store before retrying; no package was selected or registered." })
}

fn publish(source: &File, name: &OsStr, target: &File, destination: &OsStr) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        disk::publish_directory_noreplace(source, name, target, destination)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (source, name, target, destination);
        Err(refused(
            "Atomic bootstrap publication requires native Linux",
        ))
    }
}

#[cfg(test)]
#[path = "bootstrap_tests.rs"]
mod tests;
