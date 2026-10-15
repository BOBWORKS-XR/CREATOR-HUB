use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    io::{Read, Write},
    path::Path,
};

pub mod archive;
#[cfg(target_os = "linux")]
pub mod linux;
pub mod metadata;
pub mod pins;
pub mod setup;

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
pub const INSTALL_REFUSAL: &str = "WIP: installation disabled; dpkg lock handoff, native GUI-close/approval and recovery contracts are not accepted";

#[derive(Debug)]
pub struct ManualRepair {
    pub reason: String,
    pub started: Option<bool>,
}

impl std::fmt::Display for ManualRepair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Manual repair/review required; automatic retries refused: {}",
            self.reason
        )
    }
}
impl std::error::Error for ManualRepair {}

pub fn refusal(error: &(dyn std::error::Error + Send + Sync + 'static)) -> serde_json::Value {
    let manual = error.downcast_ref::<ManualRepair>();
    serde_json::json!({
        "status": if manual.is_some() { "manual-repair-required" } else { "refused" },
        "reason": error.to_string(), "installationEnabled": false,
        "experimentalTransactionCompiled": cfg!(feature = "experimental-transaction"),
        "packageTransactionStarted": manual.map(|m| m.started).unwrap_or(Some(false)),
        "packageTransactionMayHaveStarted": manual.is_some(),
        "manualRepairRequired": manual.is_some(), "nativeAcceptance": false,
    })
}

pub fn require(ok: bool, reason: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(reason.into())
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Action {
    Inspect,
    InspectRetainedMcp,
    InspectSetup,
    InspectRetainedSetup,
    Prepare,
    Retire,
    RetireSetup,
}

pub fn action(args: &[String]) -> Result<Action> {
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        [] | ["inspect"] => Ok(Action::Inspect),
        ["inspect-retained-mcp-2.7.7"] => Ok(Action::InspectRetainedMcp),
        ["inspect-setup-0.3.7"] => Ok(Action::InspectSetup),
        ["inspect-retained-setup-0.3.7"] => Ok(Action::InspectRetainedSetup),
        ["prepare-mcp-2.7.7"] => Ok(Action::Prepare),
        ["retire-mcp-2.7.7"] => Ok(Action::Retire),
        ["retire-setup-0.3.7"] => Ok(Action::RetireSetup),
        _ => Err(
            "Only fixed MCP 2.7.7 and Setup 0.3.7 inspection/retirement actions; no paths/options accepted".into(),
        ),
    }
}

#[cfg(any(target_os = "linux", test))]
fn retained_inspection_report() -> serde_json::Value {
    serde_json::json!({ "status": "inspected-retained-read-only", "product": "mcp",
        "package": pins::PACKAGE, "packageState": "compatibility", "version": pins::NEW,
        "readOnly": true, "baselineMatches": false, "compatibilityMatches": true,
        "snapshotAuthoritative": false, "installationEnabled": false,
        "experimentalTransactionCompiled": cfg!(feature = "experimental-transaction"),
        "packageTransactionStarted": false, "nativeAcceptance": false,
        "retainedFilesVerified": 9, "omittedFilesVerified": 5 })
}

pub fn state(data: &[u8]) -> Result<()> {
    require(
        data == b"creator-works-mcp\t2.7.7\tamd64\tinstall ok installed\n",
        "Exact installed, unheld MCP 2.7.7 amd64 baseline required",
    )
}

pub fn compatibility_state(data: &[u8]) -> Result<()> {
    require(
        data == format!(
            "{}\t{}\tamd64\tinstall ok installed\n",
            pins::PACKAGE,
            pins::NEW
        )
        .as_bytes(),
        "Exact healthy compatibility package state required",
    )
}

#[cfg(any(target_os = "linux", test))]
fn installed_metadata(data: &[u8], compatibility: bool) -> Result<()> {
    // dpkg-query calls w_multiarch without fw_printheader, so the default is
    // rendered as "no" even when the control file omits Multi-Arch (dpkg 1.21.1).
    let expected = if compatibility {
        b"242888\nCreator Hub Retention Validation <noreply@example.invalid>\noptional\nlibwebkit2gtk-4.1-0, libgtk-3-0\nTEST ONLY - original MCP 2.7.7 runtime compatibility payload\n No launcher or desktop entries; not a published Creator Hub transition.\nno".as_slice()
    } else {
        b"263030\nCreator Works\noptional\nlibwebkit2gtk-4.1-0, libgtk-3-0\nCreator Works MCP Launcher\n Configure and manage Creator Works MCP for Codex, Claude Code, and Unity integration\nno".as_slice()
    };
    require(
        data == expected,
        "Installed control/relationships/triggers changed",
    )
}

pub fn paths(pins: &[pins::Pin], directories: bool) -> BTreeSet<String> {
    let mut result = BTreeSet::new();
    for pin in pins {
        result.insert(pin.path.to_string());
        if directories {
            let mut parent = Path::new(pin.path).parent();
            while let Some(path) = parent.filter(|p| !p.as_os_str().is_empty()) {
                result.insert(path.to_str().expect("compiled ASCII path").to_string());
                parent = path.parent();
            }
        }
    }
    result
}

pub fn listing(data: &[u8]) -> Result<()> {
    listing_for(data, pins::FILES, false)
}

pub fn compatibility_listing(data: &[u8]) -> Result<()> {
    listing_for(data, &retained(), true)
}

fn listing_for(data: &[u8], pins: &[pins::Pin], root_entry: bool) -> Result<()> {
    let text = std::str::from_utf8(data)?;
    require(text.ends_with('\n'), "Incomplete file list")?;
    let mut actual = BTreeSet::new();
    for line in text.lines() {
        let path = line.strip_prefix('/').ok_or("Nonabsolute package file")?;
        require(actual.insert(path.to_string()), "Duplicate package file")?;
    }
    let mut expected = paths(pins, true);
    if root_entry {
        expected.insert(".".into());
    }
    require(
        actual == expected,
        "Changed/incomplete/extra package file list",
    )
}

pub fn retained() -> Vec<pins::Pin> {
    pins::FILES.iter().filter(|p| p.retained).cloned().collect()
}

pub fn stage_name(name: &str) -> bool {
    name == "mcp-2.7.7-preparation"
        || name
            .strip_prefix("mcp-2.7.7-preparation-")
            .is_some_and(|suffix| {
                suffix.len() == 32
                    && suffix
                        .bytes()
                        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            })
}

pub fn owner(data: &[u8], pin: &pins::Pin) -> Result<()> {
    require(
        data == format!("{}: /{}\n", pins::PACKAGE, pin.path).as_bytes(),
        "Foreign/shared/diverted package ownership",
    )
}

pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn copy_pinned(mut input: impl Read, mut output: impl Write, pin: &pins::Pin) -> Result<()> {
    let mut hash = Sha256::new();
    let mut count = 0;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let size = input.read(&mut buffer)?;
        if size == 0 {
            break;
        }
        count += size as u64;
        require(count <= pin.bytes, "Oversized resource")?;
        hash.update(&buffer[..size]);
        output.write_all(&buffer[..size])?;
    }
    require(
        count == pin.bytes && format!("{:x}", hash.finalize()) == pin.sha256,
        "Resource size/SHA-256 pin mismatch",
    )
}

pub fn control() -> String {
    format!("Package: {}\nVersion: {}\nArchitecture: amd64\nMaintainer: Creator Hub Retention Validation <noreply@example.invalid>\nPriority: optional\nDepends: libwebkit2gtk-4.1-0, libgtk-3-0\nInstalled-Size: {}\nDescription: TEST ONLY - original MCP 2.7.7 runtime compatibility payload\n No launcher or desktop entries; not a published Creator Hub transition.\n",
        pins::PACKAGE, pins::NEW, pins::FILES.iter().filter(|p| p.retained).map(|p| p.bytes).sum::<u64>().div_ceil(1024))
}

pub fn md5sums() -> String {
    pins::FILES
        .iter()
        .filter(|p| p.retained)
        .map(|p| format!("{}  {}\n", p.md5, p.path))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dpkg_showformat_requires_default_multiarch_no_not_an_empty_field() {
        let baseline = "263030\nCreator Works\noptional\nlibwebkit2gtk-4.1-0, libgtk-3-0\nCreator Works MCP Launcher\n Configure and manage Creator Works MCP for Codex, Claude Code, and Unity integration\nno";
        let compatibility = "242888\nCreator Hub Retention Validation <noreply@example.invalid>\noptional\nlibwebkit2gtk-4.1-0, libgtk-3-0\nTEST ONLY - original MCP 2.7.7 runtime compatibility payload\n No launcher or desktop entries; not a published Creator Hub transition.\nno";
        for (value, is_compatibility) in [(baseline, false), (compatibility, true)] {
            installed_metadata(value.as_bytes(), is_compatibility).unwrap();
            assert!(
                installed_metadata(value.trim_end_matches("no").as_bytes(), is_compatibility)
                    .is_err()
            );
            for replacement in ["same", "allowed", "foreign", "noevil"] {
                assert!(installed_metadata(
                    format!("{}{replacement}", &value[..value.len() - 2]).as_bytes(),
                    is_compatibility
                )
                .is_err());
            }
            assert!(installed_metadata(
                format!("{value}extra-relationship").as_bytes(),
                is_compatibility
            )
            .is_err());
            assert!(installed_metadata(value.as_bytes(), !is_compatibility).is_err());
        }
    }

    #[test]
    fn finite_actions_never_accept_paths_or_additional_arguments() {
        assert_eq!(action(&[]).unwrap(), Action::Inspect);
        for (arg, expected) in [
            ("inspect", Action::Inspect),
            ("inspect-retained-mcp-2.7.7", Action::InspectRetainedMcp),
            ("inspect-setup-0.3.7", Action::InspectSetup),
            ("inspect-retained-setup-0.3.7", Action::InspectRetainedSetup),
            ("prepare-mcp-2.7.7", Action::Prepare),
            ("retire-mcp-2.7.7", Action::Retire),
            ("retire-setup-0.3.7", Action::RetireSetup),
        ] {
            assert_eq!(action(&[arg.into()]).unwrap(), expected);
            assert!(action(&[arg.into(), "/tmp/evil.deb".into()]).is_err());
        }
        for arg in [
            "--root=/tmp",
            "prepare-setup-0.3.7",
            "retire-mcp-2.7.8",
            "inspect-retained-mcp-2.7.8",
            "inspect-retained-setup-0.3.8",
            "/tmp/a.deb",
            "inspect\n",
        ] {
            assert!(action(&[arg.into()]).is_err());
        }
    }
    #[test]
    fn retained_inspection_protocol_never_claims_mutation_or_production_acceptance() {
        let report = retained_inspection_report();
        assert_eq!(report["status"], "inspected-retained-read-only");
        assert_eq!(report["packageState"], "compatibility");
        assert_eq!(report["package"], pins::PACKAGE);
        assert_eq!(report["version"], pins::NEW);
        assert_eq!(report["readOnly"], true);
        assert_eq!(report["compatibilityMatches"], true);
        assert_eq!(report["retainedFilesVerified"], 9);
        assert_eq!(report["omittedFilesVerified"], 5);
        for field in [
            "baselineMatches",
            "snapshotAuthoritative",
            "installationEnabled",
            "packageTransactionStarted",
            "nativeAcceptance",
        ] {
            assert_eq!(report[field], false, "{field}");
        }
    }
    #[test]
    fn state_is_exact_not_a_version_substring() {
        let good = b"creator-works-mcp\t2.7.7\tamd64\tinstall ok installed\n";
        state(good).unwrap();
        for (old, new) in [
            ("install ok", "hold ok"),
            ("installed", "unpacked"),
            ("installed", "half-configured"),
            ("ok", "reinstreq"),
            ("2.7.7", pins::NEW),
            ("amd64", "arm64"),
            ("creator-works-mcp", "other"),
        ] {
            assert!(state(String::from_utf8_lossy(good).replace(old, new).as_bytes()).is_err());
        }
        assert!(state(&[good.as_slice(), good.as_slice()].concat()).is_err());
    }
    #[test]
    fn package_lists_and_owners_are_complete_and_exclusive() {
        let good = paths(pins::FILES, true)
            .iter()
            .map(|s| format!("/{s}\n"))
            .collect::<String>();
        listing(good.as_bytes()).unwrap();
        for bad in [
            good.clone() + "/usr/extra\n",
            good.clone() + "/usr\n",
            good.replacen("/usr\n", "", 1),
            good.replace("/usr\n", "/usr/../usr\n"),
        ] {
            assert!(listing(bad.as_bytes()).is_err());
        }
        let p = &pins::FILES[0];
        owner(format!("{}: /{}\n", pins::PACKAGE, p.path).as_bytes(), p).unwrap();
        for who in [
            "other",
            "creator-works-mcp, other",
            "diversion by creator-works-mcp",
            "creator-works-mcp:arm64",
        ] {
            assert!(owner(format!("{who}: /{}\n", p.path).as_bytes(), p).is_err());
        }
    }
    #[test]
    fn streams_reject_tamper_short_and_long_inputs() {
        let p = pins::Pin {
            path: "usr/test",
            bytes: 3,
            mode: 0o644,
            sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            md5: "unused",
            retained: true,
        };
        let mut out = Vec::new();
        copy_pinned(&b"abc"[..], &mut out, &p).unwrap();
        assert_eq!(out, b"abc");
        for bad in [&b"ab"[..], &b"abd"[..], &b"abcd"[..]] {
            assert!(copy_pinned(bad, std::io::sink(), &p).is_err());
        }
    }
    #[test]
    fn controls_are_fixed_scriptless_and_preserve_both_original_nodes() {
        assert_eq!(pins::FILES.len(), 14);
        assert_eq!(pins::FILES.iter().filter(|p| p.retained).count(), 9);
        assert_eq!(md5sums().lines().count(), 9);
        assert!(control().contains("Installed-Size: 242888\n"));
        assert!(control().contains("TEST ONLY"));
        assert!(pins::FILES
            .iter()
            .any(|p| p.retained && p.path.ends_with("runtime/node.exe")));
    }

    #[test]
    fn private_stage_names_are_finite_and_do_not_authorize_reuse() {
        assert!(stage_name("mcp-2.7.7-preparation"));
        assert!(stage_name(
            "mcp-2.7.7-preparation-0123456789abcdef0123456789abcdef"
        ));
        for bad in [
            "/tmp/candidate.deb",
            "mcp-2.7.7-preparation-..",
            "mcp-2.7.7-preparation-ABCDEF0123456789abcdef0123456789",
            "transaction-attempted",
            "mcp-2.7.8-preparation-0123456789abcdef0123456789abcdef",
        ] {
            assert!(!stage_name(bad));
        }
    }

    #[test]
    fn manual_repair_reports_do_not_claim_an_unstarted_or_unknown_transaction_was_installed() {
        for started in [None, Some(false), Some(true)] {
            let error = ManualRepair {
                reason: "fixture".into(),
                started,
            };
            let report = refusal(&error);
            assert_eq!(report["status"], "manual-repair-required");
            assert_eq!(
                report["packageTransactionStarted"],
                serde_json::json!(started)
            );
            assert_eq!(report["packageTransactionMayHaveStarted"], true);
            assert_eq!(report["manualRepairRequired"], true);
            assert_eq!(report["nativeAcceptance"], false);
        }
    }
}
