//! Bind an approved managed connection to the settings file reviewed by Hub.
use sha2::{Digest, Sha256};
use std::path::Path;

pub fn planned_path(source: &Path) -> Result<std::path::PathBuf, String> {
    view_path(
        source,
        &creator_hub_mcp_router::Store::installed_base()?.join("settings-views"),
    )
}

pub fn current_for_client(current: &Path, legacy: &Path) -> Result<std::path::PathBuf, String> {
    let review = Review::prepare_current(current, legacy)?;
    review.publish()?;
    review.path()
}

#[cfg(test)]
fn snapshot_at(source: &Path, views: &Path) -> Result<std::path::PathBuf, String> {
    publish_at(source, source, views, None)
}

pub struct Review {
    source: std::path::PathBuf,
    identity: std::path::PathBuf,
    views: std::path::PathBuf,
    before: Option<Vec<u8>>,
}

impl Review {
    pub fn prepare_current(current: &Path, legacy: &Path) -> Result<Self, String> {
        Self::prepare_at(
            current,
            legacy,
            &creator_hub_mcp_router::Store::installed_base()?.join("settings-views"),
        )
    }

    fn prepare_at(current: &Path, legacy: &Path, views: &Path) -> Result<Self, String> {
        let source = if current.exists() { current } else { legacy };
        let before = crate::settings_backup::read_bytes(source)?;
        physical(current)?;
        Ok(Self {
            source: source.into(),
            identity: current.into(),
            views: views.into(),
            before,
        })
    }

    pub fn path(&self) -> Result<std::path::PathBuf, String> {
        view_path(&self.identity, &self.views)
    }

    pub fn publish(&self) -> Result<(), String> {
        if self.source != self.identity && self.identity.exists() {
            return Err("Current MCP settings appeared during review. Check again; no shared settings were changed.".into());
        }
        let before = self
            .before
            .as_deref()
            .ok_or("Save or review MCP settings before connecting an AI client.")?;
        publish_at(&self.source, &self.identity, &self.views, Some(before)).map(|_| ())
    }
}

fn view_path(identity: &Path, views: &Path) -> Result<std::path::PathBuf, String> {
    Ok(views
        .join(format!(
            "{:x}",
            Sha256::digest(physical(identity)?.as_bytes())
        ))
        .join("launcher-config.json"))
}

fn publish_at(
    source: &Path,
    identity: &Path,
    views: &Path,
    expected: Option<&[u8]>,
) -> Result<std::path::PathBuf, String> {
    let _source_guard = crate::settings_backup::protected_options()
        .open(source)
        .map_err(|_| "Cannot reserve the reviewed MCP settings file.")?;
    let physical = physical(identity)?;
    let bytes = crate::settings_backup::read_bytes(source)?
        .ok_or("Save or review MCP settings before connecting an AI client.")?;
    if expected.is_some_and(|before| before != bytes) {
        return Err("MCP settings changed during connection review. Check again; no shared settings were changed.".into());
    }
    let mut projection: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Invalid MCP settings; no client settings were changed.")?;
    if !projection.is_object() || projection.get("_creator_hub_view").is_some() {
        return Err("Unsupported source settings for a managed view; original was kept.".into());
    }
    let root = views.join(format!("{:x}", Sha256::digest(physical.as_bytes())));
    crate::settings_backup::reject_links(&root)?;
    std::fs::create_dir_all(&root).map_err(|_| "Cannot prepare the shared MCP settings view.")?;
    let lock_path = root.join("view.lock");
    crate::settings_backup::reject_links(&lock_path)?;
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|_| "Cannot reserve the shared MCP settings view.")?;
    fs2::FileExt::try_lock_exclusive(&lock)
        .map_err(|_| "Another Hub is updating this MCP settings view. Try again.")?;
    let target = root.join("launcher-config.json");
    crate::settings_backup::reject_links(&target)?;
    let existing = crate::settings_backup::read_bytes(&target)?;
    if let Some(existing) = &existing {
        let mut previous: serde_json::Value = serde_json::from_slice(existing)
            .map_err(|_| "Invalid shared MCP settings view receipt; original was kept.")?;
        let record = previous
            .as_object_mut()
            .and_then(|object| object.remove("_creator_hub_view"))
            .ok_or("Unrecognized shared MCP settings view; original was kept.")?;
        let canonical =
            serde_json::to_vec(&previous).map_err(|_| "Cannot verify shared settings view.")?;
        if record["source"] != physical
            || record["sha256"] != format!("{:x}", Sha256::digest(canonical))
        {
            return Err(
                "Shared MCP settings view changed outside Hub; both copies were kept for review."
                    .into(),
            );
        }
    }
    let canonical =
        serde_json::to_vec(&projection).map_err(|_| "Cannot encode shared settings view.")?;
    projection["_creator_hub_view"] =
        serde_json::json!({"source":physical,"sha256":format!("{:x}",Sha256::digest(canonical))});
    let projected =
        serde_json::to_vec(&projection).map_err(|_| "Cannot encode shared settings view.")?;
    if existing.as_deref() != Some(projected.as_slice()) {
        if let Some(existing) = existing {
            let backup = root.join(format!("{:x}.backup.json", Sha256::digest(&existing)));
            match crate::settings_backup::read_bytes(&backup)? {
                Some(saved) if saved != existing => {
                    return Err("Shared MCP settings backup differs; no view was replaced.".into())
                }
                Some(_) => {}
                None => {
                    let mut file = std::fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&backup)
                        .map_err(|_| "Cannot back up shared MCP settings.")?;
                    std::io::Write::write_all(&mut file, &existing)
                        .map_err(|_| "Cannot write shared MCP settings backup.")?;
                    file.sync_all()
                        .map_err(|_| "Cannot flush shared MCP settings backup.")?;
                }
            }
        }
        crate::atomic_write(
            &target,
            std::str::from_utf8(&projected).map_err(|_| "Invalid MCP settings text.")?,
        )?;
    }
    Ok(target)
}

pub fn refresh_existing(source: &Path) -> Result<(), String> {
    if cfg!(test) {
        return Ok(());
    }
    refresh_at(
        source,
        source,
        &creator_hub_mcp_router::Store::installed_base()?.join("settings-views"),
    )?;
    Ok(())
}

pub fn refresh_recovered(current: &Path, legacy: &Path) -> Result<(), String> {
    if cfg!(test) {
        return Ok(());
    }
    refresh_at(
        current,
        legacy,
        &creator_hub_mcp_router::Store::installed_base()?.join("settings-views"),
    )
}

fn refresh_at(current: &Path, legacy: &Path, views: &Path) -> Result<(), String> {
    let review = Review::prepare_at(current, legacy, views)?;
    if review.path()?.exists() {
        review.publish()?;
    }
    Ok(())
}

#[cfg(test)]
pub fn refresh_fixture(current: &Path, legacy: &Path, views: &Path) -> Result<(), String> {
    refresh_at(current, legacy, views)
}

#[cfg(test)]
pub fn prepare_fixture(current: &Path, legacy: &Path, views: &Path) -> Result<Review, String> {
    Review::prepare_at(current, legacy, views)
}

pub fn physical(path: &Path) -> Result<String, String> {
    if !path.is_absolute() {
        return Err("Managed MCP settings require an absolute path.".into());
    }
    crate::settings_backup::reject_links(path)?;
    if path
        .components()
        .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("Managed MCP settings require an unambiguous path.".into());
    }
    let mut ancestor = path;
    while !ancestor.exists() {
        ancestor = ancestor.parent().ok_or("Missing MCP settings parent.")?;
    }
    let mut resolved = std::fs::canonicalize(ancestor)
        .map_err(|_| "Cannot locate the reviewed MCP settings file.")?;
    if ancestor != path {
        resolved.push(
            path.strip_prefix(ancestor)
                .map_err(|_| "Invalid MCP settings path.")?,
        );
    }
    crate::settings_backup::reject_links(&resolved)?;
    let value = resolved.to_str().ok_or("MCP settings path is not UTF-8.")?;
    #[cfg(windows)]
    {
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return Ok(format!(r"\\{}", rest));
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return Ok(rest.to_owned());
        }
    }
    Ok(value.to_owned())
}

pub fn pin_json(
    content: &mut serde_json::Value,
    opencode: bool,
    path: &Path,
) -> Result<(), String> {
    let (servers, environment) = if opencode {
        ("mcp", "environment")
    } else {
        ("mcpServers", "env")
    };
    let entry = content[servers]
        .get_mut(crate::MCP_CLIENT_ID)
        .ok_or("Missing managed MCP entry.")?;
    if entry.get(environment).is_none() {
        entry[environment] = serde_json::json!({});
    }
    let env = entry[environment]
        .as_object_mut()
        .ok_or("Invalid managed MCP environment.")?;
    if !env.contains_key("CREATOR_WORKS_LAUNCHER_CONFIG") {
        env.insert(
            "CREATOR_WORKS_LAUNCHER_CONFIG".into(),
            physical(path)?.into(),
        );
    }
    Ok(())
}

pub fn pin_toml(content: String, path: &Path) -> Result<String, String> {
    let mut doc = content
        .parse::<toml_edit::Document>()
        .map_err(|_| "Invalid managed MCP TOML.")?;
    let env = doc["mcp_servers"][crate::MCP_CLIENT_ID]["env"]
        .as_table_like_mut()
        .ok_or("Missing managed MCP environment.")?;
    if !env.contains_key("CREATOR_WORKS_LAUNCHER_CONFIG") {
        env.insert(
            "CREATOR_WORKS_LAUNCHER_CONFIG",
            toml_edit::value(physical(path)?),
        );
    }
    Ok(doc.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pins_reviewed_settings_without_replacing_an_explicit_override() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("launcher-config.json");
        std::fs::write(&path, "{}").unwrap();
        for opencode in [false, true] {
            let key = if opencode { "mcp" } else { "mcpServers" };
            let env = if opencode { "environment" } else { "env" };
            let mut doc = serde_json::json!({key:{crate::MCP_CLIENT_ID:{env:{"PRESERVE":"yes"}}}});
            pin_json(&mut doc, opencode, &path).unwrap();
            assert_eq!(
                doc[key][crate::MCP_CLIENT_ID][env]["CREATOR_WORKS_LAUNCHER_CONFIG"],
                physical(&path).unwrap()
            );
            doc[key][crate::MCP_CLIENT_ID][env]["CREATOR_WORKS_LAUNCHER_CONFIG"] =
                "explicit-user-override".into();
            pin_json(&mut doc, opencode, &path).unwrap();
            assert_eq!(
                doc[key][crate::MCP_CLIENT_ID][env]["CREATOR_WORKS_LAUNCHER_CONFIG"],
                "explicit-user-override"
            );
            assert_eq!(doc[key][crate::MCP_CLIENT_ID][env]["PRESERVE"], "yes");
        }
        let content = "# preserved\n[mcp_servers.creator-works.env]\nPRESERVE='yes'\n".to_string();
        let pinned = pin_toml(content, &path).unwrap();
        assert!(pinned.starts_with("# preserved"));
        assert_eq!(pin_toml(pinned.clone(), &path).unwrap(), pinned);
        assert_eq!(std::fs::read_to_string(path).unwrap(), "{}");
    }

    #[test]
    fn refuses_relative_settings_paths_without_writing() {
        assert!(physical(Path::new("relative.json")).is_err());
    }

    #[test]
    fn shared_view_preserves_source_backs_up_updates_and_refuses_external_changes() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.json");
        let initial = br#"{"channels":[],"tool_groups":"all","future":"kept"}"#;
        std::fs::write(&source, initial).unwrap();
        let views = root.path().join("views");
        let shared = snapshot_at(&source, &views).unwrap();
        let original_view = std::fs::read(&shared).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&original_view).unwrap()["tool_groups"],
            "all"
        );
        assert_eq!(std::fs::read(&source).unwrap(), initial);
        assert_eq!(snapshot_at(&source, &views).unwrap(), shared);
        let next = br#"{"channels":[],"tool_groups":"read","future":"kept"}"#;
        std::fs::write(&source, next).unwrap();
        snapshot_at(&source, &views).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&std::fs::read(&shared).unwrap()).unwrap()
                ["tool_groups"],
            "read"
        );
        assert_eq!(
            std::fs::read(
                shared
                    .parent()
                    .unwrap()
                    .join(format!("{:x}.backup.json", Sha256::digest(&original_view)))
            )
            .unwrap(),
            original_view
        );
        std::fs::write(&shared, b"external").unwrap();
        assert!(snapshot_at(&source, &views).is_err());
        assert_eq!(std::fs::read(&shared).unwrap(), b"external");
        assert_eq!(std::fs::read(&source).unwrap(), next);
    }

    #[test]
    fn retained_view_writer_lock_refuses_without_replacing_data() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.json");
        std::fs::write(&source, "{\"channels\":[]}").unwrap();
        let views = root.path().join("views");
        let shared = snapshot_at(&source, &views).unwrap();
        let before = std::fs::read(&shared).unwrap();
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(shared.parent().unwrap().join("view.lock"))
            .unwrap();
        fs2::FileExt::try_lock_exclusive(&lock).unwrap();
        assert!(snapshot_at(&source, &views).is_err());
        assert_eq!(std::fs::read(&shared).unwrap(), before);
    }

    #[test]
    fn review_is_read_only_rejects_stale_source_and_preserves_legacy_until_approval() {
        let root = tempfile::tempdir().unwrap();
        let current = root.path().join("current/launcher-config.json");
        let legacy = root.path().join("legacy.json");
        let views = root.path().join("views");
        std::fs::write(&legacy, br#"{"channels":[],"preference":"original"}"#).unwrap();
        let review = Review::prepare_at(&current, &legacy, &views).unwrap();
        let target = review.path().unwrap();
        assert!(!target.exists());
        assert!(!views.exists());
        std::fs::write(&legacy, br#"{"channels":[],"preference":"changed"}"#).unwrap();
        assert!(review.publish().is_err());
        assert!(!views.exists());
        let review = Review::prepare_at(&current, &legacy, &views).unwrap();
        review.publish().unwrap();
        assert!(!current.exists());
        let view: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&target).unwrap()).unwrap();
        assert_eq!(view["preference"], "changed");
        std::fs::create_dir_all(current.parent().unwrap()).unwrap();
        std::fs::write(&current, br#"{"channels":[],"preference":"current"}"#).unwrap();
        assert!(review.publish().is_err());
        let next = Review::prepare_at(&current, &legacy, &views).unwrap();
        assert_eq!(next.path().unwrap(), target);
        next.publish().unwrap();
        let view: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&target).unwrap()).unwrap();
        assert_eq!(view["preference"], "current");
    }

    #[test]
    fn fresh_profile_can_review_missing_clients_without_creating_settings() {
        let root = tempfile::tempdir().unwrap();
        let current = root.path().join("current/launcher-config.json");
        let legacy = root.path().join("legacy/launcher-config.json");
        let views = root.path().join("views");
        let review = Review::prepare_at(&current, &legacy, &views).unwrap();
        assert!(!review.path().unwrap().exists());
        assert!(review.publish().is_err());
        assert!(!current.exists() && !legacy.exists() && !views.exists());
    }
}
