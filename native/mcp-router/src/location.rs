use super::*;

fn executable_name() -> &'static str {
    if cfg!(windows) {
        "creator-hub-mcp-router.exe"
    } else {
        "creator-hub-mcp-router"
    }
}

fn physical_command(command: &Path) -> Result<PathBuf, String> {
    reject_links(command)?;
    let physical =
        fs::canonicalize(command).map_err(|_| "Cannot locate the retained MCP router.")?;
    reject_links(&physical)?;
    if physical.file_name().and_then(|s| s.to_str()) != Some(executable_name()) {
        return Err("The MCP router is not in its retained installation location.".into());
    }
    Ok(physical)
}

#[cfg(windows)]
pub(super) fn node_argument(path: &Path) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{}", rest));
    }
    if let Some(rest) = value.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path.to_owned()
}

fn store_at(command: &Path, binding: u32) -> Result<Store, String> {
    let directory = command
        .parent()
        .ok_or("Missing retained router directory.")?;
    let scope = directory.parent().ok_or("Missing retained router scope.")?;
    let route = scope
        .parent()
        .ok_or("Missing retained routing directory.")?;
    let base = route.parent().ok_or("Missing retained MCP store.")?;
    if directory.file_name().and_then(|s| s.to_str()) != Some(format!("router-v{binding}").as_str())
        || scope.file_name().and_then(|s| s.to_str())
            != Some(format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH).as_str())
        || route.file_name().and_then(|s| s.to_str()) != Some("mcp-route-v1")
    {
        return Err("The MCP router is not in its retained installation location.".into());
    }
    Store::new(
        base,
        PublicKey::decode(KEY).map_err(|_| "Invalid embedded MCP routing key.")?,
    )
}

pub(super) fn store_for_command(command: &Path, binding: u32) -> Result<Store, String> {
    let physical = physical_command(command)?;
    store_at(&physical, binding)
}

pub(super) fn verify_command(command: &Path) -> Result<(), String> {
    let physical = physical_command(command)?;
    let binding = match physical
        .parent()
        .and_then(Path::file_name)
        .and_then(|s| s.to_str())
    {
        Some("router-v1") => 1,
        Some("router-v2") => 2,
        _ => return Err("Unsupported retained MCP router location.".into()),
    };
    let store = store_at(&physical, binding)?;
    let router = store.router_at(physical.parent().unwrap())?;
    if router.command != physical {
        return Err("The verified MCP router location changed.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn installed_store_is_shared_under_home_not_virtualized_appdata() {
        let expected = dirs::home_dir().unwrap().join(".creator-hub");
        assert_eq!(Store::installed_base().unwrap(), expected);
        assert!(!expected.exists() || expected.is_dir());
    }

    #[cfg(windows)]
    #[test]
    fn node_arguments_keep_physical_location_without_device_prefix() {
        assert_eq!(
            node_argument(Path::new(r"\\?\C:\Packages\Client\server.mjs")),
            Path::new(r"C:\Packages\Client\server.mjs")
        );
        assert_eq!(
            node_argument(Path::new(r"\\?\UNC\server\share\server.mjs")),
            Path::new(r"\\server\share\server.mjs")
        );
        assert_eq!(
            node_argument(Path::new(r"C:\normal\server.mjs")),
            Path::new(r"C:\normal\server.mjs")
        );
    }

    #[test]
    fn executable_location_selects_its_store_not_another_profile() {
        let root = tempfile::tempdir().unwrap();
        let scope = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
        for prefix in ["ordinary", "Packages/Client/LocalCache/Local"] {
            let base = root.path().join(prefix).join("creator-hub");
            let executable = base
                .join("mcp-route-v1")
                .join(&scope)
                .join("router-v2")
                .join(executable_name());
            fs::create_dir_all(executable.parent().unwrap()).unwrap();
            fs::write(&executable, b"unexecuted location fixture").unwrap();
            let store = store_for_command(&executable, 2).unwrap();
            assert_eq!(
                fs::canonicalize(&store.root).unwrap(),
                fs::canonicalize(&base)
                    .unwrap()
                    .join("mcp-route-v1")
                    .join(&scope)
            );
            assert!(store.snapshot().unwrap().is_none());
            assert!(
                verify_command(&executable).is_err(),
                "placement alone is not signed ownership"
            );
        }
    }

    #[test]
    fn wrong_scope_version_name_and_missing_executable_refuse_without_fallback() {
        let root = tempfile::tempdir().unwrap();
        let scope = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
        for relative in [
            format!("mcp-route-v1/{scope}/router-v1/{}", executable_name()),
            format!("mcp-route-v1/foreign/router-v2/{}", executable_name()),
            format!("other/{scope}/router-v2/{}", executable_name()),
            format!("mcp-route-v1/{scope}/router-v2/other.exe"),
        ] {
            let file = root.path().join(relative);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(&file, b"fixture").unwrap();
            assert!(store_for_command(&file, 2).is_err());
        }
        assert!(store_for_command(&root.path().join("missing"), 2).is_err());
        assert!(store_for_command(Path::new("relative"), 2).is_err());
    }
}
