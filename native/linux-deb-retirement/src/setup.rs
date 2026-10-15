//! Fixed TEST ONLY Setup contract; mutation requires the nondefault transaction feature.
//! Original controls and all five files were passively read from the exact public DEB.
use crate::{pins::Pin, require, Result};

pub const PACKAGE: &str = "creator-project-setup";
pub const OLD: &str = "0.3.7";
pub const NEW: &str = "0.3.7-1+hub.retention014.1";
pub const PRIVATE: &str = "/var/lib/creator-hub-deb-retirement-setup";
pub const DOCUMENT_ROOT: &str = "/usr/share/doc/creator-project-setup";
pub const PACKAGE_BYTES: u64 = 5966970;
pub const PACKAGE_SHA256: &str = "be18f23450146e71a2960e2110474f6e0409a9521a3ced308b7fd6a6d584c63d";
pub const CONTROL_SHA256: &str = "e0d549d19d4f8820b4e07cb05bca5c8f165bfc82a9ad255c5dc9d7233e9606e9";
pub const MD5_SHA256: &str = "976a39bd65c2038de06bd8fb3d962d9e38d840a821f9ba25dbd46cb6f7824ed5";
pub const ORIGINAL_CONTROL: &[u8] = include_bytes!("../tests/fixtures/setup-0.3.7.control");
pub const ORIGINAL_MD5SUMS: &[u8] = include_bytes!("../tests/fixtures/setup-0.3.7.md5sums");

pub const FILES: &[Pin] = &[
    Pin {
        path: "usr/bin/creator-project-setup",
        bytes: 20899824,
        mode: 0o755,
        sha256: "f9c3a25c062b68cafed0c46b762532bed72127635015587324119a02d63b2944",
        md5: "e6c4394fb9b0f9e822a8fa6af8701359",
        retained: false,
    },
    Pin {
        path: "usr/share/applications/Creator Project Setup.desktop",
        bytes: 255,
        mode: 0o644,
        sha256: "2e1476333e1463aef76b9117dfde1c980829b1a76952f25717a6ce303bd087db",
        md5: "c65820a5ff6946f073269385cf98c008",
        retained: false,
    },
    Pin {
        path: "usr/share/icons/hicolor/32x32/apps/creator-project-setup.png",
        bytes: 1533,
        mode: 0o644,
        sha256: "cd24c1c5d53c558422571b466b6f1950ea0ddca76e1e3de9330fb00a5a174e10",
        md5: "316cfb65fe2870aa87039bf7c2f7c399",
        retained: false,
    },
    Pin {
        path: "usr/share/icons/hicolor/256x256@2/apps/creator-project-setup.png",
        bytes: 14336,
        mode: 0o644,
        sha256: "840d17fe62d8d5230cc9a3611f6e2492f9f9e29bdb6c7c278f762d4d9774f712",
        md5: "04f313816675353ed974afb822ebb742",
        retained: false,
    },
    Pin {
        path: "usr/share/icons/hicolor/128x128/apps/creator-project-setup.png",
        bytes: 6966,
        mode: 0o644,
        sha256: "cff3b008e6e0379beee23305e683a00ce0013a73cbb7b6a445cdc73217b3ecbe",
        md5: "bca29252eb7a62eb635251168fb2fc57",
        retained: false,
    },
];

// The only new payload is a fixed non-executable notice, never user data.
pub const NOTICE: &[u8] = b"TEST ONLY - Creator Project Setup 0.3.7 GUI retired by a disposable Creator Hub validation.\nUser settings, Unity projects, caches and client configuration are not package payload and are not removed.\n";
pub const TOMBSTONE: &[Pin] = &[Pin {
    path: "usr/share/doc/creator-project-setup/retired-by-creator-hub.txt",
    bytes: NOTICE.len() as u64,
    mode: 0o644,
    sha256: "a78a28ee51d81f81ae96c18c47fef7e66034262a59c9d189497c6e39043f5307",
    md5: "9b6d5641ea02d4204686673780ce7579",
    retained: true,
}];

pub fn control() -> String {
    format!("Package: {PACKAGE}\nVersion: {NEW}\nArchitecture: amd64\nMaintainer: Creator Hub Retention Validation <noreply@example.invalid>\nPriority: optional\nInstalled-Size: 1\nDescription: TEST ONLY - original Setup 0.3.7 GUI tombstone\n User settings and projects are not removed; not a published Creator Hub transition.\n")
}

pub fn md5sums() -> String {
    format!("{}  {}\n", TOMBSTONE[0].md5, TOMBSTONE[0].path)
}

pub fn state(bytes: &[u8], compatibility: bool) -> Result<()> {
    require(
        bytes
            == format!(
                "{PACKAGE}\t{}\tamd64\tinstall ok installed\n",
                if compatibility { NEW } else { OLD }
            )
            .as_bytes(),
        "Exact healthy unheld Setup package state required",
    )
}

pub fn installed_metadata(bytes: &[u8], compatibility: bool) -> Result<()> {
    let expected = if compatibility {
        b"1\nCreator Hub Retention Validation <noreply@example.invalid>\noptional\n\nTEST ONLY - original Setup 0.3.7 GUI tombstone\n User settings and projects are not removed; not a published Creator Hub transition.\nno".as_slice()
    } else {
        b"20484\nCreator Works\noptional\nlibwebkit2gtk-4.1-0, libgtk-3-0\nCreate and validate SideQuest Creator SDK Unity projects\n Portable setup wizard for a pinned Unity, URP, build-module, and SideQuest Creator SDK project recipe\nno".as_slice()
    };
    require(
        bytes == expected,
        "Setup control/relationships/triggers changed",
    )
}

pub fn listing(bytes: &[u8], compatibility: bool) -> Result<()> {
    crate::listing_for(
        bytes,
        if compatibility { TOMBSTONE } else { FILES },
        compatibility,
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PackageState {
    Absent,
    Original,
    Compatibility,
}

pub fn query_state(code: i32, out: &[u8], err: &[u8]) -> Result<PackageState> {
    if code == 1
        && out.is_empty()
        && err == b"dpkg-query: no packages found matching creator-project-setup\n"
    {
        return Ok(PackageState::Absent);
    }
    require(
        code == 0 && err.is_empty(),
        "Setup package query failed or emitted diagnostics",
    )?;
    if state(out, false).is_ok() {
        Ok(PackageState::Original)
    } else {
        state(out, true)?;
        Ok(PackageState::Compatibility)
    }
}

pub fn stage_name(name: &str) -> bool {
    name.strip_prefix("setup-0.3.7-preparation-")
        .is_some_and(|suffix| {
            suffix.len() == 32
                && suffix
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        })
}

pub fn inspection_report(state: PackageState) -> serde_json::Value {
    let (name, version) = match state {
        PackageState::Absent => ("absent", None),
        PackageState::Original => ("original", Some(OLD)),
        PackageState::Compatibility => ("compatibility", Some(NEW)),
    };
    serde_json::json!({ "status": "inspected-read-only", "product": "setup",
        "package": PACKAGE, "packageState": name, "version": version, "readOnly": true,
        "baselineMatches": state == PackageState::Original,
        "compatibilityMatches": state == PackageState::Compatibility,
        "snapshotAuthoritative": false, "installationEnabled": false,
        "experimentalTransactionCompiled": cfg!(feature = "experimental-transaction"),
        "packageTransactionStarted": false, "nativeAcceptance": false,
        "tombstoneFilesVerified": if state == PackageState::Compatibility { 1 } else { 0 },
        "omittedFilesVerified": if state == PackageState::Original { 0 } else { 5 } })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn original_controls_and_complete_five_file_pins_match_the_passive_public_package() {
        assert_eq!(crate::sha256(ORIGINAL_CONTROL), CONTROL_SHA256);
        assert_eq!(crate::sha256(ORIGINAL_MD5SUMS), MD5_SHA256);
        assert_eq!(FILES.len(), 5);
        let lines = std::str::from_utf8(ORIGINAL_MD5SUMS)
            .unwrap()
            .lines()
            .collect::<Vec<_>>();
        assert_eq!(lines.len(), FILES.len());
        for pin in FILES {
            assert!(lines.contains(&format!("{}  {}", pin.md5, pin.path).as_str()));
            assert!(!pin.retained);
            assert!(pin.path.starts_with("usr/"));
        }
    }

    #[test]
    fn tombstone_is_fixed_same_package_scriptless_non_executable_and_test_only() {
        assert_eq!(crate::sha256(NOTICE), TOMBSTONE[0].sha256);
        assert_eq!(NOTICE.len(), 200);
        assert_eq!(TOMBSTONE[0].mode, 0o644);
        assert_eq!(md5sums().lines().count(), 1);
        assert!(control().contains(&format!("Package: {PACKAGE}\nVersion: {NEW}\n")));
        assert!(control().contains("TEST ONLY"));
        for field in [
            "Depends:",
            "Pre-Depends:",
            "Breaks:",
            "Conflicts:",
            "Replaces:",
            "Provides:",
            "Conffiles:",
            "Triggers:",
        ] {
            assert!(!control().contains(field));
        }
        assert!(FILES.iter().all(|pin| pin.path != TOMBSTONE[0].path));
    }

    #[test]
    fn states_and_lists_never_accept_changed_identity_or_extra_user_data() {
        for compatibility in [false, true] {
            let good = format!(
                "{PACKAGE}\t{}\tamd64\tinstall ok installed\n",
                if compatibility { NEW } else { OLD }
            );
            state(good.as_bytes(), compatibility).unwrap();
            assert!(state(good.as_bytes(), !compatibility).is_err());
            for (from, to) in [
                ("install ok", "hold ok"),
                ("amd64", "arm64"),
                (PACKAGE, "other"),
                ("installed", "unpacked"),
            ] {
                assert!(state(good.replace(from, to).as_bytes(), compatibility).is_err());
            }
            let selected = if compatibility { TOMBSTONE } else { FILES };
            let mut paths = crate::paths(selected, true);
            if compatibility {
                paths.insert(".".into());
            }
            let list = paths.iter().map(|p| format!("/{p}\n")).collect::<String>();
            listing(list.as_bytes(), compatibility).unwrap();
            assert!(listing(
                format!("{list}/home/fixture/project\n").as_bytes(),
                compatibility
            )
            .is_err());
            assert!(listing(list.as_bytes(), !compatibility).is_err());
        }
    }

    #[test]
    fn metadata_requires_default_no_and_every_relationship_to_remain_empty() {
        for (data, compatibility) in [
            (b"20484\nCreator Works\noptional\nlibwebkit2gtk-4.1-0, libgtk-3-0\nCreate and validate SideQuest Creator SDK Unity projects\n Portable setup wizard for a pinned Unity, URP, build-module, and SideQuest Creator SDK project recipe\nno".as_slice(), false),
            (b"1\nCreator Hub Retention Validation <noreply@example.invalid>\noptional\n\nTEST ONLY - original Setup 0.3.7 GUI tombstone\n User settings and projects are not removed; not a published Creator Hub transition.\nno".as_slice(), true),
        ] {
            installed_metadata(data, compatibility).unwrap();
            assert!(installed_metadata(&data[..data.len()-2], compatibility).is_err());
            assert!(installed_metadata(&[data, b"other-package"].concat(), compatibility).is_err());
            assert!(installed_metadata(data, !compatibility).is_err());
        }
    }

    #[test]
    fn package_query_recognizes_only_exact_absent_original_or_compatibility_states() {
        let missing = b"dpkg-query: no packages found matching creator-project-setup\n";
        assert_eq!(query_state(1, b"", missing).unwrap(), PackageState::Absent);
        for (version, expected) in [
            (OLD, PackageState::Original),
            (NEW, PackageState::Compatibility),
        ] {
            let good = format!("{PACKAGE}\t{version}\tamd64\tinstall ok installed\n");
            assert_eq!(query_state(0, good.as_bytes(), b"").unwrap(), expected);
            for bad in [
                good.replace("install ok", "hold ok"),
                good.replace("amd64", "arm64"),
                good.replace(PACKAGE, "creator-project-setup-foreign"),
                good.replace(version, "0.3.8"),
                good.replace("installed", "config-files"),
                format!("{good}{good}"),
            ] {
                assert!(query_state(0, bad.as_bytes(), b"").is_err());
            }
            assert!(query_state(0, good.as_bytes(), b"warning").is_err());
        }
        for (code, out, err) in [
            (0, b"".as_slice(), missing.as_slice()),
            (2, b"", missing),
            (1, b"unexpected", missing),
            (1, b"", b""),
            (1, b"", b"translated error"),
        ] {
            assert!(query_state(code, out, err).is_err());
        }
    }

    #[test]
    fn setup_inspection_protocol_is_read_only_and_does_not_promote_absence() {
        for state in [
            PackageState::Absent,
            PackageState::Original,
            PackageState::Compatibility,
        ] {
            let report = inspection_report(state);
            assert_eq!(report["status"], "inspected-read-only");
            assert_eq!(report["product"], "setup");
            assert_eq!(report["package"], PACKAGE);
            assert_eq!(report["readOnly"], true);
            assert_eq!(report["baselineMatches"], state == PackageState::Original);
            assert_eq!(
                report["compatibilityMatches"],
                state == PackageState::Compatibility
            );
            assert_eq!(
                report["tombstoneFilesVerified"],
                if state == PackageState::Compatibility {
                    1
                } else {
                    0
                }
            );
            for key in [
                "installationEnabled",
                "packageTransactionStarted",
                "nativeAcceptance",
                "snapshotAuthoritative",
            ] {
                assert_eq!(report[key], false);
            }
            assert_eq!(report["version"].is_null(), state == PackageState::Absent);
        }
    }

    #[test]
    fn setup_private_stage_names_never_alias_mcp_stages_markers_or_user_paths() {
        assert_ne!(PRIVATE, crate::pins::PRIVATE);
        assert!(!PRIVATE.starts_with(&format!("{}/", crate::pins::PRIVATE)));
        assert!(stage_name(
            "setup-0.3.7-preparation-0123456789abcdef0123456789abcdef"
        ));
        for bad in [
            "mcp-2.7.7-preparation-0123456789abcdef0123456789abcdef",
            "setup-0.3.8-preparation-0123456789abcdef0123456789abcdef",
            "setup-0.3.7-preparation-0123456789ABCDEF0123456789ABCDEF",
            "setup-0.3.7-preparation-../transaction-attempted",
            "transaction-attempted",
            "/tmp/setup.deb",
        ] {
            assert!(!stage_name(bad), "{bad}");
        }
    }

    #[test]
    fn tombstone_archive_never_admits_an_old_gui_or_any_user_data_file() {
        fn archive(rows: &[(&str, &[u8])]) -> Vec<u8> {
            let mut builder = tar::Builder::new(Vec::new());
            for (path, data) in rows {
                let mut header = tar::Header::new_gnu();
                header.set_mode(0o644);
                header.set_uid(0);
                header.set_gid(0);
                header.set_size(data.len() as u64);
                header.set_path(path).unwrap();
                header.set_cksum();
                builder.append(&header, *data).unwrap();
            }
            builder.into_inner().unwrap()
        }
        let good = (TOMBSTONE[0].path, NOTICE);
        crate::archive::verify_data(archive(&[good]).as_slice(), TOMBSTONE).unwrap();
        for path in [
            FILES[0].path,
            "home/fixture/project/Assets/user.asset",
            "home/fixture/.config/creator-project-setup/preferences.json",
            "usr/share/doc/creator-project-setup/unknown.txt",
        ] {
            assert!(crate::archive::verify_data(
                archive(&[good, (path, b"preserve")]).as_slice(),
                TOMBSTONE
            )
            .is_err());
        }
        assert!(crate::archive::verify_data(
            archive(&[(TOMBSTONE[0].path, b"changed notice")]).as_slice(),
            TOMBSTONE
        )
        .is_err());
        for script in [
            "preinst",
            "postinst",
            "prerm",
            "postrm",
            "conffiles",
            "triggers",
        ] {
            assert!(crate::archive::verify_controls(
                archive(&[
                    ("control", control().as_bytes()),
                    ("md5sums", md5sums().as_bytes()),
                    (script, b"not allowed")
                ])
                .as_slice(),
                control().as_bytes(),
                md5sums().as_bytes()
            )
            .is_err());
        }
    }
}
