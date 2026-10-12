//! Retain the first signed protocol-1 router independently of replaceable Hub resources.
use super::*;

const ROUTER_PRODUCT: &str = "com.creatorworks.hub.mcp-router";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Identity {
    schema_version: u32,
    product: String,
    platform: String,
    arch: String,
    protocol: u32,
    sha256: String,
}

pub struct Router {
    pub command: PathBuf,
    // A caller keeps the verified Windows command image reserved through use.
    _image: File,
}

fn name() -> &'static str {
    if cfg!(windows) {
        "creator-hub-mcp-router.exe"
    } else {
        "creator-hub-mcp-router"
    }
}

impl Store {
    fn router_identity(&self, bytes: &[u8], signature: &[u8]) -> Result<Identity, String> {
        if bytes.len() as u64 > MAX_DESCRIPTOR || signature.len() > 4096 {
            return Err("Router metadata exceeds its size limit.".into());
        }
        let signature = Signature::decode(
            std::str::from_utf8(signature).map_err(|_| "Invalid router signature encoding.")?,
        )
        .map_err(|_| "Invalid router signature.")?;
        self.key
            .verify(bytes, &signature, false)
            .map_err(|_| "Router signature verification failed.")?;
        let identity: Identity =
            serde_json::from_slice(bytes).map_err(|_| "Invalid signed router identity.")?;
        if identity.schema_version != 1
            || identity.product != ROUTER_PRODUCT
            || identity.platform != platform()
            || identity.arch != std::env::consts::ARCH
            || identity.protocol != 1
            || !hash_valid(&identity.sha256)
        {
            return Err("Signed router identity does not match this platform/protocol.".into());
        }
        Ok(identity)
    }

    fn router_at(&self, directory: &Path) -> Result<Router, String> {
        let bytes = bounded(&directory.join("router.json"), MAX_DESCRIPTOR)?;
        let signature = bounded(&directory.join("router.minisig"), 4096)?;
        let identity = self.router_identity(&bytes, &signature)?;
        let command = directory.join(name());
        let mut image = open_payload(&command)?;
        let mut hasher = Sha256::new();
        let mut buffer = [0; 65536];
        loop {
            let count = image
                .read(&mut buffer)
                .map_err(|_| "Cannot verify retained router.")?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }
        if format!("{:x}", hasher.finalize()) != identity.sha256 {
            return Err("Retained router bytes changed. Nothing was repaired or started.".into());
        }
        Ok(Router {
            command,
            _image: image,
        })
    }

    /// Requires the caller's explicit initial migration/setup approval. A signed
    /// compatible existing router is kept, not overwritten with every Hub build.
    pub fn prepare_router(
        &self,
        source: &Path,
        bytes: &[u8],
        signature: &[u8],
    ) -> Result<Router, String> {
        let identity = self.router_identity(bytes, signature)?;
        // Validate this package even when an older compatible router is retained.
        let mut source_image = open_payload(source)?;
        let mut contents = Vec::new();
        (&mut source_image)
            .take(MAX_PAYLOAD + 1)
            .read_to_end(&mut contents)
            .map_err(|_| "Cannot read packaged router.")?;
        if contents.len() as u64 > MAX_PAYLOAD || digest(&contents) != identity.sha256 {
            return Err("Packaged router bytes do not match its signed identity.".into());
        }
        private_dir(&self.root)?;
        let lock_path = self.root.join("router-prepare.lock");
        reject_links(&lock_path)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(|_| "Cannot reserve router preparation.")?;
        lock.try_lock_exclusive()
            .map_err(|_| "Another Hub is preparing its router.")?;
        let _guard = ActivationLock(lock);
        let target = self.root.join("router-v1");
        reject_links(&target)?;
        if target.exists() {
            return self.router_at(&target);
        }
        let staging = tempfile::Builder::new()
            .prefix(".router-")
            .tempdir_in(&self.root)
            .map_err(|_| "Cannot stage signed router.")?;
        write_new(&staging.path().join(name()), &contents)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                staging.path().join(name()),
                fs::Permissions::from_mode(0o500),
            )
            .map_err(|_| "Cannot set router executable permissions.")?;
        }
        write_new(&staging.path().join("router.json"), bytes)?;
        write_new(&staging.path().join("router.minisig"), signature)?;
        drop(self.router_at(staging.path())?);
        sync_directory(staging.path())?;
        reject_links(&target)?;
        fs::rename(staging.path(), &target)
            .map_err(|_| "Cannot publish the complete signed router.")?;
        sync_directory(&self.root)?;
        self.router_at(&target)
    }

    pub fn router(&self) -> Result<Router, String> {
        self.router_at(&self.root.join("router-v1"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(kind: &str) -> (tempfile::TempDir, Store, PathBuf, Vec<u8>, Vec<u8>) {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/bootstrap-fixtures");
        let key =
            PublicKey::decode(&fs::read_to_string(fixtures.join("public.txt")).unwrap()).unwrap();
        let prefix = fixtures.join(format!("{}-{}-{kind}", platform(), std::env::consts::ARCH));
        let source = base.join(name());
        fs::write(&source, format!("router-{kind}")).unwrap();
        (
            root,
            Store::new(&base, key).unwrap(),
            source,
            fs::read(prefix.with_extension("json")).unwrap(),
            fs::read(prefix.with_extension("minisig")).unwrap(),
        )
    }
    #[test]
    fn unsigned_wrong_product_and_tampered_packages_never_publish() {
        let (_root, store, source, bytes, signature) = fixture("a");
        assert!(store.prepare_router(&source, &bytes, b"unsigned").is_err());
        let mut changed = bytes.clone();
        changed.push(b' ');
        assert!(store.prepare_router(&source, &changed, &signature).is_err());
        fs::write(&source, b"tampered").unwrap();
        assert!(store.prepare_router(&source, &bytes, &signature).is_err());
        assert!(!store.root.exists());
        let (_root, store, source, bytes, signature) = fixture("foreign");
        assert!(store.prepare_router(&source, &bytes, &signature).is_err());
        assert!(!store.root.exists());
    }
    #[test]
    fn complete_signed_router_retains_its_command_across_compatible_hub_packages() {
        let (_root, store, source, bytes, signature) = fixture("a");
        let first = store.prepare_router(&source, &bytes, &signature).unwrap();
        let command = first.command.clone();
        assert_eq!(fs::read(&command).unwrap(), b"router-a");
        assert_eq!(store.router().unwrap().command, command);
        drop(first);
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/bootstrap-fixtures");
        let prefix = fixtures.join(format!("{}-{}-b", platform(), std::env::consts::ARCH));
        let bytes = fs::read(prefix.with_extension("json")).unwrap();
        let signature = fs::read(prefix.with_extension("minisig")).unwrap();
        fs::write(&source, b"router-b").unwrap();
        assert_eq!(
            store
                .prepare_router(&source, &bytes, &signature)
                .unwrap()
                .command,
            command
        );
        assert_eq!(fs::read(&command).unwrap(), b"router-a");
        fs::write(&source, b"not the signed next package").unwrap();
        assert!(store.prepare_router(&source, &bytes, &signature).is_err());
        assert_eq!(fs::read(command).unwrap(), b"router-a");
    }
    #[test]
    fn damaged_retained_router_is_not_silently_repaired() {
        let (_root, store, source, bytes, signature) = fixture("a");
        let router = store.prepare_router(&source, &bytes, &signature).unwrap();
        let command = router.command.clone();
        drop(router);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // The owned fixture is deliberately damaged by an external writer;
            // do not mistake its normal 0500 protection for immutable storage.
            fs::set_permissions(&command, fs::Permissions::from_mode(0o700)).unwrap();
        }
        fs::write(&command, b"changed by another writer").unwrap();
        assert!(store.router().is_err());
        assert!(store.prepare_router(&source, &bytes, &signature).is_err());
        assert_eq!(fs::read(command).unwrap(), b"changed by another writer");
    }
}
