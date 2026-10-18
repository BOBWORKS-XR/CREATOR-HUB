use super::{transport, Result};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::CString,
    fs::{File, Metadata},
    io::Read,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{FileExt, MetadataExt},
    },
    path::{Component, Path},
    time::Instant,
};

pub(crate) const APP: &str = "com.creatorworks.hub";
pub(crate) const APP_REF: &str = "app/com.creatorworks.hub/x86_64/flatpak-test";
pub(crate) const ECHO: &str = "/app/libexec/creator-hub-flatpak-launch-echo";
const REPLACEMENT_KEYS: [&str; 3] = ["original-app-path", "original-runtime-path", "extra-args"];
const REFUSAL_FILE: &str = "deployment-metadata-refusal.json";
const VALUE_PREVIEW_BYTES: usize = 256;
const REFUSAL_BYTES: usize = 8192;

pub(crate) struct Pins {
    pub app: &'static str,
    pub runtime: &'static str,
    pub echo: &'static str,
    pub flatpak: &'static str,
}

impl Pins {
    pub fn compiled() -> Result<Self> {
        Ok(Self {
            app: pin(option_env!("CREATOR_FLATPAK_LAUNCH_APP_COMMIT"))?,
            runtime: pin(option_env!("CREATOR_FLATPAK_LAUNCH_RUNTIME_COMMIT"))?,
            echo: pin(option_env!("CREATOR_FLATPAK_LAUNCH_ECHO_SHA256"))?,
            flatpak: pin(option_env!("CREATOR_FLATPAK_LAUNCH_FLATPAK_SHA256"))?,
        })
    }
}

fn pin(value: Option<&'static str>) -> Result<&'static str> {
    value
        .filter(|s| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                && s.bytes().any(|b| b != b'0')
        })
        .ok_or("unreviewed-build-pins")
}

pub(crate) fn uid() -> Result<u32> {
    let mut u = [0; 3];
    let mut g = [0; 3];
    let up = u.as_mut_ptr();
    let gp = g.as_mut_ptr();
    if unsafe { libc::getresuid(up, up.add(1), up.add(2)) } != 0
        || unsafe { libc::getresgid(gp, gp.add(1), gp.add(2)) } != 0
        || u[0] == 0
        || u.iter().any(|v| *v != u[0])
        || g.iter().any(|v| *v != g[0])
    {
        return Err("native-uid-required");
    }
    Ok(u[0])
}

pub(crate) fn at(parent: &File, name: &str, flags: i32) -> Result<File> {
    let name = CString::new(name).map_err(|_| "path-nul")?;
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags | libc::O_CLOEXEC) };
    if fd < 0 {
        return Err("inspection-unavailable");
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

pub(crate) fn directory(path: &Path, uid: u32, private: bool) -> Result<File> {
    if !path.is_absolute() {
        return Err("directory-not-absolute");
    }
    let mut file = File::open("/").map_err(|_| "root-open")?;
    for part in path.components().skip(1) {
        let Component::Normal(name) = part else {
            return Err("directory-component");
        };
        let name = name.to_str().ok_or("directory-encoding")?;
        file = at(
            &file,
            name,
            libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW,
        )?;
        let m = file.metadata().map_err(|_| "directory-stat")?;
        if (m.uid() != 0 && m.uid() != uid) || m.mode() & 0o7022 != 0 {
            return Err("directory-owner-mode");
        }
    }
    let m = file.metadata().map_err(|_| "directory-stat")?;
    if private && (m.uid() != uid || m.mode() & 0o077 != 0) {
        return Err("private-directory-required");
    }
    Ok(file)
}

pub(crate) fn read(parent: &File, name: &str, limit: usize) -> Result<String> {
    let mut file = at(
        parent,
        name,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK,
    )?;
    let mut data = Vec::new();
    file.by_ref()
        .take(limit as u64 + 1)
        .read_to_end(&mut data)
        .map_err(|_| "bounded-read")?;
    if data.len() > limit {
        return Err("inspection-limit");
    }
    String::from_utf8(data).map_err(|_| "inspection-encoding")
}

pub(crate) fn digest(mut file: File, expected: &str, deadline: Instant) -> Result<()> {
    if !file.metadata().map_err(|_| "image-stat")?.is_file() {
        return Err("image-not-regular");
    }
    let mut hash = Sha256::new();
    let mut bytes = [0; 32768];
    let mut total = 0usize;
    loop {
        if Instant::now() >= deadline {
            return Err("deadline");
        }
        let n = file.read(&mut bytes).map_err(|_| "image-read")?;
        if n == 0 {
            break;
        }
        total += n;
        if total > 32 * 1024 * 1024 {
            return Err("image-limit");
        }
        hash.update(&bytes[..n]);
    }
    let actual = format!("{:x}", hash.finalize());
    if actual != expected {
        return Err("image-hash");
    }
    Ok(())
}

pub(crate) fn object(m: &Metadata) -> (u64, u64) {
    (m.dev(), m.ino())
}

pub(crate) struct Proc {
    pub dir: File,
    pub parent: u32,
    pub start: u64,
}

pub(crate) fn process(pid: u32, expected_uid: u32) -> Result<Proc> {
    if pid <= 1 {
        return Err("process-id");
    }
    let proc = File::open("/proc").map_err(|_| "proc-open")?;
    let mut fs: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstatfs(proc.as_raw_fd(), &mut fs) } != 0
        || fs.f_type != libc::PROC_SUPER_MAGIC
    {
        return Err("not-procfs");
    }
    let dir = at(
        &proc,
        &pid.to_string(),
        libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW,
    )?;
    let stat = read(&dir, "stat", 8192)?;
    let (parent, start) = stat_fields(&stat)?;
    let status = read(&dir, "status", 16384)?;
    let ids = status
        .lines()
        .find_map(|line| line.strip_prefix("Uid:"))
        .ok_or("process-uid")?;
    let ids = ids
        .split_whitespace()
        .map(str::parse::<u32>)
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| "process-uid")?;
    if ids.len() != 4 || ids.iter().any(|v| *v != expected_uid) {
        return Err("process-uid");
    }
    Ok(Proc { dir, parent, start })
}

fn stat_fields(stat: &str) -> Result<(u32, u64)> {
    let tail = stat.rsplit_once(") ").ok_or("process-stat")?.1;
    let fields = tail.split_whitespace().collect::<Vec<_>>();
    if fields.len() < 20 || fields[0] == "Z" || fields[0] == "X" {
        return Err("process-exited");
    }
    Ok((
        fields[1].parse().map_err(|_| "process-parent")?,
        fields[19].parse().map_err(|_| "process-start")?,
    ))
}

pub(crate) fn sender<const N: usize>(
    message: &transport::Message<N>,
    expected: Option<(u32, u64)>,
    owner: (u32, u64),
    uid: u32,
) -> Result<(u32, u64)> {
    transport::alive(&message.pidfd)?;
    let pid = u32::try_from(message.credentials.pid).map_err(|_| "sender-pid")?;
    if message.credentials.uid != uid {
        return Err("sender-uid");
    }
    let p = process(pid, uid)?;
    let identity = (pid, p.start);
    if expected.is_some_and(|e| e != identity) {
        return Err("sender-changed");
    }
    let self_dir = File::open("/proc/self").map_err(|_| "proc-self")?;
    let fdinfo = read(
        &self_dir,
        &format!("fdinfo/{}", message.pidfd.as_raw_fd()),
        4096,
    )?;
    if fdinfo
        .lines()
        .find_map(|line| line.strip_prefix("Pid:"))
        .and_then(|s| s.trim().parse::<u32>().ok())
        != Some(pid)
    {
        return Err("sender-pidfd-mismatch");
    }
    let mut ancestor = pid;
    let mut owned = false;
    for _ in 0..8 {
        let current = process(ancestor, uid)?;
        if ancestor == owner.0 {
            owned = current.start == owner.1;
            break;
        }
        if current.parent == ancestor || current.parent <= 1 {
            break;
        }
        ancestor = current.parent;
    }
    if !owned || pid == owner.0 {
        return Err("foreign-launch-tree");
    }
    transport::alive(&message.pidfd)?;
    Ok(identity)
}

pub(crate) fn deployment(
    message: &transport::Message,
    root: &Path,
    pins: &Pins,
    instance: &str,
    uid: u32,
    deadline: Instant,
) -> Result<()> {
    let app_path = root.join(format!(
        "flatpak/app/{APP}/x86_64/flatpak-test/{}/files",
        pins.app
    ));
    let runtime_path = std::path::PathBuf::from(format!(
        "/var/lib/flatpak/runtime/org.gnome.Platform/x86_64/50/{}/files",
        pins.runtime
    ));
    deployment_image(
        message,
        &Deployment {
            app_path: &app_path,
            runtime_path: &runtime_path,
            executable_directory: "libexec",
            executable: "creator-hub-flatpak-launch-echo",
            executable_hash: pins.echo,
            app_commit: pins.app,
            runtime_commit: pins.runtime,
            instance,
            sandbox: Sandbox::Echo(root),
        },
        uid,
        deadline,
    )
}

pub(crate) enum Sandbox<'a> {
    Echo(&'a Path),
    Gui(&'a GuiImagePin),
}

// No atime: inspection reads must not invalidate a lease. ctime catches even a
// write followed by restoration of length/mtime. Any stamp drift refuses; it
// never renews a pin or silently rehashes/adopts changed bytes.
#[derive(Debug, PartialEq, Eq)]
struct Stamp {
    object: (u64, u64),
    uid: u32,
    gid: u32,
    mode: u32,
    links: u64,
    length: u64,
    ctime: (i64, i64),
    mtime: (i64, i64),
}
impl Stamp {
    fn of(file: &File) -> Result<Self> {
        let m = file.metadata().map_err(|_| "gui-pinned-stat")?;
        Ok(Self {
            object: object(&m),
            uid: m.uid(),
            gid: m.gid(),
            mode: m.mode(),
            links: m.nlink(),
            length: m.len(),
            ctime: (m.ctime(), m.ctime_nsec()),
            mtime: (m.mtime(), m.mtime_nsec()),
        })
    }
}

pub(crate) struct GuiImagePin {
    image: File,
    image_stamp: Stamp,
    app: File,
    app_stamp: Stamp,
    runtime: File,
    runtime_stamp: Stamp,
}
impl GuiImagePin {
    pub fn admit(
        app_path: &Path,
        runtime_path: &Path,
        expected: &str,
        uid: u32,
        deadline: Instant,
    ) -> Result<Self> {
        let app = directory(app_path, uid, false)?;
        let runtime = directory(runtime_path, uid, false)?;
        let app_stamp = Stamp::of(&app)?;
        let runtime_stamp = Stamp::of(&runtime)?;
        let bin = directory(&app_path.join("bin"), uid, false)?;
        let image = at(
            &bin,
            "creator-hub",
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK,
        )?;
        let image_stamp = Stamp::of(&image)?;
        if (image_stamp.uid != 0 && image_stamp.uid != uid)
            || image_stamp.mode & 0o7022 != 0
            || image_stamp.mode & 0o111 == 0
        {
            return Err("gui-image-owner-mode");
        }
        let mut magic = [0; 20];
        if image.read_at(&mut magic, 0).map_err(|_| "gui-image-elf")? != magic.len()
            || magic[..6] != [127, 69, 76, 70, 2, 1]
            || magic[18..20] != 62u16.to_le_bytes()
        {
            return Err("gui-image-elf");
        }
        digest(
            image.try_clone().map_err(|_| "gui-image-pin")?,
            expected,
            deadline,
        )?;
        let result = Self {
            image,
            image_stamp,
            app,
            app_stamp,
            runtime,
            runtime_stamp,
        };
        result.held()?;
        Ok(result)
    }
    fn held(&self) -> Result<()> {
        for (file, expected) in [
            (&self.image, &self.image_stamp),
            (&self.app, &self.app_stamp),
            (&self.runtime, &self.runtime_stamp),
        ] {
            if Stamp::of(file)? != *expected {
                return Err("gui-pinned-image-or-root-changed");
            }
        }
        Ok(())
    }
    fn root(&self, name: &str, mounted: &File, installed: &File) -> Result<()> {
        self.held()?;
        let expected = if name == "app" {
            &self.app_stamp
        } else {
            &self.runtime_stamp
        };
        if Stamp::of(mounted)? != *expected || Stamp::of(installed)? != *expected {
            return Err("gui-pinned-root-changed");
        }
        Ok(())
    }
    fn image(&self, actual: &File, installed: &File) -> Result<()> {
        self.held()?;
        if Stamp::of(actual)? != self.image_stamp || Stamp::of(installed)? != self.image_stamp {
            return Err("gui-pinned-image-changed");
        }
        Ok(())
    }
}

pub(crate) struct Deployment<'a> {
    pub app_path: &'a Path,
    pub runtime_path: &'a Path,
    pub executable_directory: &'a str,
    pub executable: &'a str,
    pub executable_hash: &'a str,
    pub app_commit: &'a str,
    pub runtime_commit: &'a str,
    pub instance: &'a str,
    pub sandbox: Sandbox<'a>,
}

pub(crate) fn deployment_image<const N: usize>(
    message: &transport::Message<N>,
    profile: &Deployment<'_>,
    uid: u32,
    deadline: Instant,
) -> Result<()> {
    let gui = matches!(profile.sandbox, Sandbox::Gui(_));
    transport::alive(&message.pidfd)?;
    let proc = process(message.credentials.pid as u32, uid)?;
    // Only kernel-derived procfs links are traversed; no peer pathname selects a read.
    let sandbox = at(&proc.dir, "root", libc::O_PATH | libc::O_DIRECTORY)?;
    for (name, expected) in [("app", profile.app_path), ("usr", profile.runtime_path)] {
        let mounted = at(
            &sandbox,
            name,
            libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW,
        )?;
        let expected = directory(expected, uid, false)?;
        if object(&mounted.metadata().map_err(|_| "mount-stat")?)
            != object(&expected.metadata().map_err(|_| "mount-stat")?)
        {
            return Err("deployment-mount-mismatch");
        }
        if let Sandbox::Gui(pin) = profile.sandbox {
            pin.root(name, &mounted, &expected)?;
        }
    }
    let actual = at(&proc.dir, "exe", libc::O_RDONLY)?;
    let installed = directory(
        &profile.app_path.join(profile.executable_directory),
        uid,
        false,
    )?;
    let installed = at(
        &installed,
        profile.executable,
        libc::O_RDONLY | libc::O_NOFOLLOW | if gui { libc::O_NONBLOCK } else { 0 },
    )?;
    let installed_meta = installed.metadata().map_err(|_| "image-stat")?;
    if gui
        && ((installed_meta.uid() != 0 && installed_meta.uid() != uid)
            || installed_meta.mode() & 0o7022 != 0
            || installed_meta.mode() & 0o111 == 0)
    {
        return Err("gui-image-owner-mode");
    }
    if object(&actual.metadata().map_err(|_| "image-stat")?) != object(&installed_meta) {
        return Err(if gui {
            "gui-image-object-mismatch"
        } else {
            "echo-image-object-mismatch"
        });
    }
    match profile.sandbox {
        Sandbox::Echo(_) => digest(actual, profile.executable_hash, deadline)?,
        Sandbox::Gui(pin) => pin.image(&actual, &installed)?,
    }
    let metadata = read(&sandbox, ".flatpak-info", 65536)?;
    let fields = keyfile(&metadata)?;
    for (group, key, expected) in [
        ("Application", "name", APP),
        ("Instance", "app-commit", profile.app_commit),
        ("Instance", "runtime-commit", profile.runtime_commit),
        ("Instance", "instance-id", profile.instance),
        (
            "Instance",
            "app-path",
            profile.app_path.to_str().ok_or("app-path-encoding")?,
        ),
        (
            "Instance",
            "runtime-path",
            profile
                .runtime_path
                .to_str()
                .ok_or("runtime-path-encoding")?,
        ),
    ] {
        if fields
            .get(&(group.to_owned(), key.to_owned()))
            .map(String::as_str)
            != Some(expected)
        {
            return Err("deployment-metadata-mismatch");
        }
    }
    for ((section, key), value) in &fields {
        if section == "Instance" && replacement_metadata(key, value) {
            return match profile.sandbox {
                Sandbox::Echo(root) => replacement_refusal(root, &fields, key, uid),
                Sandbox::Gui(_) => Err("replacement-deployment"),
            };
        }
        if section == "Instance" && ["build", "devel"].contains(&key.as_str()) && value != "false" {
            return Err("development-sandbox");
        }
        if gui && section == "Environment" {
            return Err("gui-environment-override");
        }
        if section == "Session Bus Policy" && gui {
            if key != "com.creatorworks.hub.Host" || value != "talk" {
                return Err("unexpected-bus-policy");
            }
            continue;
        }
        if section == "Session Bus Policy" || section == "System Bus Policy" {
            return Err("unexpected-bus-policy");
        }
        if section == "Context" {
            let expected: &[&str] = match key.as_str() {
                "shared" if gui => &["ipc", "network"],
                "shared" => &["ipc"],
                "sockets" => &["fallback-x11", "wayland"],
                "devices" => &["dri"],
                "features" if value.is_empty() || value == "!devel;" => &[],
                _ if value.is_empty() && !gui => &[],
                _ => return Err("unexpected-sandbox-grant"),
            };
            let mut actual = value
                .split(';')
                .filter(|v| !v.is_empty())
                .collect::<Vec<_>>();
            if key == "features" {
                actual.clear();
            }
            actual.sort_unstable();
            if actual != expected {
                return Err("unexpected-sandbox-grant");
            }
        }
    }
    if gui {
        for key in ["shared", "sockets", "devices"] {
            if !fields.contains_key(&("Context".to_owned(), key.to_owned())) {
                return Err("missing-sandbox-grant");
            }
        }
        if fields
            .get(&(
                "Session Bus Policy".to_owned(),
                "com.creatorworks.hub.Host".to_owned(),
            ))
            .map(String::as_str)
            != Some("talk")
        {
            return Err("missing-bootstrap-policy");
        }
    }
    for name in ["mnt", "pid"] {
        let child = at(&proc.dir, &format!("ns/{name}"), libc::O_RDONLY)?;
        let native = File::open(format!("/proc/self/ns/{name}")).map_err(|_| "namespace-open")?;
        if object(&child.metadata().map_err(|_| "namespace-stat")?)
            == object(&native.metadata().map_err(|_| "namespace-stat")?)
        {
            return Err("not-owned-sandbox-namespace");
        }
    }
    transport::alive(&message.pidfd)
}

fn replacement_metadata(key: &str, value: &str) -> bool {
    // Native39106656388: an otherwise exact installed deployment emits this
    // empty list twice. Flatpak1.18.4 flatpak-context.c:3579-3588 unconditionally
    // serializes enumerable and hidden USB lists, even when both are empty.
    // This is not permission to accept nonempty USB queries or other CLI args.
    match key {
        "extra-args" => value != "--usb-list=;--usb-list=;",
        "original-app-path" | "original-runtime-path" => true,
        _ => false,
    }
}

fn replacement_refusal(
    root: &Path,
    fields: &BTreeMap<(String, String), String>,
    key: &str,
    uid: u32,
) -> Result<()> {
    // Diagnostic failure must never replace the original refusal or grant authority.
    let _ = write_metadata_refusal(root, fields, key, uid);
    Err("replacement-deployment")
}

fn metadata_refusal_payload(
    fields: &BTreeMap<(String, String), String>,
    key: &str,
) -> Result<String> {
    let key = REPLACEMENT_KEYS
        .iter()
        .find(|known| **known == key)
        .ok_or("diagnostic-key")?;
    if !fields.contains_key(&("Instance".to_owned(), (*key).to_owned())) {
        return Err("diagnostic-key");
    }
    let mut output = format!("{{\"refusedKey\":\"{key}\",\"values\":{{");
    for (index, known) in REPLACEMENT_KEYS.iter().enumerate() {
        if index != 0 {
            output.push(',');
        }
        output.push_str(&format!("\"{known}\":"));
        if let Some(value) = fields.get(&("Instance".to_owned(), (*known).to_owned())) {
            quoted_preview(&mut output, value);
        } else {
            output.push_str("null");
        }
    }
    output.push_str("}}\n");
    if output.len() > REFUSAL_BYTES {
        return Err("diagnostic-limit");
    }
    Ok(output)
}

fn quoted_preview(output: &mut String, value: &str) {
    const MARKER: &str = "[truncated]";
    let truncated = value.len() > VALUE_PREVIEW_BYTES;
    let mut end = if truncated {
        VALUE_PREVIEW_BYTES - MARKER.len()
    } else {
        value.len()
    };
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    output.push('"');
    for character in value[..end].chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            control if control < '\u{20}' => {
                output.push_str(&format!("\\u{:04x}", u32::from(control)));
            }
            other => output.push(other),
        }
    }
    if truncated {
        output.push_str(MARKER);
    }
    output.push('"');
}

fn write_metadata_refusal(
    root: &Path,
    fields: &BTreeMap<(String, String), String>,
    key: &str,
    uid: u32,
) -> Result<()> {
    let payload = metadata_refusal_payload(fields, key)?;
    // The caller supplies only prepare()'s fresh fixed proof root. No metadata
    // value is a pathname; the admitted directory FD anchors the sole new file.
    let parent = directory(root, uid, true)?;
    let m = parent.metadata().map_err(|_| "diagnostic-directory-stat")?;
    if m.uid() != uid || m.mode() & 0o7777 != 0o700 {
        return Err("diagnostic-directory-mode");
    }
    let name = CString::new(REFUSAL_FILE).map_err(|_| "diagnostic-name")?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_WRONLY
                | libc::O_CREAT
                | libc::O_EXCL
                | libc::O_NOFOLLOW
                | libc::O_CLOEXEC
                | libc::O_NONBLOCK,
            0o600 as libc::mode_t,
        )
    };
    if fd < 0 {
        return Err("diagnostic-create-new");
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let m = file.metadata().map_err(|_| "diagnostic-stat")?;
    if !m.is_file() || m.uid() != uid || m.nlink() != 1 || m.mode() & 0o7777 != 0o600 {
        return Err("diagnostic-file-mode");
    }
    std::io::Write::write_all(&mut file, payload.as_bytes()).map_err(|_| "diagnostic-write")?;
    file.sync_all().map_err(|_| "diagnostic-sync")
}

// Deliberately accepts only Flatpak's simple generated subset, not arbitrary INI.
pub(crate) fn keyfile(input: &str) -> Result<BTreeMap<(String, String), String>> {
    let mut group = "";
    let mut fields = BTreeMap::new();
    for line in input.lines() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.len() > 8192 || line.contains('\\') || line.contains('\0') {
            return Err("metadata-subset");
        }
        if line.starts_with('[') && line.ends_with(']') {
            group = &line[1..line.len() - 1];
            continue;
        }
        let (key, value) = line.split_once('=').ok_or("metadata-line")?;
        if group.is_empty()
            || key.is_empty()
            || fields
                .insert((group.to_owned(), key.to_owned()), value.to_owned())
                .is_some()
        {
            return Err("metadata-duplicate");
        }
        if fields.len() > 128 {
            return Err("metadata-limit");
        }
    }
    Ok(fields)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::{symlink, PermissionsExt},
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    struct DiagnosticRoot(PathBuf);

    struct PinFiles(DiagnosticRoot);
    impl PinFiles {
        fn fresh() -> Self {
            let root = DiagnosticRoot::fresh();
            for name in ["app", "app/bin", "runtime"] {
                fs::create_dir(root.0.join(name)).unwrap();
            }
            let mut image = vec![0; 128];
            image[..6].copy_from_slice(&[127, 69, 76, 70, 2, 1]);
            image[18..20].copy_from_slice(&62u16.to_le_bytes());
            fs::write(root.0.join("app/bin/creator-hub"), image).unwrap();
            fs::set_permissions(
                root.0.join("app/bin/creator-hub"),
                fs::Permissions::from_mode(0o700),
            )
            .unwrap();
            Self(root)
        }
        fn admit(&self) -> GuiImagePin {
            let path = self.0 .0.join("app/bin/creator-hub");
            let hash = format!("{:x}", Sha256::digest(fs::read(&path).unwrap()));
            GuiImagePin::admit(
                &self.0 .0.join("app"),
                &self.0 .0.join("runtime"),
                &hash,
                unsafe { libc::getuid() },
                Instant::now() + std::time::Duration::from_secs(2),
            )
            .unwrap()
        }
    }
    impl Drop for PinFiles {
        fn drop(&mut self) {
            let _ = fs::remove_file(self.0 .0.join("app/bin/creator-hub"));
            let _ = fs::remove_file(self.0 .0.join("app/changed"));
            for name in ["app/bin", "app", "runtime"] {
                let _ = fs::remove_dir(self.0 .0.join(name));
            }
        }
    }
    #[test]
    fn gui_pin_hashes_initially_then_checks_without_reading_image_bytes() {
        use std::io::{Seek, SeekFrom};
        let fixture = PinFiles::fresh();
        assert!(GuiImagePin::admit(
            &fixture.0 .0.join("app"),
            &fixture.0 .0.join("runtime"),
            &"0".repeat(64),
            unsafe { libc::getuid() },
            Instant::now() + std::time::Duration::from_secs(2)
        )
        .is_err());
        let pin = fixture.admit();
        let path = fixture.0 .0.join("app/bin/creator-hub");
        let mut cursor = &pin.image;
        cursor.seek(SeekFrom::Start(7)).unwrap();
        for _ in 0..32 {
            pin.image(&File::open(&path).unwrap(), &File::open(&path).unwrap())
                .unwrap();
        }
        assert_eq!(cursor.stream_position().unwrap(), 7);
        assert_eq!(fs::read(&path).unwrap().len(), 128);
    }
    #[test]
    fn gui_pin_refuses_image_mode_bytes_replacement_and_root_drift_without_renewal() {
        for change in ["bytes", "mode", "replacement", "root"] {
            let fixture = PinFiles::fresh();
            let pin = fixture.admit();
            let path = fixture.0 .0.join("app/bin/creator-hub");
            match change {
                "bytes" => {
                    let mut bytes = fs::read(&path).unwrap();
                    bytes.push(1);
                    fs::write(&path, bytes).unwrap();
                }
                "mode" => fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap(),
                "replacement" => {
                    let bytes = fs::read(&path).unwrap();
                    fs::remove_file(&path).unwrap();
                    fs::write(&path, bytes).unwrap();
                }
                _ => fs::write(fixture.0 .0.join("app/changed"), b"fixture").unwrap(),
            }
            assert!(
                pin.image(&File::open(&path).unwrap(), &File::open(&path).unwrap())
                    .is_err(),
                "{change}"
            );
            assert!(pin.held().is_err(), "{change}");
        }
    }

    #[test]
    fn metadata_refusal_empty_usb_serialization_is_not_a_deployment_override() {
        assert!(!replacement_metadata(
            "extra-args",
            "--usb-list=;--usb-list=;"
        ));
        for value in [
            "",
            "--usb-list=;",
            "--usb-list=;--usb-list=; ",
            "--usb-list=all;--usb-list=;",
            "--usb-list=;--usb-list=vnd:1234;",
            "--usb-list=;--usb-list=;--filesystem=home;",
            "--usb-list=;--usb-list=;--share=network;",
            "--usb-list=\\;--usb-list=\\;",
            "--command=/different",
        ] {
            assert!(replacement_metadata("extra-args", value), "{value}");
        }
        for key in ["original-app-path", "original-runtime-path"] {
            for value in ["", "/expected/files", "--usb-list=;--usb-list=;"] {
                assert!(replacement_metadata(key, value));
            }
        }
        assert!(!replacement_metadata("unrelated", "value"));
    }

    impl DiagnosticRoot {
        fn fresh() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let parent = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
                ".identity-refusal-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&parent).unwrap();
            fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
            let root = parent.join("creator-flatpak-launch-proof");
            fs::create_dir(&root).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            Self(root)
        }
    }

    impl Drop for DiagnosticRoot {
        fn drop(&mut self) {
            // Only exact objects created by this test, never recursive cleanup.
            let _ = fs::remove_file(self.0.join(REFUSAL_FILE));
            let _ = fs::remove_file(self.0.join("untouched"));
            let _ = fs::remove_dir(&self.0);
            let _ = fs::remove_dir(self.0.parent().unwrap());
        }
    }

    #[test]
    fn metadata_refusal_payload_only_three_known_values_and_exact_cause() {
        let fields = keyfile(
            "[Instance]\nextra-args=--fixed-fixture-flag\n[Other]\nprivate=not-for-output\n",
        )
        .unwrap();
        assert_eq!(
            metadata_refusal_payload(&fields, "extra-args").unwrap(),
            "{\"refusedKey\":\"extra-args\",\"values\":{\"original-app-path\":null,\"original-runtime-path\":null,\"extra-args\":\"--fixed-fixture-flag\"}}\n"
        );
        assert!(metadata_refusal_payload(&fields, "private").is_err());
        assert!(metadata_refusal_payload(&fields, "original-app-path").is_err());
        for key in REPLACEMENT_KEYS {
            let fields = keyfile(&format!("[Instance]\n{key}=fixture\n")).unwrap();
            assert!(metadata_refusal_payload(&fields, key)
                .unwrap()
                .starts_with(&format!("{{\"refusedKey\":\"{key}\"")));
        }
    }

    #[test]
    fn metadata_refusal_payload_is_bounded_json_with_utf8_and_control_escaping() {
        let mut output = String::new();
        quoted_preview(&mut output, "\"\\\n\t\u{1}");
        assert_eq!(output, "\"\\\"\\\\\\u000a\\u0009\\u0001\"");
        let fields = REPLACEMENT_KEYS
            .into_iter()
            .map(|key| {
                (
                    ("Instance".to_owned(), key.to_owned()),
                    format!("{}tail-not-for-output", "\u{1f642}".repeat(2048)),
                )
            })
            .collect();
        let payload = metadata_refusal_payload(&fields, "extra-args").unwrap();
        assert!(payload.len() <= REFUSAL_BYTES);
        assert_eq!(payload.matches("[truncated]").count(), 3);
        assert!(!payload.contains("tail-not-for-output"));
    }

    #[test]
    fn metadata_refusal_writes_one_private_file_without_fork_or_overwrite() {
        let root = DiagnosticRoot::fresh();
        let uid = unsafe { libc::getuid() };
        let fields = keyfile("[Instance]\nextra-args=first\n").unwrap();
        assert_eq!(
            replacement_refusal(&root.0, &fields, "extra-args", uid),
            Err("replacement-deployment")
        );
        let file = root.0.join(REFUSAL_FILE);
        let before = fs::read(&file).unwrap();
        assert_eq!(
            String::from_utf8(before.clone()).unwrap(),
            metadata_refusal_payload(&fields, "extra-args").unwrap()
        );
        let metadata = fs::symlink_metadata(&file).unwrap();
        assert_eq!(metadata.uid(), uid);
        assert_eq!(metadata.mode() & 0o7777, 0o600);
        assert_eq!(metadata.nlink(), 1);
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 1);
        let changed = keyfile("[Instance]\noriginal-app-path=changed\n").unwrap();
        assert_eq!(
            replacement_refusal(&root.0, &changed, "original-app-path", uid),
            Err("replacement-deployment")
        );
        assert_eq!(fs::read(&file).unwrap(), before);
        assert_eq!(fs::symlink_metadata(&file).unwrap().ino(), metadata.ino());
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 1);
    }

    #[test]
    fn metadata_refusal_symlink_or_nonprivate_root_keeps_original_refusal() {
        let root = DiagnosticRoot::fresh();
        let uid = unsafe { libc::getuid() };
        let fields = keyfile("[Instance]\nextra-args=fixture\n").unwrap();
        let target = root.0.join("untouched");
        fs::write(&target, b"untouched-sentinel").unwrap();
        symlink("untouched", root.0.join(REFUSAL_FILE)).unwrap();
        assert_eq!(
            replacement_refusal(&root.0, &fields, "extra-args", uid),
            Err("replacement-deployment")
        );
        assert_eq!(fs::read(&target).unwrap(), b"untouched-sentinel");
        fs::remove_file(root.0.join(REFUSAL_FILE)).unwrap();
        fs::set_permissions(&root.0, fs::Permissions::from_mode(0o750)).unwrap();
        assert_eq!(
            replacement_refusal(&root.0, &fields, "extra-args", uid),
            Err("replacement-deployment")
        );
        assert!(!root.0.join(REFUSAL_FILE).exists());
    }

    #[test]
    fn pins_refuse_missing_malformed_and_placeholder_values() {
        assert!(pin(None).is_err());
        assert!(pin(Some("abc")).is_err());
        assert!(pin(Some(
            "0000000000000000000000000000000000000000000000000000000000000000"
        ))
        .is_err());
        assert!(pin(Some(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ))
        .is_ok());
    }

    #[test]
    fn parser_refuses_duplicate_fields_escapes_and_oversize() {
        assert!(keyfile("[Instance]\napp-commit=one\napp-commit=two").is_err());
        assert!(keyfile("[Instance]\napp-path=escaped\\svalue").is_err());
        assert!(keyfile(&format!("[Instance]\na={}", "a".repeat(8193))).is_err());
        assert_eq!(
            keyfile("[Application]\nname=com.creatorworks.hub\n")
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn stat_name_cannot_move_parent_or_start_fields() {
        let stat = "99 (name ) with spaces) S 42 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1234 0";
        assert_eq!(stat_fields(stat).unwrap(), (42, 1234));
        assert!(stat_fields("99 (gone) Z 42").is_err());
    }
}
