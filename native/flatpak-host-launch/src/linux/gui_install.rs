//! Native-only selection. Neither the renderer nor the wire can select a path or pin.
use super::{identity, launch::OwnedLaunch, Result};
use std::{
    collections::BTreeMap,
    fs::File,
    io::Read,
    os::{fd::AsRawFd, unix::fs::MetadataExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub(super) const REF: &str = "app/com.creatorworks.hub/x86_64/stable";
pub(super) const RUNTIME: &str = "runtime/org.gnome.Platform/x86_64/50";
const FLATPAK: &str = "/usr/bin/flatpak";

pub(super) fn compiled_hash() -> Result<&'static str> {
    option_env!("CREATOR_FLATPAK_GUI_SHA256")
        .filter(|s| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                && s.bytes().any(|b| b != b'0')
        })
        .ok_or("gui-compiled-image-pin-required")
}

struct SystemImage {
    file: File,
    identity: (u64, u64, u64, i64, i64),
}
impl SystemImage {
    fn open() -> Result<Self> {
        let dir = identity::directory(Path::new("/usr/bin"), 0, false)?;
        let file = identity::at(&dir, "flatpak", libc::O_RDONLY | libc::O_NOFOLLOW)?;
        let m = file.metadata().map_err(|_| "gui-flatpak-stat")?;
        if !m.is_file()
            || m.uid() != 0
            || m.mode() & 0o7022 != 0
            || m.mode() & 0o111 == 0
            || m.len() < 64
            || m.len() > 32 * 1024 * 1024
        {
            return Err("gui-flatpak-owner-mode");
        }
        let mut magic = [0; 20];
        (&file)
            .read_exact(&mut magic)
            .map_err(|_| "gui-flatpak-image")?;
        if magic[..6] != [127, 69, 76, 70, 2, 1] || magic[18..20] != 62u16.to_le_bytes() {
            return Err("gui-flatpak-elf");
        }
        Ok(Self {
            file,
            identity: (m.dev(), m.ino(), m.len(), m.ctime(), m.ctime_nsec()),
        })
    }
    fn check(&self) -> Result<()> {
        let current = Self::open()?;
        if current.identity != self.identity
            || identity::object(&self.file.metadata().map_err(|_| "gui-flatpak-stat")?)
                != (self.identity.0, self.identity.1)
        {
            return Err("gui-flatpak-replaced");
        }
        Ok(())
    }
}

pub(super) struct Installation {
    pub uid: u32,
    pub app_path: PathBuf,
    pub runtime_path: PathBuf,
    pub app_commit: String,
    pub runtime_commit: String,
    pub hash: &'static str,
    pub image: Option<identity::GuiImagePin>,
    env: BTreeMap<String, std::ffi::OsString>,
    home: PathBuf,
    app_user: bool,
    flatpak: SystemImage,
}

fn absolute(value: std::ffi::OsString) -> Result<PathBuf> {
    let path = PathBuf::from(value);
    if !path.is_absolute()
        || path.components().any(|p| {
            !matches!(
                p,
                std::path::Component::RootDir | std::path::Component::Normal(_)
            )
        })
        || path
            .to_str()
            .is_none_or(|s| s.chars().any(char::is_control))
    {
        return Err("gui-native-directory");
    }
    Ok(path)
}

fn commit(value: String) -> Result<String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || value.bytes().all(|b| b == b'0')
    {
        return Err("gui-deployment-commit");
    }
    Ok(value)
}

impl Installation {
    pub fn inspect(deadline: Instant) -> Result<Self> {
        // Compile-time native pin is checked before environment, filesystem or process work.
        let hash = compiled_hash()?;
        let uid = identity::uid()?;
        if std::env::var_os("FLATPAK_ID").is_some()
            || Path::new("/.flatpak-info")
                .try_exists()
                .map_err(|_| "gui-native-context")?
        {
            return Err("gui-native-context");
        }
        let home = absolute(std::env::var_os("HOME").ok_or("gui-native-home")?)?;
        identity::directory(&home, uid, false)?;
        let data = absolute(
            std::env::var_os("XDG_DATA_HOME")
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| home.join(".local/share").into()),
        )?;
        let user_root = data.join("flatpak");
        let mut env = BTreeMap::from([
            ("HOME".into(), home.clone().into_os_string()),
            ("XDG_DATA_HOME".into(), data.into_os_string()),
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("LANG".into(), "C.UTF-8".into()),
            ("FLATPAK_FANCY_OUTPUT".into(), "0".into()),
        ]);
        for key in [
            "XDG_CONFIG_HOME",
            "XDG_CACHE_HOME",
            "XDG_STATE_HOME",
            "XDG_RUNTIME_DIR",
            "DISPLAY",
            "WAYLAND_DISPLAY",
            "XAUTHORITY",
            "DBUS_SESSION_BUS_ADDRESS",
        ] {
            if let Some(value) = std::env::var_os(key) {
                env.insert(key.into(), value);
            }
        }
        let runtime_dir = absolute(
            env.get("XDG_RUNTIME_DIR")
                .cloned()
                .ok_or("gui-session-runtime")?,
        )?;
        identity::directory(&runtime_dir, uid, true)?;
        let mut result = Self {
            uid,
            app_path: PathBuf::new(),
            runtime_path: PathBuf::new(),
            app_commit: String::new(),
            runtime_commit: String::new(),
            hash,
            image: None,
            env,
            home,
            app_user: false,
            flatpak: SystemImage::open()?,
        };
        let version = result.cli(&["--version"], deadline)?;
        let v = version
            .strip_prefix("Flatpak ")
            .ok_or("gui-flatpak-version")?
            .split('.')
            .map(str::parse::<u32>)
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| "gui-flatpak-version")?;
        if v.len() != 3 || (v[0], v[1], v[2]) < (1, 18, 4) {
            return Err("gui-flatpak-version");
        }
        let user = result.contains(true, false, REF, deadline)?;
        if user {
            identity::directory(&user_root, uid, false)?;
        }
        result.app_user = user;
        if !user && !result.contains(false, false, REF, deadline)? {
            return Err("gui-not-installed");
        }
        result.app_commit = commit(result.info(user, "--show-commit", REF, deadline)?)?;
        let app_base = if user {
            user_root.clone()
        } else {
            PathBuf::from("/var/lib/flatpak")
        };
        result.app_path =
            result.deployment_path(user, REF, &result.app_commit, &app_base, deadline)?;
        if result.info(user, "--show-runtime", REF, deadline)?
            != RUNTIME.strip_prefix("runtime/").ok_or("gui-runtime-ref")?
        {
            return Err("gui-runtime-ref");
        }
        let runtime_user = user && result.contains(true, true, RUNTIME, deadline)?;
        if !runtime_user && !result.contains(false, true, RUNTIME, deadline)? {
            return Err("gui-runtime-unavailable");
        }
        result.runtime_commit =
            commit(result.info(runtime_user, "--show-commit", RUNTIME, deadline)?)?;
        let runtime_base = if runtime_user {
            user_root
        } else {
            PathBuf::from("/var/lib/flatpak")
        };
        result.runtime_path = result.deployment_path(
            runtime_user,
            RUNTIME,
            &result.runtime_commit,
            &runtime_base,
            deadline,
        )?;
        result.image = Some(identity::GuiImagePin::admit(
            &result.app_path,
            &result.runtime_path,
            hash,
            uid,
            deadline,
        )?);
        Ok(result)
    }

    fn contains(
        &self,
        user: bool,
        runtime: bool,
        reference: &str,
        deadline: Instant,
    ) -> Result<bool> {
        let output = self.cli(
            &[
                "list",
                if user { "--user" } else { "--system" },
                if runtime { "--runtime" } else { "--app" },
                "--columns=ref",
            ],
            deadline,
        )?;
        let count = output.lines().filter(|line| *line == reference).count();
        if count > 1 {
            return Err("gui-ambiguous-installation");
        }
        Ok(count == 1)
    }
    fn info(&self, user: bool, option: &str, reference: &str, deadline: Instant) -> Result<String> {
        self.cli(
            &[
                "info",
                if user { "--user" } else { "--system" },
                option,
                reference,
            ],
            deadline,
        )
    }
    fn deployment_path(
        &self,
        user: bool,
        reference: &str,
        commit: &str,
        base: &Path,
        deadline: Instant,
    ) -> Result<PathBuf> {
        let location = self.info(user, "--show-location", reference, deadline)?;
        let expected = base.join(reference).join(commit);
        if Path::new(&location) != expected {
            return Err("gui-alternate-installation");
        }
        let files = expected.join("files");
        identity::directory(&files, self.uid, false)?;
        Ok(files)
    }
    pub fn recheck_os(&self) -> Result<()> {
        self.flatpak.check()
    }
    pub fn command(&self) -> Result<Command> {
        self.recheck_os()?;
        let mut command = Command::new(FLATPAK);
        command.args([
            "run",
            if self.app_user { "--user" } else { "--system" },
            "--die-with-parent",
            "--instance-id-fd=4",
            &format!("--commit={}", self.app_commit),
            &format!("--runtime-commit={}", self.runtime_commit),
            "--command=/app/bin/creator-hub",
            REF,
        ]);
        command.env_clear().envs(&self.env).current_dir(&self.home);
        Ok(command)
    }
    fn cli(&self, args: &[&str], deadline: Instant) -> Result<String> {
        self.recheck_os()?;
        let child = Command::new(FLATPAK)
            .args(args)
            .env_clear()
            .envs(&self.env)
            .current_dir(&self.home)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "gui-flatpak-inspection")?;
        let mut child = OwnedLaunch {
            socket: None,
            child,
            cleaned: false,
            reaped: false,
        };
        let mut out = child.child.stdout.take().ok_or("gui-inspection-output")?;
        let fd = out.as_raw_fd();
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err("gui-inspection-nonblock");
        }
        let mut bytes = Vec::new();
        let mut eof = false;
        loop {
            if Instant::now() >= deadline {
                return Err("gui-inspection-deadline");
            }
            let mut buf = [0; 4096];
            match out.read(&mut buf) {
                Ok(0) => eof = true,
                Ok(n) => {
                    if bytes.len() + n > 65536 {
                        return Err("gui-inspection-limit");
                    }
                    bytes.extend_from_slice(&buf[..n]);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return Err("gui-inspection-read"),
            }
            if let Some(status) = child.child.try_wait().map_err(|_| "gui-inspection-wait")? {
                if !status.success() {
                    return Err("gui-inspection-refused");
                }
                if eof {
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        if !child.cleanup() {
            return Err("gui-inspection-reap");
        }
        self.recheck_os()?;
        let text = String::from_utf8(bytes).map_err(|_| "gui-inspection-encoding")?;
        Ok(text.strip_suffix('\n').unwrap_or(&text).to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_paths_and_commits_reject_relative_parent_and_controls() {
        for p in ["relative", "/a/../b", "/a\nb"] {
            assert!(absolute(p.into()).is_err());
        }
        assert!(absolute("/home/test/.local/share".into()).is_ok());
        for s in [
            "0".repeat(64),
            "A".repeat(64),
            "1".repeat(63),
            format!("{}\n", "1".repeat(64)),
        ] {
            assert!(commit(s).is_err());
        }
        assert!(commit("a".repeat(64)).is_ok());
    }
}
