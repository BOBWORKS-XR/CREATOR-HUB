use serde::Serialize;
use std::ffi::OsString;
use std::io::Write;

#[derive(Debug, PartialEq)]
pub enum StartupMode {
    Standalone,
    Info,
    Hosted,
    Invalid,
}

pub fn startup_mode(arguments: impl IntoIterator<Item = OsString>) -> StartupMode {
    let arguments: Vec<_> = arguments.into_iter().collect();
    if arguments.len() == 1 && arguments[0] == "--creator-hub-host" {
        StartupMode::Hosted
    } else if arguments.len() == 1 && arguments[0] == "--creator-hub-info" {
        StartupMode::Info
    } else if arguments.iter().any(|argument| {
        argument
            .to_string_lossy()
            .to_ascii_lowercase()
            .starts_with("--creator-hub")
    }) {
        StartupMode::Invalid
    } else {
        StartupMode::Standalone
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    schema_version: u32,
    app_id: &'static str,
    display_name: &'static str,
    version: &'static str,
    platform: &'static str,
    architecture: &'static str,
    capabilities: Vec<&'static str>,
}

pub fn write_info(mut output: impl Write) -> Result<(), String> {
    let info = AppInfo {
        schema_version: 1,
        app_id: "creator-project-setup",
        display_name: "Creator Project Setup",
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        capabilities: vec!["launch.standalone"],
    };
    serde_json::to_writer(&mut output, &info).map_err(|error| error.to_string())?;
    output.write_all(b"\n").map_err(|error| error.to_string())?;
    output.flush().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mode(arguments: &[&str]) -> StartupMode {
        startup_mode(arguments.iter().map(OsString::from))
    }

    #[test]
    fn only_exact_info_invocation_succeeds() {
        assert_eq!(mode(&["--creator-hub-info"]), StartupMode::Info);
        for arguments in [
            vec!["--creator-hub-info", "--output", "anything.json"],
            vec!["project-path", "--creator-hub-info"],
            vec!["--creator-hub-info", "--creator-hub-info"],
            vec!["--creator-hub-info=true"],
            vec!["--creator-hub-install"],
            vec!["--creator-hub"],
            vec!["--CREATOR-HUB-INFO"],
            vec!["--Creator-Hub-Info"],
            vec!["--CREATOR-HUB-UNKNOWN"],
        ] {
            assert_eq!(mode(&arguments), StartupMode::Invalid);
        }
    }

    #[test]
    fn standalone_arguments_keep_existing_behavior() {
        assert_eq!(mode(&[]), StartupMode::Standalone);
        assert_eq!(mode(&["-psn_0_12345"]), StartupMode::Standalone);
    }

    #[test]
    fn info_is_compact_and_uses_compiled_version() {
        let mut bytes = Vec::new();
        write_info(&mut bytes).unwrap();
        assert!(bytes.len() < 1024);
        assert_eq!(bytes.iter().filter(|byte| **byte == b'\n').count(), 1);
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["appId"], "creator-project-setup");
        assert_eq!(value["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(value["platform"], std::env::consts::OS);
        assert_eq!(value["architecture"], std::env::consts::ARCH);
        assert_eq!(
            value["capabilities"],
            serde_json::json!(["launch.standalone"])
        );
        assert_eq!(value.as_object().unwrap().len(), 7);
    }

    #[test]
    fn version_matches_app_packaging() {
        for source in [
            include_str!("../../package.json"),
            include_str!("../tauri.conf.json"),
        ] {
            let value: serde_json::Value = serde_json::from_str(source).unwrap();
            assert_eq!(value["version"], env!("CARGO_PKG_VERSION"));
        }
        assert!(include_str!("../../src/index.html").contains(env!("CARGO_PKG_VERSION")));
    }

    #[test]
    fn broken_output_is_reported() {
        struct Broken;
        impl Write for Broken {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        assert!(write_info(Broken).is_err());
    }
}
