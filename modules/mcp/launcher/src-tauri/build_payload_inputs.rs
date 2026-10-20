use std::{
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
};

pub const OVERRIDE_ENV: &str = "CREATOR_HUB_INTEGRATED_MCP_PAYLOAD";

#[derive(Debug, PartialEq, Eq)]
pub struct PayloadInput {
    pub name: &'static str,
    pub source: PathBuf,
}

pub fn select_inputs(
    target_os: &str,
    integrated_service: bool,
    supplied_root: Option<&OsStr>,
) -> Result<[PayloadInput; 4], String> {
    let names = [
        "creator-works-mcp.mjs",
        if target_os == "windows" {
            "runtime/node.exe"
        } else {
            "runtime/node"
        },
        "unity-extension/Editor/BanterMCPBridge.cs",
        "unity-extension/Editor/CreatorWorksMCPLogo.png",
    ];
    let Some(supplied_root) = supplied_root else {
        return Ok(names.map(|name| PayloadInput {
            name,
            source: Path::new(if name.starts_with("unity-extension/") {
                "../.."
            } else {
                "../../release"
            })
            .join(name),
        }));
    };
    if !integrated_service {
        return Err("The payload override requires the integrated-service feature.".into());
    }
    let supplied_root = Path::new(supplied_root);
    if !supplied_root.is_absolute() {
        return Err("The payload override must be an absolute directory.".into());
    }
    let metadata = fs::symlink_metadata(supplied_root)
        .map_err(|_| "The payload override directory is unavailable.")?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("The payload override must be a real directory.".into());
    }
    let root = supplied_root
        .canonicalize()
        .map_err(|_| "Cannot canonicalize the payload override directory.")?;
    if root
        .to_str()
        .is_none_or(|value| value.contains(['\r', '\n']))
    {
        return Err("The payload override cannot be represented in Cargo directives.".into());
    }
    // Check only the four fixed inputs and their parents; never scan the payload.
    for name in names {
        let mut file = root.clone();
        let parts: Vec<_> = Path::new(name).components().collect();
        for (index, part) in parts.iter().enumerate() {
            file.push(part);
            let metadata = fs::symlink_metadata(&file)
                .map_err(|_| format!("Required MCP payload input is unavailable: {name}."))?;
            if metadata.file_type().is_symlink()
                || if index + 1 == parts.len() {
                    !metadata.is_file()
                } else {
                    !metadata.is_dir()
                }
            {
                return Err(format!(
                    "Redirected or non-regular MCP payload input: {name}."
                ));
            }
        }
    }
    Ok(names.map(|name| PayloadInput {
        name,
        source: root.join(name),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new(target: &str) -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let root = std::env::temp_dir().join(format!(
                "creator-mcp-build-inputs-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            let fixture = Self(root);
            for input in select_inputs(target, false, None).unwrap() {
                let file = fixture.0.join(input.name);
                fs::create_dir_all(file.parent().unwrap()).unwrap();
                fs::write(file, input.name).unwrap();
            }
            fixture
        }

        fn select(&self, target: &str) -> Result<[PayloadInput; 4], String> {
            select_inputs(target, true, Some(self.0.as_os_str()))
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn standalone_inputs_and_feature_without_override_remain_identical() {
        for target in ["linux", "macos", "windows"] {
            let inputs = select_inputs(target, false, None).unwrap();
            assert_eq!(inputs, select_inputs(target, true, None).unwrap());
            assert_eq!(
                inputs[0].source,
                Path::new("../../release/creator-works-mcp.mjs")
            );
            assert_eq!(
                inputs[1].source,
                Path::new(if target == "windows" {
                    "../../release/runtime/node.exe"
                } else {
                    "../../release/runtime/node"
                })
            );
            assert_eq!(
                inputs[2].source,
                Path::new("../../unity-extension/Editor/BanterMCPBridge.cs")
            );
            assert_eq!(
                inputs[3].source,
                Path::new("../../unity-extension/Editor/CreatorWorksMCPLogo.png")
            );
        }
    }

    #[test]
    fn override_requires_feature_even_for_valid_payload() {
        let fixture = Fixture::new("linux");
        assert!(select_inputs("linux", false, Some(fixture.0.as_os_str())).is_err());
    }

    #[test]
    fn override_selects_only_four_canonical_target_inputs() {
        for target in ["linux", "macos", "windows"] {
            let fixture = Fixture::new(target);
            fs::write(fixture.0.join("unlisted.txt"), "ignored").unwrap();
            let canonical = fixture.0.canonicalize().unwrap();
            let inputs = fixture.select(target).unwrap();
            for input in &inputs {
                assert_eq!(input.source, canonical.join(input.name));
                assert_eq!(fs::read(&input.source).unwrap(), input.name.as_bytes());
            }
            assert_eq!(inputs.len(), 4);
            assert_eq!(
                inputs[1].name,
                if target == "windows" {
                    "runtime/node.exe"
                } else {
                    "runtime/node"
                }
            );
        }
    }

    #[test]
    fn invalid_supplied_paths_never_use_standalone_fallback() {
        let fixture = Fixture::new("linux");
        for path in [
            Path::new(""),
            Path::new("relative/server"),
            &fixture.0.join("missing"),
            &fixture.0.join("creator-works-mcp.mjs"),
        ] {
            assert!(select_inputs("linux", true, Some(path.as_os_str())).is_err());
        }
    }

    #[test]
    fn every_input_is_required_and_must_be_regular() {
        for input in select_inputs("linux", false, None).unwrap() {
            let fixture = Fixture::new("linux");
            let file = fixture.0.join(input.name);
            fs::remove_file(&file).unwrap();
            assert!(fixture.select("linux").is_err());
            fs::create_dir(file).unwrap();
            assert!(fixture.select("linux").is_err());
        }
    }

    #[test]
    fn runtime_choice_uses_target_not_host_or_alternate_filename() {
        let fixture = Fixture::new("linux");
        assert!(fixture.select("windows").is_err());
        fs::write(fixture.0.join("runtime/node.exe"), "windows").unwrap();
        assert_eq!(
            fixture.select("windows").unwrap()[1].name,
            "runtime/node.exe"
        );
        assert_eq!(fixture.select("linux").unwrap()[1].name, "runtime/node");
    }

    #[test]
    fn build_script_calls_this_selector_and_tracks_env_and_each_selected_file() {
        let source = include_str!("build.rs");
        assert!(source.contains("mod build_payload_inputs;"));
        assert!(source.contains("let inputs = select_inputs("));
        assert!(source.contains("std::env::var_os(OVERRIDE_ENV)"));
        assert!(source.contains("std::env::var_os(\"CARGO_FEATURE_INTEGRATED_SERVICE\").is_some()"));
        assert!(source.contains("cargo:rerun-if-env-changed={OVERRIDE_ENV}"));
        assert!(source.contains("cargo:rerun-if-env-changed=CARGO_FEATURE_INTEGRATED_SERVICE"));
        assert!(source.contains("for PayloadInput { name, source } in inputs {"));
        assert!(source.contains("println!(\"cargo:rerun-if-changed={}\", source.display());"));
        assert!(source.contains("std::fs::File::open(source)"));
    }

    #[cfg(unix)]
    #[test]
    fn redirected_leaf_parent_and_root_are_refused() {
        use std::os::unix::fs::symlink;
        for name in ["creator-works-mcp.mjs", "runtime", "."] {
            let fixture = Fixture::new("linux");
            let other = Fixture::new("linux");
            let link = fixture.0.join(name);
            let target = other.0.join(name);
            if name == "." {
                let link = fixture.0.join("redirected-root");
                symlink(&other.0, &link).unwrap();
                assert!(select_inputs("linux", true, Some(link.as_os_str())).is_err());
            } else {
                if link.is_dir() {
                    fs::remove_dir_all(&link).unwrap();
                } else {
                    fs::remove_file(&link).unwrap();
                }
                symlink(target, &link).unwrap();
                assert!(fixture.select("linux").is_err());
            }
        }
    }
}
