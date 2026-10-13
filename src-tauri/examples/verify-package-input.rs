//! Offline signature check for cross-platform build handoffs, never activation.
use minisign_verify::{PublicKey, Signature};
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path};

fn bounded(path: &Path, limit: u64) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > limit {
        return Err("Package signing input must be a bounded regular file.".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(limit + 1)
        .read_to_end(&mut bytes)?;
    if bytes.is_empty() || bytes.len() as u64 > limit {
        return Err("Package signing input is empty or exceeds its limit.".into());
    }
    Ok(bytes)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 2 {
        return Err("Usage: verify-package-input METADATA DETACHED-MINISIGN".into());
    }
    let mut bytes = bounded(Path::new(&args[0]), 128 * 1024)?;
    let signature = bounded(Path::new(&args[1]), 4096)?;
    let signature = Signature::decode(std::str::from_utf8(&signature)?)?;
    let key = PublicKey::decode(include_str!("../src/catalog-key.pub"))?;
    key.verify(&bytes, &signature, false)?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    bytes[0] ^= 1;
    if key.verify(&bytes, &signature, false).is_ok() {
        return Err("Changed package signing input was not refused.".into());
    }
    println!("Verified trusted package signature: {digest}. No activation or client changes.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_bounds_refuse_empty_large_or_nonregular_files() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("metadata.json");
        assert!(bounded(root.path(), 8).is_err());
        assert!(bounded(&file, 8).is_err());
        fs::write(&file, []).unwrap();
        assert!(bounded(&file, 8).is_err());
        fs::write(&file, b"123456789").unwrap();
        assert!(bounded(&file, 8).is_err());
        fs::write(&file, b"12345678").unwrap();
        assert_eq!(bounded(&file, 8).unwrap(), b"12345678");
    }
}
