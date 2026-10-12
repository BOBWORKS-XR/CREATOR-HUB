//! Signed archive staging and an atomic macOS application replacement.
use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
#[cfg(target_os = "macos")]
use std::path::PathBuf;
use std::{
    fs,
    io::Cursor,
    path::{Component, Path},
};

const APP: &str = "Creator Hub.app";
const MAX_UNPACKED: u64 = 1024 * 1024 * 1024;

fn member(path: &Path) -> Result<(), String> {
    let mut parts = path.components();
    if parts.next() != Some(Component::Normal(APP.as_ref()))
        || parts.any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("The signed Hub archive contains an unexpected application path.".into());
    }
    Ok(())
}

fn prepare(
    bytes: &[u8],
    parent: &Path,
    executable_sha256: &str,
) -> Result<tempfile::TempDir, String> {
    crate::platform::reject_links(parent)?;
    let staged = tempfile::Builder::new().prefix(".creator-hub-update-").tempdir_in(parent)
        .map_err(|_| "Cannot stage the Hub update in Applications. The installed app was not changed. Check folder permissions and free space.")?;
    let mut archive = tar::Archive::new(GzDecoder::new(Cursor::new(bytes)));
    let mut size = 0u64;
    let mut seen = std::collections::HashSet::new();
    for (index, entry) in archive
        .entries()
        .map_err(|_| "Invalid signed Hub archive.")?
        .enumerate()
    {
        if index >= 8192 {
            return Err("The Hub archive has too many entries.".into());
        }
        let mut entry = entry.map_err(|_| "Cannot read the signed Hub archive.")?;
        let path = entry
            .path()
            .map_err(|_| "Invalid Hub archive path.")?
            .into_owned();
        member(&path)?;
        if !seen.insert(path.clone()) {
            return Err("The Hub archive contains duplicate paths.".into());
        }
        let kind = entry.header().entry_type();
        if !(kind.is_file() || kind.is_dir()) {
            return Err("Hub update archives cannot contain links or special files.".into());
        }
        size = size
            .checked_add(entry.size())
            .ok_or("Hub archive size overflow.")?;
        if size > MAX_UNPACKED {
            return Err("The Hub archive exceeds its unpacked size limit.".into());
        }
        entry
            .unpack_in(staged.path())
            .map_err(|_| "Cannot extract the Hub update. The installed app was not changed.")?;
    }
    let app = staged.path().join(APP);
    let binary = app.join("Contents/MacOS/creator-hub");
    let bytes = crate::manager::bounded_read(&binary, crate::catalog::MAX_ARTIFACT)?;
    if !crate::catalog::hash_valid(executable_sha256)
        || format!("{:x}", Sha256::digest(&bytes)) != executable_sha256
    {
        return Err("The new Hub executable does not match its signed descriptor.".into());
    }
    if !fs::metadata(app.join("Contents/Info.plist")).is_ok_and(|m| m.is_file()) {
        return Err("The Hub update has no application metadata.".into());
    }
    // Flush the new files before publishing their directory entry.
    for entry in seen {
        let file = staged.path().join(entry);
        if file.is_file() {
            #[cfg(unix)]
            let flushed = fs::File::open(&file).and_then(|f| f.sync_all());
            #[cfg(not(unix))]
            let flushed = fs::OpenOptions::new()
                .write(true)
                .open(&file)
                .and_then(|f| f.sync_all());
            flushed.map_err(|_| "Cannot flush the staged Hub update.")?;
        }
    }
    Ok(staged)
}

#[cfg(target_os = "macos")]
fn exchange(current: &Path, staged: &Path) -> Result<(), String> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let current =
        CString::new(current.as_os_str().as_bytes()).map_err(|_| "Invalid installed Hub path.")?;
    let staged =
        CString::new(staged.as_os_str().as_bytes()).map_err(|_| "Invalid staged Hub path.")?;
    // Both directories are on the same volume. RENAME_SWAP has no interval in
    // which the installed app is absent, and a failed call leaves both intact.
    if unsafe { libc::renamex_np(current.as_ptr(), staged.as_ptr(), libc::RENAME_SWAP) } != 0 {
        return Err("macOS refused the atomic Hub replacement. The installed app was kept. Check Applications permissions and retry.".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn install(
    bytes: &[u8],
    installed_exe: &Path,
    executable_sha256: &str,
    before_publish: impl FnOnce() -> Result<(), String>,
) -> Result<PathBuf, String> {
    crate::platform::reject_links(installed_exe)?;
    let app = installed_exe
        .ancestors()
        .nth(3)
        .ok_or("Invalid installed Hub application.")?;
    if app.file_name().is_none_or(|name| name != APP) {
        return Err("Unexpected Hub application name.".into());
    }
    let parent = app.parent().ok_or("Invalid Applications directory.")?;
    let staged = prepare(bytes, parent, executable_sha256)?;
    let new_app = staged.path().join(APP);
    let verified = std::process::Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(&new_app)
        .output()
        .map_err(|_| "Cannot verify the staged macOS Hub signature.")?;
    if !verified.status.success() {
        return Err(
            "The staged macOS app failed code-signature verification. The installed app was kept."
                .into(),
        );
    }
    before_publish()?;
    // The directory becomes the old-app backup after the swap; never let a
    // TempDir destructor remove it on either success or an uncertain outcome.
    let backup = staged.keep();
    exchange(app, &backup.join(APP))?;
    fs::File::open(parent).and_then(|f| f.sync_all())
        .map_err(|_| "The Hub app was replaced, but its directory could not be flushed. Restart the installed app; the old copy was retained.")?;
    Ok(backup.join(APP))
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    fn archive(files: &[(&str, &[u8])]) -> Vec<u8> {
        let encoder = GzEncoder::new(Vec::new(), Compression::default());
        let mut tar = tar::Builder::new(encoder);
        for (path, bytes) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            tar.append_data(&mut header, path, *bytes).unwrap();
        }
        tar.into_inner().unwrap().finish().unwrap()
    }
    fn payload() -> Vec<u8> {
        archive(&[
            ("Creator Hub.app/Contents/MacOS/creator-hub", b"new"),
            ("Creator Hub.app/Contents/Info.plist", b"fixture"),
        ])
    }
    #[test]
    fn valid_archive_is_staged_beside_old_app_without_modifying_it() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join(APP)).unwrap();
        fs::write(root.path().join(APP).join("old"), b"preserved").unwrap();
        let stage = prepare(
            &payload(),
            root.path(),
            &format!("{:x}", Sha256::digest(b"new")),
        )
        .unwrap();
        assert_eq!(
            fs::read(stage.path().join(APP).join("Contents/MacOS/creator-hub")).unwrap(),
            b"new"
        );
        assert_eq!(
            fs::read(root.path().join(APP).join("old")).unwrap(),
            b"preserved"
        );
    }

    #[cfg(unix)]
    #[test]
    fn valid_read_only_resource_is_staged_without_changing_its_mode() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let mut tar = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::default()));
        for (name, bytes, mode) in [
            (
                "Creator Hub.app/Contents/MacOS/creator-hub",
                b"new".as_slice(),
                0o755,
            ),
            (
                "Creator Hub.app/Contents/Info.plist",
                b"fixture".as_slice(),
                0o444,
            ),
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(mode);
            header.set_cksum();
            tar.append_data(&mut header, name, bytes).unwrap();
        }
        let bytes = tar.into_inner().unwrap().finish().unwrap();
        let stage = prepare(
            &bytes,
            root.path(),
            &format!("{:x}", Sha256::digest(b"new")),
        )
        .unwrap();
        assert_eq!(
            fs::metadata(stage.path().join(APP).join("Contents/Info.plist"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o444
        );
    }
    #[test]
    fn malformed_wrong_identity_missing_metadata_and_duplicate_entries_leave_old_app() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("old"), b"preserved").unwrap();
        let hash = format!("{:x}", Sha256::digest(b"new"));
        for data in [
            b"bad".to_vec(),
            archive(&[("Other.app/Contents/MacOS/creator-hub", b"new")]),
            archive(&[("Creator Hub.app/Contents/MacOS/creator-hub", b"new")]),
            archive(&[
                ("Creator Hub.app/Contents/MacOS/creator-hub", b"new"),
                ("Creator Hub.app/Contents/MacOS/creator-hub", b"new"),
            ]),
        ] {
            assert!(prepare(&data, root.path(), &hash).is_err());
            assert_eq!(fs::read(root.path().join("old")).unwrap(), b"preserved");
        }
        assert!(prepare(&payload(), root.path(), &"a".repeat(64)).is_err());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }
    #[test]
    fn traversal_absolute_paths_and_other_bundle_roots_are_refused() {
        for path in [
            "/Creator Hub.app/file",
            "Other.app/file",
            "Creator Hub.app/../outside",
            "Creator Hub.app/a/../../outside",
        ] {
            assert!(member(Path::new(path)).is_err());
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn native_swap_preserves_both_complete_apps_and_failed_swap_changes_neither() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("old.app");
        let new = root.path().join("new.app");
        fs::create_dir(&old).unwrap();
        fs::create_dir(&new).unwrap();
        fs::write(old.join("marker"), b"old").unwrap();
        fs::write(new.join("marker"), b"new").unwrap();
        assert!(exchange(&old, &root.path().join("missing.app")).is_err());
        assert_eq!(fs::read(old.join("marker")).unwrap(), b"old");
        assert_eq!(fs::read(new.join("marker")).unwrap(), b"new");
        exchange(&old, &new).unwrap();
        assert_eq!(fs::read(old.join("marker")).unwrap(), b"new");
        assert_eq!(fs::read(new.join("marker")).unwrap(), b"old");
    }
}
