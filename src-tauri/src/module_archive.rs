use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io::Read, path::Path};

const MAX_ARCHIVE: u64 = 256 * 1024 * 1024;
const MAX_FILE: u64 = 256 * 1024 * 1024;
const MAX_TOTAL: u64 = 512 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Binding {
    pub schema_version: u32,
    pub file: String,
    pub sha256: String,
    pub size: u64,
    pub unpacked_size: u64,
    pub files: BTreeMap<String, Record>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Record {
    pub size: u64,
    pub mode: u32,
}

pub(super) struct Member {
    pub bytes: Vec<u8>,
    pub mode: u32,
}

pub(super) struct Snapshot(pub BTreeMap<String, Member>);

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn relative(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name
            .bytes()
            .all(|byte| (32..=126).contains(&byte) && byte != b'\\' && byte != b':')
        && name
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

impl Binding {
    pub fn validate(&self, expected: &BTreeMap<String, (String, u32)>) -> Result<(), String> {
        if self.schema_version != 1
            || self.file != "modules.tar.gz"
            || self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || self.size == 0
            || self.size > MAX_ARCHIVE
            || self.files.len() != expected.len()
        {
            return Err("Invalid Linux module archive binding.".into());
        }
        let mut total = 0u64;
        for (name, record) in &self.files {
            let (hash, mode) = expected
                .get(name)
                .ok_or("Unlisted module archive binding.")?;
            if !relative(name)
                || record.size > MAX_FILE
                || record.mode != *mode
                || !matches!(mode, 0o644 | 0o755)
                || hash.len() != 64
                || !hash
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err("Invalid raw module archive binding.".into());
            }
            total = total
                .checked_add(record.size)
                .ok_or("Module archive size overflow.")?;
        }
        if total > MAX_TOTAL || total != self.unpacked_size {
            return Err("Invalid module archive size binding.".into());
        }
        Ok(())
    }
}

fn open_capture(file: &Path) -> Result<std::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    }
    options
        .open(file)
        .map_err(|_| "Cannot capture the regular module archive.".into())
}

pub(super) fn read(
    file: &Path,
    binding: &Binding,
    expected: &BTreeMap<String, (String, u32)>,
) -> Result<Snapshot, String> {
    binding.validate(expected)?;
    if std::fs::symlink_metadata(file)
        .map_err(|_| "Cannot inspect the module archive.")?
        .file_type()
        .is_symlink()
    {
        return Err("Redirected module archive.".into());
    }
    let input = open_capture(file)?;
    let metadata = input
        .metadata()
        .map_err(|_| "Cannot inspect the module archive.")?;
    if !metadata.is_file() || metadata.len() != binding.size {
        return Err("Module archive size changed.".into());
    }
    let mut bytes = Vec::new();
    input
        .take(binding.size + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot snapshot the module archive.")?;
    decode(&bytes, binding, expected)
}

pub(super) fn decode(
    bytes: &[u8],
    binding: &Binding,
    expected: &BTreeMap<String, (String, u32)>,
) -> Result<Snapshot, String> {
    binding.validate(expected)?;
    if bytes.len() as u64 != binding.size || digest(bytes) != binding.sha256 {
        return Err("Build-bound module archive changed. Nothing was opened.".into());
    }
    let limit = binding.unpacked_size + binding.files.len() as u64 * 1024 + 10240;
    let mut gzip = flate2::bufread::GzDecoder::new(bytes);
    let mut unpacked = Vec::new();
    (&mut gzip)
        .take(limit + 1)
        .read_to_end(&mut unpacked)
        .map_err(|_| "Invalid compressed module archive.")?;
    if unpacked.len() as u64 > limit || !gzip.get_ref().is_empty() {
        return Err("Oversized module archive or trailing compressed data.".into());
    }
    let mut archive = tar::Archive::new(unpacked.as_slice());
    let entries = archive.entries().map_err(|_| "Invalid module archive.")?;
    let mut members = BTreeMap::new();
    let mut end = 0usize;
    for item in entries.raw(true) {
        let mut item = item.map_err(|_| "Invalid module archive header.")?;
        let header = item.header();
        let raw = header.as_bytes();
        let path = header.path_bytes();
        let name = std::str::from_utf8(&path).map_err(|_| "Non-ASCII module archive path.")?;
        let record = binding
            .files
            .get(name)
            .ok_or("Unlisted module archive member.")?;
        if !relative(name)
            || members.contains_key(name)
            || header.as_ustar().is_none()
            || raw[156] != b'0'
            || raw[157..257].iter().chain(&raw[345..500]).any(|b| *b != 0)
            || header.mode().ok() != Some(record.mode)
            || header.size().ok() != Some(record.size)
            || header.uid().ok() != Some(0)
            || header.gid().ok() != Some(0)
        {
            return Err("Unsupported, redirected or duplicate module archive member.".into());
        }
        let name = name.to_owned();
        let start = item.raw_file_position() as usize;
        end = start + (record.size as usize).div_ceil(512) * 512;
        let data_end = start + record.size as usize;
        if end > unpacked.len() || unpacked[data_end..end].iter().any(|b| *b != 0) {
            return Err("Truncated or noncanonical module archive.".into());
        }
        let mut contents = Vec::new();
        item.read_to_end(&mut contents)
            .map_err(|_| "Cannot read raw module archive member.")?;
        if contents.len() as u64 != record.size || digest(&contents) != expected[&name].0 {
            return Err(format!("Archived raw module changed: {name}"));
        }
        members.insert(
            name,
            Member {
                bytes: contents,
                mode: record.mode,
            },
        );
    }
    if members.len() != expected.len()
        || unpacked.len() % 512 != 0
        || unpacked.len().saturating_sub(end) < 1024
        || unpacked[end..].iter().any(|b| *b != 0)
    {
        return Err("Incomplete module archive or unknown trailing members.".into());
    }
    Ok(Snapshot(members))
}

impl Snapshot {
    pub fn write(&self, name: &str, to: &Path) -> Result<(), String> {
        use std::io::Write;
        let member = self.0.get(name).ok_or("Missing verified archive member.")?;
        if !matches!(member.mode, 0o644 | 0o755) {
            return Err("Invalid verified member mode.".into());
        }
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(to)
            .map_err(|_| "Cannot stage the verified archive member.")?;
        file.write_all(&member.bytes)
            .map_err(|_| "Cannot write the verified archive member.")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(member.mode))
                .map_err(|_| "Cannot set the verified archive member mode.")?;
        }
        file.sync_all()
            .map_err(|_| "Cannot flush the verified archive member.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;

    fn compressed(bytes: &[u8]) -> Vec<u8> {
        let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
        gzip.write_all(bytes).unwrap();
        gzip.finish().unwrap()
    }

    fn tar(members: &[(&str, &[u8], u32, u8)]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        for (name, bytes, mode, kind) in members {
            let mut header = tar::Header::new_ustar();
            header.set_path(name).unwrap();
            header.set_mode(*mode);
            header.set_uid(0);
            header.set_gid(0);
            header.set_mtime(0);
            header.set_entry_type(tar::EntryType::new(*kind));
            header.set_size(bytes.len() as u64);
            header.set_cksum();
            builder.append(&header, *bytes).unwrap();
        }
        builder.into_inner().unwrap()
    }

    fn fixture(raw: &[u8]) -> (Vec<u8>, Binding, BTreeMap<String, (String, u32)>) {
        let bytes = compressed(raw);
        let binding = Binding {
            schema_version: 1,
            file: "modules.tar.gz".into(),
            sha256: digest(&bytes),
            size: bytes.len() as u64,
            unpacked_size: 7,
            files: BTreeMap::from([(
                "mcp/test".into(),
                Record {
                    size: 7,
                    mode: 0o755,
                },
            )]),
        };
        let expected = BTreeMap::from([("mcp/test".into(), (digest(b"fixture"), 0o755))]);
        (bytes, binding, expected)
    }

    #[test]
    fn exact_archive_bytes_raw_digest_and_mode_are_required_before_any_write() {
        let (bytes, binding, expected) = fixture(&tar(&[("mcp/test", b"fixture", 0o755, b'0')]));
        let snapshot = decode(&bytes, &binding, &expected).unwrap();
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("fixture");
        snapshot.write("mcp/test", &file).unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"fixture");
        assert!(snapshot.write("mcp/test", &file).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(file).unwrap().permissions().mode() & 0o7777,
                0o755
            );
        }
        let mut changed = bytes.clone();
        changed[15] ^= 1;
        assert!(decode(&changed, &binding, &expected).is_err());
        let mut wrong = expected.clone();
        wrong.get_mut("mcp/test").unwrap().0 = digest(b"changed");
        assert!(decode(&bytes, &binding, &wrong).is_err());
    }

    #[test]
    fn links_special_files_extensions_and_privileged_modes_are_rejected() {
        for kind in *b"1234567xgLKS" {
            let (bytes, binding, expected) =
                fixture(&tar(&[("mcp/test", b"fixture", 0o755, kind)]));
            assert!(decode(&bytes, &binding, &expected).is_err(), "type {kind}");
        }
        for mode in [0o644, 0o777, 0o4755, 0o2755, 0o1755, 0o600] {
            let (bytes, binding, expected) = fixture(&tar(&[("mcp/test", b"fixture", mode, b'0')]));
            assert!(
                decode(&bytes, &binding, &expected).is_err(),
                "mode {mode:o}"
            );
        }
    }

    #[test]
    fn duplicate_unknown_missing_and_post_terminator_members_are_rejected() {
        for raw in [
            tar(&[
                ("mcp/test", b"fixture", 0o755, b'0'),
                ("mcp/test", b"fixture", 0o755, b'0'),
            ]),
            tar(&[
                ("mcp/test", b"fixture", 0o755, b'0'),
                ("mcp/unknown", b"extra", 0o644, b'0'),
            ]),
            tar(&[]),
            [
                tar(&[("mcp/test", b"fixture", 0o755, b'0')]),
                tar(&[("mcp/unknown", b"extra", 0o644, b'0')]),
            ]
            .concat(),
        ] {
            let (bytes, binding, expected) = fixture(&raw);
            assert!(decode(&bytes, &binding, &expected).is_err());
        }
    }

    #[test]
    fn path_binding_rejects_absolute_traversal_and_platform_aliases() {
        for path in [
            "../test",
            "/mcp/test",
            "mcp/../test",
            "mcp//test",
            "mcp/./test",
            "C:/test",
            "mcp\\test",
            "mcp/\0test",
        ] {
            let (bytes, mut binding, _) = fixture(&tar(&[("mcp/test", b"fixture", 0o755, b'0')]));
            binding.files = BTreeMap::from([(
                path.into(),
                Record {
                    size: 7,
                    mode: 0o755,
                },
            )]);
            let expected = BTreeMap::from([(path.into(), (digest(b"fixture"), 0o755))]);
            assert!(decode(&bytes, &binding, &expected).is_err(), "{path:?}");
        }
    }

    #[test]
    fn bounded_sizes_truncation_corruption_and_gzip_trailing_bytes_fail_closed() {
        let raw = tar(&[("mcp/test", b"fixture", 0o755, b'0')]);
        let (bytes, binding, expected) = fixture(&raw);
        for size in [0, MAX_ARCHIVE + 1, u64::MAX] {
            let mut invalid = binding.clone();
            invalid.size = size;
            assert!(decode(&bytes, &invalid, &expected).is_err());
        }
        let mut invalid = binding.clone();
        invalid.files.get_mut("mcp/test").unwrap().size = MAX_FILE + 1;
        invalid.unpacked_size = MAX_FILE + 1;
        assert!(decode(&bytes, &invalid, &expected).is_err());
        let mut invalid = binding.clone();
        invalid.unpacked_size = MAX_TOTAL + 1;
        assert!(decode(&bytes, &invalid, &expected).is_err());
        for raw in [&raw[..510], &raw[..1025]] {
            let (bytes, binding, expected) = fixture(raw);
            assert!(decode(&bytes, &binding, &expected).is_err());
        }
        for altered in [
            [&bytes[..bytes.len() - 1], &[0xff]].concat(),
            [bytes.clone(), compressed(b"extra")].concat(),
            [bytes.clone(), vec![0]].concat(),
            compressed(&vec![0; 20000]),
        ] {
            let mut rebound = binding.clone();
            rebound.size = altered.len() as u64;
            rebound.sha256 = digest(&altered);
            assert!(decode(&altered, &rebound, &expected).is_err());
        }
    }

    #[test]
    fn malformed_header_padding_and_archive_name_are_not_accepted() {
        let raw = tar(&[("mcp/test", b"fixture", 0o755, b'0')]);
        let mut corrupt = raw.clone();
        corrupt[0] ^= 1;
        let (bytes, binding, expected) = fixture(&corrupt);
        assert!(decode(&bytes, &binding, &expected).is_err());
        let mut corrupt = raw;
        corrupt[520] = 1;
        let (bytes, mut binding, expected) = fixture(&corrupt);
        assert!(decode(&bytes, &binding, &expected).is_err());
        binding.file = "../modules.tar.gz".into();
        assert!(decode(&bytes, &binding, &expected).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn captured_archive_refuses_fifo_and_symlink_replacement_without_blocking() {
        use std::os::fd::AsRawFd;
        use std::{
            ffi::CString,
            os::unix::{ffi::OsStrExt, fs::symlink},
        };
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("modules.tar.gz");
        let target = root.path().join("unchanged.tar.gz");
        let (bytes, binding, expected) = fixture(&tar(&[("mcp/test", b"fixture", 0o755, b'0')]));
        std::fs::write(&file, &bytes).unwrap();
        assert!(read(&file, &binding, &expected).is_ok());
        let captured = open_capture(&file).unwrap();
        assert_ne!(
            unsafe { libc::fcntl(captured.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
            0
        );
        assert_ne!(
            unsafe { libc::fcntl(captured.as_raw_fd(), libc::F_GETFL) } & libc::O_NONBLOCK,
            0
        );
        drop(captured);
        // Model replacement after a successful path inspection. The opened
        // descriptor, not that inspection, must still refuse the redirect.
        let inspected = std::fs::symlink_metadata(&file).unwrap();
        assert!(inspected.is_file());
        std::fs::rename(&file, &target).unwrap();
        symlink(&target, &file).unwrap();
        assert!(open_capture(&file).is_err());
        assert!(read(&file, &binding, &expected).is_err());
        std::fs::remove_file(&file).unwrap();
        let name = CString::new(file.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(read(&file, &binding, &expected).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
    }
}
