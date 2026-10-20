//! Inspect streams without extraction. Raw entries reject hidden PAX/link metadata.
use crate::{copy_pinned, paths, pins::Pin, require, Result};
use std::{collections::BTreeSet, io::Read};

fn name(raw: &[u8]) -> Result<String> {
    let text = std::str::from_utf8(raw)?;
    if text == "./" || text == "." {
        return Ok(String::new());
    }
    let text = text.strip_prefix("./").unwrap_or(text);
    let text = text.strip_suffix('/').unwrap_or(text);
    require(
        !text.is_empty()
            && text
                .split('/')
                .all(|p| !p.is_empty() && p != "." && p != "..")
            && !text.contains(['\\', '\0', '\r', '\n']),
        "Noncanonical archive path",
    )?;
    Ok(text.into())
}

pub fn verify_data(input: impl Read, pins: &[Pin]) -> Result<()> {
    let allowed = paths(pins, true);
    let mut seen = BTreeSet::new();
    let mut files = BTreeSet::new();
    let mut archive = tar::Archive::new(input);
    archive.set_ignore_zeros(true);
    for entry in archive.entries()?.raw(true) {
        let mut entry = entry?;
        let path = name(&entry.path_bytes())?;
        require(seen.insert(path.clone()), "Duplicate archive entry")?;
        require(
            entry.header().uid()? == 0 && entry.header().gid()? == 0,
            "Non-root archive ownership",
        )?;
        require(
            entry.header().link_name_bytes().is_none(),
            "Archive link target refused",
        )?;
        let kind = entry.header().entry_type();
        if kind.is_dir() {
            require(
                (path.is_empty() || allowed.contains(&path))
                    && !pins.iter().any(|p| p.path == path)
                    && entry.header().mode()? == 0o755
                    && entry.size() == 0,
                "Unexpected directory/type/mode",
            )?;
        } else {
            let pin = pins
                .iter()
                .find(|p| p.path == path)
                .ok_or("Extra payload file")?;
            require(
                kind.is_file() && entry.size() == pin.bytes && entry.header().mode()? == pin.mode,
                "Unexpected payload type/size/mode",
            )?;
            copy_pinned(&mut entry, std::io::sink(), pin)?;
            files.insert(path);
        }
    }
    require(files == paths(pins, false), "Missing payload resource")
}

pub fn verify_controls(input: impl Read, control: &[u8], md5sums: &[u8]) -> Result<()> {
    let mut archive = tar::Archive::new(input);
    archive.set_ignore_zeros(true);
    let mut seen = BTreeSet::new();
    for entry in archive.entries()?.raw(true) {
        let mut entry = entry?;
        let path = name(&entry.path_bytes())?;
        require(seen.insert(path.clone()), "Duplicate control member")?;
        require(
            entry.header().uid()? == 0
                && entry.header().gid()? == 0
                && entry.header().link_name_bytes().is_none(),
            "Control ownership/link refused",
        )?;
        if path.is_empty() {
            require(
                entry.header().entry_type().is_dir()
                    && entry.header().mode()? == 0o755
                    && entry.size() == 0,
                "Invalid control root",
            )?;
            continue;
        }
        let expected = match path.as_str() {
            "control" => control,
            "md5sums" => md5sums,
            _ => return Err("Extra control/script/conffile member".into()),
        };
        require(
            entry.header().entry_type().is_file()
                && entry.header().mode()? == 0o644
                && entry.size() == expected.len() as u64,
            "Control type/mode/size refused",
        )?;
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes)?;
        require(
            bytes == expected,
            "Control bytes differ from compiled template",
        )?;
    }
    require(
        seen.contains("control") && seen.contains("md5sums"),
        "Missing control members",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tar(rows: &[(&str, u8, u32, u64, &[u8])]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        for (path, kind, mode, uid, data) in rows {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::new(*kind));
            header.set_mode(*mode);
            header.set_uid(*uid);
            header.set_gid(0);
            header.set_size(data.len() as u64);
            header.set_path(path).unwrap();
            header.set_cksum();
            builder.append(&header, *data).unwrap();
        }
        builder.into_inner().unwrap()
    }
    fn pin() -> Pin {
        Pin {
            path: "usr/test",
            bytes: 3,
            mode: 0o644,
            sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            md5: "unused",
            retained: true,
        }
    }
    #[test]
    fn exact_payload_and_controls_are_accepted() {
        verify_data(&tar(&[("usr/test", b'0', 0o644, 0, b"abc")])[..], &[pin()]).unwrap();
        verify_controls(
            &tar(&[
                ("control", b'0', 0o644, 0, b"c"),
                ("md5sums", b'0', 0o644, 0, b"m"),
            ])[..],
            b"c",
            b"m",
        )
        .unwrap();
    }
    #[test]
    fn payload_type_mode_owner_extra_missing_duplicate_and_tamper_refuse() {
        for row in [
            ("usr/test", b'2', 0o644, 0, &b"abc"[..]),
            ("usr/test", b'1', 0o644, 0, &b"abc"[..]),
            ("usr/test", b'0', 0o666, 0, &b"abc"[..]),
            ("usr/test", b'0', 0o644, 1, &b"abc"[..]),
            ("usr/test", b'0', 0o644, 0, &b"abd"[..]),
            ("usr/other", b'0', 0o644, 0, &b"abc"[..]),
            ("usr/test", b'x', 0o644, 0, &b"abc"[..]),
        ] {
            assert!(verify_data(&tar(&[row])[..], &[pin()]).is_err(), "{row:?}");
        }
        let row = ("usr/test", b'0', 0o644, 0, &b"abc"[..]);
        assert!(verify_data(&tar(&[row, row])[..], &[pin()]).is_err());
        assert!(verify_data(&tar(&[])[..], &[pin()]).is_err());
    }
    #[test]
    fn controls_never_admit_scripts_relationship_changes_or_links() {
        let good = [
            ("control", b'0', 0o644, 0, &b"c"[..]),
            ("md5sums", b'0', 0o644, 0, &b"m"[..]),
        ];
        for extra in ["postinst", "prerm", "conffiles", "triggers"] {
            let mut rows = good.to_vec();
            rows.push((extra, b'0', 0o644, 0, b"evil"));
            assert!(verify_controls(&tar(&rows)[..], b"c", b"m").is_err());
        }
        assert!(verify_controls(&tar(&good)[..], b"c\nReplaces: other", b"m").is_err());
        assert!(verify_controls(&tar(&good[..1])[..], b"c", b"m").is_err());
        assert!(verify_controls(&tar(&[good[0], good[0], good[1]])[..], b"c", b"m").is_err());
    }
    #[test]
    fn archive_names_do_not_normalize_away_attacks() {
        for path in [
            "/usr/test",
            "../test",
            "usr/../test",
            "usr//test",
            "usr/./test",
            "usr\\test",
            "usr/test\n",
        ] {
            assert!(name(path.as_bytes()).is_err(), "{path}");
        }
        assert_eq!(name(b"./usr/test").unwrap(), "usr/test");
    }

    #[test]
    fn concatenated_members_after_end_markers_do_not_hide_extra_files() {
        let mut data = tar(&[("usr/test", b'0', 0o644, 0, b"abc")]);
        data.extend(tar(&[("usr/extra", b'0', 0o644, 0, b"x")]));
        assert!(verify_data(&data[..], &[pin()]).is_err());
        let mut data = tar(&[
            ("control", b'0', 0o644, 0, b"c"),
            ("md5sums", b'0', 0o644, 0, b"m"),
        ]);
        data.extend(tar(&[("postinst", b'0', 0o644, 0, b"evil")]));
        assert!(verify_controls(&data[..], b"c", b"m").is_err());
    }
}
