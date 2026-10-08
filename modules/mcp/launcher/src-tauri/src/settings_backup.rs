//! Retained before-images for explicit built-in settings saves, not a migration journal.
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, Write},
    path::{Path, PathBuf},
};

const DIRECTORY: &str = ".creator-hub-settings-backups";
const MAX_BYTES: u64 = 2 * 1024 * 1024;

fn reject_links(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                let link = metadata.file_type().is_symlink();
                #[cfg(windows)]
                let link = {
                    use std::os::windows::fs::MetadataExt;
                    link || metadata.file_attributes() & 0x400 != 0
                };
                if link {
                    return Err(
                        "Protected settings paths cannot contain links or junctions.".into(),
                    );
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Cannot inspect protected settings paths.".into()),
        }
    }
    Ok(())
}

fn protected_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
        options.share_mode(FILE_SHARE_READ);
    }
    options
}

fn open_existing(path: &Path, writable: bool) -> Result<Option<File>, String> {
    reject_links(path)?;
    match protected_options().write(writable).open(path) {
        Ok(file) => Ok(Some(file)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => Err("Cannot reserve settings for a protected before-image.".into()),
    }
}

fn read(file: &mut File) -> Result<Vec<u8>, String> {
    if !file
        .metadata()
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() <= MAX_BYTES)
    {
        return Err("Settings backup requires a regular file of at most 2 MiB.".into());
    }
    file.rewind()
        .map_err(|_| "Cannot read the complete settings before-image.")?;
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read the complete settings before-image.")?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Settings changed size during backup. Nothing was saved.".into());
    }
    Ok(bytes)
}

pub fn retain(path: &Path) -> Result<(), String> {
    retain_with_sync(path, File::sync_all)
}

fn retain_with_sync(
    path: &Path,
    mut sync: impl FnMut(&File) -> io::Result<()>,
) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Protected settings saves require an absolute path.".into());
    }
    let Some(mut source) = open_existing(path, false)? else {
        return Ok(());
    };
    let bytes = read(&mut source)?;
    let parent = path.parent().ok_or("Settings have no parent folder.")?;
    let directory = parent.join(DIRECTORY);
    reject_links(&directory)?;
    #[allow(unused_mut)]
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(&directory) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err("Cannot create retained settings backups. Nothing was saved.".into()),
    }
    reject_links(&directory)?;
    let metadata = fs::metadata(&directory).map_err(|_| "Cannot inspect retained backups.")?;
    if !metadata.is_dir() {
        return Err("The retained backup location is not a folder. Nothing was saved.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(
                "Settings backup folder permissions are not private. Nothing was saved.".into(),
            );
        }
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid settings file name.")?;
    let backup = directory.join(format!("{name}.{:x}.bak", Sha256::digest(&bytes)));
    reject_links(&backup)?;
    let mut file = match open_existing(&backup, true)? {
        Some(file) => file,
        None => {
            let mut options = protected_options();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options
                .open(&backup)
                .map_err(|_| "Cannot reserve a retained backup. Nothing was saved.")?;
            file.write_all(&bytes)
                .map_err(|_| "The settings backup could not be written. Nothing was saved.")?;
            file
        }
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let metadata = file
            .metadata()
            .map_err(|_| "Cannot inspect retained backup permissions.")?;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(
                "Settings backup file permissions are not private. Nothing was saved.".into(),
            );
        }
    }
    if read(&mut file)? != bytes {
        return Err("A retained backup changed. Inspect it before saving settings.".into());
    }
    // Matching bytes can remain after a failed flush; reuse must finish durability too.
    sync(&file).map_err(|_| "The settings backup could not be flushed. Nothing was saved.")?;
    #[cfg(unix)]
    {
        File::open(&directory)
            .and_then(|file| sync(&file))
            .and_then(|_| File::open(parent).and_then(|file| sync(&file)))
            .map_err(|_| {
                "The retained backup directory could not be flushed. Nothing was saved."
            })?;
    }
    drop(file);
    drop(source);
    Ok(())
}

pub(crate) struct StagedFile {
    path: PathBuf,
    published: bool,
}

impl StagedFile {
    pub(crate) fn write(
        path: &Path,
        write: impl FnOnce(&mut File) -> io::Result<()>,
    ) -> io::Result<Self> {
        let mut options = protected_options();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(path)?;
        // Arm cleanup only after reserving this path; collisions are never ours.
        let staged = Self {
            path: path.to_owned(),
            published: false,
        };
        let result = write(&mut file);
        drop(file);
        result?;
        Ok(staged)
    }

    pub(crate) fn publish(
        mut self,
        publish: impl FnOnce(&Path) -> io::Result<()>,
    ) -> io::Result<()> {
        publish(&self.path)?;
        self.published = true;
        Ok(())
    }
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        if !self.published {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_settings_do_not_create_backups_and_relative_paths_are_rejected() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        retain(&root.join("missing.json")).unwrap();
        assert_eq!(fs::read_dir(root).unwrap().count(), 0);
        assert!(retain(Path::new("relative.json")).is_err());
    }

    #[test]
    fn backups_retain_exact_bytes_deduplicate_and_never_overwrite_old_versions() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        let path = root.join("launcher-config.json");
        let original = b"{ \"unknown\": [1, true] }\r\n";
        fs::write(&path, original).unwrap();
        retain(&path).unwrap();
        retain(&path).unwrap();
        let directory = root.join(DIRECTORY);
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        let backup = fs::read_dir(&directory)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(fs::read(&backup).unwrap(), original);
        fs::write(&path, b"next version").unwrap();
        retain(&path).unwrap();
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 2);
        assert_eq!(fs::read(&backup).unwrap(), original);
        assert_eq!(fs::read(&path).unwrap(), b"next version");
    }

    #[test]
    fn matching_backup_retries_failed_file_sync_before_succeeding() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        let path = root.join("config.json");
        fs::write(&path, b"original").unwrap();
        for _ in 0..2 {
            let mut calls = 0;
            assert!(retain_with_sync(&path, |_| {
                calls += 1;
                Err(io::Error::other("injected file sync failure"))
            })
            .is_err());
            assert_eq!(calls, 1);
            assert_eq!(fs::read(&path).unwrap(), b"original");
            let backup = fs::read_dir(root.join(DIRECTORY))
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path();
            assert_eq!(fs::read(backup).unwrap(), b"original");
        }
        let mut calls = 0;
        retain_with_sync(&path, |file| {
            calls += 1;
            file.sync_all()
        })
        .unwrap();
        assert!(calls >= 1);
        assert_eq!(fs::read_dir(root.join(DIRECTORY)).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn matching_backup_retries_failed_directory_sync() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        let path = root.join("config.json");
        fs::write(&path, b"original").unwrap();
        for failed_call in [2, 3] {
            for _ in 0..2 {
                let mut calls = 0;
                assert!(retain_with_sync(&path, |file| {
                    calls += 1;
                    if calls == failed_call {
                        Err(io::Error::other("injected directory sync failure"))
                    } else {
                        file.sync_all()
                    }
                })
                .is_err());
                assert_eq!(calls, failed_call);
                assert_eq!(fs::read(&path).unwrap(), b"original");
            }
        }
        let mut calls = 0;
        retain_with_sync(&path, |file| {
            calls += 1;
            file.sync_all()
        })
        .unwrap();
        assert_eq!(calls, 3);
    }

    #[test]
    fn partial_stage_and_sync_failures_clean_only_the_owned_temporary_file() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        let path = root.join("config.json");
        fs::write(&path, b"original").unwrap();
        retain(&path).unwrap();
        let backup = fs::read_dir(root.join(DIRECTORY))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        for partial in [true, false] {
            let temporary = root.join("owned.tmp");
            let result = StagedFile::write(&temporary, |file| {
                if partial {
                    file.write_all(b"new")?;
                    Err(io::Error::other("injected partial write failure"))
                } else {
                    file.write_all(b"new complete settings")?;
                    Err(io::Error::other("injected stage sync failure"))
                }
            });
            assert!(result.is_err());
            assert!(!temporary.exists());
            assert_eq!(fs::read(&path).unwrap(), b"original");
            assert_eq!(fs::read(&backup).unwrap(), b"original");
        }
    }

    #[test]
    fn staged_file_collision_does_not_write_or_remove_the_existing_file() {
        let fixture = tempfile::tempdir().unwrap();
        let temporary = fixture.path().join("collision.tmp");
        fs::write(&temporary, b"not ours").unwrap();
        let mut called = false;
        assert!(StagedFile::write(&temporary, |_| {
            called = true;
            Ok(())
        })
        .is_err());
        assert!(!called);
        assert_eq!(fs::read(&temporary).unwrap(), b"not ours");
    }

    #[test]
    fn staged_publication_failure_preserves_destination_and_cleans_temporary() {
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path().join("config.json");
        let temporary = fixture.path().join("owned.tmp");
        fs::write(&path, b"original").unwrap();
        let staged = StagedFile::write(&temporary, |file| {
            file.write_all(b"new complete settings")?;
            file.sync_all()
        })
        .unwrap();
        assert!(staged
            .publish(|_| Err(io::Error::other("injected publish failure")))
            .is_err());
        assert!(!temporary.exists());
        assert_eq!(fs::read(&path).unwrap(), b"original");
    }

    #[test]
    fn successful_publication_does_not_clean_a_recreated_temporary_path() {
        let fixture = tempfile::tempdir().unwrap();
        let destination = fixture.path().join("published.json");
        let temporary = fixture.path().join("owned.tmp");
        let staged = StagedFile::write(&temporary, |file| {
            file.write_all(b"published settings")?;
            file.sync_all()
        })
        .unwrap();
        staged
            .publish(|path| {
                fs::rename(path, &destination)?;
                fs::write(path, b"new owner")
            })
            .unwrap();
        assert_eq!(fs::read(destination).unwrap(), b"published settings");
        assert_eq!(fs::read(temporary).unwrap(), b"new owner");
    }

    #[cfg(windows)]
    #[test]
    fn windows_source_and_backup_handles_stay_protected_through_sync() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        let path = root.join("config.json");
        let original = b"original";
        fs::write(&path, original).unwrap();
        let backup = root
            .join(DIRECTORY)
            .join(format!("config.json.{:x}.bak", Sha256::digest(original)));
        for _ in 0..2 {
            retain_with_sync(&path, |file| {
                for protected in [&path, &backup] {
                    assert!(OpenOptions::new().write(true).open(protected).is_err());
                    assert!(fs::remove_file(protected).is_err());
                    assert_eq!(fs::read(protected).unwrap(), original);
                }
                file.sync_all()
            })
            .unwrap();
        }
        assert!(OpenOptions::new().write(true).open(&path).is_ok());
        assert!(OpenOptions::new().write(true).open(&backup).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn windows_active_source_or_backup_writer_prevents_retention() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        let path = root.join("config.json");
        fs::write(&path, b"original").unwrap();
        let writer = OpenOptions::new().write(true).open(&path).unwrap();
        assert!(retain(&path).is_err());
        assert!(!root.join(DIRECTORY).exists());
        drop(writer);
        retain(&path).unwrap();
        let backup = fs::read_dir(root.join(DIRECTORY))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let writer = OpenOptions::new().write(true).open(&backup).unwrap();
        assert!(retain(&path).is_err());
        drop(writer);
        retain(&path).unwrap();
        assert_eq!(fs::read(path).unwrap(), b"original");
        assert_eq!(fs::read(backup).unwrap(), b"original");
    }

    #[cfg(unix)]
    #[test]
    fn reused_backup_with_public_file_permissions_is_refused_without_chmod() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        let path = root.join("config.json");
        fs::write(&path, b"original").unwrap();
        retain(&path).unwrap();
        let backup = fs::read_dir(root.join(DIRECTORY))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        fs::set_permissions(&backup, fs::Permissions::from_mode(0o644)).unwrap();
        let mut calls = 0;
        assert!(retain_with_sync(&path, |_| {
            calls += 1;
            Ok(())
        })
        .is_err());
        assert_eq!(calls, 0);
        assert_eq!(
            fs::metadata(&backup).unwrap().permissions().mode() & 0o777,
            0o644
        );
        assert_eq!(fs::read(&backup).unwrap(), b"original");
        assert_eq!(fs::read(path).unwrap(), b"original");
    }

    #[test]
    fn corrupt_backup_and_unusable_destination_refuse_without_modifying_original() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        let path = root.join("config.toml");
        fs::write(&path, b"original").unwrap();
        fs::write(root.join(DIRECTORY), b"not a folder").unwrap();
        assert!(retain(&path).is_err());
        fs::remove_file(root.join(DIRECTORY)).unwrap();
        retain(&path).unwrap();
        let backup = fs::read_dir(root.join(DIRECTORY))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        fs::write(&backup, b"corrupt").unwrap();
        assert!(retain(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"original");
        assert_eq!(fs::read(&backup).unwrap(), b"corrupt");
    }

    #[cfg(unix)]
    #[test]
    fn backups_are_private_and_links_are_not_followed() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        let path = root.join("config.json");
        fs::write(&path, b"private fixture").unwrap();
        retain(&path).unwrap();
        let directory = root.join(DIRECTORY);
        assert_eq!(
            fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let backup = fs::read_dir(&directory)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(
            fs::metadata(&backup).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let link = root.join("alias.json");
        symlink(&path, &link).unwrap();
        assert!(retain(&link).is_err());
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(retain(&path).is_err());
        assert_eq!(fs::read(path).unwrap(), b"private fixture");
    }
}
