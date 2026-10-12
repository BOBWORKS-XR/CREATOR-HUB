//! Derive kernel-comparable identities from descriptor-verified Mach-O bytes.
//! No path-based codesign subprocess or mutable static-code object is authority.
use sha2::{Digest, Sha256};

fn range(bytes: &[u8], offset: usize, length: usize) -> Result<&[u8], String> {
    bytes
        .get(offset..offset.checked_add(length).ok_or("Mach-O range overflow.")?)
        .ok_or_else(|| "Truncated Mach-O identity.".into())
}

fn be(bytes: &[u8], offset: usize) -> Result<usize, String> {
    Ok(u32::from_be_bytes(range(bytes, offset, 4)?.try_into().unwrap()) as usize)
}

fn le(bytes: &[u8], offset: usize) -> Result<usize, String> {
    Ok(u32::from_le_bytes(range(bytes, offset, 4)?.try_into().unwrap()) as usize)
}

pub(crate) fn cdhashes(image: &[u8]) -> Result<Vec<[u8; 20]>, String> {
    // The packaged Node archives are architecture-specific. Refuse FAT and
    // non-native slices rather than guessing which slice the kernel selected.
    if le(image, 0)? != 0xfeedfacf
        || le(image, 4)?
            != if cfg!(target_arch = "aarch64") {
                0x0100000c
            } else {
                0x01000007
            }
        || le(image, 12)? != 2
    {
        return Err("MCP requires a native, thin, signed 64-bit Mach-O executable.".into());
    }
    let commands = range(image, 32, le(image, 20)?)?;
    let mut cursor = 0;
    let mut signature = None;
    for _ in 0..le(image, 16)? {
        let size = le(commands, cursor + 4)?;
        if size < 8 {
            return Err("Invalid Mach-O load command.".into());
        }
        let command = range(commands, cursor, size)?;
        if le(command, 0)? == 0x1d {
            if size != 16 || signature.is_some() {
                return Err("Ambiguous Mach-O code signature.".into());
            }
            signature = Some((le(command, 8)?, le(command, 12)?));
        }
        cursor += size;
    }
    if cursor != commands.len() {
        return Err("Invalid Mach-O load command count.".into());
    }
    let (offset, size) = signature.ok_or("MCP executable has no embedded code signature.")?;
    let blob = range(image, offset, size)?;
    if be(blob, 0)? != 0xfade0cc0 || be(blob, 4)? > size {
        return Err("Invalid embedded code signature.".into());
    }
    let blob = range(blob, 0, be(blob, 4)?)?;
    let count = be(blob, 8)?;
    range(
        blob,
        12,
        count.checked_mul(8).ok_or("Signature index overflow.")?,
    )?;
    let mut hashes = Vec::new();
    for index in 0..count {
        let slot = be(blob, 12 + index * 8)?;
        if slot != 0 && !(0x1000..=0x1005).contains(&slot) {
            continue;
        }
        let start = be(blob, 16 + index * 8)?;
        let cd = range(blob, start, be(blob, start + 4)?)?;
        if be(cd, 0)? != 0xfade0c02 || cd.len() < 44 {
            return Err("Invalid CodeDirectory.".into());
        }
        let hash_type = cd[37];
        if hash_type != 2 && hash_type != 3 {
            continue; // Never authorize a SHA-1-only runtime.
        }
        let hash_size = if hash_type == 2 { 32 } else { 20 };
        if cd[36] as usize != hash_size
            || cd[39] > 16
            || be(cd, 32)? != offset
            || (be(cd, 8)? >= 0x20100 && be(cd, 44)? != 0)
        {
            return Err("Unsupported or incomplete MCP CodeDirectory coverage.".into());
        }
        if be(cd, 8)? >= 0x20300 && u64::from_be_bytes(range(cd, 56, 8)?.try_into().unwrap()) != 0 {
            return Err("Extended CodeDirectory limits are unsupported.".into());
        }
        let page = 1usize << cd[39];
        let slots = offset.div_ceil(page);
        if slots != be(cd, 28)? {
            return Err("CodeDirectory page count does not cover the executable.".into());
        }
        let table = range(
            cd,
            be(cd, 16)?,
            slots.checked_mul(hash_size).ok_or("Code hash overflow.")?,
        )?;
        for (index, contents) in range(image, 0, offset)?.chunks(page).enumerate() {
            let hash = Sha256::digest(contents);
            if hash[..hash_size] != table[index * hash_size..(index + 1) * hash_size] {
                return Err("MCP executable pages do not match their CodeDirectory.".into());
            }
        }
        hashes.push(Sha256::digest(cd)[..20].try_into().unwrap());
    }
    if hashes.is_empty() {
        return Err("MCP executable requires a SHA-256 CodeDirectory.".into());
    }
    Ok(hashes)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Vec<u8> {
        let mut bytes = vec![0; 4096];
        for (offset, value) in [
            (0, 0xfeedfacfu32),
            (
                4,
                if cfg!(target_arch = "aarch64") {
                    0x0100000c
                } else {
                    0x01000007
                },
            ),
            (12, 2),
            (16, 1),
            (20, 16),
            (32, 0x1d),
            (36, 16),
            (40, 4096),
            (44, 96),
        ] {
            bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        let page_hash = Sha256::digest(&bytes);
        let mut cd = vec![0; 76];
        for (offset, value) in [
            (0, 0xfade0c02u32),
            (4, 76),
            (8, 0x20001),
            (16, 44),
            (28, 1),
            (32, 4096),
        ] {
            cd[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
        }
        cd[36] = 32;
        cd[37] = 2;
        cd[39] = 12;
        cd[44..].copy_from_slice(&page_hash);
        for value in [0xfade0cc0u32, 96, 1, 0, 20] {
            bytes.extend_from_slice(&value.to_be_bytes());
        }
        bytes.extend(cd);
        bytes
    }
    #[test]
    fn exact_page_tamper_and_changed_code_directory_are_detected() {
        let bytes = fixture();
        let identity = cdhashes(&bytes).unwrap();
        let mut changed = bytes.clone();
        changed[4000] ^= 1;
        assert!(cdhashes(&changed).is_err());
        let mut changed = bytes;
        changed[4096 + 20 + 12] ^= 1; // Flags change the kernel identity.
        assert_ne!(cdhashes(&changed).unwrap(), identity);
    }
    #[test]
    fn truncated_unsigned_and_incomplete_coverage_are_refused() {
        for end in 0..fixture().len() {
            assert!(cdhashes(&fixture()[..end]).is_err());
        }
        let mut bytes = fixture();
        bytes[4096 + 20 + 37] = 1;
        assert!(cdhashes(&bytes).is_err());
        let mut bytes = fixture();
        bytes[4096 + 20 + 32..4096 + 20 + 36].copy_from_slice(&4095u32.to_be_bytes());
        assert!(cdhashes(&bytes).is_err());
    }
}
