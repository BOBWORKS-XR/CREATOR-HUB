#![allow(dead_code)]
#[path = "../../../../../modules/mcp/launcher/src-tauri/src/hosted_payload.rs"]
mod hosted_payload;

#[cfg(test)]
mod tests {
    use super::hosted_payload::Root;
    use std::{fs, path::PathBuf};

    const RESOURCES: &[(&str, &[u8])] = &[
        ("runtime/node", b"fixture-node"),
        ("creator-works-mcp.mjs", b"fixture-server"),
        (
            "unity-extension/Editor/BanterMCPBridge.cs",
            b"fixture-bridge",
        ),
        (
            "unity-extension/Editor/CreatorWorksMCPLogo.png",
            b"fixture-logo",
        ),
    ];

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().canonicalize().unwrap();
        for (name, bytes) in RESOURCES {
            let path = directory.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }
        (temporary, directory)
    }

    #[test]
    fn public_root_requires_all_four_exact_resources_before_binding() {
        let (_temporary, directory) = fixture();
        assert_eq!(super::hosted_payload::FILES.len(), RESOURCES.len());
        for (name, bytes) in RESOURCES {
            let path = directory.join(name);
            fs::remove_file(&path).unwrap();
            assert!(Root::verified(directory.clone()).is_err(), "missing {name}");
            fs::write(&path, bytes).unwrap();
            Root::verified(directory.clone()).unwrap();
            let mut changed = bytes.to_vec();
            changed[0] ^= 1;
            fs::write(&path, changed).unwrap();
            assert!(Root::verified(directory.clone()).is_err(), "changed {name}");
            fs::write(path, bytes).unwrap();
        }
    }

    #[test]
    fn public_reads_and_copies_share_verified_bytes_and_refuse_unlisted_resources() {
        let (_temporary, directory) = fixture();
        let root = Root::verified(directory.clone()).unwrap();
        for (index, (name, bytes)) in RESOURCES.iter().enumerate() {
            let mut returned = root.read_verified(name).unwrap();
            assert_eq!(returned, *bytes);
            returned[0] ^= 1;
            assert_eq!(root.read_verified(name).unwrap(), *bytes);
            let destination = directory.join(format!("copied-{index}"));
            assert_eq!(
                root.copy_verified(name, &destination).unwrap(),
                bytes.len() as u64
            );
            assert_eq!(fs::read(destination).unwrap(), *bytes);
        }
        for name in [
            "../runtime/node",
            "runtime/../runtime/node",
            "unlisted",
            "/runtime/node",
        ] {
            let destination = directory.join("must-not-exist");
            assert!(root.read_verified(name).is_err());
            assert!(root.copy_verified(name, &destination).is_err());
            assert!(!destination.exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_public_consumption_survives_writes_replacements_links_and_metadata_changes() {
        use std::os::unix::fs::symlink;
        let (_temporary, directory) = fixture();
        let mut root = Root::verified(directory.clone()).unwrap();
        for (index, (name, bytes)) in RESOURCES.iter().enumerate() {
            let path = directory.join(name);
            fs::write(&path, b"unapproved in-place bytes").unwrap();
            assert_eq!(root.read_verified(name).unwrap(), *bytes);
            let replacement = directory.join(format!("replacement-{index}"));
            fs::write(&replacement, b"unapproved replacement bytes").unwrap();
            fs::rename(&replacement, &path).unwrap();
            assert_eq!(root.read_verified(name).unwrap(), *bytes);
            fs::remove_file(&path).unwrap();
            fs::write(&replacement, b"unapproved linked bytes").unwrap();
            symlink(&replacement, &path).unwrap();
            let destination = directory.join(format!("installed-{index}"));
            root.copy_verified(name, &destination).unwrap();
            assert_eq!(fs::read(destination).unwrap(), *bytes);
        }
        assert!(Root::verified(directory).is_err());
        let (_alternate, metadata) = fixture();
        root.0 = metadata;
        for (name, bytes) in RESOURCES {
            fs::write(root.0.join(name), b"routing path is not resource authority").unwrap();
            assert_eq!(root.read_verified(name).unwrap(), *bytes);
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_public_binding_refuses_linked_resources_and_parents() {
        use std::os::unix::fs::symlink;
        for (name, bytes) in RESOURCES {
            let (_temporary, directory) = fixture();
            let original = directory.join("original");
            fs::write(&original, bytes).unwrap();
            let path = directory.join(name);
            fs::remove_file(&path).unwrap();
            symlink(&original, &path).unwrap();
            assert!(Root::verified(directory).is_err(), "linked {name}");
        }
        let (_temporary, directory) = fixture();
        let linked = directory.join("linked-parent");
        symlink(&directory, &linked).unwrap();
        assert!(Root::verified(linked).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_public_consumption_rechecks_build_hashes_after_mutation() {
        let (_temporary, directory) = fixture();
        let root = Root::verified(directory.clone()).unwrap();
        for (name, bytes) in RESOURCES {
            let path = directory.join(name);
            fs::write(&path, b"unapproved bytes").unwrap();
            assert!(root.read_verified(name).is_err());
            let destination = directory.join("must-not-exist");
            assert!(root.copy_verified(name, &destination).is_err());
            assert!(!destination.exists());
            fs::write(path, bytes).unwrap();
        }
    }
}
