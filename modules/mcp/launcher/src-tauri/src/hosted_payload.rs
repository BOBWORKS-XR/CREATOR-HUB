//! Writable hosting never falls back to the developer checkout or an old bundle.
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::collections::BTreeMap;
use std::{
    fs::{File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
};

include!(concat!(env!("OUT_DIR"), "/hosted_payload.rs"));

pub struct Root(pub PathBuf, #[cfg(unix)] BTreeMap<String, Vec<u8>>);

#[allow(dead_code)] // Unix acceptance API; production hosting remains gated.
impl Root {
    /// Unix callers must consume these snapshots through the methods below.
    /// The public path is routing metadata, not immutable file-use authority.
    pub fn verified(directory: PathBuf) -> Result<Self, String> {
        Self::with_files(directory, FILES)
    }

    fn with_files(directory: PathBuf, files: &[(&str, &str)]) -> Result<Self, String> {
        #[cfg(unix)]
        let mut snapshots = BTreeMap::new();
        for (name, expected) in files {
            let mut file = open_image(&directory.join(name))?;
            let bytes = read_image(&mut file)?;
            if format!("{:x}", Sha256::digest(&bytes)) != *expected {
                return Err(format!("Hosted payload does not match this MCP build: {name}. No setup operation was started."));
            }
            #[cfg(unix)]
            snapshots.insert((*name).to_owned(), bytes);
        }
        #[cfg(unix)]
        let root = Self(directory, snapshots);
        #[cfg(not(unix))]
        let root = Self(directory);
        Ok(root)
    }

    pub fn read_verified(&self, name: &str) -> Result<Vec<u8>, String> {
        #[cfg(unix)]
        {
            self.1
                .get(name)
                .cloned()
                .ok_or_else(|| "Resource is outside the verified hosted payload.".into())
        }
        #[cfg(windows)]
        {
            let expected = FILES
                .iter()
                .find(|(entry, _)| *entry == name)
                .ok_or("Resource is outside the verified hosted payload.")?
                .1;
            let mut file = open_image(&self.0.join(name))?;
            let bytes = read_image(&mut file)?;
            if format!("{:x}", Sha256::digest(&bytes)) != expected {
                return Err("Hosted payload changed before consumption.".into());
            }
            Ok(bytes)
        }
        #[cfg(not(any(windows, unix)))]
        Err("Verified hosted resources are unsupported on this platform.".into())
    }

    pub fn copy_verified(&self, name: &str, destination: &Path) -> Result<u64, String> {
        let bytes = self.read_verified(name)?;
        std::fs::write(destination, &bytes)
            .map_err(|_| "Cannot write verified hosted resource.")?;
        Ok(bytes.len() as u64)
    }
}

pub fn lock_image(path: &Path) -> Result<(File, String), String> {
    let mut file = open_image(path)?;
    let bytes = read_image(&mut file)?;
    Ok((file, format!("{:x}", Sha256::digest(&bytes))))
}

fn open_image(path: &Path) -> Result<File, String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("Hosted files require absolute paths.".into());
    }
    for ancestor in path.ancestors() {
        match std::fs::symlink_metadata(ancestor) {
            Ok(meta) => {
                let link = meta.file_type().is_symlink();
                #[cfg(windows)]
                let link = {
                    use std::os::windows::fs::MetadataExt;
                    link || meta.file_attributes() & 0x400 != 0
                };
                if link {
                    return Err("Hosted files cannot use symbolic links or junctions.".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Cannot inspect hosted file path.".into()),
        }
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1);
    }
    let file = options
        .open(path)
        .map_err(|_| format!("Cannot open required hosted file: {}", path.display()))?;
    let metadata = file.metadata().map_err(|_| "Cannot inspect hosted file.")?;
    if !metadata.is_file() || metadata.len() > 128 * 1024 * 1024 {
        return Err("Hosted file is invalid or exceeds the size limit.".into());
    }
    Ok(file)
}

fn read_image(file: &mut File) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    file.take(128 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot verify hosted file.")?;
    if bytes.len() > 128 * 1024 * 1024 {
        return Err("Hosted file grew beyond its size limit during verification.".into());
    }
    Ok(bytes)
}

#[allow(dead_code)]
pub fn lock(directory: &Path) -> Result<Vec<File>, String> {
    verify(directory, FILES)
}

#[allow(dead_code)]
fn verify(directory: &Path, files: &[(&str, &str)]) -> Result<Vec<File>, String> {
    files.iter().map(|(name, expected)| {
        let (file, hash) = lock_image(&directory.join(name))?;
        if hash != *expected { return Err(format!("Hosted payload does not match this MCP build: {name}. No setup operation was started.")); }
        Ok(file)
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn snapshots_not_advisory_locks_bind_exact_resource_consumption() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().canonicalize().unwrap();
        let path = directory.join("bridge.cs");
        let bytes = b"exact approved bridge bytes";
        std::fs::write(&path, bytes).unwrap();
        let hash = format!("{:x}", Sha256::digest(bytes));
        let expected = [("bridge.cs", hash.as_str())];
        let root = Root::with_files(directory.clone(), &expected).unwrap();
        // Non-cooperating writes really succeed on Unix. They cannot modify
        // the buffer that the installer consumes through copy_verified.
        std::fs::write(&path, b"exact approved bridge byteX").unwrap();
        assert!(Root::with_files(directory.clone(), &expected).is_err());
        let replacement = directory.join("replacement");
        std::fs::write(&replacement, b"replacement executable bytes").unwrap();
        std::fs::rename(&replacement, &path).unwrap();
        let target = directory.join("installed.cs");
        root.copy_verified("bridge.cs", &target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
        assert!(root.read_verified("../bridge.cs").is_err());
        assert!(root.read_verified("unlisted").is_err());
        assert!(Root::with_files(directory, &expected).is_err());
    }
    #[test]
    fn missing_mismatched_and_changed_payloads_are_not_accepted() {
        let root = std::env::temp_dir().join(format!("creator-payload-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        // macOS temp_dir can contain the system /var -> /private/var link.
        let root = root.canonicalize().unwrap();
        let path = root.join("server.mjs");
        let hash = format!("{:x}", Sha256::digest(b"fixture"));
        let expected = [("server.mjs", hash.as_str())];
        assert!(verify(&root, &expected).is_err());
        std::fs::write(&path, b"wrong").unwrap();
        assert!(verify(&root, &expected).is_err());
        std::fs::write(&path, b"fixture").unwrap();
        let handles = verify(&root, &expected).unwrap();
        #[cfg(windows)]
        {
            assert!(std::fs::write(&path, b"changed").is_err());
            assert!(std::fs::remove_file(&path).is_err());
        }
        drop(handles);
        std::fs::write(&path, b"changed").unwrap();
        assert!(verify(&root, &expected).is_err());
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&root).unwrap();
    }
}
