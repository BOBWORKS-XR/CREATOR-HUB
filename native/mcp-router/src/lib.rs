//! A receipt selects a generation; only signed metadata authorizes its bytes.
use fs2::FileExt;
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
};

const MAX_DESCRIPTOR: u64 = 32 * 1024;
const MAX_RECEIPT: u64 = 2048;
const MAX_PAYLOAD: u64 = 128 * 1024 * 1024;
const PRODUCT: &str = "com.creatorworks.hub.mcp-runtime";
const KEY: &str = include_str!("../../../src-tauri/src/catalog-key.pub");

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Module {
    pub executable: String,
    pub version: String,
    pub files: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Descriptor {
    pub schema_version: u32,
    pub product: String,
    pub hub_version: String,
    pub platform: String,
    pub arch: String,
    pub module: Module,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    schema_version: u32,
    descriptor_sha256: String,
    generation: String,
}

pub struct Store {
    root: PathBuf,
    generations: PathBuf,
    key: PublicKey,
}

pub struct Runtime {
    pub node: PathBuf,
    pub server: PathBuf,
    pub hub_version: String,
    pub generation: String,
    // Windows denies write/delete sharing for the lifetime of the child.
    _payload: Vec<File>,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn hash_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

pub fn platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

pub fn generation(module: &Module) -> Result<String, String> {
    Ok(digest(
        &serde_json::to_vec(module).map_err(|_| "Cannot encode runtime identity.")?,
    ))
}

pub fn module_files() -> Vec<String> {
    let extension = if cfg!(windows) { ".exe" } else { "" };
    let mut files = vec![
        format!("mcp/creator-works-mcp-launcher{extension}"),
        "mcp/server/creator-works-mcp.mjs".into(),
        format!("mcp/server/runtime/node{extension}"),
        "mcp/server/runtime/LICENSE".into(),
        "mcp/server/runtime/VERSION".into(),
        "mcp/server/unity-extension/Editor/BanterMCPBridge.cs".into(),
        "mcp/server/unity-extension/Editor/CreatorWorksMCPLogo.png".into(),
        "mcp/server/LICENSE".into(),
        "mcp/server/THIRD_PARTY_NOTICES.md".into(),
    ];
    files.sort();
    files
}

fn reject_links(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("MCP routing requires absolute paths.".into());
    }
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) => {
                #[allow(unused_mut)]
                let mut link = meta.file_type().is_symlink();
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    link |= meta.file_attributes() & 0x400 != 0;
                }
                if link {
                    return Err("MCP runtime paths cannot use links or junctions.".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Cannot inspect MCP runtime path.".into()),
        }
    }
    Ok(())
}

fn open_payload(path: &Path) -> Result<File, String> {
    reject_links(path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1);
    }
    let file = options
        .open(path)
        .map_err(|_| "Verified MCP runtime file is unavailable.")?;
    let meta = file
        .metadata()
        .map_err(|_| "Cannot inspect MCP runtime file.")?;
    if !meta.is_file() || meta.len() > MAX_PAYLOAD {
        return Err("MCP runtime file is invalid or too large.".into());
    }
    Ok(file)
}

fn bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    open_payload(path)?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read MCP routing record.")?;
    if bytes.len() as u64 > limit {
        return Err("MCP routing record exceeds its size limit.".into());
    }
    Ok(bytes)
}

fn private_dir(path: &Path) -> Result<(), String> {
    reject_links(path)?;
    fs::create_dir_all(path).map_err(|_| "Cannot create MCP routing storage.")?;
    reject_links(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::metadata(path)
            .map_err(|_| "Cannot inspect routing storage.")?
            .permissions()
            .mode()
            & 0o077
            != 0
        {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))
                .map_err(|_| "Cannot protect routing storage.")?;
        }
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|_| "Cannot flush MCP routing directory; recheck the active route.")?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    reject_links(path)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "Cannot reserve MCP routing record.")?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot flush MCP routing record.".into())
}

struct ActivationLock(File);

impl Drop for ActivationLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

impl Store {
    /// The executable always supplies the compiled-in release key. An explicit
    /// key is useful for disposable tests, not a user-controlled CLI option.
    pub fn new(base: &Path, key: PublicKey) -> Result<Self, String> {
        reject_links(base)?;
        let scope = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
        Ok(Self {
            root: base.join("mcp-route-v1").join(&scope),
            generations: base.join("runtime-generations").join(scope),
            key,
        })
    }

    pub fn installed() -> Result<Self, String> {
        let base = dirs::data_local_dir()
            .ok_or("Local app data is unavailable.")?
            .join("creator-hub");
        Self::new(
            &base,
            PublicKey::decode(KEY).map_err(|_| "Invalid embedded MCP routing key.")?,
        )
    }

    pub fn snapshot(&self) -> Result<Option<Vec<u8>>, String> {
        let path = self.root.join("active.json");
        reject_links(&path)?;
        match fs::symlink_metadata(&path) {
            Ok(_) => bounded(&path, MAX_RECEIPT).map(Some),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("Cannot inspect the active MCP route.".into()),
        }
    }

    fn descriptor(&self, bytes: &[u8], signature: &[u8]) -> Result<Descriptor, String> {
        if bytes.len() as u64 > MAX_DESCRIPTOR || signature.len() > 4096 {
            return Err("Signed MCP runtime metadata exceeds its size limit.".into());
        }
        let signature = Signature::decode(
            std::str::from_utf8(signature)
                .map_err(|_| "Invalid MCP runtime signature encoding.")?,
        )
        .map_err(|_| "Invalid MCP runtime signature.")?;
        self.key
            .verify(bytes, &signature, false)
            .map_err(|_| "MCP runtime signature verification failed.")?;
        let value: Descriptor =
            serde_json::from_slice(bytes).map_err(|_| "Invalid MCP runtime descriptor.")?;
        let extension = if cfg!(windows) { ".exe" } else { "" };
        if value.schema_version != 1
            || value.product != PRODUCT
            || value.platform != platform()
            || value.arch != std::env::consts::ARCH
            || semver::Version::parse(&value.hub_version).is_err()
            || semver::Version::parse(&value.module.version).is_err()
            || value.module.executable != format!("mcp/creator-works-mcp-launcher{extension}")
            || value.module.files.keys().cloned().collect::<Vec<_>>() != module_files()
            || value.module.files.values().any(|hash| !hash_valid(hash))
        {
            return Err("Signed MCP runtime identity does not match this router.".into());
        }
        Ok(value)
    }

    fn payload(&self, descriptor: &Descriptor) -> Result<Runtime, String> {
        let generation = generation(&descriptor.module)?;
        let root = self.generations.join(&generation);
        let mut handles = Vec::new();
        for (name, hash) in &descriptor.module.files {
            let mut file = open_payload(&root.join(name))?;
            let mut hasher = Sha256::new();
            let mut buffer = [0; 64 * 1024];
            loop {
                let count = file
                    .read(&mut buffer)
                    .map_err(|_| "Cannot verify MCP runtime bytes.")?;
                if count == 0 {
                    break;
                }
                hasher.update(&buffer[..count]);
            }
            if format!("{:x}", hasher.finalize()) != *hash {
                return Err(format!(
                    "MCP runtime bytes changed: {name}. Nothing was started."
                ));
            }
            handles.push(file);
        }
        Ok(Runtime {
            node: root.join(format!(
                "mcp/server/runtime/node{}",
                if cfg!(windows) { ".exe" } else { "" }
            )),
            server: root.join("mcp/server/creator-works-mcp.mjs"),
            hub_version: descriptor.hub_version.clone(),
            generation,
            _payload: handles,
        })
    }

    fn resolve_receipt(&self, bytes: &[u8]) -> Result<Runtime, String> {
        let receipt: Receipt =
            serde_json::from_slice(bytes).map_err(|_| "Invalid active MCP routing receipt.")?;
        if receipt.schema_version != 1
            || !hash_valid(&receipt.descriptor_sha256)
            || !hash_valid(&receipt.generation)
        {
            return Err("Invalid active MCP runtime identity.".into());
        }
        let root = self
            .root
            .join("descriptors")
            .join(&receipt.descriptor_sha256);
        let bytes = bounded(&root.join("runtime.json"), MAX_DESCRIPTOR)?;
        if digest(&bytes) != receipt.descriptor_sha256 {
            return Err("Active MCP descriptor changed. Nothing was started.".into());
        }
        let signature = bounded(&root.join("runtime.minisig"), 4096)?;
        let descriptor = self.descriptor(&bytes, &signature)?;
        if generation(&descriptor.module)? != receipt.generation {
            return Err("Active MCP generation does not match its signed descriptor.".into());
        }
        self.payload(&descriptor)
    }

    pub fn resolve(&self) -> Result<Runtime, String> {
        self.resolve_receipt(
            &self
                .snapshot()?
                .ok_or("No managed MCP runtime is active. Open Creator Hub to set it up.")?,
        )
    }

    /// Call only after review/approval. The expected snapshot prevents a stale
    /// review from replacing a route activated by another Hub in the meantime.
    pub fn activate(
        &self,
        bytes: &[u8],
        signature: &[u8],
        expected: Option<&[u8]>,
    ) -> Result<String, String> {
        self.activate_with(bytes, signature, expected, |_| Ok(()))
    }

    fn activate_with(
        &self,
        bytes: &[u8],
        signature: &[u8],
        expected: Option<&[u8]>,
        checkpoint: impl Fn(&str) -> Result<(), String>,
    ) -> Result<String, String> {
        let descriptor = self.descriptor(bytes, signature)?;
        let runtime = self.payload(&descriptor)?;
        private_dir(&self.root)?;
        let lock_path = self.root.join("activate.lock");
        reject_links(&lock_path)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(|_| "Cannot open MCP activation lock.")?;
        lock.try_lock_exclusive()
            .map_err(|_| "Another Hub is activating MCP. Retry after it finishes.")?;
        let _guard = ActivationLock(lock);
        let previous = self.snapshot()?;
        if previous.as_deref() != expected {
            return Err(
                "The active MCP route changed after review. Review it again; nothing was replaced."
                    .into(),
            );
        }
        if let Some(previous) = &previous {
            let current = self.resolve_receipt(previous)?;
            let old_version = semver::Version::parse(&current.hub_version)
                .map_err(|_| "Invalid previous Hub version.")?;
            let new_version = semver::Version::parse(&runtime.hub_version)
                .map_err(|_| "Invalid target Hub version.")?;
            if new_version < old_version
                || (new_version == old_version && current.generation != runtime.generation)
            {
                return Err("MCP activation would downgrade or replace an existing Hub version. Nothing was replaced.".into());
            }
        }
        let descriptor_id = digest(bytes);
        let directory = self.root.join("descriptors");
        private_dir(&directory)?;
        let target = directory.join(&descriptor_id);
        reject_links(&target)?;
        if target.exists() {
            if bounded(&target.join("runtime.json"), MAX_DESCRIPTOR)? != bytes
                || bounded(&target.join("runtime.minisig"), 4096)? != signature
            {
                return Err(
                    "Retained signed runtime metadata changed. Nothing was replaced.".into(),
                );
            }
        } else {
            let staging = tempfile::Builder::new()
                .prefix(".descriptor-")
                .tempdir_in(&directory)
                .map_err(|_| "Cannot stage signed runtime metadata.")?;
            write_new(&staging.path().join("runtime.json"), bytes)?;
            write_new(&staging.path().join("runtime.minisig"), signature)?;
            sync_directory(staging.path())?;
            checkpoint("descriptor")?;
            fs::rename(staging.path(), &target)
                .map_err(|_| "Cannot retain signed runtime metadata.")?;
        }
        sync_directory(&target)?;
        sync_directory(&directory)?;
        if let Some(previous) = &previous {
            let history = self.root.join("history");
            private_dir(&history)?;
            let backup = history.join(format!("{}.json", digest(previous)));
            reject_links(&backup)?;
            if backup.exists() {
                if bounded(&backup, MAX_RECEIPT)? != *previous {
                    return Err("Retained MCP route backup changed. Nothing was replaced.".into());
                }
                let mut options = OpenOptions::new();
                options.read(true).write(true);
                #[cfg(windows)]
                {
                    use std::os::windows::fs::OpenOptionsExt;
                    options.share_mode(1);
                }
                let mut file = options
                    .open(&backup)
                    .map_err(|_| "Cannot reopen retained MCP route backup.")?;
                let mut saved = Vec::new();
                (&mut file)
                    .take(MAX_RECEIPT + 1)
                    .read_to_end(&mut saved)
                    .map_err(|_| "Cannot recheck retained MCP route backup.")?;
                if saved != *previous {
                    return Err("Retained MCP route backup changed. Nothing was replaced.".into());
                }
                file.sync_all()
                    .map_err(|_| "Cannot flush retained MCP route backup.")?;
            } else {
                write_new(&backup, previous)?;
            }
            sync_directory(&history)?;
        }
        checkpoint("backup")?;
        let receipt = serde_json::to_vec(&Receipt {
            schema_version: 1,
            descriptor_sha256: descriptor_id,
            generation: runtime.generation.clone(),
        })
        .map_err(|_| "Cannot encode MCP activation receipt.")?;
        let mut staged = tempfile::Builder::new()
            .prefix(".activation-")
            .tempfile_in(&self.root)
            .map_err(|_| "Cannot stage MCP activation receipt.")?;
        staged
            .write_all(&receipt)
            .and_then(|_| staged.as_file().sync_all())
            .map_err(|_| "Cannot flush MCP activation receipt.")?;
        checkpoint("receipt")?;
        // Readers see the entire old or new receipt, never a partially written one.
        let path = self.root.join("active.json");
        reject_links(&path)?;
        if self.snapshot()? != previous {
            return Err("MCP route changed during activation. Nothing was replaced.".into());
        }
        staged
            .persist(&path)
            .map_err(|_| "Cannot publish MCP activation receipt. Recheck the active route.")?;
        checkpoint("published")?;
        sync_directory(&self.root)?;
        Ok(runtime.generation)
    }
}

impl Runtime {
    /// Only the single-connection headless executable may call this method.
    /// Its Windows process containment lives until that executable exits.
    pub fn run(self) -> Result<ExitStatus, String> {
        // Unix file locks do not prevent a non-cooperating writer replacing a
        // verified path. Do not mistake them for the Windows payload binding.
        if !cfg!(windows) {
            return Err("Managed MCP routing on this platform still needs native payload binding acceptance.".into());
        }
        #[cfg(windows)]
        let job = child_job::Job::contain_router()?;
        let mut command = Command::new(&self.node);
        command
            .arg(&self.server)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|_| "Cannot start verified MCP runtime.")?;
        #[cfg(windows)]
        if !job.contains(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                "MCP runtime did not inherit its owned process group. Nothing was left running."
                    .into(),
            );
        }
        child
            .wait()
            .map_err(|_| "Cannot wait for the MCP runtime; check Creator Hub.".into())
    }
}

#[cfg(windows)]
mod child_job {
    use std::{os::windows::io::AsRawHandle, process::Child};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
                JobObjectExtendedLimitInformation, SetInformationJobObject,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Threading::GetCurrentProcess,
        },
    };

    pub struct Job {
        handle: HANDLE,
        process_bound: bool,
    }

    impl Job {
        pub fn contain_router() -> Result<Self, String> {
            let mut job = Self {
                handle: unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) },
                process_bound: false,
            };
            if job.handle.is_null() {
                return Err("Cannot create owned MCP process group.".into());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if unsafe {
                SetInformationJobObject(
                    job.handle,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of_val(&limits) as u32,
                )
            } == 0
                || unsafe { AssignProcessToJobObject(job.handle, GetCurrentProcess()) } == 0
            {
                return Err(
                    "Cannot contain the owned MCP runtime. Nothing was left running.".into(),
                );
            }
            job.process_bound = true;
            Ok(job)
        }

        pub fn contains(&self, child: &Child) -> bool {
            let mut contained = 0;
            (unsafe { IsProcessInJob(child.as_raw_handle().cast(), self.handle, &mut contained) })
                != 0
                && contained != 0
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // Once attached, OS process exit closes the last handle and cleans
            // descendants. Closing it here would kill the router before it can
            // forward the child's exit status. No handle is inherited by Node.
            if !self.process_bound && !self.handle.is_null() {
                unsafe {
                    CloseHandle(self.handle);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
