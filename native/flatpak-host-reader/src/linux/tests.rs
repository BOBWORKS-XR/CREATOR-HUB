use super::*;
use std::{
    os::unix::fs::{symlink, DirBuilderExt, PermissionsExt},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, MutexGuard,
    },
};

static NEXT: AtomicU64 = AtomicU64::new(0);
static FIXTURES: Mutex<()> = Mutex::new(());
const SETTINGS: [Setting; 5] = [
    Setting::OpenCodeJson,
    Setting::OpenCodeJsonc,
    Setting::CreatorMcp,
    Setting::LegacyMcp,
    Setting::SetupEditors,
];

struct Fixture {
    base: PathBuf,
    uid: u32,
    paths: HostPaths,
    _guard: MutexGuard<'static, ()>,
}

impl Fixture {
    fn new() -> Self {
        // Ancestor metadata is pinned too; fixture directory creation must be serialized.
        let guard = FIXTURES.lock().unwrap();
        let identity = Identity::capture().unwrap().admit(false).unwrap();
        // Only a fresh owned directory under the disposable test checkout is written.
        // Production has no root/identity injection API and never creates directories.
        let base = std::env::current_dir().unwrap().join(format!(
            ".flatpak-host-fixture-{}-{}",
            identity.pid,
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::DirBuilder::new().mode(0o700).create(&base).unwrap();
        let paths = derive_paths(&base, None, None).unwrap();
        for setting in SETTINGS {
            fs::create_dir_all(paths.setting(setting).as_path().parent().unwrap()).unwrap();
        }
        Self {
            base,
            uid: identity.uid[0],
            paths,
            _guard: guard,
        }
    }

    fn file(&self, setting: Setting) -> PathBuf {
        self.paths.setting(setting).as_path().to_owned()
    }

    fn put(&self, setting: Setting, bytes: &[u8]) {
        fs::write(self.file(setting), bytes).unwrap();
        fs::set_permissions(self.file(setting), fs::Permissions::from_mode(0o600)).unwrap();
    }

    fn reader(&self) -> HostSettings {
        HostSettings {
            identity: Identity::capture().unwrap().admit(false).unwrap(),
            paths: self.paths.clone(),
            reader: ProtectedReader::new(self.uid, self.paths.clone()).unwrap(),
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        assert_eq!(
            self.base.parent(),
            Some(std::env::current_dir().unwrap().as_path())
        );
        assert!(self
            .base
            .file_name()
            .unwrap()
            .as_bytes()
            .starts_with(b".flatpak-host-fixture-"));
        let meta = fs::symlink_metadata(&self.base).unwrap();
        assert!(meta.is_dir() && !meta.is_symlink() && meta.uid() == self.uid);
        fs::remove_dir_all(&self.base).unwrap();
    }
}

#[test]
fn admission_refuses_sandbox_root_and_changed_real_effective_saved_ids() {
    let valid = Identity {
        uid: [1001; 3],
        gid: [1001; 3],
        pid: 2345,
    };
    assert_eq!(valid.admit(false).unwrap(), valid);
    assert!(valid.admit(true).is_err());
    for bad in [
        Identity {
            uid: [0; 3],
            ..valid
        },
        Identity {
            uid: [1001, 0, 1001],
            ..valid
        },
        Identity {
            uid: [1001, 1001, 0],
            ..valid
        },
        Identity {
            gid: [1001, 0, 1001],
            ..valid
        },
        Identity { pid: 1, ..valid },
    ] {
        assert!(bad.admit(false).is_err());
    }
}

#[test]
fn account_and_xdg_mapping_ignore_home_and_host_hint_inputs() {
    let home = Path::new("/fixture-native-account");
    let paths = derive_paths(home, None, None).unwrap();
    assert_eq!(
        paths.setting(Setting::CreatorMcp).as_path(),
        home.join(".config/creator-works-mcp/launcher-config.json")
    );
    assert_eq!(
        paths.setting(Setting::SetupEditors).as_path(),
        home.join(".local/share/CreatorProjectSetup/editor-roots.json")
    );
    let custom = derive_paths(
        home,
        Some("/fixture-config".into()),
        Some("/fixture-data".into()),
    )
    .unwrap();
    assert_eq!(
        custom.setting(Setting::LegacyMcp).as_path(),
        Path::new("/fixture-config/banter-mcp/launcher-config.json")
    );
    for bad in [
        "",
        "relative",
        "/fixture/../escape",
        "/fixture/./config",
        "/fixture//config",
        "/fixture/config/",
        "/fixture\nconfig",
        "/fixture-native-account/.var/app/other/config",
    ] {
        assert!(
            derive_paths(home, Some(bad.into()), None).is_err(),
            "{bad:?}"
        );
        assert!(
            derive_paths(home, None, Some(bad.into())).is_err(),
            "{bad:?}"
        );
    }
}

#[test]
fn all_five_exact_settings_read_original_bytes_without_creating_or_rewriting_files() {
    let f = Fixture::new();
    for setting in SETTINGS {
        f.put(setting, b"// exact unknown fields and whitespace\r\n{}");
    }
    let before = SETTINGS.map(|setting| Stamp::from(&fs::metadata(f.file(setting)).unwrap()));
    let atimes = SETTINGS.map(|setting| {
        let meta = fs::metadata(f.file(setting)).unwrap();
        (meta.atime(), meta.atime_nsec())
    });
    let mut host = f.reader();
    for setting in SETTINGS {
        assert_eq!(
            host.inspect(setting),
            Presence::Present(b"// exact unknown fields and whitespace\r\n{}".to_vec())
        );
    }
    assert_eq!(
        before,
        SETTINGS.map(|setting| Stamp::from(&fs::metadata(f.file(setting)).unwrap()))
    );
    assert_eq!(
        atimes,
        SETTINGS.map(|setting| {
            let meta = fs::metadata(f.file(setting)).unwrap();
            (meta.atime(), meta.atime_nsec())
        })
    );
}

#[test]
fn empty_and_exact_limit_are_present_and_oversized_is_unavailable() {
    let f = Fixture::new();
    f.put(Setting::OpenCodeJson, b"");
    f.put(
        Setting::SetupEditors,
        &vec![b'x'; Setting::SetupEditors.limit()],
    );
    f.put(
        Setting::CreatorMcp,
        &vec![b'x'; Setting::CreatorMcp.limit() + 1],
    );
    let mut host = f.reader();
    assert_eq!(
        host.inspect(Setting::OpenCodeJson),
        Presence::Present(vec![])
    );
    assert_eq!(
        host.inspect(Setting::SetupEditors),
        Presence::Present(vec![b'x'; Setting::SetupEditors.limit()])
    );
    assert!(matches!(
        host.inspect(Setting::CreatorMcp),
        Presence::Unavailable(_)
    ));
}

#[test]
fn absent_requires_an_accessible_unchanged_exact_settings_parent() {
    let f = Fixture::new();
    let mut host = f.reader();
    assert_eq!(host.inspect(Setting::CreatorMcp), Presence::Absent);
    fs::remove_dir(f.file(Setting::CreatorMcp).parent().unwrap()).unwrap();
    assert!(matches!(
        host.inspect(Setting::CreatorMcp),
        Presence::Unavailable(Unavailable::Root(_))
    ));
    assert!(!f.file(Setting::CreatorMcp).parent().unwrap().exists());
}

#[test]
fn symlinked_file_or_ancestor_and_hardlinked_settings_refuse() {
    let f = Fixture::new();
    f.put(Setting::CreatorMcp, b"owned original");
    symlink(f.file(Setting::CreatorMcp), f.file(Setting::LegacyMcp)).unwrap();
    fs::hard_link(f.file(Setting::CreatorMcp), f.file(Setting::OpenCodeJson)).unwrap();
    let parent = f.file(Setting::SetupEditors).parent().unwrap().to_owned();
    fs::remove_dir(&parent).unwrap();
    symlink(f.file(Setting::CreatorMcp).parent().unwrap(), &parent).unwrap();
    let mut host = f.reader();
    for setting in [
        Setting::CreatorMcp,
        Setting::LegacyMcp,
        Setting::OpenCodeJson,
        Setting::SetupEditors,
    ] {
        assert!(
            matches!(host.inspect(setting), Presence::Unavailable(_)),
            "{setting:?}"
        );
    }
}

#[test]
fn a_symlink_above_the_settings_parent_refuses_before_binding() {
    let f = Fixture::new();
    f.put(Setting::CreatorMcp, b"fixture");
    let config = f.base.join(".config");
    let retained = f.base.join("retained-config");
    fs::rename(&config, &retained).unwrap();
    symlink(&retained, &config).unwrap();
    let mut host = f.reader();
    assert!(matches!(
        host.inspect(Setting::CreatorMcp),
        Presence::Unavailable(_)
    ));
    assert!(host.reader.roots.is_empty());
}

#[test]
fn fifo_and_directory_at_a_settings_filename_never_open_for_io() {
    let f = Fixture::new();
    let fifo = CString::new(f.file(Setting::CreatorMcp).as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    fs::create_dir(f.file(Setting::OpenCodeJson)).unwrap();
    let mut host = f.reader();
    for setting in [Setting::CreatorMcp, Setting::OpenCodeJson] {
        assert!(matches!(host.inspect(setting), Presence::Unavailable(_)));
    }
}

#[test]
fn foreign_owner_checks_and_unsafe_file_or_directory_modes_refuse() {
    let f = Fixture::new();
    f.put(Setting::CreatorMcp, b"fixture");
    let meta = fs::metadata(f.file(Setting::CreatorMcp)).unwrap();
    assert!(regular(&meta, f.uid + 1, Setting::CreatorMcp.limit()).is_err());
    let root = f.file(Setting::CreatorMcp).parent().unwrap().to_owned();
    assert!(directory(&fs::metadata(&root).unwrap(), f.uid + 1, true).is_err());
    for mode in [0o000, 0o620, 0o602, 0o700, 0o4600] {
        fs::set_permissions(
            f.file(Setting::CreatorMcp),
            fs::Permissions::from_mode(mode),
        )
        .unwrap();
        assert!(matches!(
            f.reader().inspect(Setting::CreatorMcp),
            Presence::Unavailable(_)
        ));
    }
    fs::set_permissions(
        f.file(Setting::CreatorMcp),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o720)).unwrap();
    assert!(matches!(
        f.reader().inspect(Setting::CreatorMcp),
        Presence::Unavailable(_)
    ));
}

#[test]
fn a_foreign_typed_mapping_or_wrong_limit_cannot_select_another_file() {
    let f = Fixture::new();
    f.put(Setting::CreatorMcp, b"fixture");
    let mut reader = f.reader().reader;
    reader.bind(Setting::CreatorMcp).unwrap();
    let foreign = derive_paths(Path::new("/foreign-account"), None, None).unwrap();
    assert!(reader
        .read_setting(
            &foreign.setting(Setting::CreatorMcp),
            Setting::CreatorMcp.limit()
        )
        .is_err());
    assert!(reader
        .read_setting(&f.paths.setting(Setting::CreatorMcp), usize::MAX)
        .is_err());
    assert!(reader.check_root(&f.base).is_err());
}

#[test]
fn observable_same_length_in_place_change_during_read_is_not_returned() {
    let f = Fixture::new();
    f.put(Setting::CreatorMcp, b"before");
    let mut host = f.reader();
    let file = f.file(Setting::CreatorMcp);
    let mutation = std::sync::Arc::new(Mutex::new(None));
    let observation = mutation.clone();
    host.reader.before_read = Some(Box::new(move || {
        let metadata = fs::metadata(&file).unwrap();
        let before = Stamp::from(&metadata);
        fs::write(&file, b"after!").unwrap();
        // A write can share the previous coarse clock timestamp (38749794146).
        // Exercise the observable-change contract without a sleep/timing guess.
        File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(metadata.modified().unwrap() + std::time::Duration::from_secs(1))
            .unwrap();
        let after = Stamp::from(&fs::metadata(&file).unwrap());
        assert_ne!(
            before, after,
            "Fixture must actually change observed metadata"
        );
        *observation.lock().unwrap() = Some((before, after));
    }));
    let result = host.inspect(Setting::CreatorMcp);
    let observed = match &result {
        Presence::Present(bytes) if bytes == b"after!" => "present-after",
        Presence::Present(bytes) if bytes == b"before" => "present-before",
        Presence::Present(_) => "present-other",
        Presence::Absent => "absent",
        Presence::Unavailable(_) => "unavailable",
    };
    assert!(
        matches!(result, Presence::Unavailable(_)),
        "owned fixture observation={observed}; stamps={:?}",
        *mutation.lock().unwrap()
    );
}

#[test]
fn filename_replacement_after_pinning_never_returns_the_detached_original() {
    let f = Fixture::new();
    f.put(Setting::CreatorMcp, b"before");
    let mut host = f.reader();
    let file = f.file(Setting::CreatorMcp);
    host.reader.before_read = Some(Box::new(move || {
        fs::rename(&file, file.with_extension("retained")).unwrap();
        fs::write(&file, b"after!").unwrap();
    }));
    assert!(matches!(
        host.inspect(Setting::CreatorMcp),
        Presence::Unavailable(_)
    ));
}

#[test]
fn parent_replacement_after_pinning_is_unavailable_not_absent() {
    let f = Fixture::new();
    f.put(Setting::CreatorMcp, b"before");
    let mut host = f.reader();
    let root = f.file(Setting::CreatorMcp).parent().unwrap().to_owned();
    host.reader.before_read = Some(Box::new(move || {
        fs::rename(&root, root.with_extension("retained")).unwrap();
        fs::create_dir(&root).unwrap();
    }));
    assert!(matches!(
        host.inspect(Setting::CreatorMcp),
        Presence::Unavailable(_)
    ));
}

#[test]
fn changed_process_identity_refuses_before_binding_any_settings_directory() {
    let f = Fixture::new();
    let mut host = f.reader();
    host.identity.pid += 1;
    assert!(matches!(
        host.inspect(Setting::CreatorMcp),
        Presence::Unavailable(_)
    ));
    assert!(host.reader.roots.is_empty());
}

#[test]
fn descriptors_are_cloexec_and_read_handles_have_no_write_access() {
    let f = Fixture::new();
    f.put(Setting::CreatorMcp, b"before");
    let mut host = f.reader();
    let root = host.reader.bind(Setting::CreatorMcp).unwrap();
    let fd = host.reader.roots.get(&root).unwrap().leaf.as_raw_fd();
    assert_ne!(
        unsafe { libc::fcntl(fd, libc::F_GETFD) } & libc::FD_CLOEXEC,
        0
    );
    assert_ne!(unsafe { libc::fcntl(fd, libc::F_GETFL) } & libc::O_PATH, 0);
    let pinned = open_at(
        fd,
        std::ffi::OsStr::new("launcher-config.json"),
        libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )
    .unwrap();
    let input = open_at(
        host.reader.proc_fds.as_raw_fd(),
        std::ffi::OsStr::new(&pinned.as_raw_fd().to_string()),
        libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOATIME,
    )
    .unwrap();
    let flags = unsafe { libc::fcntl(input.as_raw_fd(), libc::F_GETFL) };
    assert_eq!(flags & libc::O_ACCMODE, libc::O_RDONLY);
    assert_ne!(flags & libc::O_NOATIME, 0);
    assert_eq!(
        host.inspect(Setting::CreatorMcp),
        Presence::Present(b"before".to_vec())
    );
}
