//! Finite production contract. A helper postcheck is never release qualification.
use crate::{metadata::Target, pins, require, Result};
use serde_json::{json, Value};

pub const PROTOCOL: u32 = 2;
pub const COHORT: &str = "creator-hub-deb-retirement-016-v1";
pub const MCP_NEW: &str = "2.7.7-1+hub.retention016.1";

fn envelope(status: &str) -> Value {
    json!({ "protocolVersion": PROTOCOL, "cohort": COHORT, "mode": "production",
        "status": status, "nativeAcceptance": false, "externalQualificationRequired": true })
}

pub fn mcp_control() -> String {
    format!("Package: {}\nVersion: {MCP_NEW}\nArchitecture: amd64\nMaintainer: Creator Works\nPriority: optional\nDepends: libwebkit2gtk-4.1-0, libgtk-3-0\nInstalled-Size: {}\nDescription: Creator Hub retained MCP 2.7.7 runtime\n Original runtime retained at its existing paths; standalone GUI entries removed.\n",
        pins::PACKAGE, crate::retained().iter().map(|pin| pin.bytes).sum::<u64>().div_ceil(1024))
}

pub fn mcp_compatibility_state(bytes: &[u8]) -> Result<()> {
    require(
        bytes
            == format!(
                "{}\t{MCP_NEW}\tamd64\tinstall ok installed\n",
                pins::PACKAGE
            )
            .as_bytes(),
        "Exact healthy production MCP compatibility package required",
    )
}

#[cfg(any(target_os = "linux", test))]
pub fn mcp_installed_metadata(bytes: &[u8], compatibility: bool) -> Result<()> {
    if !compatibility {
        return crate::installed_metadata(bytes, false);
    }
    require(bytes == b"242888\nCreator Works\noptional\nlibwebkit2gtk-4.1-0, libgtk-3-0\nCreator Hub retained MCP 2.7.7 runtime\n Original runtime retained at its existing paths; standalone GUI entries removed.\nno",
        "Production MCP control/relationships/triggers changed")
}

pub fn inspection(target: Target, retained: bool) -> Value {
    let (product, package, version) = match target {
        Target::Mcp => (
            "mcp",
            pins::PACKAGE,
            if retained { MCP_NEW } else { pins::OLD },
        ),
        Target::Setup => (
            "setup",
            setup::PACKAGE,
            if retained { setup::NEW } else { setup::OLD },
        ),
    };
    let mut report = envelope(if retained {
        "inspected-retained-read-only"
    } else {
        "inspected-read-only"
    });
    report.as_object_mut().unwrap().extend(
        json!({ "product": product, "package": package,
        "packageState": if retained { "compatibility" } else { "original" }, "version": version,
        "readOnly": true, "baselineMatches": !retained, "compatibilityMatches": retained,
        "snapshotAuthoritative": false, "packageTransactionStarted": false,
        "retainedFilesVerified": if retained && target == Target::Mcp { 9 } else { 0 },
        "tombstoneFilesVerified": if retained && target == Target::Setup { 1 } else { 0 },
        "omittedFilesVerified": if retained { 5 } else { 0 } })
        .as_object()
        .unwrap()
        .clone(),
    );
    report
}

#[cfg(any(all(target_os = "linux", feature = "production-transaction"), test))]
pub(crate) fn prepared(candidate: &std::path::Path) -> Value {
    let mut report = envelope("prepared-not-installed");
    report["candidate"] = json!(candidate);
    report["packageTransactionStarted"] = json!(false);
    report
}

#[cfg(any(all(target_os = "linux", feature = "production-transaction"), test))]
pub(crate) fn completion(target: Target, candidate: &std::path::Path) -> Value {
    let mut report = envelope("transaction-postchecked");
    let (product, package, version) = match target {
        Target::Mcp => ("mcp", pins::PACKAGE, MCP_NEW),
        Target::Setup => ("setup", setup::PACKAGE, setup::NEW),
    };
    report.as_object_mut().unwrap().extend(json!({ "product": product, "package": package,
        "candidate": candidate, "version": version, "packageTransactionStarted": true,
        "manualRepairRequired": false, "retainedFilesVerified": if target == Target::Mcp { 9 } else { 0 },
        "tombstoneFilesVerified": if target == Target::Setup { 1 } else { 0 }, "omittedFilesVerified": 5,
        "retryPolicy": "attempt marker retained; no automatic retry" }).as_object().unwrap().clone());
    report
}

#[cfg(any(feature = "production-transaction", test))]
pub(crate) fn refusal(
    error: &dyn std::fmt::Display,
    manual: Option<&crate::ManualRepair>,
) -> Value {
    let mut report = envelope(if manual.is_some() {
        "manual-repair-required"
    } else {
        "refused"
    });
    report.as_object_mut().unwrap().extend(json!({ "reason": error.to_string(),
        "packageTransactionStarted": manual.map(|m| m.started).unwrap_or(Some(false)),
        "packageTransactionMayHaveStarted": manual.is_some(), "manualRepairRequired": manual.is_some()
    }).as_object().unwrap().clone());
    report
}

pub mod setup {
    use super::*;
    pub use crate::setup::{
        stage_name, PackageState, FILES, MD5_SHA256, NOTICE_ROOT, OLD, PACKAGE, PRIVATE,
    };
    pub const NEW: &str = "0.3.7-1+hub.retention016.1";
    pub const NOTICE: &[u8] = b"Creator Project Setup 0.3.7 GUI retired by Creator Hub.\nUser settings, Unity projects, caches and client configuration are preserved.\n";
    pub const TOMBSTONE: &[pins::Pin] = &[pins::Pin {
        path: "usr/share/creator-project-setup/retired-by-creator-hub.txt",
        bytes: NOTICE.len() as u64,
        mode: 0o644,
        sha256: "a04ca21391c408ec055d22ba7defecd8278a0682e0d398538d77fbfb3605c5bb",
        md5: "376aea48d74151e59b407c3d71bbad3c",
        retained: true,
    }];

    pub fn control() -> String {
        format!("Package: {PACKAGE}\nVersion: {NEW}\nArchitecture: amd64\nMaintainer: Creator Works\nPriority: optional\nInstalled-Size: 1\nDescription: Creator Project Setup retired by Creator Hub\n User settings and projects are preserved; standalone GUI entries removed.\n")
    }
    pub fn md5sums() -> String {
        format!("{}  {}\n", TOMBSTONE[0].md5, TOMBSTONE[0].path)
    }
    pub fn state(bytes: &[u8], compatibility: bool) -> Result<()> {
        if !compatibility {
            return crate::setup::state(bytes, false);
        }
        require(
            bytes == format!("{PACKAGE}\t{NEW}\tamd64\tinstall ok installed\n").as_bytes(),
            "Exact healthy production Setup compatibility package required",
        )
    }
    pub fn installed_metadata(bytes: &[u8], compatibility: bool) -> Result<()> {
        if !compatibility {
            return crate::setup::installed_metadata(bytes, false);
        }
        require(bytes == b"1\nCreator Works\noptional\n\nCreator Project Setup retired by Creator Hub\n User settings and projects are preserved; standalone GUI entries removed.\nno",
            "Production Setup control/relationships/triggers changed")
    }
    pub fn listing(bytes: &[u8], compatibility: bool) -> Result<()> {
        crate::listing_for(
            bytes,
            if compatibility { TOMBSTONE } else { FILES },
            compatibility,
        )
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
    pub fn inspection_report(state: PackageState) -> Value {
        let mut report = inspection(Target::Setup, state == PackageState::Compatibility);
        if state == PackageState::Absent {
            report["packageState"] = json!("absent");
            report["version"] = Value::Null;
            report["baselineMatches"] = json!(false);
        }
        report
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_cohort_and_public_pins_remain_frozen() {
        assert_eq!(pins::NEW, "2.7.7-1+hub.retention014.1");
        assert_eq!(crate::setup::NEW, "0.3.7-1+hub.retention014.1");
        assert_eq!(
            crate::sha256(crate::control().as_bytes()),
            "7f10ab22085114c37d99e8a6283fc2bcd1900d8017981694d98cab9900527236"
        );
        assert_eq!(
            crate::sha256(crate::setup::control().as_bytes()),
            "2d351ca73c20e7109888eb52de5b0cbf37bd568bc480845a0c4c68cae0577dc6"
        );
        assert_eq!(
            crate::sha256(crate::setup::NOTICE),
            "a78a28ee51d81f81ae96c18c47fef7e66034262a59c9d189497c6e39043f5307"
        );
        assert_eq!(crate::retained().len(), 9);
        assert_eq!(setup::FILES.len(), 5);
    }

    #[test]
    fn production_packages_cannot_alias_development_or_self_qualify() {
        assert_ne!(MCP_NEW, pins::NEW);
        assert_ne!(setup::NEW, crate::setup::NEW);
        for control in [mcp_control(), setup::control()] {
            assert!(!control.contains("TEST ONLY"));
            assert!(!control.contains("Validation"));
            assert!(control.contains("retention016.1"));
        }
        assert_eq!(crate::sha256(setup::NOTICE), setup::TOMBSTONE[0].sha256);
        assert_eq!(setup::TOMBSTONE[0].mode, 0o644);
        assert!(mcp_compatibility_state(
            format!(
                "{}\t{}\tamd64\tinstall ok installed\n",
                pins::PACKAGE,
                pins::NEW
            )
            .as_bytes()
        )
        .is_err());
        assert!(setup::state(
            format!(
                "{}\t{}\tamd64\tinstall ok installed\n",
                setup::PACKAGE,
                crate::setup::NEW
            )
            .as_bytes(),
            true
        )
        .is_err());
        for target in [Target::Mcp, Target::Setup] {
            let report = completion(target, std::path::Path::new("/fixed-test-candidate"));
            assert_eq!(report["status"], "transaction-postchecked");
            assert_eq!(report["nativeAcceptance"], false);
            assert_eq!(report["externalQualificationRequired"], true);
            assert!(report.get("installationEnabled").is_none());
            assert!(report.get("experimentalTransactionCompiled").is_none());
        }
    }

    #[test]
    fn production_metadata_and_states_admit_only_the_exact_distinct_packages() {
        for (package, version, validate) in [
            (
                pins::PACKAGE,
                MCP_NEW,
                mcp_compatibility_state as fn(&[u8]) -> Result<()>,
            ),
            (
                setup::PACKAGE,
                setup::NEW,
                (|bytes| setup::state(bytes, true)) as fn(&[u8]) -> Result<()>,
            ),
        ] {
            let good = format!("{package}\t{version}\tamd64\tinstall ok installed\n");
            validate(good.as_bytes()).unwrap();
            for bad in [
                good.replace("amd64", "arm64"),
                good.replace("install ok", "hold ok"),
                good.replace("installed", "unpacked"),
                good.replace(package, "other-package"),
                good.replace(version, "latest"),
                format!("{good}{good}"),
            ] {
                assert!(validate(bad.as_bytes()).is_err());
            }
        }
        for (metadata, validate) in [
            ("242888\nCreator Works\noptional\nlibwebkit2gtk-4.1-0, libgtk-3-0\nCreator Hub retained MCP 2.7.7 runtime\n Original runtime retained at its existing paths; standalone GUI entries removed.\nno",
                mcp_installed_metadata as fn(&[u8], bool) -> Result<()>),
            ("1\nCreator Works\noptional\n\nCreator Project Setup retired by Creator Hub\n User settings and projects are preserved; standalone GUI entries removed.\nno",
                setup::installed_metadata as fn(&[u8], bool) -> Result<()>),
        ] {
            validate(metadata.as_bytes(), true).unwrap();
            assert!(validate(metadata.as_bytes(), false).is_err());
            assert!(validate(metadata.trim_end_matches("no").as_bytes(), true).is_err());
            assert!(validate(format!("{metadata}extra-relationship").as_bytes(), true).is_err());
        }
        for (version, expected) in [
            (setup::OLD, setup::PackageState::Original),
            (setup::NEW, setup::PackageState::Compatibility),
        ] {
            let state = format!(
                "{}\t{version}\tamd64\tinstall ok installed\n",
                setup::PACKAGE
            );
            assert_eq!(
                setup::query_state(0, state.as_bytes(), b"").unwrap(),
                expected
            );
            assert!(setup::query_state(0, state.as_bytes(), b"warning").is_err());
        }
    }

    #[test]
    fn production_notice_has_no_scripts_relationships_or_user_data_payload() {
        assert_eq!(setup::TOMBSTONE.len(), 1);
        assert_eq!(
            setup::TOMBSTONE[0].path,
            "usr/share/creator-project-setup/retired-by-creator-hub.txt"
        );
        assert_eq!(setup::NOTICE.len(), setup::TOMBSTONE[0].bytes as usize);
        assert_eq!(setup::md5sums(), "376aea48d74151e59b407c3d71bbad3c  usr/share/creator-project-setup/retired-by-creator-hub.txt\n");
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
            assert!(!setup::control().contains(field));
        }
        assert!(!setup::NOTICE
            .windows(b"TEST ONLY".len())
            .any(|bytes| bytes == b"TEST ONLY"));
        let list = crate::paths(setup::TOMBSTONE, true)
            .iter()
            .map(|path| format!("/{path}\n"))
            .collect::<String>();
        let list = format!("/.\n{list}");
        setup::listing(list.as_bytes(), true).unwrap();
        assert!(setup::listing(
            format!("{list}/home/fixture/settings.json\n").as_bytes(),
            true
        )
        .is_err());
        assert!(setup::listing(list.as_bytes(), false).is_err());
    }

    #[test]
    fn preparation_and_uncertain_refusals_never_claim_postchecks_or_qualification() {
        let prepared = prepared(std::path::Path::new("/fixed-test-candidate"));
        assert_eq!(prepared["status"], "prepared-not-installed");
        assert_eq!(prepared["packageTransactionStarted"], false);
        assert_eq!(prepared["nativeAcceptance"], false);
        assert_eq!(prepared["externalQualificationRequired"], true);
        let refused = refusal(&"before transaction", None);
        assert_eq!(refused["status"], "refused");
        assert_eq!(refused["packageTransactionStarted"], false);
        assert_eq!(refused["packageTransactionMayHaveStarted"], false);
        assert_eq!(refused["manualRepairRequired"], false);
        for started in [Some(false), Some(true), None] {
            let manual = crate::ManualRepair {
                started,
                reason: "interrupted".into(),
            };
            let report = refusal(&manual, Some(&manual));
            assert_eq!(report["status"], "manual-repair-required");
            assert_eq!(report["packageTransactionStarted"], json!(started));
            assert_eq!(report["packageTransactionMayHaveStarted"], true);
            assert_eq!(report["manualRepairRequired"], true);
            assert_eq!(report["nativeAcceptance"], false);
            assert_eq!(report["externalQualificationRequired"], true);
        }
    }

    #[test]
    fn actual_helper_reports_match_the_strict_root_production_parser() {
        use crate::root_protocol as root;
        for (target, root_target, candidate) in [
            (Target::Mcp, root::Target::Mcp, "/var/lib/creator-hub-deb-retirement/mcp-2.7.7-preparation-0123456789abcdef0123456789abcdef/runtime-only.deb"),
            (Target::Setup, root::Target::Setup, "/var/lib/creator-hub-deb-retirement-setup/setup-0.3.7-preparation-0123456789abcdef0123456789abcdef/gui-tombstone.deb"),
        ] {
            for retained in [false, true] {
                root::production_inspect_response(root_target, &serde_json::to_vec(&inspection(target, retained)).unwrap(), retained).unwrap();
            }
            let output = root::Capture { bytes:serde_json::to_vec(&completion(target, std::path::Path::new(candidate))).unwrap(), exceeded:false };
            assert_eq!(root::production_retire_response(root_target, Some(0), &output).unwrap(), root::Outcome::ExperimentalVerified);
        }
        let absent = setup::inspection_report(setup::PackageState::Absent);
        assert!(root::production_inspect_response(
            root::Target::Setup,
            &serde_json::to_vec(&absent).unwrap(),
            false
        )
        .is_err());
    }
}
