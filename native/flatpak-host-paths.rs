//! Unconnected host/private settings mapping. Hints and declarations do not grant access.
//! A future native caller must validate effective grants and supply protected, bounded reads.
use std::{
    io,
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Setting {
    OpenCodeJson,
    OpenCodeJsonc,
    CreatorMcp,
    LegacyMcp,
    SetupEditors,
}

const SETTINGS: [Setting; 5] = [
    Setting::OpenCodeJson,
    Setting::OpenCodeJsonc,
    Setting::CreatorMcp,
    Setting::LegacyMcp,
    Setting::SetupEditors,
];

impl Setting {
    fn relative(self) -> &'static str {
        match self {
            Self::OpenCodeJson => "opencode/opencode.json",
            Self::OpenCodeJsonc => "opencode/opencode.jsonc",
            Self::CreatorMcp => "creator-works-mcp/launcher-config.json",
            Self::LegacyMcp => "banter-mcp/launcher-config.json",
            Self::SetupEditors => "CreatorProjectSetup/editor-roots.json",
        }
    }

    pub fn limit(self) -> usize {
        match self {
            Self::OpenCodeJson | Self::OpenCodeJsonc => 2 * 1024 * 1024,
            Self::CreatorMcp | Self::LegacyMcp => 256 * 1024,
            Self::SetupEditors => 16 * 1024,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathError {
    InvalidRoot,
    PrivateHostOverlap,
    GrantOutsideAllowlist,
}

fn validate_root(path: &Path) -> Result<(), PathError> {
    let text = path.to_str().ok_or(PathError::InvalidRoot)?;
    if !path.is_absolute()
        || path.parent().is_none()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
        || text.starts_with("//")
        || text.starts_with("\\\\")
        || text.chars().any(char::is_control)
    {
        return Err(PathError::InvalidRoot);
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrivatePaths {
    config: PathBuf,
    data: PathBuf,
}

impl PrivatePaths {
    pub fn new(config: PathBuf, data: PathBuf) -> Result<Self, PathError> {
        validate_root(&config)?;
        validate_root(&data)?;
        Ok(Self { config, data })
    }

    pub fn setting(&self, setting: Setting) -> PrivateSettingPath {
        let base = if setting == Setting::SetupEditors {
            &self.data
        } else {
            &self.config
        };
        PrivateSettingPath(base.join(setting.relative()))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrivateSettingPath(PathBuf);

impl PrivateSettingPath {
    pub fn as_path(&self) -> &Path {
        &self.0
    }
}

/// Values for HOST_XDG_CONFIG_HOME and HOST_XDG_DATA_HOME, not sandbox XDG values.
/// None means unset; an explicitly empty or relative value is invalid, not a fallback.
#[derive(Default)]
pub struct HostHints {
    pub config: Option<PathBuf>,
    pub data: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostPaths {
    config: PathBuf,
    data: PathBuf,
}

impl HostPaths {
    pub fn from_hints(
        private: &PrivatePaths,
        host_home: &Path,
        hints: HostHints,
    ) -> Result<Self, PathError> {
        validate_root(host_home)?;
        let config = hints.config.unwrap_or_else(|| host_home.join(".config"));
        let data = hints.data.unwrap_or_else(|| host_home.join(".local/share"));
        for host in [&config, &data] {
            validate_root(host)?;
            for owned in [&private.config, &private.data] {
                if host.starts_with(owned) || owned.starts_with(host) {
                    return Err(PathError::PrivateHostOverlap);
                }
            }
        }
        Ok(Self { config, data })
    }

    pub fn setting(&self, setting: Setting) -> HostSettingPath {
        let base = if setting == Setting::SetupEditors {
            &self.data
        } else {
            &self.config
        };
        HostSettingPath {
            path: base.join(setting.relative()),
            setting,
        }
    }

    pub fn inspect(
        &self,
        setting: Setting,
        grants: &DeclaredGrants,
        reader: &mut impl SettingsReader,
    ) -> Presence<Vec<u8>> {
        let file = self.setting(setting);
        let root = file
            .path
            .parent()
            .expect("allowlisted settings have a parent");
        if !grants.roots.iter().any(|granted| granted == root) {
            return Presence::Unavailable(Unavailable::NotGranted);
        }
        if let Err(error) = reader.check_root(root) {
            return Presence::Unavailable(Unavailable::Root(error.kind()));
        }
        let read = reader.read_setting(&file, setting.limit());
        // A vanished or inaccessible granted root is not evidence of a missing setting.
        if let Err(error) = reader.check_root(root) {
            return Presence::Unavailable(Unavailable::Root(error.kind()));
        }
        match read {
            Ok(bytes) if bytes.len() <= setting.limit() => Presence::Present(bytes),
            Ok(_) => Presence::Unavailable(Unavailable::TooLarge),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Presence::Absent,
            Err(error) => Presence::Unavailable(Unavailable::Read(error.kind())),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostSettingPath {
    path: PathBuf,
    setting: Setting,
}

impl HostSettingPath {
    pub fn as_path(&self) -> &Path {
        &self.path
    }

    pub fn setting(&self) -> Setting {
        self.setting
    }
}

/// A caller declaration only, not an OS permission check or a persisted consent receipt.
/// Only exact parents of allowlisted settings are accepted; no home/config-wide grants.
#[derive(Default)]
pub struct DeclaredGrants {
    roots: Vec<PathBuf>,
}

impl DeclaredGrants {
    pub fn new(host: &HostPaths, roots: Vec<PathBuf>) -> Result<Self, PathError> {
        for root in &roots {
            validate_root(root)?;
            if !SETTINGS
                .iter()
                .any(|setting| host.setting(*setting).path.parent() == Some(root.as_path()))
            {
                return Err(PathError::GrantOutsideAllowlist);
            }
        }
        Ok(Self { roots })
    }
}

/// Implementations must validate effective access and bind/recheck root identity
/// across calls, reject links/redirected ancestors, and bound regular-file reads.
/// No implementation is supplied here; path validation above is lexical only.
pub trait SettingsReader {
    fn check_root(&mut self, root: &Path) -> io::Result<()>;
    fn read_setting(&mut self, path: &HostSettingPath, max_bytes: usize) -> io::Result<Vec<u8>>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unavailable {
    NotGranted,
    Root(io::ErrorKind),
    Read(io::ErrorKind),
    TooLarge,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Presence<T> {
    Unavailable(Unavailable),
    Absent,
    Present(T),
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    fn synthetic(relative: &str) -> PathBuf {
        #[cfg(windows)]
        let base = Path::new("C:/flatpak-host-paths-synthetic");
        #[cfg(not(windows))]
        let base = Path::new("/flatpak-host-paths-synthetic");
        base.join(relative)
    }

    fn fixture() -> (PrivatePaths, HostPaths) {
        let private =
            PrivatePaths::new(synthetic("private/config"), synthetic("private/data")).unwrap();
        let host =
            HostPaths::from_hints(&private, &synthetic("home"), HostHints::default()).unwrap();
        (private, host)
    }

    fn grants(host: &HostPaths, setting: Setting) -> DeclaredGrants {
        DeclaredGrants::new(
            host,
            vec![host
                .setting(setting)
                .as_path()
                .parent()
                .unwrap()
                .to_path_buf()],
        )
        .unwrap()
    }

    #[derive(Debug, PartialEq, Eq)]
    enum Call {
        Root(PathBuf),
        Read(PathBuf, usize),
    }

    struct Reader {
        result: Result<Vec<u8>, io::ErrorKind>,
        roots: VecDeque<Result<(), io::ErrorKind>>,
        calls: Vec<Call>,
    }

    impl Reader {
        fn new(result: Result<Vec<u8>, io::ErrorKind>) -> Self {
            Self {
                result,
                roots: VecDeque::new(),
                calls: Vec::new(),
            }
        }
    }

    impl SettingsReader for Reader {
        fn check_root(&mut self, root: &Path) -> io::Result<()> {
            self.calls.push(Call::Root(root.to_path_buf()));
            self.roots
                .pop_front()
                .unwrap_or(Ok(()))
                .map_err(io::Error::from)
        }

        fn read_setting(
            &mut self,
            file: &HostSettingPath,
            max_bytes: usize,
        ) -> io::Result<Vec<u8>> {
            self.calls
                .push(Call::Read(file.as_path().to_path_buf(), max_bytes));
            self.result.clone().map_err(io::Error::from)
        }
    }

    #[test]
    fn private_and_default_host_settings_stay_in_separate_typed_roots() {
        let (private, host) = fixture();
        for setting in SETTINGS {
            assert_ne!(
                private.setting(setting).as_path(),
                host.setting(setting).as_path()
            );
        }
        assert_eq!(
            host.setting(Setting::OpenCodeJsonc).as_path(),
            synthetic("home/.config/opencode/opencode.jsonc")
        );
        assert_eq!(
            host.setting(Setting::SetupEditors).as_path(),
            synthetic("home/.local/share/CreatorProjectSetup/editor-roots.json")
        );
        assert_eq!(
            private.setting(Setting::CreatorMcp).as_path(),
            synthetic("private/config/creator-works-mcp/launcher-config.json")
        );
        assert_eq!(
            private.setting(Setting::SetupEditors).as_path(),
            synthetic("private/data/CreatorProjectSetup/editor-roots.json")
        );
    }

    #[test]
    fn nondefault_host_xdg_hints_do_not_redirect_private_settings() {
        let (private, _) = fixture();
        let before = private.clone();
        let host = HostPaths::from_hints(
            &private,
            &synthetic("home"),
            HostHints {
                config: Some(synthetic("host/custom-config")),
                data: Some(synthetic("host/custom-data")),
            },
        )
        .unwrap();
        assert_eq!(
            host.setting(Setting::LegacyMcp).as_path(),
            synthetic("host/custom-config/banter-mcp/launcher-config.json")
        );
        assert_eq!(
            host.setting(Setting::SetupEditors).as_path(),
            synthetic("host/custom-data/CreatorProjectSetup/editor-roots.json")
        );
        assert_eq!(private, before);
    }

    #[test]
    fn invalid_hints_refuse_instead_of_silently_falling_back() {
        let (private, _) = fixture();
        for value in [
            PathBuf::new(),
            PathBuf::from("relative"),
            synthetic("host/../escape"),
            synthetic("bad\nroot"),
            PathBuf::from("//server/share"),
            PathBuf::from("\\\\server\\share"),
        ] {
            for config_hint in [true, false] {
                let hints = if config_hint {
                    HostHints {
                        config: Some(value.clone()),
                        data: None,
                    }
                } else {
                    HostHints {
                        config: None,
                        data: Some(value.clone()),
                    }
                };
                assert_eq!(
                    HostPaths::from_hints(&private, &synthetic("home"), hints),
                    Err(PathError::InvalidRoot)
                );
            }
        }
    }

    #[test]
    fn invalid_private_roots_and_host_home_refuse_before_mapping() {
        let (private, _) = fixture();
        assert_eq!(
            PrivatePaths::new(PathBuf::from("relative"), synthetic("data")),
            Err(PathError::InvalidRoot)
        );
        assert_eq!(
            PrivatePaths::new(synthetic("config"), PathBuf::new()),
            Err(PathError::InvalidRoot)
        );
        assert_eq!(
            HostPaths::from_hints(&private, Path::new("relative"), HostHints::default()),
            Err(PathError::InvalidRoot)
        );
    }

    #[test]
    fn host_hints_cannot_alias_or_cover_private_settings_roots() {
        let (private, _) = fixture();
        for host in [
            synthetic("private/config"),
            synthetic("private/config/nested"),
            synthetic("private/data"),
            synthetic("private"),
        ] {
            assert_eq!(
                HostPaths::from_hints(
                    &private,
                    &synthetic("home"),
                    HostHints {
                        config: Some(host),
                        data: None,
                    }
                ),
                Err(PathError::PrivateHostOverlap)
            );
        }
    }

    #[test]
    fn explicit_grants_accept_only_exact_allowlisted_settings_directories() {
        let (_, host) = fixture();
        for setting in SETTINGS {
            assert!(DeclaredGrants::new(
                &host,
                vec![host
                    .setting(setting)
                    .as_path()
                    .parent()
                    .unwrap()
                    .to_path_buf()]
            )
            .is_ok());
        }
        for root in [
            synthetic("home"),
            synthetic("home/.config"),
            synthetic("private/config"),
            synthetic("home/.codex"),
            host.setting(Setting::OpenCodeJsonc).as_path().to_path_buf(),
        ] {
            assert!(matches!(
                DeclaredGrants::new(&host, vec![root]),
                Err(PathError::GrantOutsideAllowlist)
            ));
        }
    }

    #[test]
    fn ungranted_paths_are_unavailable_without_calling_any_reader() {
        let (_, host) = fixture();
        let mut reader = Reader::new(Err(io::ErrorKind::NotFound));
        for setting in SETTINGS {
            assert_eq!(
                host.inspect(setting, &DeclaredGrants::default(), &mut reader),
                Presence::Unavailable(Unavailable::NotGranted)
            );
        }
        assert!(reader.calls.is_empty());
    }

    #[test]
    fn grant_does_not_authorize_another_settings_directory_or_host_mapping() {
        let (private, host) = fixture();
        let granted = grants(&host, Setting::OpenCodeJsonc);
        let other = HostPaths::from_hints(&private, &synthetic("other-home"), HostHints::default())
            .unwrap();
        let mut reader = Reader::new(Ok(vec![]));
        assert_eq!(
            host.inspect(Setting::CreatorMcp, &granted, &mut reader),
            Presence::Unavailable(Unavailable::NotGranted)
        );
        assert_eq!(
            other.inspect(Setting::OpenCodeJsonc, &granted, &mut reader),
            Presence::Unavailable(Unavailable::NotGranted)
        );
        assert!(reader.calls.is_empty());
    }

    #[test]
    fn absent_requires_accessible_granted_root_before_and_after_not_found() {
        let (_, host) = fixture();
        let mut reader = Reader::new(Err(io::ErrorKind::NotFound));
        assert_eq!(
            host.inspect(
                Setting::OpenCodeJsonc,
                &grants(&host, Setting::OpenCodeJsonc),
                &mut reader
            ),
            Presence::Absent
        );
        let file = host.setting(Setting::OpenCodeJsonc);
        let root = file.as_path().parent().unwrap().to_path_buf();
        assert_eq!(
            reader.calls,
            [
                Call::Root(root.clone()),
                Call::Read(file.as_path().to_path_buf(), Setting::OpenCodeJsonc.limit()),
                Call::Root(root)
            ]
        );
    }

    #[test]
    fn missing_or_denied_granted_root_is_unavailable_never_absent() {
        let (_, host) = fixture();
        for error in [
            io::ErrorKind::NotFound,
            io::ErrorKind::PermissionDenied,
            io::ErrorKind::Other,
        ] {
            let mut reader = Reader::new(Err(io::ErrorKind::NotFound));
            reader.roots.push_back(Err(error));
            assert_eq!(
                host.inspect(
                    Setting::LegacyMcp,
                    &grants(&host, Setting::LegacyMcp),
                    &mut reader
                ),
                Presence::Unavailable(Unavailable::Root(error))
            );
            assert_eq!(reader.calls.len(), 1);
        }
    }

    #[test]
    fn read_errors_are_unavailable_not_missing_defaults() {
        let (_, host) = fixture();
        for error in [
            io::ErrorKind::PermissionDenied,
            io::ErrorKind::InvalidData,
            io::ErrorKind::Other,
        ] {
            let mut reader = Reader::new(Err(error));
            assert_eq!(
                host.inspect(
                    Setting::CreatorMcp,
                    &grants(&host, Setting::CreatorMcp),
                    &mut reader
                ),
                Presence::Unavailable(Unavailable::Read(error))
            );
        }
    }

    #[test]
    fn synthetic_opencode_and_legacy_creator_bytes_remain_exact_and_bounded() {
        let (_, host) = fixture();
        for (setting, bytes) in [
            (
                Setting::OpenCodeJson,
                b"{\"mcp\":{\"other\":{\"command\":[\"keep\"]}}}".to_vec(),
            ),
            (
                Setting::OpenCodeJsonc,
                b"// keep\r\n{\"mcp\":{}}\r\n".to_vec(),
            ),
            (
                Setting::CreatorMcp,
                b"{\"channels\":[],\"auto_start\":false,\"unknown\":\"keep\"}".to_vec(),
            ),
            (
                Setting::LegacyMcp,
                b"{\"channels\":[],\"enable_custom_scripts\":false}".to_vec(),
            ),
            (Setting::SetupEditors, b"[]".to_vec()),
        ] {
            let mut reader = Reader::new(Ok(bytes.clone()));
            assert_eq!(
                host.inspect(setting, &grants(&host, setting), &mut reader),
                Presence::Present(bytes)
            );
            assert_eq!(
                reader.calls[1],
                Call::Read(
                    host.setting(setting).as_path().to_path_buf(),
                    setting.limit()
                )
            );
            assert_eq!(host.setting(setting).setting(), setting);
        }
    }

    #[test]
    fn empty_files_are_present_and_oversized_reads_are_unavailable() {
        let (_, host) = fixture();
        let setting = Setting::SetupEditors;
        let mut empty = Reader::new(Ok(vec![]));
        assert_eq!(
            host.inspect(setting, &grants(&host, setting), &mut empty),
            Presence::Present(vec![])
        );
        let mut oversized = Reader::new(Ok(vec![0; setting.limit() + 1]));
        assert_eq!(
            host.inspect(setting, &grants(&host, setting), &mut oversized),
            Presence::Unavailable(Unavailable::TooLarge)
        );
    }

    #[test]
    fn root_access_loss_after_read_never_reports_present_or_absent() {
        let (_, host) = fixture();
        for read in [Ok(b"synthetic".to_vec()), Err(io::ErrorKind::NotFound)] {
            let mut reader = Reader::new(read);
            reader
                .roots
                .extend([Ok(()), Err(io::ErrorKind::PermissionDenied)]);
            assert_eq!(
                host.inspect(
                    Setting::OpenCodeJsonc,
                    &grants(&host, Setting::OpenCodeJsonc),
                    &mut reader
                ),
                Presence::Unavailable(Unavailable::Root(io::ErrorKind::PermissionDenied))
            );
        }
    }
}
