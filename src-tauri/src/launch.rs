use serde::Serialize;
use std::ffi::OsString;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum View {
    Hub,
    Mcp,
    Setup,
}

// Launch roles never select an executable or approve a mutation.
pub fn native_support_requested(arguments: impl IntoIterator<Item = OsString>) -> bool {
    let arguments: Vec<_> = arguments.into_iter().take(2).collect();
    cfg!(all(
        target_os = "linux",
        feature = "experimental-linux-portable-update"
    )) && matches!(arguments.as_slice(), [flag] if flag == "--install-native-support")
}

#[cfg(any(
    test,
    all(target_os = "linux", feature = "experimental-linux-portable-update")
))]
pub(crate) fn automatic_native_support(
    platform: (&str, &str),
    enabled: bool,
    arguments: &[OsString],
    bundle: Option<tauri::utils::config::BundleType>,
    has_host_marker: bool,
    sandboxed: bool,
    appimage_hint: Option<&std::ffi::OsStr>,
) -> bool {
    // Bundle and filename hints select only a restricted screen, never authority.
    platform == ("linux", "x86_64")
        && enabled
        && arguments.is_empty()
        && bundle == Some(tauri::utils::config::BundleType::AppImage)
        && !has_host_marker
        && !sandboxed
        && native_support_alias(appimage_hint)
}

#[cfg(any(
    test,
    all(target_os = "linux", feature = "experimental-linux-portable-update")
))]
fn native_support_alias(hint: Option<&std::ffi::OsStr>) -> bool {
    let Some(hint) = hint.and_then(std::ffi::OsStr::to_str) else {
        return false;
    };
    // Lexical Linux filename intent only: never inspect or execute this path.
    if hint.len() > 4096 || !hint.starts_with('/') || hint.chars().any(char::is_control) {
        return false;
    }
    let name = hint.rsplit('/').next().unwrap_or_default();
    let stem = concat!(
        "Creator.Hub.Native.Support_",
        env!("CARGO_PKG_VERSION"),
        "_amd64"
    );
    let Some(suffix) = name
        .strip_prefix(stem)
        .and_then(|name| name.strip_suffix(".AppImage"))
    else {
        return false;
    };
    if suffix.is_empty() {
        return true;
    }
    let Some(number) = suffix
        .strip_prefix(" (")
        .and_then(|number| number.strip_suffix(')'))
    else {
        return false;
    };
    (1..=3).contains(&number.len())
        && !number.starts_with('0')
        && number.bytes().all(|digit| digit.is_ascii_digit())
}

pub fn parse(arguments: impl IntoIterator<Item = OsString>) -> Result<View, ()> {
    let arguments: Vec<_> = arguments.into_iter().take(4).collect();
    match arguments.as_slice() {
        [] => Ok(View::Hub),
        [flag] if native_support_requested([flag.clone()]) => Ok(View::Hub),
        [flag]
            if flag == "--flatpak-activate"
                && cfg!(all(
                    target_os = "linux",
                    feature = "experimental-flatpak-host",
                    feature = "integrated-features"
                )) =>
        {
            Ok(View::Hub)
        }
        [flag, app] if flag == "--open-app" && app == "mcp" => Ok(View::Mcp),
        [flag, app] if flag == "--open-app" && app == "setup" => Ok(View::Setup),
        _ => Err(()),
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    view: View,
    revision: u64,
}

pub struct Launch(Mutex<Request>);
impl Launch {
    pub fn new(view: View) -> Self {
        Self(Mutex::new(Request { view, revision: 0 }))
    }
    fn update(&self, view: View) -> Option<Request> {
        let mut request = self.0.lock().ok()?;
        request.revision = request.revision.checked_add(1)?;
        request.view = view;
        Some(request.clone())
    }
}

pub fn activate(app: &tauri::AppHandle, arguments: Vec<String>) {
    let Ok(view) = parse(arguments.into_iter().skip(1).map(OsString::from)) else {
        return;
    };
    if let Some(request) = app.state::<Launch>().update(view) {
        // The persisted in-memory revision also covers requests arriving before UI listeners.
        let _ = app.emit_to("main", "hub-launch-view", request);
    }
    let _ = focus(app);
}

pub fn focus(app: &tauri::AppHandle) -> bool {
    if app.state::<crate::manager::Manager>().is_closing() {
        return false;
    }
    if let Some(window) = app.get_webview_window("main") {
        let shown = window.show().is_ok();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return shown;
    }
    false
}

#[tauri::command]
pub fn get_launch_request(handle: tauri::AppHandle) -> Result<Request, String> {
    handle
        .state::<Launch>()
        .0
        .lock()
        .map(|value| value.clone())
        .map_err(|_| "Hub launch state is unavailable.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_fixed_navigation_arguments_are_accepted() {
        assert_eq!(parse([]), Ok(View::Hub));
        for (name, view) in [("mcp", View::Mcp), ("setup", View::Setup)] {
            assert_eq!(
                parse([OsString::from("--open-app"), OsString::from(name)]),
                Ok(view)
            );
        }
        for arguments in [
            vec!["--open-app"],
            vec!["--open-app=mcp"],
            vec!["--OPEN-APP", "mcp"],
            vec!["--open-app", "MCP"],
            vec!["--open-app", "../mcp"],
            vec!["--open-app", "mcp", "--install"],
            vec!["C:\\tool.exe"],
            vec!["--install", "setup"],
            vec!["--open-app", "setup", "--open-app", "mcp"],
        ] {
            assert!(parse(arguments.into_iter().map(OsString::from)).is_err());
        }
    }
    #[test]
    fn later_requests_supersede_startup_without_losing_order() {
        let launch = Launch::new(View::Setup);
        let mcp = launch.update(View::Mcp).unwrap();
        assert_eq!(mcp.view, View::Mcp);
        assert_eq!(mcp.revision, 1);
        let hub = launch.update(View::Hub).unwrap();
        assert_eq!(hub.revision, 2);
        assert_eq!(launch.0.lock().unwrap().view, View::Hub);
    }

    #[test]
    fn flatpak_activation_is_exact_and_requires_the_integrated_linux_host_build() {
        assert_eq!(
            parse([OsString::from("--flatpak-activate")]).is_ok(),
            cfg!(all(
                target_os = "linux",
                feature = "experimental-flatpak-host",
                feature = "integrated-features"
            ))
        );
        for args in [
            vec!["--flatpak-activate", "mcp"],
            vec!["--flatpak-activate=/tmp/app"],
            vec!["--flatpak-activate", "--install"],
            vec!["--FLATPAK-ACTIVATE"],
        ] {
            assert!(parse(args.into_iter().map(OsString::from)).is_err());
        }
    }

    #[test]
    fn native_support_role_requires_the_exact_single_flag_and_linux_update_feature() {
        let arguments = [OsString::from("--install-native-support")];
        let supported = cfg!(all(
            target_os = "linux",
            feature = "experimental-linux-portable-update"
        ));
        assert_eq!(native_support_requested(arguments.clone()), supported);
        assert_eq!(parse(arguments).is_ok(), supported);
        for args in [
            vec![],
            vec!["--install-native-support", "--open-app", "mcp"],
            vec!["--install-native-support", "--install-native-support"],
            vec!["--install-native-support=/tmp/store"],
            vec!["--INSTALL-NATIVE-SUPPORT"],
        ] {
            assert!(!native_support_requested(
                args.into_iter().map(OsString::from)
            ));
        }
    }

    #[test]
    fn automatic_bootstrap_requires_all_seven_startup_fields() {
        use tauri::utils::config::BundleType;
        let image = || Some(BundleType::AppImage);
        let hint = OsString::from(format!(
            "/downloads/Creator.Hub.Native.Support_{}_amd64.AppImage",
            env!("CARGO_PKG_VERSION")
        ));
        assert!(automatic_native_support(
            ("linux", "x86_64"),
            true,
            &[],
            image(),
            false,
            false,
            Some(&hint)
        ));
        for os in ["windows", "unknown", "Linux"] {
            assert!(!automatic_native_support(
                (os, "x86_64"),
                true,
                &[],
                image(),
                false,
                false,
                Some(&hint)
            ));
        }
        for architecture in ["aarch64", "x86", "unknown"] {
            assert!(!automatic_native_support(
                ("linux", architecture),
                true,
                &[],
                image(),
                false,
                false,
                Some(&hint)
            ));
        }
        assert!(!automatic_native_support(
            ("linux", "x86_64"),
            false,
            &[],
            image(),
            false,
            false,
            Some(&hint)
        ));
        for argument in [
            "--flatpak-activate",
            "--install-native-support",
            "--open-app",
            "file.unity",
        ] {
            assert!(!automatic_native_support(
                ("linux", "x86_64"),
                true,
                &[OsString::from(argument)],
                image(),
                false,
                false,
                Some(&hint)
            ));
        }
        for bundle in [
            None,
            Some(BundleType::Deb),
            Some(BundleType::Rpm),
            Some(BundleType::Nsis),
        ] {
            assert!(!automatic_native_support(
                ("linux", "x86_64"),
                true,
                &[],
                bundle,
                false,
                false,
                Some(&hint)
            ));
        }
        assert!(!automatic_native_support(
            ("linux", "x86_64"),
            true,
            &[],
            image(),
            true,
            false,
            Some(&hint)
        ));
        assert!(!automatic_native_support(
            ("linux", "x86_64"),
            true,
            &[],
            image(),
            false,
            true,
            Some(&hint)
        ));
        assert_eq!(parse([]), Ok(View::Hub));
    }

    #[test]
    fn ordinary_argless_appimage_still_opens_normal_hub() {
        let stem = format!("/downloads/Creator.Hub_{}_amd64", env!("CARGO_PKG_VERSION"));
        for name in std::iter::once(format!("{stem}.AppImage"))
            .chain((1..=999).map(|n| format!("{stem} ({n}).AppImage")))
        {
            assert!(!automatic_native_support(
                ("linux", "x86_64"),
                true,
                &[],
                Some(tauri::utils::config::BundleType::AppImage),
                false,
                false,
                Some(std::ffi::OsStr::new(&name)),
            ));
        }
    }

    #[test]
    fn setup_alias_accepts_only_current_absolute_name_and_bounded_browser_duplicates() {
        let stem = format!(
            "/not-read/Creator.Hub.Native.Support_{}_amd64",
            env!("CARGO_PKG_VERSION")
        );
        for name in std::iter::once(format!("{stem}.AppImage"))
            .chain((1..=999).map(|n| format!("{stem} ({n}).AppImage")))
        {
            assert!(
                native_support_alias(Some(std::ffi::OsStr::new(&name))),
                "{name}"
            );
        }
        assert!(!native_support_alias(None));
        for name in [
            String::new(),
            format!("{}.AppImage", stem.trim_start_matches('/')),
            format!("{stem}.AppImage/"),
            format!("{stem}.AppImage/other"),
            format!("{stem}.appimage"),
            format!("{stem}.AppImage.bak"),
            format!("{stem} copy.AppImage"),
            format!("{stem} (0).AppImage"),
            format!("{stem} (00).AppImage"),
            format!("{stem} (01).AppImage"),
            format!("{stem} (1000).AppImage"),
            format!("{stem} (+1).AppImage"),
            format!("{stem} (-1).AppImage"),
            format!("{stem}(1).AppImage"),
            format!("{stem} (1) (2).AppImage"),
            format!("{stem} (1 ).AppImage"),
            format!("{stem} (1.0).AppImage"),
            format!("{stem} (\u{ff11}).AppImage"),
            format!("{stem} (1).AppImage "),
            format!("{stem}\0.AppImage"),
            format!("/bad\n{stem}.AppImage"),
            format!("/bad\r{stem}.AppImage"),
            format!("/bad\u{7f}{stem}.AppImage"),
            format!("/{}{stem}.AppImage", "x".repeat(4096)),
            format!(
                "/Creator.Hub.Native.Support_{}-other_amd64.AppImage",
                env!("CARGO_PKG_VERSION")
            ),
            format!(
                "/Creator.Hub.Native.Support_{}_aarch64.AppImage",
                env!("CARGO_PKG_VERSION")
            ),
        ] {
            assert!(
                !native_support_alias(Some(std::ffi::OsStr::new(&name))),
                "{name:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn setup_alias_rejects_non_utf8_hint() {
        use std::os::unix::ffi::OsStringExt;
        let hint = OsString::from_vec(vec![b'/', 0xff]);
        assert!(!native_support_alias(Some(&hint)));
    }
}
