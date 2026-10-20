//! A startup fingerprint refuses updates after the installed target is replaced.
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Debug, PartialEq, Eq)]
struct Fingerprint {
    length: u64,
    hash: String,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

fn fingerprint(path: &Path) -> Result<Fingerprint, String> {
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    crate::platform::reject_links(path)?;
    let mut file = File::open(path).map_err(|_| "The original Hub installation is unavailable.")?;
    let initial = file
        .metadata()
        .map_err(|_| "Cannot inspect the original Hub installation.")?;
    if !initial.is_file() || initial.len() > crate::catalog::MAX_ARTIFACT {
        return Err("Invalid installed Hub executable or package.".into());
    }
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    let mut length = 0u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| "Cannot fingerprint this Hub installation.")?;
        if read == 0 {
            break;
        }
        length = length
            .checked_add(read as u64)
            .ok_or("Installed Hub size overflow.")?;
        if length > crate::catalog::MAX_ARTIFACT {
            return Err("The installed Hub changed while checking its identity.".into());
        }
        hash.update(&buffer[..read]);
    }
    let final_meta = file
        .metadata()
        .map_err(|_| "Cannot recheck this Hub installation.")?;
    let current =
        fs::metadata(path).map_err(|_| "This Hub installation was moved while it was running.")?;
    if initial.len() != length
        || final_meta.len() != length
        || initial.modified().ok() != final_meta.modified().ok()
        || current.len() != length
    {
        return Err("This Hub installation changed while its identity was checked.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if (initial.dev(), initial.ino()) != (current.dev(), current.ino()) {
            return Err("This Hub installation was replaced while it was running.".into());
        }
    }
    Ok(Fingerprint {
        length,
        hash: format!("{:x}", hash.finalize()),
        #[cfg(unix)]
        device: initial.dev(),
        #[cfg(unix)]
        inode: initial.ino(),
    })
}

#[derive(Debug)]
pub struct Identity {
    target: PathBuf,
    target_fingerprint: Fingerprint,
    executable: PathBuf,
    executable_fingerprint: Fingerprint,
    #[cfg(unix)]
    bundle: Option<(PathBuf, u64, u64)>,
}

impl Identity {
    pub fn capture(target: &Path, executable: &Path) -> Result<Self, String> {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        #[cfg(target_os = "linux")]
        {
            let running = fs::metadata("/proc/self/exe")
                .map_err(|_| "Cannot check the running Hub image.")?;
            let named =
                fs::metadata(executable).map_err(|_| "Cannot check the named Hub image.")?;
            if (running.dev(), running.ino()) != (named.dev(), named.ino()) {
                return Err(
                    "The running Hub image no longer matches its installed pathname.".into(),
                );
            }
        }
        #[cfg(unix)]
        let bundle = if cfg!(target_os = "macos") {
            let path = executable
                .ancestors()
                .nth(3)
                .ok_or("Invalid installed Hub bundle.")?
                .to_path_buf();
            let metadata =
                fs::metadata(&path).map_err(|_| "Cannot inspect the original Hub bundle.")?;
            Some((path, metadata.dev(), metadata.ino()))
        } else {
            None
        };
        Ok(Self {
            target: target.into(),
            target_fingerprint: fingerprint(target)?,
            executable: executable.into(),
            executable_fingerprint: fingerprint(executable)?,
            #[cfg(unix)]
            bundle,
        })
    }

    pub fn verify(&self, target: &Path) -> Result<(), String> {
        if target != self.target
            || fingerprint(target)? != self.target_fingerprint
            || fingerprint(&self.executable)? != self.executable_fingerprint
        {
            return Err("Another Hub copy replaced this running installation. Restart the installed app before updating; no installer was started.".into());
        }
        #[cfg(unix)]
        if let Some((path, device, inode)) = &self.bundle {
            use std::os::unix::fs::MetadataExt;
            let metadata = fs::metadata(path).map_err(|_| "The running Hub bundle was moved.")?;
            if (*device, *inode) != (metadata.dev(), metadata.ino()) {
                return Err("The running Hub bundle was replaced. Restart the installed app before updating.".into());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(not(target_os = "linux"))]
    #[test]
    fn renamed_target_with_another_file_at_the_same_path_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let app = root.path().join("Hub.app/Contents/MacOS/hub");
        fs::create_dir_all(app.parent().unwrap()).unwrap();
        let target = root.path().join("Hub.AppImage");
        fs::write(&target, b"original").unwrap();
        fs::write(&app, b"running").unwrap();
        let identity = Identity::capture(&target, &app).unwrap();
        identity.verify(&target).unwrap();
        fs::rename(&target, root.path().join("kept.AppImage")).unwrap();
        fs::write(&target, b"another!").unwrap();
        assert!(identity.verify(&target).is_err());
        assert_eq!(
            fs::read(root.path().join("kept.AppImage")).unwrap(),
            b"original"
        );
        assert_eq!(fs::read(&target).unwrap(), b"another!");
    }
    #[test]
    fn fingerprint_refuses_in_place_changes_without_touching_the_file() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("Hub.AppImage");
        fs::write(&path, b"original").unwrap();
        let before = fingerprint(&path).unwrap();
        fs::write(&path, b"modified").unwrap();
        assert_ne!(fingerprint(&path).unwrap(), before);
        assert_eq!(fs::read(&path).unwrap(), b"modified");
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn native_linux_target_replacement_is_refused_against_the_actual_running_executable() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("Hub.AppImage");
        fs::write(&path, b"original").unwrap();
        let identity = Identity::capture(&path, &std::env::current_exe().unwrap()).unwrap();
        identity.verify(&path).unwrap();
        fs::rename(&path, root.path().join("kept.AppImage")).unwrap();
        fs::write(&path, b"another!").unwrap();
        assert!(identity.verify(&path).is_err());
    }
}
