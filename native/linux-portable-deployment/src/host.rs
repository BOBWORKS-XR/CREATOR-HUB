//! Native-host admission and reviewed deployment. No sandbox command relay,
//! settings import, service registration, network access or automatic recovery.
use super::*;
use std::{collections::BTreeMap, ffi::OsString, fs::File};

const RUNNER: &str = "AppRun";
pub const HOST_PROFILE: &str = "creator-hub-portable-host.json";
const STORE_DIRECTORY: &str = "creator-hub-portable";
pub const HOST_MARKER: &str = "CREATOR_HUB_PORTABLE_HOST";
const SESSION_ENV: &[&str] = &[
    "PATH",
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "DBUS_SESSION_BUS_ADDRESS",
    "XAUTHORITY",
    "LANG",
    "LC_ALL",
    "LANGUAGE",
];

/// Captured from a native process, never HOST_XDG_* hints supplied by a sandbox.
/// These values retain the existing native settings locations; they do not grant
/// permission to read/write any setting or establish client ownership.
pub struct HostSession {
    environment: BTreeMap<OsString, OsString>,
    store: PathBuf,
}

impl HostSession {
    pub fn capture() -> Result<Self> {
        disk::admit()?;
        require(
            std::env::var_os("FLATPAK_ID").is_none()
                && fs::symlink_metadata("/.flatpak-info")
                    .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound),
            "Portable host must run outside the Flatpak sandbox",
        )?;
        Self::from_values(
            SESSION_ENV.iter().filter_map(|name| {
                std::env::var_os(name).map(|value| (OsString::from(name), value))
            }),
        )
    }

    pub(super) fn from_values(
        values: impl IntoIterator<Item = (OsString, OsString)>,
    ) -> Result<Self> {
        let mut environment = BTreeMap::new();
        let mut length = 0;
        for (key, value) in values {
            require(
                SESSION_ENV.iter().any(|allowed| key == *allowed)
                    && !environment.contains_key(&key),
                "Only unique native session environment fields are accepted",
            )?;
            length += key.len() + value.len();
            require(length <= 32768, "Native session environment exceeds bound")?;
            if key == "PATH" {
                require(
                    !value.is_empty()
                        && std::env::split_paths(&value).all(|entry| {
                            entry.is_absolute()
                                && !entry
                                    .components()
                                    .any(|part| matches!(part, std::path::Component::ParentDir))
                        }),
                    "Native PATH must contain only absolute executable directories",
                )?;
            }
            if key == "HOME" || key.to_string_lossy().starts_with("XDG_") || key == "XAUTHORITY" {
                let path = Path::new(&value);
                require(
                    path.is_absolute()
                        && path.parent().is_some()
                        && !path
                            .components()
                            .any(|part| matches!(part, std::path::Component::ParentDir)
                                || matches!(part, std::path::Component::Normal(value) if value == "." || value == ".."))
                        && !value.to_string_lossy().chars().any(char::is_control),
                    "Native settings/session roots must be absolute and unambiguous",
                )?;
            }
            environment.insert(key, value);
        }
        let home = environment
            .get(std::ffi::OsStr::new("HOME"))
            .ok_or_else(|| refused("Native home directory is unavailable"))?;
        let data = environment
            .get(std::ffi::OsStr::new("XDG_DATA_HOME"))
            .map(PathBuf::from)
            .unwrap_or_else(|| Path::new(home).join(".local/share"));
        Ok(Self {
            environment,
            store: data.join(STORE_DIRECTORY),
        })
    }

    /// Dedicated executable store, not a replacement for the app's settings.
    pub fn store_path(&self) -> &Path {
        &self.store
    }

    pub fn config_home(&self) -> PathBuf {
        self.environment
            .get(std::ffi::OsStr::new("XDG_CONFIG_HOME"))
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                Path::new(&self.environment[std::ffi::OsStr::new("HOME")]).join(".config")
            })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallChoice {
    KeepCurrent,
    InstallReviewed,
}

/// Private fields bind approval to this store, target and exact prior selection.
pub struct InstallReview {
    root: PathBuf,
    generation: String,
    version: String,
    previous: Option<SelectionSnapshot>,
}

impl InstallReview {
    pub fn version(&self) -> &str {
        &self.version
    }
    pub fn previous(&self) -> Option<&Selection> {
        self.previous.as_ref().map(SelectionSnapshot::selection)
    }
}

#[derive(Debug)]
pub enum InstallOutcome {
    Declined,
    Selected(Activation),
}

impl Store {
    pub fn review_install(&self, package: &VerifiedPackage) -> Result<InstallReview> {
        self.review_install_with(package, &production_verify)
    }

    pub(super) fn review_install_with(
        &self,
        package: &VerifiedPackage,
        verifier: &Verifier,
    ) -> Result<InstallReview> {
        self.checked()?;
        let _lock = disk::lock(&self.root.join("transaction.lock"))?;
        no_recovery(self)?;
        signed_manifest(
            &package.bytes,
            &package.signature,
            &Expected::linux_x86_64(&package.manifest.version)?,
            verifier,
        )?;
        require_runner(&package.manifest)?;
        host_profile(
            &package.manifest,
            package
                .contents
                .get(HOST_PROFILE)
                .ok_or_else(|| refused("Signed portable host profile is required"))?,
        )?;
        let previous = self.snapshot_with(verifier)?;
        let generation = package.generation();
        if let Some(before) = &previous {
            require(
                before.selection.generation == generation
                    || semver::Version::parse(&package.manifest.version).unwrap()
                        > semver::Version::parse(&before.selection.version).unwrap(),
                "Downgrade or same-version replacement refused",
            )?;
        }
        Ok(InstallReview {
            root: self.root.clone(),
            generation,
            version: package.manifest.version.clone(),
            previous,
        })
    }

    /// Consent does not imply execution. Staging and selection remain separate
    /// from launching, connection checks, migration and release qualification.
    pub fn install_reviewed(
        &self,
        review: &InstallReview,
        package: &VerifiedPackage,
        choice: InstallChoice,
        cancelled: impl Fn() -> bool,
    ) -> Result<InstallOutcome> {
        self.install_reviewed_with(review, package, choice, &cancelled, &production_verify)
    }

    pub(super) fn install_reviewed_with(
        &self,
        review: &InstallReview,
        package: &VerifiedPackage,
        choice: InstallChoice,
        cancelled: &dyn Fn() -> bool,
        verifier: &Verifier,
    ) -> Result<InstallOutcome> {
        // Declining is read-only, even if the reviewed state has since changed.
        if choice == InstallChoice::KeepCurrent {
            return Ok(InstallOutcome::Declined);
        }
        cancel(cancelled)?;
        require(
            review.root == self.root
                && review.generation == package.generation()
                && review.version == package.manifest.version,
            "Reviewed deployment target changed",
        )?;
        {
            self.checked()?;
            let _lock = disk::lock(&self.root.join("transaction.lock"))?;
            no_recovery(self)?;
            require(
                self.snapshot_with(verifier)? == review.previous,
                "Current selection changed after review",
            )?;
        }
        let generation = self.stage_with(package, cancelled, &|_| Ok(()), verifier)?;
        let selected = self.activate_with(
            &generation,
            &Expected::linux_x86_64(&review.version)?,
            review.previous.as_ref(),
            cancelled,
            &|_| Ok(()),
            verifier,
        )?;
        Ok(InstallOutcome::Selected(selected))
    }

    pub fn activation_lease(&self, expected: &Expected) -> Result<LaunchLease> {
        self.activation_lease_with(expected, &production_verify)
    }

    pub(super) fn activation_lease_with(
        &self,
        expected: &Expected,
        verifier: &Verifier,
    ) -> Result<LaunchLease> {
        self.checked()?;
        let lock = disk::lock(&self.root.join("transaction.lock"))?;
        no_recovery(self)?;
        let snapshot = self
            .snapshot_with(verifier)?
            .ok_or_else(|| refused("No portable Hub installation is selected"))?;
        require(
            snapshot.selection.version == expected.version,
            "Selected host version does not match the launcher",
        )?;
        let manifest = self.generation(&snapshot.selection.generation, expected, verifier)?;
        require_runner(&manifest)?;
        let appdir = self
            .root
            .join("generations")
            .join(&snapshot.selection.generation)
            .join("AppDir");
        host_profile(
            &manifest,
            &disk::read_regular(&appdir.join(HOST_PROFILE), 4096, true)?,
        )?;
        let hold = |name: &str| -> Result<File> {
            let Entry::File { size, sha256, .. } = &manifest.entries[name] else {
                return Err(refused("Signed executable is not a file"));
            };
            let (file, bytes) = disk::hold_regular(&appdir.join(name), MAX_FILE, true)?;
            require(
                bytes.len() as u64 == *size && digest(&bytes) == *sha256,
                "Signed executable changed during activation",
            )?;
            Ok(file)
        };
        let runner = hold(RUNNER)?;
        let executable = hold(crate::ENTRYPOINT)?;
        require(
            self.snapshot_with(verifier)? == Some(snapshot.clone()),
            "Selection changed during activation",
        )?;
        Ok(LaunchLease {
            root: self.root.clone(),
            snapshot,
            appdir,
            runner,
            executable,
            _lock: lock,
        })
    }

    /// Startup readback does not take a writer lock: the launcher can still be
    /// returning from spawn. Exact selection/image checks bracket admission.
    #[cfg(target_os = "linux")]
    pub fn bind_current_process(&self, expected: &Expected) -> Result<()> {
        disk::admit()?;
        let actual = File::open("/proc/self/exe")
            .map_err(|_| refused("Cannot bind the running Hub executable"))?;
        self.bind_process_with(
            expected,
            std::env::var_os("APPDIR").as_deref(),
            &actual,
            &production_verify,
        )
    }

    #[cfg(any(target_os = "linux", test))]
    pub(super) fn bind_process_with(
        &self,
        expected: &Expected,
        appdir_hint: Option<&std::ffi::OsStr>,
        actual: &File,
        verifier: &Verifier,
    ) -> Result<()> {
        self.checked()?;
        no_recovery(self)?;
        let before = self
            .snapshot_with(verifier)?
            .ok_or_else(|| refused("No portable Hub is selected"))?;
        require(
            before.selection.version == expected.version,
            "Running host version differs from selection",
        )?;
        let manifest = self.generation(&before.selection.generation, expected, verifier)?;
        require_runner(&manifest)?;
        let appdir = self
            .root
            .join("generations")
            .join(&before.selection.generation)
            .join("AppDir");
        host_profile(
            &manifest,
            &disk::read_regular(&appdir.join(HOST_PROFILE), 4096, true)?,
        )?;
        require(
            appdir_hint == Some(appdir.as_os_str()),
            "Portable AppDir hint differs from the verified selection",
        )?;
        let (selected, _) = disk::hold_regular(&appdir.join(crate::ENTRYPOINT), MAX_FILE, true)?;
        require(
            same_file(&selected, actual)?,
            "Running Hub is not the selected signed executable",
        )?;
        no_recovery(self)?;
        require(
            self.snapshot_with(verifier)?.as_ref() == Some(&before),
            "Portable selection changed during startup",
        )
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostProfile {
    schema_version: u32,
    version: String,
    activation_interface: String,
    integrated_features: bool,
    startup_image_binding: u32,
    executable_sha256: String,
}

pub(super) fn host_profile(manifest: &Manifest, bytes: &[u8]) -> Result<()> {
    require(
        !bytes.is_empty() && bytes.len() <= 4096,
        "Bounded signed host profile is required",
    )?;
    let profile: HostProfile = serde_json::from_slice(bytes)
        .map_err(|_| refused("Malformed or ambiguous signed host profile"))?;
    let Entry::File { sha256, .. } = &manifest.entries[crate::ENTRYPOINT] else {
        return Err(refused("Signed Hub executable is not a regular file"));
    };
    require(
        matches!(manifest.entries.get(HOST_PROFILE),
        Some(Entry::File {mode: 0o644, size, sha256})
            if (1..=4096).contains(size) && *size == bytes.len() as u64 && *sha256 == digest(bytes))
            && profile.schema_version == 1
            && profile.version == manifest.version
            && profile.activation_interface == "com.creatorworks.hub.Host1"
            && profile.integrated_features
            && profile.startup_image_binding == 1
            && profile.executable_sha256 == *sha256,
        "Signed host profile does not bind this integrated Hub image/protocol",
    )
}

pub(super) fn require_runner(manifest: &Manifest) -> Result<()> {
    require(
        matches!(
            manifest.entries.get(RUNNER),
            Some(Entry::File {
                mode: 0o755,
                size: 1..,
                ..
            })
        ),
        "A signed executable AppRun is required for portable dependency setup",
    )
}

fn no_recovery(store: &Store) -> Result<()> {
    if optional_record(&store.root.join("pending.json"))?.is_some() {
        return Err(Error {
            kind: ErrorKind::RecoveryRequired,
            message: "Review portable deployment recovery before installation or activation",
        });
    }
    Ok(())
}

/// Holds a cooperative transaction lock and both signed executables. Native
/// launch uses fixed AppRun and fixed navigation only; no caller command/args.
/// Same-UID filesystem attacks remain outside the store's threat model.
pub struct LaunchLease {
    root: PathBuf,
    snapshot: SelectionSnapshot,
    appdir: PathBuf,
    runner: File,
    executable: File,
    _lock: File,
}

impl LaunchLease {
    pub fn selection(&self) -> &Selection {
        self.snapshot.selection()
    }

    pub fn revalidate(&self) -> Result<()> {
        self.recheck(&production_verify)
    }

    pub(super) fn recheck(&self, verifier: &Verifier) -> Result<()> {
        let store = Store::open_inner(&self.root)?;
        no_recovery(&store)?;
        require(
            store.snapshot_with(verifier)? == Some(self.snapshot.clone()),
            "Portable selection changed before activation",
        )?;
        for (name, held) in [
            (RUNNER, &self.runner),
            (crate::ENTRYPOINT, &self.executable),
        ] {
            let (named, _) = disk::hold_regular(&self.appdir.join(name), MAX_FILE, true)?;
            require(
                same_file(held, &named)?,
                "Portable executable pathname changed",
            )?;
        }
        Ok(())
    }

    /// This confirms only a child process was spawned. A native-window/version
    /// acknowledgement and live MCP connection are separate acceptance gates.
    #[cfg(target_os = "linux")]
    pub fn spawn(self, session: &HostSession) -> Result<std::process::Child> {
        disk::admit()?;
        require(
            self.root == session.store,
            "Activation must use this native session's fixed store",
        )?;
        self.recheck(&production_verify)?;
        let mut command = self.command(session);
        command
            .spawn()
            .map_err(|_| refused("Portable Hub could not start; settings and selection were kept"))
    }

    #[cfg(any(target_os = "linux", test))]
    pub(super) fn command(&self, session: &HostSession) -> std::process::Command {
        let mut command = std::process::Command::new(self.appdir.join(RUNNER));
        command
            .arg("--flatpak-activate")
            .current_dir(&self.appdir)
            .env_clear()
            .envs(&session.environment)
            .env("APPDIR", &self.appdir)
            .env(HOST_MARKER, "1")
            .stdin(std::process::Stdio::null());
        if !session
            .environment
            .contains_key(std::ffi::OsStr::new("PATH"))
        {
            command.env("PATH", "/usr/local/bin:/usr/bin:/bin");
        }
        command
    }
}

pub(super) fn same_file(left: &File, right: &File) -> Result<bool> {
    let a = left
        .metadata()
        .map_err(|_| refused("Cannot recheck held executable"))?;
    let b = right
        .metadata()
        .map_err(|_| refused("Cannot recheck executable identity"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok((
            a.dev(),
            a.ino(),
            a.uid(),
            a.mode(),
            a.nlink(),
            a.len(),
            a.ctime(),
            a.ctime_nsec(),
        ) == (
            b.dev(),
            b.ino(),
            b.uid(),
            b.mode(),
            b.nlink(),
            b.len(),
            b.ctime(),
            b.ctime_nsec(),
        ))
    }
    #[cfg(not(unix))]
    Ok(a.len() == b.len() && a.modified().ok() == b.modified().ok())
}
