//! Linux-DEB-only, post-install authority for one managed-route CAS attempt.
use creator_hub_mcp_router::Store;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

const LIMIT: u64 = 256 * 1024;
const HUB_ONLY_MANUAL_INSTALL: &str = "Hub-only manual installation remains available: use the system package manager with a Hub DEB verified against its signed release. This does not approve or retry MCP activation. Keep the retained route outcome for read-only review; do not delete it or run the full migration wizard to unblock Hub.";
const REVIEW: &str = "Retained MCP runtimes and client settings were not removed. No activation was retried or rolled back. Read the route outcome first. If the prior route is verified, open MCP and explicitly Apply only the intended client. If the outcome is unknown, recheck read-only and inspect the retained handoff before changing a connection or attempting another Hub update.";

fn require(ok: bool, message: &str) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err(message.into())
    }
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn hash_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub(crate) fn after_operation<G, T, E>(
    operation: Result<G, E>,
    work: impl FnOnce() -> Result<T, E>,
    hint: impl FnOnce(),
) -> Result<T, E> {
    let result = operation.and_then(|_guard| work());
    hint();
    result
}

#[derive(PartialEq, Eq)]
struct ImageMetadata {
    length: u64,
    modified: std::time::SystemTime,
    #[cfg(unix)]
    identity: (u64, u64, u32, u32, u32, u64, i64, i64, i64, i64),
}

fn image_metadata(info: &fs::Metadata, owner: u32) -> Result<ImageMetadata, String> {
    require(
        info.is_file() && info.len() > 0 && info.len() <= 512 * 1024 * 1024,
        "The installed restart image is not a bounded ordinary executable.",
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        require(
            info.uid() == owner
                && info.nlink() == 1
                && info.mode() & 0o022 == 0
                && info.mode() & 0o111 != 0,
            "The installed restart image owner/mode/link identity is unsafe.",
        )?;
    }
    #[cfg(not(unix))]
    let _ = owner;
    Ok(ImageMetadata {
        length: info.len(),
        modified: info
            .modified()
            .map_err(|_| "Cannot inspect restart image timestamp.")?,
        #[cfg(unix)]
        identity: {
            use std::os::unix::fs::MetadataExt;
            (
                info.dev(),
                info.ino(),
                info.uid(),
                info.gid(),
                info.mode(),
                info.nlink(),
                info.mtime(),
                info.mtime_nsec(),
                info.ctime(),
                info.ctime_nsec(),
            )
        },
    })
}

fn image_ancestry(path: &Path, owner: u32) -> Result<(), String> {
    require(
        path.is_absolute()
            && path
                .canonicalize()
                .map_err(|_| "The installed restart image is unavailable.")?
                == path,
        "An exact canonical installed restart path is required.",
    )?;
    for entry in path.ancestors() {
        let info =
            fs::symlink_metadata(entry).map_err(|_| "Cannot inspect restart image ancestry.")?;
        require(
            !info.file_type().is_symlink(),
            "Linked restart image ancestry refused.",
        )?;
        if entry != path {
            require(info.is_dir(), "Invalid restart image ancestry.")?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                require(
                    (info.uid() == 0 || info.uid() == owner)
                        && (info.mode() & 0o022 == 0
                            || info.uid() == 0 && info.mode() & 0o1000 != 0),
                    "Writable or foreign restart image ancestry refused.",
                )?;
            }
        }
    }
    #[cfg(not(unix))]
    let _ = owner;
    Ok(())
}

pub(crate) struct VerifiedRestartImage {
    file: File,
    path: PathBuf,
    sha256: String,
    owner: u32,
    metadata: ImageMetadata,
}
impl VerifiedRestartImage {
    pub fn native_deb(installed: &Path, restart: &Path, sha256: &str) -> Result<Self, String> {
        require(
            installed == Path::new("/usr/bin/creator-hub"),
            "Only the installed native DEB restart target is admitted.",
        )?;
        Self::capture(installed, restart, sha256, 0)
    }
    fn capture(installed: &Path, restart: &Path, sha256: &str, owner: u32) -> Result<Self, String> {
        require(
            installed == restart && hash_valid(sha256),
            "The restart path or signed executable hash differs from the approved target.",
        )?;
        image_ancestry(installed, owner)?;
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
        }
        let file = options
            .open(installed)
            .map_err(|_| "Cannot open the installed replacement image.")?;
        let metadata = image_metadata(
            &file
                .metadata()
                .map_err(|_| "Cannot inspect the replacement image.")?,
            owner,
        )?;
        let mut image = Self {
            file,
            path: installed.into(),
            sha256: sha256.into(),
            owner,
            metadata,
        };
        image.recheck()?;
        Ok(image)
    }
    fn recheck(&mut self) -> Result<(), String> {
        image_ancestry(&self.path, self.owner)?;
        let named =
            fs::symlink_metadata(&self.path).map_err(|_| "The replacement image disappeared.")?;
        require(
            image_metadata(&named, self.owner)? == self.metadata,
            "The replacement image identity changed before restart.",
        )?;
        self.file
            .seek(SeekFrom::Start(0))
            .map_err(|_| "Cannot recheck the replacement image.")?;
        let mut hash = Sha256::new();
        let mut count = 0u64;
        let mut buffer = [0u8; 65536];
        loop {
            let read = self
                .file
                .read(&mut buffer)
                .map_err(|_| "Cannot hash the replacement image.")?;
            if read == 0 {
                break;
            }
            count += read as u64;
            require(
                count <= 512 * 1024 * 1024,
                "Replacement image grew beyond its bound.",
            )?;
            hash.update(&buffer[..read]);
        }
        require(count == self.metadata.length && format!("{:x}", hash.finalize()) == self.sha256,
            "The installed replacement image does not match the signed executable SHA256; restart was refused.")?;
        require(
            image_metadata(
                &self
                    .file
                    .metadata()
                    .map_err(|_| "Cannot recheck the held replacement image.")?,
                self.owner,
            )? == self.metadata
                && image_metadata(
                    &fs::symlink_metadata(&self.path)
                        .map_err(|_| "Cannot recheck the replacement pathname.")?,
                    self.owner,
                )? == self.metadata,
            "The replacement image changed while verifying it.",
        )?;
        image_ancestry(&self.path, self.owner)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Publication {
    NotRequired,
    Published,
    Unknown(String),
}

pub(crate) enum DebCompletion {
    Cancelled,
    InstalledRestartBlocked {
        reason: String,
        publication: Option<Publication>,
    },
    Installed {
        image: VerifiedRestartImage,
        publication: Publication,
    },
}

pub(crate) fn complete_deb_install(
    outcome: &crate::linux_update::Outcome,
    verify: impl FnOnce() -> Result<VerifiedRestartImage, String>,
    publish: impl FnOnce() -> Result<Publication, String>,
) -> DebCompletion {
    if *outcome == crate::linux_update::Outcome::Cancelled {
        return DebCompletion::Cancelled;
    }
    let mut image = match verify() {
        Ok(image) => image,
        Err(reason) => {
            return DebCompletion::InstalledRestartBlocked {
                reason,
                publication: None,
            }
        }
    };
    let publication = match publish() {
        Ok(publication) => publication,
        Err(reason) => Publication::Unknown(reason),
    };
    if let Err(reason) = image.recheck() {
        return DebCompletion::InstalledRestartBlocked {
            reason,
            publication: Some(publication),
        };
    }
    DebCompletion::Installed { image, publication }
}

fn blocked_restart_notice(
    version: &str,
    reason: &str,
    publication: &Option<Publication>,
) -> String {
    let metadata = match publication {
        Some(Publication::Unknown(error)) => {
            format!(" MCP handoff publication is also unknown: {error}.")
        }
        _ => String::new(),
    };
    format!("Hub {version} package installation returned Installed, but its verified restart is blocked: {reason}.{metadata} No restart was requested. {HUB_ONLY_MANUAL_INSTALL}")
}
impl DebCompletion {
    pub fn finish(
        self,
        version: &str,
        emit: impl FnOnce(&str),
        restart: impl FnOnce(),
    ) -> Result<String, String> {
        match self {
            Self::Cancelled => {
                let notice = "Hub update cancelled at system authorization. Nothing was installed. Your settings and retained MCP connections were kept; closed app views can be reopened from Hub.".to_owned();
                emit(&notice);
                Ok(notice)
            }
            Self::InstalledRestartBlocked {
                reason,
                publication,
            } => {
                let notice = blocked_restart_notice(version, &reason, &publication);
                emit(&notice);
                Err(notice)
            }
            Self::Installed {
                mut image,
                publication,
            } => {
                if let Err(reason) = image.recheck() {
                    let notice = blocked_restart_notice(version, &reason, &Some(publication));
                    emit(&notice);
                    return Err(notice);
                }
                let pending = match publication {
                    Publication::Published => "The managed MCP route handoff is published; the new Root must validate and complete it.".to_owned(),
                    Publication::NotRequired => "No MCP handoff was published; no routing authority was created.".to_owned(),
                    Publication::Unknown(reason) => format!("MCP handoff publication is unknown: {reason}. A complete valid Ready may be consumed once; absent or invalid metadata requires read-only/legacy review. No MCP activation success is claimed."),
                };
                let notice = format!("Hub {version} was installed. Restarting its verified replacement image. {pending}");
                emit(&notice);
                restart();
                Ok(notice)
            }
        }
    }
}

pub(crate) struct Current {
    pub version: String,
    pub executable_sha256: String,
    pub installed: PathBuf,
}

pub(crate) struct VerifiedRelease {
    pub version: String,
    pub executable_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RouteTarget {
    pub descriptor_sha256: String,
    pub generation: String,
}
impl RouteTarget {
    fn receipt(&self) -> Result<Vec<u8>, String> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Receipt<'a> {
            schema_version: u32,
            descriptor_sha256: &'a str,
            generation: &'a str,
        }
        require(
            hash_valid(&self.descriptor_sha256) && hash_valid(&self.generation),
            "Invalid update route identity.",
        )?;
        serde_json::to_vec(&Receipt {
            schema_version: 1,
            descriptor_sha256: &self.descriptor_sha256,
            generation: &self.generation,
        })
        .map_err(|_| "Cannot encode the update route identity.".into())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
enum Phase {
    // Post-Installed approval, not an assertion that directory fsync acknowledged publication.
    Ready,
    Attempting(RouteTarget),
    Completed(RouteTarget),
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    schema_version: u32,
    from_version: String,
    installed: PathBuf,
    release: Vec<u8>,
    signature: Vec<u8>,
    previous: Vec<u8>,
    phase: Phase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    failure: Option<String>,
}

fn decode(bytes: &[u8]) -> Result<Record, String> {
    let record: Record =
        serde_json::from_slice(bytes).map_err(|_| "Invalid MCP update handoff.")?;
    require(
        record.schema_version == 1
            && !record.previous.is_empty()
            && record.previous.len() <= 16384
            && record.release.len() <= 32768
            && record.signature.len() <= 4096,
        "Invalid MCP update handoff bounds.",
    )?;
    Ok(record)
}

fn verify_current(
    record: &Record,
    current: &Current,
    verify: &impl Fn(&[u8], &[u8]) -> Result<VerifiedRelease, String>,
) -> Result<(), String> {
    let target = verify(&record.release, &record.signature)?;
    let from =
        semver::Version::parse(&record.from_version).map_err(|_| "Invalid old Hub version.")?;
    let to = semver::Version::parse(&target.version).map_err(|_| "Invalid target Hub version.")?;
    require(
        to > from
            && target.version == current.version
            && hash_valid(&target.executable_sha256)
            && target.executable_sha256 == current.executable_sha256
            && record.installed == current.installed
            && current.installed == Path::new("/usr/bin/creator-hub"),
        "The handoff does not authorize this exact installed Hub image/version/location.",
    )
}

fn safe_file(file: &File) -> Result<(), String> {
    let info = file
        .metadata()
        .map_err(|_| "Cannot inspect the MCP update record.")?;
    require(info.is_file(), "MCP update record is not an ordinary file.")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        require(
            info.uid() == unsafe { libc::geteuid() }
                && info.nlink() == 1
                && info.mode() & 0o7777 == 0o600,
            "MCP update record owner/mode/link identity is unsafe.",
        )?;
    }
    Ok(())
}

fn read(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot inspect the MCP update record.".into()),
        Ok(info) => require(
            !info.file_type().is_symlink() && info.is_file(),
            "Linked or special MCP update record refused.",
        )?,
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "Cannot open the MCP update record.")?;
    safe_file(&file)?;
    let before = file
        .metadata()
        .map_err(|_| "Cannot inspect the held MCP update record.")?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read the MCP update record.")?;
    require(
        bytes.len() as u64 <= LIMIT,
        "MCP update record exceeds its bound.",
    )?;
    safe_file(&file)?;
    let named =
        fs::symlink_metadata(path).map_err(|_| "MCP update record disappeared while reading.")?;
    let after = file
        .metadata()
        .map_err(|_| "Cannot recheck the held MCP update record.")?;
    require(
        !named.file_type().is_symlink()
            && named.is_file()
            && before.len() == bytes.len() as u64
            && before.len() == after.len()
            && before.len() == named.len()
            && before.modified().ok() == after.modified().ok()
            && before.modified().ok() == named.modified().ok(),
        "MCP update record changed while reading.",
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        require(
            (
                before.dev(),
                before.ino(),
                before.uid(),
                before.mode(),
                before.ctime(),
                before.ctime_nsec(),
            ) == (
                named.dev(),
                named.ino(),
                named.uid(),
                named.mode(),
                named.ctime(),
                named.ctime_nsec(),
            ),
            "MCP update record identity changed while reading.",
        )?;
    }
    Ok(Some(bytes))
}

struct Journal {
    path: PathBuf,
    _lock: File,
}
impl Journal {
    fn open(path: &Path) -> Result<Self, String> {
        let parent = path.parent().ok_or("MCP handoff directory unavailable.")?;
        require(
            parent.is_absolute()
                && parent
                    .canonicalize()
                    .map_err(|_| "MCP handoff directory unavailable.")?
                    == parent,
            "Canonical private MCP handoff directory required.",
        )?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let info = parent
                .metadata()
                .map_err(|_| "Cannot inspect the MCP handoff directory.")?;
            require(
                info.uid() == unsafe { libc::geteuid() } && info.mode() & 0o7777 == 0o700,
                "Private owned MCP handoff directory required.",
            )?;
        }
        let lock_path = parent.join("mcp-route-update.lock");
        if fs::symlink_metadata(&lock_path).is_ok() {
            let _ = read(&lock_path)?;
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let lock = options
            .open(&lock_path)
            .map_err(|_| "Cannot reserve MCP update handoff.")?;
        safe_file(&lock)?;
        lock.try_lock_exclusive()
            .map_err(|_| "Another Hub owns the MCP update handoff; no activation was attempted.")?;
        Ok(Self {
            path: path.into(),
            _lock: lock,
        })
    }
    fn write(&self, record: &Record) -> Result<(), String> {
        self.write_after_rename(record, || Ok(()))
    }
    fn write_after_rename(
        &self,
        record: &Record,
        after_rename: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        self.write_checked(record, || Ok(()), after_rename)
    }
    fn write_checked(
        &self,
        record: &Record,
        before_rename: impl FnOnce() -> Result<(), String>,
        after_rename: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let bytes = serde_json::to_vec(record).map_err(|_| "Cannot encode MCP update handoff.")?;
        require(
            bytes.len() as u64 <= LIMIT,
            "MCP update handoff exceeds its bound.",
        )?;
        let mut staged = tempfile::Builder::new()
            .prefix(".mcp-update-")
            .tempfile_in(self.path.parent().unwrap())
            .map_err(|_| "Cannot stage MCP update handoff.")?;
        staged
            .write_all(&bytes)
            .and_then(|_| staged.as_file().sync_all())
            .map_err(|_| "Cannot flush MCP update handoff.")?;
        let _ = read(&self.path)?;
        before_rename()?;
        staged
            .persist(&self.path)
            .map_err(|_| "MCP handoff publication needs review.")?;
        after_rename()?;
        #[cfg(unix)]
        File::open(self.path.parent().unwrap())
            .and_then(|f| f.sync_all())
            .map_err(|_| "MCP handoff durability needs review.")?;
        Ok(())
    }
    fn archive(&self, bytes: &[u8]) -> Result<(), String> {
        require(
            fs::read_dir(self.path.parent().unwrap())
                .map_err(|_| "Cannot inspect handoff history.")?
                .take(257)
                .count()
                <= 256,
            "Handoff history bound reached; review retained records before another update.",
        )?;
        let path = self
            .path
            .parent()
            .unwrap()
            .join(format!("mcp-route-history-{}.json", digest(bytes)));
        if let Some(old) = read(&path)? {
            require(old == bytes, "Retained MCP handoff history changed.")?;
            #[cfg(unix)]
            {
                File::open(&path)
                    .and_then(|file| file.sync_all())
                    .map_err(|_| "Cannot flush retained handoff history.")?;
                File::open(self.path.parent().unwrap())
                    .and_then(|file| file.sync_all())
                    .map_err(|_| "Cannot flush handoff history directory.")?;
            }
            return Ok(());
        }
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options
            .open(&path)
            .map_err(|_| "Cannot retain the previous MCP handoff.")?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Cannot flush retained MCP handoff.")?;
        #[cfg(unix)]
        File::open(self.path.parent().unwrap())
            .and_then(|file| file.sync_all())
            .map_err(|_| "Cannot flush handoff history directory.")?;
        Ok(())
    }
}

fn known_commit(
    store: &Store,
    route_root: &Path,
    record: &Record,
    target: &RouteTarget,
    version: &str,
) -> Result<(), String> {
    let expected = target.receipt()?;
    require(
        store.snapshot()?.as_deref() == Some(expected.as_slice()),
        "MCP activation outcome is unresolved; the expected target receipt is not active.",
    )?;
    let runtime = store.resolve()?;
    require(
        runtime.generation == target.generation && runtime.hub_version == version,
        "The active MCP runtime is not the handoff target.",
    )?;
    require(
        read(
            &route_root
                .join("history")
                .join(format!("{}.json", digest(&record.previous))),
        )?
        .as_deref()
            == Some(record.previous.as_slice()),
        "The exact prior receipt is not retained in route history.",
    )?;
    require(
        store.snapshot()?.as_deref() == Some(expected.as_slice()),
        "MCP route changed during outcome review.",
    )
}

pub(crate) struct Prepared {
    path: PathBuf,
    before: Option<Vec<u8>>,
    record: Record,
}

fn require_higher_target(target: &str, current_root: &str, active_hub: &str) -> Result<(), String> {
    let target = semver::Version::parse(target).map_err(|_| "Invalid approved version.")?;
    let current =
        semver::Version::parse(current_root).map_err(|_| "Invalid current Root version.")?;
    let active =
        semver::Version::parse(active_hub).map_err(|_| "Invalid active signed Hub version.")?;
    require(target > current && target > active, "The fresh signed Hub target must be newer than both this Root and the actual active Hub route.")
}

impl Prepared {
    // Called only by the newly confirmed Update Hub operation. Old bytes are
    // retention data, never authority or a reason to replay an earlier attempt.
    pub fn capture(
        path: &Path,
        store: &Store,
        current: &Current,
        signed: (Vec<u8>, Vec<u8>),
        verify: impl Fn(&[u8], &[u8]) -> Result<VerifiedRelease, String>,
    ) -> Result<Option<Self>, String> {
        let (release, signature) = signed;
        let before = read(path)?;
        let Some(previous) = store.snapshot()? else {
            return Ok(None);
        };
        let actual = store.resolve()?;
        require(
            store.snapshot()?.as_deref() == Some(previous.as_slice()),
            "The actual MCP route changed during fresh update capture.",
        )?;
        let target = verify(&release, &signature)?;
        require_higher_target(&target.version, &current.version, &actual.hub_version)?;
        require(
            hash_valid(&target.executable_sha256)
                && release.len() <= 32768
                && signature.len() <= 4096,
            "A newer exact signed DEB target is required.",
        )?;
        Ok(Some(Self {
            path: path.into(),
            before,
            record: Record {
                schema_version: 1,
                from_version: current.version.clone(),
                installed: current.installed.clone(),
                release,
                signature,
                previous,
                phase: Phase::Ready,
                failure: None,
            },
        }))
    }
    pub fn publish(
        self,
        outcome: &crate::linux_update::Outcome,
        store: &Store,
    ) -> Result<(), String> {
        self.publish_after_rename(outcome, store, || Ok(()))
    }
    fn publish_after_rename(
        self,
        outcome: &crate::linux_update::Outcome,
        store: &Store,
        after_rename: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        self.publish_with_check(outcome, store, || Ok(()), after_rename)
    }
    fn publish_with_check(
        self,
        outcome: &crate::linux_update::Outcome,
        store: &Store,
        before_check: impl FnOnce() -> Result<(), String>,
        after_rename: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        if *outcome == crate::linux_update::Outcome::Cancelled {
            return Ok(());
        }
        require(
            store.snapshot()?.as_deref() == Some(self.record.previous.as_slice()),
            "The original MCP route changed during installation; no handoff was published.",
        )?;
        store.resolve()?;
        let journal = Journal::open(&self.path)?;
        require(
            read(&self.path)? == self.before,
            "MCP update handoff changed during installation.",
        )?;
        if let Some(bytes) = &self.before {
            journal.archive(bytes)?;
        }
        journal.write_checked(
            &self.record,
            || {
                before_check()?;
                require(
                    read(&self.path)? == self.before,
                    "The old raw handoff changed before fresh intent publication.",
                )?;
                if let Some(bytes) = &self.before {
                    let backup = self
                        .path
                        .parent()
                        .unwrap()
                        .join(format!("mcp-route-history-{}.json", digest(bytes)));
                    require(
                        read(&backup)?.as_deref() == Some(bytes.as_slice()),
                        "The exact opaque handoff backup changed before fresh publication.",
                    )?;
                }
                require(
                    store.snapshot()?.as_deref() == Some(self.record.previous.as_slice()),
                    "The actual MCP route changed before fresh intent publication.",
                )?;
                store.resolve()?;
                require(
                    read(&self.path)? == self.before,
                    "The old raw handoff changed while validating fresh publication.",
                )?;
                require(
                    store.snapshot()?.as_deref() == Some(self.record.previous.as_slice()),
                    "The actual MCP route changed while rechecking fresh publication.",
                )
            },
            after_rename,
        )
    }
}

pub(crate) struct Activation {
    previous: Vec<u8>,
    target: RouteTarget,
}
impl Activation {
    pub fn authorize(&self, previous: Option<&[u8]>, target: &RouteTarget) -> Result<(), String> {
        require(
            previous == Some(self.previous.as_slice()) && *target == self.target,
            "This route review differs from the durable signed-update activation authority.",
        )
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Resumed {
    Absent,
    Activated,
    KnownCommitted,
}

pub(crate) fn resume<F>(
    path: &Path,
    route_root: &Path,
    store: &Store,
    current: &Current,
    verify: impl Fn(&[u8], &[u8]) -> Result<VerifiedRelease, String>,
    target: impl FnOnce() -> Result<RouteTarget, String>,
    prepare: impl FnOnce(&[u8]) -> Result<F, String>,
) -> Result<Resumed, String>
where
    F: FnOnce(Activation) -> Result<(), String>,
{
    if read(path)?.is_none() {
        return Ok(Resumed::Absent);
    }
    let journal = Journal::open(path)?;
    let mut record = decode(&read(path)?.ok_or("MCP handoff disappeared.")?)?;
    verify_current(&record, current, &verify)?;
    let expected = target()?;
    match &record.phase {
        Phase::Attempting(target) | Phase::Completed(target) => {
            require(
                *target == expected,
                "The retained activation target differs from this Root's bound manifest.",
            )?;
            known_commit(store, route_root, &record, target, &current.version)?;
            // Read-only classification: never repeat an uncertain Store activation.
            return Ok(Resumed::KnownCommitted);
        }
        Phase::Ready => {}
    }
    require(
        store.snapshot()?.as_deref() == Some(record.previous.as_slice()),
        "The approved old MCP receipt changed; review the current connection before activation.",
    )?;
    store.resolve()?;
    let authority = Activation {
        previous: record.previous.clone(),
        target: expected.clone(),
    };
    record.phase = Phase::Attempting(expected.clone());
    journal.write(&record)?;
    let result = prepare(&record.previous)
        .and_then(|activate| activate(authority))
        .and_then(|_| known_commit(store, route_root, &record, &expected, &current.version));
    if let Err(error) = result {
        record.failure = Some(error.chars().take(512).collect());
        return match journal.write(&record) {
            Ok(()) => Err(error),
            Err(retain) => Err(format!(
                "{error} The durable attempt is spent; retaining its reason also failed: {retain}"
            )),
        };
    }
    record.phase = Phase::Completed(expected);
    journal.write(&record)?;
    Ok(Resumed::Activated)
}

pub(crate) fn review_message(path: &Path, error: &str) -> String {
    format!(
        "Hub's managed MCP update needs review. {error}\n\n{REVIEW}\n\nHandoff: {}",
        path.display()
    )
}

pub(crate) fn manual_install_message(package: &Path, version: &str, error: &str) -> String {
    format!(
        "This attempt has not installed Hub. MCP handoff preparation refused: {}\n\n{HUB_ONLY_MANUAL_INSTALL}\n\nThe downloaded Hub {version} package is {}. Recheck its hash against the signed release before manual installation. No routing authority was created by this refusal.",
        error.chars().take(512).collect::<String>(), package.display()
    )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Readback {
    pub schema_version: u32,
    pub outcome: String,
    pub route: String,
    pub intent_sha256: Option<String>,
    pub target_version: Option<String>,
    pub target_executable_sha256: Option<String>,
    pub handoff_path: Option<String>,
    pub expected_generation: Option<String>,
    pub active_generation: Option<String>,
    pub reason: Option<String>,
    pub recovery: String,
    pub hub_only_manual_install: Option<String>,
}
impl Readback {
    pub fn unavailable(reason: &str) -> Self {
        Self {
            schema_version: 1,
            outcome: "review-required".into(),
            route: "unknown".into(),
            intent_sha256: None,
            target_version: None,
            target_executable_sha256: None,
            handoff_path: None,
            expected_generation: None,
            active_generation: None,
            reason: Some(reason.chars().take(512).collect()),
            recovery: "read-only-recheck".into(),
            hub_only_manual_install: Some(HUB_ONLY_MANUAL_INSTALL.into()),
        }
    }
}

// This is observation, not another resume path: no writes, staging, CAS or consent.
pub(crate) fn readback(
    path: &Path,
    route_root: &Path,
    store: &Store,
    current: &Current,
    verify: impl Fn(&[u8], &[u8]) -> Result<VerifiedRelease, String>,
    target: &RouteTarget,
) -> Readback {
    let mut result = Readback::unavailable("The current route could not be verified. Recheck the retained outcome before changing a client.");
    result.handoff_path = Some(path.display().to_string());
    let mut observed = None;
    let inspect = (|| -> Result<(), String> {
        let bytes = read(path)?.ok_or("No retained route-update handoff is available.")?;
        let record = decode(&bytes)?;
        let route_before = store.snapshot()?;
        observed = Some((bytes.clone(), route_before.clone()));
        result.intent_sha256 = Some(digest(
            &serde_json::to_vec(&(
                record.schema_version,
                &record.from_version,
                &record.installed,
                &record.release,
                &record.signature,
                &record.previous,
            ))
            .map_err(|_| "Cannot identify route-update intent.")?,
        ));
        verify_current(&record, current, &verify)?;
        result.target_version = Some(current.version.clone());
        result.target_executable_sha256 = Some(current.executable_sha256.clone());
        result.expected_generation = Some(target.generation.clone());
        match &record.phase {
            Phase::Attempting(saved) | Phase::Completed(saved) if saved == target => {
                if known_commit(store, route_root, &record, saved, &current.version).is_ok() {
                    result.route = "verified-target".into();
                    result.outcome = if matches!(&record.phase, Phase::Completed(_)) {
                        "activated"
                    } else {
                        "known-committed"
                    }
                    .into();
                    result.active_generation = Some(target.generation.clone());
                    result.reason = None;
                    result.recovery = "none".into();
                    result.hub_only_manual_install = None;
                } else {
                    require(
                        store.snapshot()?.as_deref() == Some(record.previous.as_slice()),
                        "The activation outcome is unknown, not a verified old route.",
                    )?;
                    let old = store.resolve()?;
                    result.route = "verified-prior".into();
                    result.active_generation = Some(old.generation);
                    result.reason = Some(record.failure.clone().unwrap_or_else(|| "The route attempt did not establish the exact target. Existing retained A is verified; no automatic retry will occur.".into()));
                    result.recovery = "explicit-client-apply".into();
                }
            }
            Phase::Ready => {
                require(
                    store.snapshot()?.as_deref() == Some(record.previous.as_slice()),
                    "The unconsumed handoff no longer has its exact prior route.",
                )?;
                let old = store.resolve()?;
                result.route = "verified-prior".into();
                result.active_generation = Some(old.generation);
                result.outcome = "not-attempted".into();
                result.reason = Some("The approved handoff has not recorded an activation attempt; new-generation routing is not established.".into());
                result.recovery = "read-only-recheck".into();
            }
            _ => {
                return Err(
                    "The retained attempted target differs from this Root's bound signed target."
                        .into(),
                )
            }
        }
        require(
            read(path)?.as_deref() == Some(bytes.as_slice()),
            "Route outcome changed during readback; recheck it.",
        )?;
        require(
            store.snapshot()? == route_before,
            "Active route changed during readback; recheck it.",
        )?;
        Ok(())
    })();
    if let Err(error) = inspect {
        // A healthy payload is independent of the old operation. Do not adopt
        // its Ready/Attempting/Completed state or turn this into native proof.
        if let Some((bytes, route_before)) = observed {
            let current_payload = (|| -> Result<Option<Readback>, String> {
                require(
                    read(path)?.as_deref() == Some(bytes.as_slice())
                        && store.snapshot()? == route_before,
                    "Retained handoff or active route changed before independent readback.",
                )?;
                if let Some(mut positive) = legacy_readback(store, current, target) {
                    if positive.outcome == "verified-current" {
                        require(
                            read(path)?.as_deref() == Some(bytes.as_slice())
                                && store.snapshot()? == route_before,
                            "Retained handoff or active route changed during independent readback.",
                        )?;
                        positive.handoff_path = Some(path.display().to_string());
                        return Ok(Some(positive));
                    }
                }
                Ok(None)
            })();
            if let Ok(Some(positive)) = current_payload {
                return positive;
            }
        }
        result.outcome = "review-required".into();
        result.route = "unknown".into();
        result.active_generation = None;
        result.reason = Some(error.chars().take(512).collect());
        result.recovery = "read-only-recheck".into();
    }
    result
}

// Older Hub senders cannot create a handoff. Observation must not hide that gap
// or manufacture automatic authority; only an explicit existing client Apply can advance it.
pub(crate) fn legacy_readback(
    store: &Store,
    current: &Current,
    target: &RouteTarget,
) -> Option<Readback> {
    let inspect = (|| -> Result<Option<Readback>, String> {
        let Some(before) = store.snapshot()? else {
            return Ok(None);
        };
        let old = store.resolve()?;
        require(
            store.snapshot()?.as_deref() == Some(before.as_slice()),
            "The legacy route changed during inspection.",
        )?;
        if old.generation == target.generation {
            let mut result = Readback::unavailable("");
            result.outcome = "verified-current".into();
            result.route = "verified-target".into();
            result.target_version = Some(current.version.clone());
            result.expected_generation = Some(target.generation.clone());
            result.active_generation = Some(old.generation);
            result.reason = None;
            result.recovery = "none".into();
            result.hub_only_manual_install = None;
            return Ok(Some(result));
        }
        require(semver::Version::parse(&old.hub_version).map_err(|_| "Invalid active Hub version.")?
            < semver::Version::parse(&current.version).map_err(|_| "Invalid current Hub version.")?,
            "The differing active route is not an older compatible Hub route; recheck before changing a client.")?;
        let mut result = Readback::unavailable("This older updater supplied no approved route handoff. Hub is updated, but new MCP connections still use the verified prior generation. Existing sessions were not disconnected. Open MCP and explicitly Apply only the intended client; automatic route advance is not established for this upgrade.");
        result.outcome = "legacy-review-required".into();
        result.route = "verified-prior".into();
        result.target_version = Some(current.version.clone());
        result.expected_generation = Some(target.generation.clone());
        result.active_generation = Some(old.generation);
        result.recovery = "explicit-client-apply".into();
        Ok(Some(result))
    })();
    match inspect {
        Ok(value) => value,
        Err(error) => Some(Readback::unavailable(&error)),
    }
}

#[cfg(test)]
#[path = "mcp_update_handoff.test.rs"]
mod tests;
