#[cfg(any(target_os = "macos", target_os = "linux", test))]
use std::path::{Path, PathBuf};
use tauri::utils::config::BundleType;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Target {
    pub platform: &'static str,
    pub architecture: &'static str,
    pub package: &'static str,
    pub extension: &'static str,
}

impl Target {
    pub fn select(os: &str, arch: &str, bundle: Option<BundleType>) -> Result<Self, String> {
        let architecture = match arch {
            "x86_64" => "x86_64",
            "aarch64" if os == "macos" => "aarch64",
            _ => return Err("This architecture does not have an accepted Hub updater.".into()),
        };
        let (platform, package, extension) = match (os, bundle) {
            // Windows still requires the guarded per-user NSIS registration.
            ("windows", None | Some(BundleType::Nsis)) => ("windows", "nsis", ".exe"),
            ("macos", Some(BundleType::App)) => ("macos", "app", ".app.tar.gz"),
            ("linux", Some(BundleType::AppImage)) => ("linux", "appimage", ".AppImage"),
            ("linux", Some(BundleType::Deb)) => ("linux", "deb", ".deb"),
            ("linux", Some(BundleType::Rpm)) => ("linux", "rpm", ".rpm"),
            _ => return Err("Install an official Hub package before using in-app updates.".into()),
        };
        Ok(Self {
            platform,
            architecture,
            package,
            extension,
        })
    }

    pub fn native() -> Result<Self, String> {
        if flatpak() {
            return Err("Flatpak manages this Hub installation. Use your Software app or Flatpak to update it; native installers cannot run inside this sandbox.".into());
        }
        Self::select(
            std::env::consts::OS,
            std::env::consts::ARCH,
            tauri::utils::platform::bundle_type(),
        )
    }

    pub fn descriptor(self) -> String {
        if self.platform == "windows" && self.architecture == "x86_64" && self.package == "nsis" {
            return crate::catalog::DESCRIPTOR_NAME.into();
        }
        let suffix = if self.platform == "linux" {
            format!("-{}", self.package)
        } else {
            String::new()
        };
        format!(
            "creator-hub-{}-{}{suffix}.json",
            self.platform, self.architecture
        )
    }

    pub fn updater_key(self) -> String {
        let os = if self.platform == "macos" {
            "darwin"
        } else {
            self.platform
        };
        // Keep the published Windows key unchanged; package-specific Linux keys
        // prevent a DEB/RPM installation from accidentally receiving an AppImage.
        if self.platform == "windows" {
            format!("{os}-{}", self.architecture)
        } else {
            format!("{os}-{}-{}", self.architecture, self.package)
        }
    }
}

pub fn flatpak() -> bool {
    #[cfg(target_os = "linux")]
    {
        flatpak_context(
            std::env::consts::OS,
            std::env::var_os("FLATPAK_ID").is_some(),
            std::path::Path::new("/.flatpak-info").is_file(),
        )
    }
    #[cfg(not(target_os = "linux"))]
    false
}

#[cfg(any(target_os = "linux", test))]
fn flatpak_context(os: &str, has_id: bool, has_info: bool) -> bool {
    os == "linux" && (has_id || has_info)
}

#[cfg(any(target_os = "macos", test))]
pub fn mac_application(exe: &Path, home: &Path) -> Result<PathBuf, String> {
    let suffix = Path::new("Creator Hub.app/Contents/MacOS/creator-hub");
    let allowed = [
        Path::new("/Applications").join(suffix),
        home.join("Applications").join(suffix),
    ];
    if !allowed.iter().any(|path| path == exe)
        || exe.to_string_lossy().contains(['\'', '"', '\n', '\r'])
    {
        return Err("Move Creator Hub to Applications and open that copy before updating. Do not run it from the downloaded disk image.".into());
    }
    exe.ancestors()
        .nth(3)
        .map(Path::to_path_buf)
        .ok_or_else(|| "Cannot check the installed Hub app.".into())
}

#[cfg(any(target_os = "linux", test))]
pub fn appimage_location(exe: &Path, appdir: &Path, image: &Path) -> Result<PathBuf, String> {
    if !appdir.is_absolute()
        || !image.is_absolute()
        || !exe.starts_with(appdir)
        || image.starts_with(appdir)
        || image.extension().is_none_or(|ext| ext != "AppImage")
    {
        return Err("Cannot identify the running Hub AppImage. Open the original AppImage file before updating.".into());
    }
    // APPIMAGE and APPDIR are inherited strings, not backing-file identity.
    // Until the running container can be bound to its outer file, refuse the
    // destructive path rather than replacing an unrelated inherited image.
    Err("Automatic AppImage updates are not enabled for this build because the running container cannot be verified. Download the latest AppImage and replace it after closing Hub; your app data is kept separately.".into())
}

#[cfg(any(target_os = "linux", test))]
pub fn verify_restart_target(installed: &Path, restart: &Path) -> Result<(), String> {
    if installed != restart {
        return Err("A launcher passed a different AppImage restart location to Hub. Close Hub and open the installed package directly before updating. No installer was started.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_flatpak_repacked_from_deb_cannot_use_the_native_installer() {
        assert!(flatpak_context("linux", true, false));
        assert!(flatpak_context("linux", false, true));
        assert!(flatpak_context("linux", true, true));
        assert!(!flatpak_context("linux", false, false));
        assert!(!flatpak_context("windows", true, true));
        assert!(!flatpak_context("macos", true, true));
    }
    #[test]
    fn each_installed_package_has_a_distinct_descriptor_and_updater_target() {
        for (os, arch, bundle, package, extension, descriptor, updater) in [
            (
                "windows",
                "x86_64",
                BundleType::Nsis,
                "nsis",
                ".exe",
                "creator-hub-windows-x86_64.json",
                "windows-x86_64",
            ),
            (
                "macos",
                "aarch64",
                BundleType::App,
                "app",
                ".app.tar.gz",
                "creator-hub-macos-aarch64.json",
                "darwin-aarch64-app",
            ),
            (
                "macos",
                "x86_64",
                BundleType::App,
                "app",
                ".app.tar.gz",
                "creator-hub-macos-x86_64.json",
                "darwin-x86_64-app",
            ),
            (
                "linux",
                "x86_64",
                BundleType::AppImage,
                "appimage",
                ".AppImage",
                "creator-hub-linux-x86_64-appimage.json",
                "linux-x86_64-appimage",
            ),
            (
                "linux",
                "x86_64",
                BundleType::Deb,
                "deb",
                ".deb",
                "creator-hub-linux-x86_64-deb.json",
                "linux-x86_64-deb",
            ),
            (
                "linux",
                "x86_64",
                BundleType::Rpm,
                "rpm",
                ".rpm",
                "creator-hub-linux-x86_64-rpm.json",
                "linux-x86_64-rpm",
            ),
        ] {
            let target = Target::select(os, arch, Some(bundle)).unwrap();
            assert_eq!((target.package, target.extension), (package, extension));
            assert_eq!(target.descriptor(), descriptor);
            assert_eq!(target.updater_key(), updater);
        }
    }
    #[test]
    fn unsupported_architecture_portable_binary_and_msi_refuse_updating() {
        for (os, arch, bundle) in [
            ("linux", "aarch64", Some(BundleType::Deb)),
            ("windows", "x86_64", Some(BundleType::Msi)),
            ("linux", "x86_64", None),
            ("macos", "x86_64", None),
        ] {
            assert!(Target::select(os, arch, bundle).is_err());
        }
    }
    #[test]
    fn mac_disk_images_translocated_and_unexpected_copies_are_not_update_targets() {
        let home = Path::new("/Users/test");
        for path in [
            "/Applications/Creator Hub.app/Contents/MacOS/creator-hub",
            "/Users/test/Applications/Creator Hub.app/Contents/MacOS/creator-hub",
        ] {
            assert!(mac_application(Path::new(path), home)
                .unwrap()
                .ends_with("Creator Hub.app"));
        }
        for path in [
            "/Volumes/Creator Hub/Creator Hub.app/Contents/MacOS/creator-hub",
            "/private/var/AppTranslocation/Creator Hub.app/Contents/MacOS/creator-hub",
            "/Users/test/Downloads/creator-hub",
        ] {
            assert!(mac_application(Path::new(path), home).is_err());
        }
    }
    #[test]
    fn unproven_appimage_paths_cannot_authorize_replacement_of_an_outer_file() {
        let root = std::env::temp_dir();
        let dir = root.join(".mount_Hub");
        let exe = dir.join("usr/bin/creator-hub");
        let image = root.join("Creator_Hub.AppImage");
        assert!(appimage_location(&exe, &dir, &image)
            .unwrap_err()
            .contains("running container cannot be verified"));
        assert!(appimage_location(&exe, &dir, &root.join("Unrelated.AppImage")).is_err());
        assert!(appimage_location(&root.join("usr/bin/creator-hub"), &dir, &image).is_err());
        assert!(appimage_location(&exe, &dir, &dir.join("bad.AppImage")).is_err());
        assert!(appimage_location(&exe, &dir, Path::new("relative.AppImage")).is_err());
    }
    #[test]
    fn inherited_appimage_cannot_redirect_a_deb_or_rpm_restart() {
        let root = tempfile::tempdir().unwrap();
        let installed = root.path().join("usr/bin/creator-hub");
        assert!(verify_restart_target(&installed, &installed).is_ok());
        let unrelated = root.path().join("Another-App.AppImage");
        assert!(verify_restart_target(&installed, &unrelated)
            .unwrap_err()
            .contains("No installer was started"));
    }
}
