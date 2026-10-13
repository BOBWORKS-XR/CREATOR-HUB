//! Offline signed-payload check only; no activation, client edits or GUI acceptance.
use creator_hub_mcp_router::Store;
use minisign_verify::PublicKey;
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path};

fn bounded(path: &Path) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(128 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 128 * 1024 {
        return Err("Runtime metadata exceeds its verification limit.".into());
    }
    Ok(bytes)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 2 {
        return Err("Usage: verify-managed-runtime CANDIDATE-DIRECTORY HUB-VERSION".into());
    }
    let root = Path::new(&args[0]);
    let key = PublicKey::decode(include_str!("../src/catalog-key.pub"))?;
    let temporary = tempfile::tempdir()?;
    let store = Store::new(&temporary.path().canonicalize()?, key)?;
    let mut bytes = bounded(&root.join("modules/routing/runtime.json"))?;
    let signature = bounded(&root.join("modules/routing/runtime.minisig"))?;
    let descriptor = store.verify_descriptor(&bytes, &signature)?;
    if descriptor.hub_version != args[1] {
        return Err("Signed runtime belongs to a different Hub version.".into());
    }
    for (name, expected) in &descriptor.module.files {
        let path = root.join("modules").join(name);
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("Runtime payload must be a regular file.".into());
        }
        let mut digest = Sha256::new();
        std::io::copy(&mut fs::File::open(path)?, &mut digest)?;
        if format!("{:x}", digest.finalize()) != *expected {
            return Err("Runtime payload differs from its signed descriptor.".into());
        }
    }
    bytes[0] ^= 1;
    if store.verify_descriptor(&bytes, &signature).is_ok() {
        return Err("Changed runtime metadata was not refused.".into());
    }
    println!("Verified managed runtime {}: trusted signature, exact payload and tamper refusal. No activation or client changes.", descriptor.hub_version);
    Ok(())
}
