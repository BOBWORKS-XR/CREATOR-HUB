use crate::{
    catalog::{self, AppId, Release},
    platform,
};
use fs2::FileExt;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

#[derive(Default)]
pub struct Manager {
    busy: Arc<AtomicBool>,
    closing: Mutex<bool>,
    cancel: AtomicBool,
    releases: Mutex<Vec<(AppId, Release)>>,
}

pub struct Operation {
    busy: Arc<AtomicBool>,
    _lock: File,
}
impl Drop for Operation {
    fn drop(&mut self) {
        self.busy.store(false, Ordering::SeqCst);
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub app: AppId,
    pub phase: String,
    pub message: String,
    pub received: u64,
    pub total: u64,
    pub cancellable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub app: AppId,
    pub installed_version: Option<String>,
    pub available_version: String,
    pub installed: bool,
    pub trusted: bool,
    pub running: bool,
    pub update_available: bool,
    pub downloaded: bool,
    pub issue: Option<String>,
    pub check_warning: Option<String>,
    pub installer_interactive: bool,
    pub install_blocked: Option<String>,
    pub required_hub_version: Option<String>,
    pub installed_path: Option<PathBuf>,
    pub detected_copies: Vec<DetectedCopy>,
    pub hosted_preview: Option<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedCopy {
    path: PathBuf,
    version: Option<String>,
    verified: bool,
}

fn detected_copies(app: AppId) -> Vec<DetectedCopy> {
    paths(app)
        .unwrap_or_default()
        .into_iter()
        .map(|path| {
            let known = file_hash(&path)
                .ok()
                .and_then(|hash| known_executable(app, &hash).ok().flatten());
            DetectedCopy {
                path,
                verified: known.is_some(),
                version: known.map(|r| r.version),
            }
        })
        .collect()
}

#[derive(Serialize)]
pub struct Snapshot {
    pub supported: bool,
    pub apps: Vec<AppState>,
}

#[derive(Serialize, Deserialize)]
struct Adoption {
    path: PathBuf,
}

fn root() -> Result<PathBuf, String> {
    let path = dirs::data_local_dir()
        .ok_or("Local app data is unavailable.")?
        .join("CreatorHub");
    platform::reject_links(&path)?;
    fs::create_dir_all(&path).map_err(|_| "Cannot create Hub's local data directory.")?;
    Ok(path)
}

pub(crate) fn child_dir(name: &str) -> Result<PathBuf, String> {
    let path = root()?.join(name);
    platform::reject_links(&path)?;
    fs::create_dir_all(&path).map_err(|_| "Cannot create Hub's local cache.")?;
    Ok(path)
}

pub(crate) fn bounded_read(path: &Path, max: u64) -> Result<Vec<u8>, String> {
    platform::reject_links(path)?;
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| "Local record is unavailable.")?
        .take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read local record.")?;
    if bytes.len() as u64 > max {
        return Err("Local record exceeds its size limit.".into());
    }
    Ok(bytes)
}

pub(crate) fn atomic_write(path: &Path, data: &[u8]) -> Result<(), String> {
    platform::reject_links(path)?;
    let pending = path.with_extension("pending");
    platform::reject_links(&pending)?;
    let mut file = File::create(&pending).map_err(|_| "Cannot write local record.")?;
    file.write_all(data)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot save local record.")?;
    drop(file);
    fs::rename(&pending, path).map_err(|_| "Cannot promote local record.".into())
}

pub(crate) fn file_hash(path: &Path) -> Result<String, String> {
    platform::reject_links(path)?;
    let mut file = File::open(path).map_err(|_| "App file is unavailable or locked.")?;
    if file
        .metadata()
        .map_err(|_| "Cannot inspect app file.")?
        .len()
        > catalog::MAX_ARTIFACT
    {
        return Err("App file exceeds the verification limit.".into());
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buffer)
            .map_err(|_| "App verification failed.")?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn cached_releases(app: AppId) -> Result<Vec<Release>, String> {
    let mut releases = vec![catalog::bootstrap(app)];
    let dir = child_dir("catalog")?;
    let mut count = 0;
    for entry in fs::read_dir(dir).map_err(|_| "Cannot inspect cached release catalog.")? {
        let entry = entry.map_err(|_| "Cannot inspect cached release catalog.")?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(&format!("{}-", app.id())) && name.ends_with(".json") {
            count += 1;
            if count > 64 {
                return Err("Too many cached descriptors. Inspect Hub's catalog cache.".into());
            }
            let path = entry.path();
            if let (Ok(bytes), Ok(sig)) = (
                bounded_read(&path, catalog::MAX_METADATA),
                bounded_read(&path.with_extension("minisig"), 4096),
            ) {
                if let Ok(release) = catalog::verify_signed(app, &bytes, &sig, true) {
                    releases.push(release);
                }
            }
        }
    }
    Ok(releases)
}

fn latest(app: AppId, preview: bool) -> Result<Release, String> {
    cached_releases(app)?
        .into_iter()
        .filter(|r| r.validate(app, preview).is_ok())
        .max_by_key(|r| Version::parse(&r.version).unwrap())
        .ok_or("No compatible release is available.".into())
}

fn known_executable(app: AppId, hash: &str) -> Result<Option<Release>, String> {
    if app == AppId::Setup
        && hash == "4f6e5d28df2c68eed6fe1193e52aae7a4aa26a215191a79fcabca0890896540c"
    {
        // The separately published portable 0.2.2 EXE differs from the NSIS payload.
        let mut portable = catalog::bootstrap(app);
        portable.executable_sha256 = hash.into();
        return Ok(Some(portable));
    }
    Ok(cached_releases(app)?
        .into_iter()
        .find(|r| r.executable_sha256 == hash))
}

fn paths(app: AppId) -> Result<Vec<PathBuf>, String> {
    let record = root()?.join(format!("{}.json", app.id()));
    let mut found = platform::registered(app)?;
    if record.exists() {
        let adoption: Adoption = serde_json::from_slice(&bounded_read(&record, 4096)?)
            .map_err(|_| "The saved app location is invalid.")?;
        if !found.iter().any(|p| platform::same_path(p, &adoption.path)) {
            found.push(adoption.path);
        }
    }
    let default = platform::default_exe(app)?;
    if default.exists() && !found.iter().any(|p| platform::same_path(p, &default)) {
        found.push(default);
    }
    Ok(found)
}

fn installed(app: AppId) -> Result<Option<(PathBuf, Option<Release>)>, String> {
    let mut found = paths(app)?;
    if found.len() > 1 {
        let record = root()?.join(format!("{}.json", app.id()));
        let selected = bounded_read(&record, 4096)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Adoption>(&bytes).ok());
        if let Some(selected) = selected {
            found.retain(|path| platform::same_path(path, &selected.path));
        }
        if found.len() != 1 {
            return Err("More than one copy of this app was found. Choose the one you want to use. Hub won't remove either copy.".into());
        }
    }
    let Some(path) = found.into_iter().next() else {
        return Ok(None);
    };
    if !path.is_file() {
        return Err("An app is registered but its executable is missing. Repair or remove that registration before installing another copy.".into());
    }
    let hash = file_hash(&path)?;
    let descriptor = known_executable(app, &hash)?;
    Ok(Some((path, descriptor)))
}

fn cache_path(release: &Release) -> Result<PathBuf, String> {
    Ok(child_dir("downloads")?.join(format!("{}.exe", release.sha256)))
}
fn verified_download(release: &Release) -> bool {
    cache_path(release).is_ok_and(|p| {
        fs::metadata(&p).is_ok_and(|m| m.len() == release.byte_length)
            && file_hash(&p).is_ok_and(|h| h == release.sha256)
    })
}

impl Manager {
    pub fn busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }
    pub fn allow_close(&self) -> bool {
        let Ok(mut closing) = self.closing.lock() else {
            return false;
        };
        if self.busy() {
            return false;
        }
        *closing = true;
        true
    }
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }
    pub(crate) fn cancellation(&self) -> &AtomicBool {
        &self.cancel
    }
    pub fn begin(&self) -> Result<Operation, String> {
        let closing = self
            .closing
            .lock()
            .map_err(|_| "Hub lifecycle state is unavailable.")?;
        if *closing {
            return Err("Hub is closing. No new operation was started.".into());
        }
        if self.busy.swap(true, Ordering::SeqCst) {
            return Err("Another Hub operation is already running.".into());
        }
        drop(closing);
        let result = (|| {
            let path = root()?.join("operation.lock");
            platform::reject_links(&path)?;
            let lock = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(path)
                .map_err(|_| "Cannot create app-operation lock.")?;
            lock.try_lock_exclusive()
                .map_err(|_| "Another Creator Hub window is already managing apps.")?;
            Ok(lock)
        })();
        match result {
            Ok(lock) => {
                self.cancel.store(false, Ordering::SeqCst);
                Ok(Operation {
                    busy: Arc::clone(&self.busy),
                    _lock: lock,
                })
            }
            Err(e) => {
                self.busy.store(false, Ordering::SeqCst);
                Err(e)
            }
        }
    }

    pub fn snapshot(&self, check: bool, preview: bool) -> Result<Snapshot, String> {
        if !platform::supported() {
            return Ok(Snapshot {
                supported: false,
                apps: Vec::new(),
            });
        }
        let _operation = self.begin()?;
        let mut states = Vec::new();
        let mut selected = Vec::new();
        for app in AppId::ALL {
            let mut warning = None;
            if check {
                let result =
                    catalog::client().and_then(|client| catalog::discover(&client, app, preview));
                match result {
                    Ok(Some((release, bytes, sig))) => {
                        let old = latest(app, preview)?;
                        if release.version == old.version && release != old {
                            warning = Some("An immutable release descriptor changed. Keeping the previously verified release.".into());
                        } else if Version::parse(&release.version).unwrap()
                            >= Version::parse(&old.version).unwrap()
                        {
                            let path = child_dir("catalog")?.join(format!(
                                "{}-{}.json",
                                app.id(),
                                release.version
                            ));
                            atomic_write(&path.with_extension("minisig"), &sig)?;
                            atomic_write(&path, &bytes)?;
                        } else {
                            warning = Some("The feed returned an older version. Keeping the newer verified release.".into());
                        }
                    }
                    Ok(None) => {}
                    Err(error) => {
                        warning = Some(format!("{error} Using the last verified release."))
                    }
                }
            }
            let release = latest(app, preview)?;
            let mut state = AppState {
                app,
                installed_version: None,
                available_version: release.version.clone(),
                installed: false,
                trusted: false,
                running: false,
                update_available: false,
                downloaded: verified_download(&release),
                issue: None,
                check_warning: warning,
                installer_interactive: release.installer_protocol == 0,
                install_blocked: release.install_block_reason(app),
                required_hub_version: release.required_hub_version().map(String::from),
                installed_path: None,
                detected_copies: Vec::new(),
                hosted_preview: crate::hosted::preview_mode(app),
            };
            match installed(app) {
                Ok(Some((path, known))) => {
                    state.installed = true;
                    state.installed_path = Some(path.clone());
                    state.trusted = known.is_some();
                    if let Some(known) = known {
                        state.update_available = Version::parse(&release.version).unwrap()
                            > Version::parse(&known.version).unwrap();
                        state.installed_version = Some(known.version);
                    } else {
                        state.issue = Some("Hub couldn't verify this app. Choose an official copy. Nothing was changed.".into());
                    }
                    match platform::running(app, &path) {
                        Ok(running) => state.running = !running.gui.is_empty() || running.server,
                        Err(error) => state.issue = Some(error),
                    }
                }
                Ok(None) => {
                    match platform::running(app, &platform::default_exe(app)?) {
                        Ok(r) if r.other_copy || !r.gui.is_empty() => state.issue = Some("A standalone copy is running. Choose Use existing app instead of creating a second installation.".into()),
                        Err(error) => state.issue = Some(error),
                        _ => {}
                    }
                }
                Err(error) => state.issue = Some(error),
            }
            if state.issue.is_some() && !state.installed {
                state.detected_copies = detected_copies(app);
            }
            selected.push((app, release));
            states.push(state);
        }
        *self
            .releases
            .lock()
            .map_err(|_| "Release state is unavailable.")? = selected;
        Ok(Snapshot {
            supported: true,
            apps: states,
        })
    }

    fn selected(&self, app: AppId, expected: &str) -> Result<Release, String> {
        let releases = self
            .releases
            .lock()
            .map_err(|_| "Release state is unavailable.")?;
        let release = releases
            .iter()
            .find(|(id, _)| *id == app)
            .map(|(_, r)| r.clone())
            .ok_or("Refresh the app list before continuing.")?;
        if release.version != expected {
            return Err("The available release changed. Review it before continuing.".into());
        }
        Ok(release)
    }

    fn download(
        &self,
        app: AppId,
        release: &Release,
        progress: &impl Fn(Progress),
    ) -> Result<PathBuf, String> {
        let path = cache_path(release)?;
        platform::reject_links(&path)?;
        if verified_download(release) {
            return Ok(path);
        }
        let required = release.byte_length.saturating_mul(4) + 128 * 1024 * 1024;
        if fs2::available_space(path.parent().unwrap())
            .map_err(|_| "Cannot inspect free disk space.")?
            < required
        {
            return Err(
                "There is not enough free disk space for this app and its installer.".into(),
            );
        }
        let partial = path.with_extension("part");
        platform::reject_links(&partial)?;
        let file = File::create(&partial).map_err(|_| "Cannot create the download file.")?;
        let result = download_stream(app, release, file, &self.cancel, |received| {
            progress(Progress {
                app,
                phase: "downloading".into(),
                message: format!("Downloading {} {}", app.name(), release.version),
                received,
                total: release.byte_length,
                cancellable: true,
            })
        });
        if let Err(error) = result {
            let _ = fs::remove_file(&partial);
            return Err(error);
        }
        if self.cancel.load(Ordering::SeqCst) {
            let _ = fs::remove_file(&partial);
            return Err("Download cancelled.".into());
        }
        fs::rename(&partial, &path).map_err(|_| "Cannot finish the verified download.")?;
        Ok(path)
    }

    pub fn prepare(
        &self,
        app: AppId,
        version: String,
        progress: impl Fn(Progress),
    ) -> Result<String, String> {
        let _operation = self.begin()?;
        let release = self.selected(app, &version)?;
        if let Some(reason) = release.install_block_reason(app) {
            return Err(reason);
        }
        self.download(app, &release, &progress)?;
        Ok(format!(
            "{} {} downloaded and verified. Installation has not started.",
            app.name(),
            version
        ))
    }

    pub fn install(
        &self,
        app: AppId,
        version: String,
        reopen: bool,
        close_running: bool,
        progress: impl Fn(Progress),
    ) -> Result<String, String> {
        let _operation = self.begin()?;
        if !platform::supported() {
            return Err("App installation is available on Windows x64 only in this build.".into());
        }
        let release = self.selected(app, &version)?;
        if let Some(reason) = release.install_block_reason(app) {
            return Err(reason);
        }
        let current = installed(app)?;
        let target = platform::default_exe(app)?;
        if let Some((path, known)) = &current {
            let known = known
                .as_ref()
                .ok_or("Existing app is not a verified release. No files were replaced.")?;
            if Version::parse(&known.version).unwrap() > Version::parse(&release.version).unwrap() {
                return Err(
                    "A newer app is already installed. Downgrades are not permitted.".into(),
                );
            }
            if !platform::same_path(path, &target) {
                return Err("This app uses a custom or portable location. Keep using that copy; Hub will not create a second installation.".into());
            }
            platform::verify_nsis_update_target(app.name(), &target)?;
        }
        platform::reject_links(&target)?;
        let installer = self.download(app, &release, &progress)?;
        let running = platform::running(app, &target)?;
        if running.server || running.other_copy {
            return Err("Close active MCP client connections and other copies of this app before installing. No process was stopped.".into());
        }
        if !running.gui.is_empty() {
            let close_supported = current
                .as_ref()
                .and_then(|(_, known)| known.as_ref())
                .is_some_and(|r| r.lifecycle_protocol == 1);
            if !close_running || !close_supported {
                return Err("Close this app before installing. This installed version does not support a guarded Hub restart.".into());
            }
            platform::window_action(&running.gui, &target, true)?;
            let deadline = Instant::now() + Duration::from_secs(15);
            while !platform::running(app, &target)?.gui.is_empty() {
                if Instant::now() >= deadline {
                    return Err(
                        "The app is busy or refused to close. Installation has not started.".into(),
                    );
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        if self.cancel.load(Ordering::SeqCst) {
            return Err("Installation cancelled before starting the installer.".into());
        }
        let final_check = platform::running(app, &target)?;
        if !final_check.gui.is_empty() || final_check.server || final_check.other_copy {
            return Err("The app became active. Installation was paused.".into());
        }
        if file_hash(&installer)? != release.sha256 {
            return Err("Cached installer changed. Download it again.".into());
        }
        // /UPDATE bypasses old NSIS uninstallers; matching MSI entries are
        // refused. Silent mode still requires a signed, guarded new installer.
        let safe_silent = release.installer_protocol == 1;
        progress(Progress { app, phase: "installing".into(), message: if safe_silent { "Installing the verified app..." } else { "Complete the app installer window. Hub will verify the result and reopen the app when it finishes." }.into(), received: 0, total: 0, cancellable: false });
        let mut command = platform::command(&installer);
        if current.is_some() {
            platform::verify_nsis_update_target(app.name(), &target)?;
            let expected = current
                .as_ref()
                .and_then(|(_, known)| known.as_ref())
                .ok_or("The installed app could not be rechecked.")?;
            if file_hash(&target)? != expected.executable_sha256 {
                return Err(
                    "The installed app changed while downloading. Check for updates again.".into(),
                );
            }
            command.arg("/UPDATE");
        } else if target.exists() {
            return Err("An app was installed while downloading. Check for updates again.".into());
        }
        if safe_silent {
            command.arg("/S");
        }
        let status = command.status().map_err(|_| {
            "Windows could not start the installer. Check SmartScreen or security prompts."
        })?;
        if !status.success() {
            return Err(format!(
                "Installer stopped (exit {}). The existing installation was not marked as updated.",
                status.code().unwrap_or(-1)
            ));
        }
        if file_hash(&target)? != release.executable_sha256 {
            return Err("The installed executable did not match the verified release. Hub has not marked it ready or opened it. Review the installer result; cached installers have been kept, but the installation may need repair.".into());
        }
        atomic_write(
            &root()?.join(format!("{}.json", app.id())),
            &serde_json::to_vec(&Adoption {
                path: target.clone(),
            })
            .unwrap(),
        )?;
        if reopen {
            open_verified(app, &target)?;
        }
        Ok(format!(
            "{} {} installed and verified{}.",
            app.name(),
            version,
            if reopen { "; app opened" } else { "" }
        ))
    }

    pub fn hosted_candidate(&self, app: AppId) -> Result<Option<PathBuf>, String> {
        match installed(app)? {
            Some((path, Some(_))) => Ok(Some(path)),
            Some((_, None)) => Err(
                "This app is not a verified release. Choose a verified copy or update it first."
                    .into(),
            ),
            None => Ok(None),
        }
    }

    pub fn open(&self, app: AppId) -> Result<String, String> {
        let _operation = self.begin()?;
        let (path, known) = installed(app)?.ok_or("This app is not installed.")?;
        if known.is_none() {
            return Err(
                "The app executable is not in the verified catalog. It was not launched.".into(),
            );
        }
        open_verified(app, &path)?;
        Ok(format!("Opened {}.", app.name()))
    }

    pub fn adopt(&self, app: AppId, path: PathBuf) -> Result<(), String> {
        let _operation = self.begin()?;
        if !path.is_absolute() || !path.is_file() {
            return Err("Choose an existing app executable.".into());
        }
        let hash = file_hash(&path)?;
        if known_executable(app, &hash)?.is_none() {
            return Err(
                "The selected app is not a verified release. Nothing was run or changed.".into(),
            );
        }
        let existing = platform::registered(app)?;
        if !existing.is_empty() && !existing.iter().any(|p| platform::same_path(p, &path)) {
            return Err("A different registered installation already exists. Hub will not silently choose between copies.".into());
        }
        atomic_write(
            &root()?.join(format!("{}.json", app.id())),
            &serde_json::to_vec(&Adoption { path }).unwrap(),
        )
    }

    pub fn select_detected(&self, app: AppId, path: PathBuf) -> Result<(), String> {
        if !paths(app)?
            .iter()
            .any(|known| platform::same_path(known, &path))
        {
            return Err(
                "That app is no longer in the detected locations. Refresh and select it again."
                    .into(),
            );
        }
        self.adopt(app, path)
    }
}

fn open_verified(app: AppId, path: &Path) -> Result<(), String> {
    let hash = file_hash(path)?;
    if known_executable(app, &hash)?.is_none() {
        return Err("App verification failed before launch.".into());
    }
    let running = platform::running(app, path)?;
    if running.other_copy {
        return Err(
            "Another copy of this app is running. Switch to it instead of opening a duplicate."
                .into(),
        );
    }
    if !running.gui.is_empty() {
        return platform::window_action(&running.gui, path, false);
    }
    platform::command(path)
        .spawn()
        .map_err(|_| "The app could not be opened.")?;
    Ok(())
}

#[cfg(test)]
pub fn copy_verified(
    mut source: impl Read,
    target: impl Write,
    size: u64,
    expected: &str,
    cancel: &AtomicBool,
    progress: impl Fn(u64),
) -> Result<(), String> {
    let mut buffer = [0u8; 64 * 1024];
    let mut sink = VerifiedSink::new(target, size, expected);
    let mut last = Instant::now();
    progress(0);
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("Download cancelled.".into());
        }
        let count = source
            .read(&mut buffer)
            .map_err(|_| "Download interrupted. Retry when connected.")?;
        if count == 0 {
            break;
        }
        sink.write(&buffer[..count])?;
        if last.elapsed() >= Duration::from_millis(150) {
            progress(sink.received);
            last = Instant::now();
        }
    }
    sink.finish()?;
    progress(size);
    Ok(())
}

struct VerifiedSink<'a, W> {
    target: W,
    size: u64,
    expected: &'a str,
    received: u64,
    hash: Sha256,
}
impl<'a, W: Write> VerifiedSink<'a, W> {
    fn new(target: W, size: u64, expected: &'a str) -> Self {
        Self {
            target,
            size,
            expected,
            received: 0,
            hash: Sha256::new(),
        }
    }
    fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.received = self
            .received
            .checked_add(bytes.len() as u64)
            .ok_or("Download size overflow.")?;
        if self.received > self.size {
            return Err("Download exceeded the signed size.".into());
        }
        self.target
            .write_all(bytes)
            .map_err(|_| "Cannot save download. Check free disk space.")?;
        self.hash.update(bytes);
        Ok(())
    }
    fn finish(mut self) -> Result<(), String> {
        if self.received != self.size || format!("{:x}", self.hash.finalize()) != self.expected {
            return Err(
                "Download size or SHA-256 verification failed. Nothing was installed.".into(),
            );
        }
        self.target
            .flush()
            .map_err(|_| "Cannot finish saving download.".into())
    }
}

async fn cancellable<T>(
    future: impl std::future::Future<Output = T>,
    cancel: &AtomicBool,
) -> Result<T, String> {
    tokio::pin!(future);
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("Download cancelled.".into());
        }
        tokio::select! {
            result = &mut future => return Ok(result),
            _ = tokio::time::sleep(Duration::from_millis(50)) => {}
        }
    }
}

fn download_stream(
    app: AppId,
    release: &Release,
    target: impl Write,
    cancel: &AtomicBool,
    progress: impl Fn(u64),
) -> Result<(), String> {
    download_stream_url(
        &app.download_url(&release.version, &release.asset_name),
        release,
        target,
        cancel,
        progress,
    )
}

pub(crate) fn download_stream_url(
    url: &str,
    release: &Release,
    target: impl Write,
    cancel: &AtomicBool,
    progress: impl Fn(u64),
) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        progress(0);
        let client = catalog::streaming_client()?;
        let request = client.get(url).send();
        let mut response = cancellable(request, cancel)
            .await?
            .and_then(|r| r.error_for_status())
            .map_err(|_| "The download failed. Check your connection and try again.")?;
        if response
            .content_length()
            .is_some_and(|n| n != release.byte_length)
        {
            return Err("The download size differs from the trusted release.".into());
        }
        let mut sink = VerifiedSink::new(target, release.byte_length, &release.sha256);
        let mut last = Instant::now();
        loop {
            let bytes = cancellable(response.chunk(), cancel)
                .await?
                .map_err(|_| "Download interrupted. Retry when connected.")?;
            let Some(bytes) = bytes else {
                break;
            };
            sink.write(&bytes)?;
            if last.elapsed() >= Duration::from_millis(150) {
                progress(sink.received);
                last = Instant::now();
            }
        }
        if cancel.load(Ordering::SeqCst) {
            return Err("Download cancelled.".into());
        }
        sink.finish()?;
        progress(release.byte_length);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn verifies_exact_bytes_and_rejects_corruption_truncation_and_extra_bytes() {
        let hash = format!("{:x}", Sha256::digest(b"abc"));
        for (data, size, valid) in [
            (b"abc".as_slice(), 3, true),
            (b"abd", 3, false),
            (b"ab", 3, false),
            (b"abcd", 3, false),
        ] {
            let mut output = Vec::new();
            let cancel = AtomicBool::new(false);
            assert_eq!(
                copy_verified(data, &mut output, size, &hash, &cancel, |_| {}).is_ok(),
                valid
            );
        }
    }
    #[test]
    fn cancellation_and_disk_errors_never_complete() {
        assert!(copy_verified(
            b"abc".as_slice(),
            Vec::new(),
            3,
            "bad",
            &AtomicBool::new(true),
            |_| {}
        )
        .unwrap_err()
        .contains("cancelled"));
        struct Full;
        impl Write for Full {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::ErrorKind::StorageFull.into())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        assert!(copy_verified(
            b"abc".as_slice(),
            Full,
            3,
            "bad",
            &AtomicBool::new(false),
            |_| {}
        )
        .unwrap_err()
        .contains("disk"));
    }
    #[test]
    fn local_record_replacement_is_atomic() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("record.json");
        atomic_write(&path, b"old").unwrap();
        atomic_write(&path, b"new").unwrap();
        assert_eq!(fs::read(path).unwrap(), b"new");
    }
    #[test]
    fn accepted_close_prevents_new_operations() {
        let manager = Manager::default();
        assert!(manager.allow_close());
        assert!(manager.begin().err().unwrap().contains("closing"));
    }
    #[test]
    fn busy_hub_refuses_close() {
        let manager = Manager::default();
        manager.busy.store(true, Ordering::SeqCst);
        assert!(!manager.allow_close());
        manager.busy.store(false, Ordering::SeqCst);
        assert!(manager.allow_close());
    }
    #[test]
    #[ignore = "Explicit network-only acceptance: downloads pinned official installers but never executes them"]
    fn real_pinned_downloads_are_verified_without_installation() {
        let manager = Manager::default();
        let _operation = manager.begin().unwrap();
        for app in AppId::ALL {
            let release = catalog::bootstrap(app);
            let file = manager.download(app, &release, &|_| {}).unwrap();
            assert_eq!(file_hash(&file).unwrap(), release.sha256);
            assert_eq!(fs::metadata(file).unwrap().len(), release.byte_length);
            println!("Verified {} {} download only", app.name(), release.version);
            let temp = tempfile::tempfile().unwrap();
            download_stream(app, &release, temp, &AtomicBool::new(false), |_| {}).unwrap();
        }
    }
    #[test]
    #[ignore = "Read-only live inventory: creates only Hub-owned cache directories; no app or project changes"]
    fn real_windows_inventory_does_not_launch_apps() {
        let snapshot = Manager::default().snapshot(false, false).unwrap();
        assert!(snapshot.supported);
        assert_eq!(snapshot.apps.len(), 2);
        for state in snapshot.apps {
            println!(
                "{}: installed={}, trusted={}, attention={}, detected={}, verifiedCopies={}",
                state.app.name(),
                state.installed,
                state.trusted,
                state.issue.is_some(),
                state.detected_copies.len(),
                state
                    .detected_copies
                    .iter()
                    .filter(|copy| copy.verified)
                    .count()
            );
        }
    }
    #[test]
    fn stalled_network_future_cancels_promptly_and_is_dropped() {
        let cancelled = std::sync::Arc::new(AtomicBool::new(false));
        let flag = cancelled.clone();
        let thread = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            flag.store(true, Ordering::SeqCst);
        });
        let start = Instant::now();
        struct Dropped(std::sync::Arc<AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let dropped = std::sync::Arc::new(AtomicBool::new(false));
        let marker = Dropped(dropped.clone());
        let pending = async {
            let _marker = marker;
            std::future::pending::<()>().await
        };
        let result = tauri::async_runtime::block_on(cancellable(pending, &cancelled));
        thread.join().unwrap();
        assert!(result.unwrap_err().contains("cancelled"));
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(dropped.load(Ordering::SeqCst));
    }
}
