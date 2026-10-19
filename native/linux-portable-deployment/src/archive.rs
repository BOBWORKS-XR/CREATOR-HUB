// Same raw-USTAR, bounded gzip and canonical padding contract as module_archive.rs.
use crate::{digest, refused, require, Entry, Manifest, Result};
use std::{collections::BTreeMap, io::Read};

pub(crate) fn relative(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 240
        && name.split('/').count() <= 32
        && name
            .bytes()
            .all(|b| (32..=126).contains(&b) && !b"\\:".contains(&b))
        && name.split('/').all(|part| {
            let stem = part
                .split('.')
                .next()
                .unwrap_or_default()
                .to_ascii_uppercase();
            !part.is_empty()
                && part.len() <= 100
                && part != "."
                && part != ".."
                && !part.ends_with(['.', ' '])
                && !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                && !(stem.len() == 4
                    && (stem.starts_with("COM") || stem.starts_with("LPT"))
                    && stem.as_bytes()[3].is_ascii_digit())
        })
}

pub(crate) fn decode(raw: &[u8], manifest: &Manifest) -> Result<BTreeMap<String, Vec<u8>>> {
    require(
        raw.len() as u64 == manifest.archive.size && digest(raw) == manifest.archive.sha256,
        "Signed archive bytes differ",
    )?;
    let limit = manifest.archive.unpacked_size + manifest.entries.len() as u64 * 1024 + 10240;
    let mut gzip = flate2::bufread::GzDecoder::new(raw);
    let mut unpacked = Vec::new();
    (&mut gzip)
        .take(limit + 1)
        .read_to_end(&mut unpacked)
        .map_err(|_| refused("Invalid compressed AppDir archive"))?;
    require(
        unpacked.len() as u64 <= limit && gzip.get_ref().is_empty(),
        "Oversized archive or trailing gzip data",
    )?;
    let mut archive = tar::Archive::new(unpacked.as_slice());
    let entries = archive
        .entries()
        .map_err(|_| refused("Invalid AppDir TAR"))?;
    let mut contents = BTreeMap::new();
    let mut end = 0usize;
    for item in entries.raw(true) {
        require(
            contents.len() < manifest.entries.len(),
            "Extra archive members",
        )?;
        let mut item = item.map_err(|_| refused("Invalid AppDir TAR header"))?;
        let header = item.header();
        let path = header.path_bytes();
        let raw_name = std::str::from_utf8(&path).map_err(|_| refused("Non-ASCII archive path"))?;
        let name = if header.entry_type().is_dir() {
            raw_name.strip_suffix('/').unwrap_or(raw_name)
        } else {
            raw_name
        };
        let entry = manifest
            .entries
            .get(name)
            .ok_or_else(|| refused("Unlisted archive member"))?;
        require(
            relative(name) && !contents.contains_key(name),
            "Duplicate/noncanonical archive member",
        )?;
        let bytes = header.as_bytes();
        require(
            header.as_ustar().is_some()
                && bytes[157..257].iter().all(|b| *b == 0)
                && header.uid().ok() == Some(0)
                && header.gid().ok() == Some(0),
            "Only ordinary root-owned USTAR members accepted",
        )?;
        let size = match entry {
            Entry::Directory { mode } => {
                require(
                    bytes[156] == b'5'
                        && header.mode().ok() == Some(*mode)
                        && header.size().ok() == Some(0),
                    "Directory type/mode/size differs",
                )?;
                0
            }
            Entry::File { size, mode, .. } => {
                require(
                    bytes[156] == b'0'
                        && header.mode().ok() == Some(*mode)
                        && header.size().ok() == Some(*size),
                    "File type/mode/size differs",
                )?;
                *size
            }
        };
        let start = usize::try_from(item.raw_file_position())
            .map_err(|_| refused("Archive offset overflow"))?;
        end = start
            .checked_add((size as usize).div_ceil(512) * 512)
            .ok_or_else(|| refused("Archive length overflow"))?;
        let data_end = start + size as usize;
        require(
            end <= unpacked.len() && unpacked[data_end..end].iter().all(|b| *b == 0),
            "Truncated/noncanonical archive padding",
        )?;
        let name = name.to_owned();
        let mut data = Vec::new();
        item.read_to_end(&mut data)
            .map_err(|_| refused("Cannot read bound AppDir member"))?;
        require(data.len() as u64 == size, "Short archive member")?;
        if let Entry::File { sha256, .. } = entry {
            require(digest(&data) == *sha256, "AppDir member hash differs")?;
        }
        if name == crate::ENTRYPOINT {
            require(
                data.len() >= 20
                    && data[..7] == *b"\x7fELF\x02\x01\x01"
                    && data[18..20] == [0x3e, 0],
                "Entrypoint must be x86_64 little-endian ELF",
            )?;
        }
        contents.insert(name, data);
    }
    require(
        contents.len() == manifest.entries.len()
            && unpacked.len() % 512 == 0
            && unpacked.len().saturating_sub(end) >= 1024
            && unpacked[end..].iter().all(|b| *b == 0),
        "Incomplete archive or unknown trailing members",
    )?;
    Ok(contents)
}
