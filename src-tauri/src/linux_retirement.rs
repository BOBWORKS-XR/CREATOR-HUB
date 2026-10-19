//! Linux-only client for the finite, protected DEB helper. Not release authority.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]
use serde::Deserialize;
use std::{io::Read, process::Command};

const HELPER: &str = "/usr/libexec/creator-hub-deb-retirement-helper";
const PKEXEC: &str = "/usr/bin/pkexec";
const LIMIT: usize = 64 * 1024;

/// Native-only finite targets. No command, version or path is supplied by a caller.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    Mcp,
    Setup,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    Inspect,
    InspectRetained,
    Retire,
}

fn command(target: Target, action: Action) -> Command {
    let argument = match (target, action) {
        (Target::Mcp, Action::Inspect) => "inspect",
        (Target::Mcp, Action::InspectRetained) => "inspect-retained-mcp-2.7.7",
        (Target::Mcp, Action::Retire) => "retire-mcp-2.7.7",
        (Target::Setup, Action::Inspect) => "inspect-setup-0.3.7",
        (Target::Setup, Action::InspectRetained) => "inspect-retained-setup-0.3.7",
        (Target::Setup, Action::Retire) => "retire-setup-0.3.7",
    };
    let mut cmd = if action == Action::Retire {
        let mut cmd = Command::new(PKEXEC);
        cmd.args(["--disable-internal-agent", HELPER, argument]);
        cmd
    } else {
        let mut cmd = Command::new(HELPER);
        cmd.arg(argument);
        cmd
    };
    cmd.env_clear()
        .current_dir("/")
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .env("LANG", "C")
        .env("LC_ALL", "C");
    cmd
}

pub(crate) struct Capture {
    pub(crate) bytes: Vec<u8>,
    pub(crate) exceeded: bool,
}

fn capture(mut reader: impl Read) -> std::io::Result<Capture> {
    let mut result = Capture {
        bytes: Vec::new(),
        exceeded: false,
    };
    let mut buffer = [0; 8192];
    loop {
        let count = match reader.read(&mut buffer) {
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            other => other?,
        };
        if count == 0 {
            return Ok(result);
        }
        let keep = count.min(LIMIT - result.bytes.len());
        result.bytes.extend_from_slice(&buffer[..keep]);
        result.exceeded |= keep != count;
        // Drain both pipes to EOF. Never kill an authorized package transaction
        // because a diagnostic exceeded the capture bound.
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Inspection {
    status: String,
    baseline_matches: bool,
    snapshot_authoritative: bool,
    installation_enabled: bool,
    package_transaction_started: bool,
    experimental_transaction_compiled: bool,
    native_acceptance: bool,
    blocker: String,
}

fn inspect_response(target: Target, bytes: &[u8]) -> Result<(), String> {
    #[cfg(all(target_os = "linux", feature = "linux-production-migration"))]
    {
        production_inspect_response(target, bytes, false)
    }
    #[cfg(not(all(target_os = "linux", feature = "linux-production-migration")))]
    {
        inspect_development_response(target, bytes)
    }
}

fn inspect_development_response(target: Target, bytes: &[u8]) -> Result<(), String> {
    if target == Target::Setup {
        return setup_inspection_response(bytes, false);
    }
    let value: Inspection = serde_json::from_slice(bytes)
        .map_err(|_| "The Linux migration helper returned an unknown inspection protocol.")?;
    if value.status != "inspected-read-only"
        || !value.baseline_matches
        || value.snapshot_authoritative
        || value.installation_enabled
        || value.package_transaction_started
        || !value.experimental_transaction_compiled
        || value.native_acceptance
        || value.blocker.is_empty()
    {
        return Err(
            "This helper has no accepted experimental MCP retirement baseline. Apps were kept."
                .into(),
        );
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RetainedInspection {
    status: String,
    product: String,
    package: String,
    package_state: String,
    version: String,
    read_only: bool,
    baseline_matches: bool,
    compatibility_matches: bool,
    snapshot_authoritative: bool,
    installation_enabled: bool,
    experimental_transaction_compiled: bool,
    package_transaction_started: bool,
    native_acceptance: bool,
    retained_files_verified: u32,
    omitted_files_verified: u32,
}

fn retained_response(target: Target, bytes: &[u8]) -> Result<(), String> {
    #[cfg(all(target_os = "linux", feature = "linux-production-migration"))]
    {
        production_inspect_response(target, bytes, true)
    }
    #[cfg(not(all(target_os = "linux", feature = "linux-production-migration")))]
    {
        retained_development_response(target, bytes)
    }
}

fn retained_development_response(target: Target, bytes: &[u8]) -> Result<(), String> {
    if target == Target::Setup {
        return setup_inspection_response(bytes, true);
    }
    let value: RetainedInspection = serde_json::from_slice(bytes).map_err(|_| {
        "Cannot verify the retained MCP package after cleanup. Keep recovery records."
    })?;
    if value.status != "inspected-retained-read-only"
        || value.product != "mcp"
        || value.package != "creator-works-mcp"
        || value.package_state != "compatibility"
        || value.version != "2.7.7-1+hub.retention014.1"
        || !value.read_only
        || value.baseline_matches
        || !value.compatibility_matches
        || value.snapshot_authoritative
        || value.installation_enabled
        || !value.experimental_transaction_compiled
        || value.package_transaction_started
        || value.native_acceptance
        || value.retained_files_verified != 9
        || value.omitted_files_verified != 5
    {
        return Err("The retained MCP package did not match its independent postcheck. Keep files and review package state before retrying.".into());
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Completion {
    status: String,
    experimental_transaction_compiled: bool,
    installation_enabled: bool,
    package_transaction_started: bool,
    manual_repair_required: bool,
    native_acceptance: bool,
    candidate: String,
    version: String,
    retained_files_verified: u32,
    omitted_files_verified: u32,
    retry_policy: String,
}

// Setup has a distinct wire contract: zero retained runtime files and exactly
// one fixed non-executable notice. Do not default missing fields or accept the
// MCP protocol as a Setup result (or vice versa).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetupInspection {
    status: String,
    product: String,
    package: String,
    package_state: String,
    version: String,
    read_only: bool,
    baseline_matches: bool,
    compatibility_matches: bool,
    snapshot_authoritative: bool,
    installation_enabled: bool,
    experimental_transaction_compiled: bool,
    package_transaction_started: bool,
    native_acceptance: bool,
    tombstone_files_verified: u32,
    omitted_files_verified: u32,
}

fn setup_inspection_response(bytes: &[u8], retained: bool) -> Result<(), String> {
    let value: SetupInspection = serde_json::from_slice(bytes)
        .map_err(|_| "The Linux helper returned an unknown Setup inspection protocol.")?;
    if value.status
        != if retained {
            "inspected-retained-read-only"
        } else {
            "inspected-read-only"
        }
        || value.product != "setup"
        || value.package != "creator-project-setup"
        || value.package_state
            != if retained {
                "compatibility"
            } else {
                "original"
            }
        || value.version
            != if retained {
                "0.3.7-1+hub.retention014.1"
            } else {
                "0.3.7"
            }
        || !value.read_only
        || value.baseline_matches != !retained
        || value.compatibility_matches != retained
        || value.snapshot_authoritative
        || value.installation_enabled
        || !value.experimental_transaction_compiled
        || value.package_transaction_started
        || value.native_acceptance
        || value.tombstone_files_verified != u32::from(retained)
        || value.omitted_files_verified != if retained { 5 } else { 0 }
    {
        return Err("The exact Setup 0.3.7 package or notice did not match its independent inspection. Keep recovery records; no automatic retry is allowed.".into());
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetupCompletion {
    status: String,
    product: String,
    package: String,
    experimental_transaction_compiled: bool,
    installation_enabled: bool,
    package_transaction_started: bool,
    manual_repair_required: bool,
    native_acceptance: bool,
    candidate: String,
    version: String,
    retained_files_verified: u32,
    tombstone_files_verified: u32,
    omitted_files_verified: u32,
    retry_policy: String,
}

fn setup_development_completion_response(bytes: &[u8]) -> Result<Outcome, String> {
    let value: SetupCompletion = serde_json::from_slice(bytes).map_err(|_| {
        "The Setup cleanup result is unknown. Keep recovery records; do not retry automatically."
    })?;
    if value.status != "experimental-transaction-verified"
        || value.product != "setup"
        || value.package != "creator-project-setup"
        || !value.experimental_transaction_compiled
        || value.installation_enabled
        || !value.package_transaction_started
        || value.manual_repair_required
        || value.native_acceptance
        || value.version != "0.3.7-1+hub.retention014.1"
        || value.retained_files_verified != 0
        || value.tombstone_files_verified != 1
        || value.omitted_files_verified != 5
        || !value
            .candidate
            .starts_with("/var/lib/creator-hub-deb-retirement-setup/")
        || value.retry_policy != "attempt marker retained; no automatic retry"
    {
        return Err("The helper did not verify the exact Setup retirement notice and omitted GUI files. Keep recovery records; do not retry automatically.".into());
    }
    Ok(Outcome::ExperimentalVerified)
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Cancelled,
    // Historical internal name shared by the coordinators. Either protocol's
    // success means only verified helper postchecks, never release acceptance.
    ExperimentalVerified,
}

fn retire_response(target: Target, code: Option<i32>, output: &Capture) -> Result<Outcome, String> {
    #[cfg(all(target_os = "linux", feature = "linux-production-migration"))]
    {
        production_retire_response(target, code, output)
    }
    #[cfg(not(all(target_os = "linux", feature = "linux-production-migration")))]
    {
        retire_development_response(target, code, output)
    }
}

fn retire_development_response(
    target: Target,
    code: Option<i32>,
    output: &Capture,
) -> Result<Outcome, String> {
    if code == Some(126) {
        return Ok(Outcome::Cancelled);
    }
    if code == Some(127) {
        return Err("System authorization was unavailable or refused. The cleanup record remains pending for manual package-state review even if the original package is still installed. No fallback password prompt or automatic retry was opened; no saved transaction may be replayed.".into());
    }
    if code != Some(0) || output.exceeded {
        return Err("Standalone cleanup did not report a verified completion. A transaction may have started. Keep all settings, backups and retained runtimes; review the system package manager before retrying.".into());
    }
    if target == Target::Setup {
        return setup_development_completion_response(&output.bytes);
    }
    let value: Completion = serde_json::from_slice(&output.bytes)
        .map_err(|_| "The cleanup result is unknown. Keep retained files and review package state; do not automatically retry.")?;
    if value.status != "experimental-transaction-verified"
        || !value.experimental_transaction_compiled
        || value.installation_enabled
        || !value.package_transaction_started
        || value.manual_repair_required
        || value.native_acceptance
        || value.version != "2.7.7-1+hub.retention014.1"
        || value.retained_files_verified != 9
        || value.omitted_files_verified != 5
        || !value
            .candidate
            .starts_with("/var/lib/creator-hub-deb-retirement/")
        || value.retry_policy != "attempt marker retained; no automatic retry"
    {
        return Err("The helper did not verify the expected retained MCP runtime. Keep recovery records and review package state; do not automatically retry.".into());
    }
    Ok(Outcome::ExperimentalVerified)
}

const PRODUCTION_COHORT: &str = "creator-hub-deb-retirement-016-v1";

fn production_identity(
    protocol: u32,
    cohort: &str,
    mode: &str,
    accepted: bool,
    qualification_required: bool,
) -> Result<(), String> {
    if protocol != 2
        || cohort != PRODUCTION_COHORT
        || mode != "production"
        || accepted
        || !qualification_required
    {
        return Err("Unknown production helper cohort or self-certified acceptance. Existing apps and recovery records were kept.".into());
    }
    Ok(())
}

fn production_target(target: Target, retained: bool) -> (&'static str, &'static str, &'static str) {
    match (target, retained) {
        (Target::Mcp, false) => ("mcp", "creator-works-mcp", "2.7.7"),
        (Target::Mcp, true) => ("mcp", "creator-works-mcp", "2.7.7-1+hub.retention016.1"),
        (Target::Setup, false) => ("setup", "creator-project-setup", "0.3.7"),
        (Target::Setup, true) => (
            "setup",
            "creator-project-setup",
            "0.3.7-1+hub.retention016.1",
        ),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProductionInspection {
    protocol_version: u32,
    cohort: String,
    mode: String,
    status: String,
    native_acceptance: bool,
    external_qualification_required: bool,
    product: String,
    package: String,
    package_state: String,
    version: String,
    read_only: bool,
    baseline_matches: bool,
    compatibility_matches: bool,
    snapshot_authoritative: bool,
    package_transaction_started: bool,
    retained_files_verified: u32,
    tombstone_files_verified: u32,
    omitted_files_verified: u32,
}

pub(crate) fn production_inspect_response(
    target: Target,
    bytes: &[u8],
    retained: bool,
) -> Result<(), String> {
    let value: ProductionInspection = serde_json::from_slice(bytes)
        .map_err(|_| "The installed helper did not return the strict production inspection protocol. No development fallback was used.")?;
    production_identity(
        value.protocol_version,
        &value.cohort,
        &value.mode,
        value.native_acceptance,
        value.external_qualification_required,
    )?;
    let (product, package, version) = production_target(target, retained);
    if value.status
        != if retained {
            "inspected-retained-read-only"
        } else {
            "inspected-read-only"
        }
        || value.product != product
        || value.package != package
        || value.version != version
        || value.package_state
            != if retained {
                "compatibility"
            } else {
                "original"
            }
        || !value.read_only
        || value.baseline_matches != !retained
        || value.compatibility_matches != retained
        || value.snapshot_authoritative
        || value.package_transaction_started
        || value.retained_files_verified
            != if retained && target == Target::Mcp {
                9
            } else {
                0
            }
        || value.tombstone_files_verified
            != if retained && target == Target::Setup {
                1
            } else {
                0
            }
        || value.omitted_files_verified != if retained { 5 } else { 0 }
    {
        return Err("Production helper inspection did not verify the exact admitted package and postcheck counts. Apps were kept.".into());
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProductionCompletion {
    protocol_version: u32,
    cohort: String,
    mode: String,
    status: String,
    native_acceptance: bool,
    external_qualification_required: bool,
    product: String,
    package: String,
    version: String,
    candidate: String,
    package_transaction_started: bool,
    manual_repair_required: bool,
    retained_files_verified: u32,
    tombstone_files_verified: u32,
    omitted_files_verified: u32,
    retry_policy: String,
}

fn production_candidate(target: Target, candidate: &str) -> bool {
    let (prefix, suffix) = match target {
        Target::Mcp => (
            "/var/lib/creator-hub-deb-retirement/mcp-2.7.7-preparation-",
            "/runtime-only.deb",
        ),
        Target::Setup => (
            "/var/lib/creator-hub-deb-retirement-setup/setup-0.3.7-preparation-",
            "/gui-tombstone.deb",
        ),
    };
    candidate
        .strip_prefix(prefix)
        .and_then(|value| value.strip_suffix(suffix))
        .is_some_and(|nonce| {
            nonce.len() == 32
                && nonce
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        })
}

pub(crate) fn production_retire_response(
    target: Target,
    code: Option<i32>,
    output: &Capture,
) -> Result<Outcome, String> {
    if code == Some(126) {
        return Ok(Outcome::Cancelled);
    }
    if code == Some(127) {
        return Err("System authorization was unavailable or refused. Keep the pending record for manual review; no fallback or automatic retry was opened.".into());
    }
    if code != Some(0) || output.exceeded {
        return Err("Production cleanup outcome is unknown. Keep settings, retained runtime and recovery records; do not retry automatically.".into());
    }
    let value: ProductionCompletion = serde_json::from_slice(&output.bytes)
        .map_err(|_| "The helper did not return the strict production postcheck protocol. No development fallback was used.")?;
    production_identity(
        value.protocol_version,
        &value.cohort,
        &value.mode,
        value.native_acceptance,
        value.external_qualification_required,
    )?;
    let (product, package, version) = production_target(target, true);
    if value.status != "transaction-postchecked"
        || value.product != product
        || value.package != package
        || value.version != version
        || !production_candidate(target, &value.candidate)
        || !value.package_transaction_started
        || value.manual_repair_required
        || value.retained_files_verified != if target == Target::Mcp { 9 } else { 0 }
        || value.tombstone_files_verified != if target == Target::Setup { 1 } else { 0 }
        || value.omitted_files_verified != 5
        || value.retry_policy != "attempt marker retained; no automatic retry"
    {
        return Err("The production helper did not verify the exact retained package. Keep recovery records; do not replay cleanup.".into());
    }
    Ok(Outcome::ExperimentalVerified)
}

#[cfg(target_os = "linux")]
mod native {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::{
        fs::OpenOptions,
        io,
        os::unix::fs::{MetadataExt, OpenOptionsExt},
        path::Path,
        process::Stdio,
        thread,
    };

    #[derive(PartialEq, Eq)]
    struct Image {
        stamp: (u64, u64, u64, u32, i64, i64, i64, i64),
        hash: String,
    }

    fn stamp(meta: &std::fs::Metadata) -> (u64, u64, u64, u32, i64, i64, i64, i64) {
        (
            meta.dev(),
            meta.ino(),
            meta.len(),
            meta.mode(),
            meta.mtime(),
            meta.mtime_nsec(),
            meta.ctime(),
            meta.ctime_nsec(),
        )
    }

    fn image(path: &Path, helper: bool) -> Result<Image, String> {
        for parent in path.ancestors().skip(1) {
            let meta = parent
                .symlink_metadata()
                .map_err(|_| "Cannot inspect the protected helper directory.")?;
            if !meta.is_dir() || meta.uid() != 0 || meta.gid() != 0 || meta.mode() & 0o7022 != 0 {
                return Err(
                    "The migration helper directory is not protected. Apps were kept.".into(),
                );
            }
        }
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(path)
            .map_err(|_| {
                "The protected Linux migration helper or system authorization is not installed."
            })?;
        let before = file
            .metadata()
            .map_err(|_| "Cannot inspect the migration helper image.")?;
        if !before.is_file()
            || before.uid() != 0
            || before.gid() != 0
            || before.mode() & 0o022 != 0
            || before.mode() & 0o111 == 0
            || before.len() == 0
            || before.len() > 32 * 1024 * 1024
            || helper && (before.nlink() != 1 || before.mode() & 0o7000 != 0)
        {
            return Err(
                "The installed helper or authorization image is not protected. Apps were kept."
                    .into(),
            );
        }
        let mut hash = Sha256::new();
        let mut count = 0u64;
        let mut buffer = [0u8; 65536];
        loop {
            let size = match file.read(&mut buffer) {
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                other => other.map_err(|_| "Cannot fingerprint the protected helper image.")?,
            };
            if size == 0 {
                break;
            }
            count += size as u64;
            if count > before.len() {
                return Err("The helper image changed while reading.".into());
            }
            hash.update(&buffer[..size]);
        }
        let after = file
            .metadata()
            .map_err(|_| "Cannot recheck the helper image.")?;
        let named = path
            .symlink_metadata()
            .map_err(|_| "The helper path changed while checking.")?;
        if count != before.len()
            || stamp(&before) != stamp(&after)
            || stamp(&before) != stamp(&named)
            || named.file_type().is_symlink()
        {
            return Err("The helper image changed while checking. Apps were kept.".into());
        }
        Ok(Image {
            stamp: stamp(&before),
            hash: format!("{:x}", hash.finalize()),
        })
    }

    fn run(target: Target, action: Action) -> Result<(Option<i32>, Capture), String> {
        let mut cmd = command(target, action);
        let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .spawn().map_err(|_| "The migration helper could not start. No fallback or automatic retry was attempted.")?;
        let stdout = child.stdout.take().expect("configured stdout pipe");
        let stderr = child.stderr.take().expect("configured stderr pipe");
        let out = thread::spawn(move || capture(stdout));
        let err = thread::spawn(move || capture(stderr));
        // No timeout, kill, or second launch while the helper owns dpkg locks.
        let status = loop {
            match child.wait() {
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                other => break other,
            }
        };
        let output = out.join();
        let diagnostic = err.join();
        let unknown = "Migration helper output or exit is unknown. Keep retained files and inspect package state before retrying.";
        let status = status.map_err(|_| unknown)?;
        let output = output.map_err(|_| unknown)?.map_err(|_| unknown)?;
        let diagnostic = diagnostic.map_err(|_| unknown)?.map_err(|_| unknown)?;
        if diagnostic.exceeded {
            return Err(unknown.into());
        }
        Ok((status.code(), output))
    }

    /// Opaque image binding from native inspection, never renderer input.
    pub struct Plan {
        target: Target,
        helper: Image,
        authorization: Image,
    }

    impl Plan {
        fn images(target: Target) -> Result<Self, String> {
            Ok(Self {
                target,
                helper: image(Path::new(HELPER), true)?,
                authorization: image(Path::new(PKEXEC), false)?,
            })
        }

        pub fn inspect(target: Target) -> Result<Self, String> {
            let result = Self::images(target)?;
            let (code, output) = run(target, Action::Inspect)?;
            if code != Some(0) || output.exceeded {
                return Err("The exact standalone DEB baseline could not be verified. No installation was changed.".into());
            }
            inspect_response(target, &output.bytes)?;
            result.recheck_image()?;
            Ok(result)
        }

        pub fn inspect_retained(target: Target) -> Result<Self, String> {
            let result = Self::images(target)?;
            result.verify_retained()?;
            Ok(result)
        }

        pub fn recheck_image(&self) -> Result<(), String> {
            if image(Path::new(HELPER), true)? != self.helper
                || image(Path::new(PKEXEC), false)? != self.authorization
            {
                return Err("The reviewed migration helper or authorization image changed. Check again; no automatic retry is allowed.".into());
            }
            Ok(())
        }

        pub fn recheck_baseline(&self) -> Result<(), String> {
            self.recheck_image()?;
            let (code, output) = run(self.target, Action::Inspect)?;
            if code != Some(0) || output.exceeded {
                return Err(
                    "The reviewed standalone installation changed. Check again before retirement."
                        .into(),
                );
            }
            inspect_response(self.target, &output.bytes)?;
            self.recheck_image()
        }

        /// Caller must already have rechecked backups, routes, client dependencies,
        /// closed GUI state and native approval. This makes one polkit attempt only.
        pub fn retire_after_native_review(&self) -> Result<Outcome, String> {
            self.recheck_baseline()?;
            let (code, output) = run(self.target, Action::Retire)?;
            let outcome = retire_response(self.target, code, &output)?;
            self.recheck_image().map_err(|_| "Helper image changed during cleanup. Completion is unknown; inspect package state before retrying.")?;
            if outcome == Outcome::ExperimentalVerified {
                self.verify_retained()?;
            }
            Ok(outcome)
        }

        pub fn verify_retained(&self) -> Result<(), String> {
            self.recheck_image()?;
            let (code, output) = run(self.target, Action::InspectRetained)?;
            if code != Some(0) || output.exceeded {
                return Err("The helper could not independently verify the retained package after cleanup. Keep recovery records and inspect package state; no automatic retry was attempted.".into());
            }
            retained_response(self.target, &output.bytes)?;
            self.recheck_image()
        }
    }
}

#[cfg(target_os = "linux")]
pub use native::Plan;

#[cfg(test)]
mod tests {
    use super::*;
    use super::{
        inspect_development_response as inspect_response,
        retained_development_response as retained_response,
        retire_development_response as retire_response,
        setup_development_completion_response as setup_completion_response,
    };

    fn production_inspection(target: Target, retained: bool) -> serde_json::Value {
        let (product, package, version) = production_target(target, retained);
        serde_json::json!({ "protocolVersion":2, "cohort":PRODUCTION_COHORT, "mode":"production",
            "status":if retained { "inspected-retained-read-only" } else { "inspected-read-only" },
            "nativeAcceptance":false, "externalQualificationRequired":true,
            "product":product, "package":package, "version":version,
            "packageState":if retained { "compatibility" } else { "original" },
            "readOnly":true, "baselineMatches":!retained, "compatibilityMatches":retained,
            "snapshotAuthoritative":false, "packageTransactionStarted":false,
            "retainedFilesVerified":if retained && target == Target::Mcp {9} else {0},
            "tombstoneFilesVerified":if retained && target == Target::Setup {1} else {0},
            "omittedFilesVerified":if retained {5} else {0} })
    }

    fn production_completion(target: Target) -> serde_json::Value {
        let (product, package, version) = production_target(target, true);
        let candidate = match target {
            Target::Mcp => "/var/lib/creator-hub-deb-retirement/mcp-2.7.7-preparation-0123456789abcdef0123456789abcdef/runtime-only.deb",
            Target::Setup => "/var/lib/creator-hub-deb-retirement-setup/setup-0.3.7-preparation-0123456789abcdef0123456789abcdef/gui-tombstone.deb",
        };
        serde_json::json!({ "protocolVersion":2, "cohort":PRODUCTION_COHORT, "mode":"production",
            "status":"transaction-postchecked", "nativeAcceptance":false, "externalQualificationRequired":true,
            "product":product, "package":package, "version":version, "candidate":candidate,
            "packageTransactionStarted":true, "manualRepairRequired":false,
            "retainedFilesVerified":if target == Target::Mcp {9} else {0},
            "tombstoneFilesVerified":if target == Target::Setup {1} else {0}, "omittedFilesVerified":5,
            "retryPolicy":"attempt marker retained; no automatic retry" })
    }

    #[test]
    fn production_protocol_cannot_adopt_development_or_cross_product_reports() {
        for target in [Target::Mcp, Target::Setup] {
            for retained in [false, true] {
                let bytes = serde_json::to_vec(&production_inspection(target, retained)).unwrap();
                production_inspect_response(target, &bytes, retained).unwrap();
                assert!(production_inspect_response(target, &bytes, !retained).is_err());
                let other = if target == Target::Mcp {
                    Target::Setup
                } else {
                    Target::Mcp
                };
                assert!(production_inspect_response(other, &bytes, retained).is_err());
                assert!(inspect_response(target, &bytes).is_err());
                assert!(retained_response(target, &bytes).is_err());
            }
            let output = Capture {
                bytes: serde_json::to_vec(&production_completion(target)).unwrap(),
                exceeded: false,
            };
            assert_eq!(
                production_retire_response(target, Some(0), &output).unwrap(),
                Outcome::ExperimentalVerified
            );
            assert!(retire_response(target, Some(0), &output).is_err());
        }
        assert!(production_inspect_response(
            Target::Mcp,
            &serde_json::to_vec(&inspection()).unwrap(),
            false
        )
        .is_err());
        assert!(production_inspect_response(
            Target::Setup,
            &serde_json::to_vec(&setup_inspection(false)).unwrap(),
            false
        )
        .is_err());
        assert!(production_retire_response(Target::Mcp, Some(0), &completion()).is_err());
        assert!(production_retire_response(Target::Setup, Some(0), &setup_completion()).is_err());
    }

    #[test]
    fn production_identity_versions_counts_and_qualification_are_exact() {
        for target in [Target::Mcp, Target::Setup] {
            for retained in [false, true] {
                let good = production_inspection(target, retained);
                for (key, value) in [
                    ("protocolVersion", serde_json::json!(1)),
                    ("cohort", serde_json::json!("retention014")),
                    ("mode", serde_json::json!("TEST ONLY")),
                    ("nativeAcceptance", serde_json::json!(true)),
                    ("externalQualificationRequired", serde_json::json!(false)),
                    ("readOnly", serde_json::json!(false)),
                    ("snapshotAuthoritative", serde_json::json!(true)),
                    ("packageTransactionStarted", serde_json::json!(true)),
                    ("version", serde_json::json!("latest")),
                    ("retainedFilesVerified", serde_json::json!(42)),
                    ("tombstoneFilesVerified", serde_json::json!(42)),
                    ("omittedFilesVerified", serde_json::json!(42)),
                    ("installationEnabled", serde_json::json!(true)),
                ] {
                    let mut bad = good.clone();
                    bad[key] = value;
                    assert!(
                        production_inspect_response(
                            target,
                            &serde_json::to_vec(&bad).unwrap(),
                            retained
                        )
                        .is_err(),
                        "{key}"
                    );
                }
                for key in good.as_object().unwrap().keys() {
                    let mut bad = good.clone();
                    bad.as_object_mut().unwrap().remove(key);
                    assert!(
                        production_inspect_response(
                            target,
                            &serde_json::to_vec(&bad).unwrap(),
                            retained
                        )
                        .is_err(),
                        "missing {key}"
                    );
                }
            }
            let good = production_completion(target);
            for (key, value) in [
                ("protocolVersion", serde_json::json!(3)),
                ("cohort", serde_json::json!("unknown")),
                ("mode", serde_json::json!("development")),
                ("nativeAcceptance", serde_json::json!(true)),
                ("externalQualificationRequired", serde_json::json!(false)),
                (
                    "status",
                    serde_json::json!("experimental-transaction-verified"),
                ),
                ("version", serde_json::json!("2.7.7-1+hub.retention014.1")),
                ("packageTransactionStarted", serde_json::json!(false)),
                ("manualRepairRequired", serde_json::json!(true)),
                ("retainedFilesVerified", serde_json::json!(42)),
                ("tombstoneFilesVerified", serde_json::json!(42)),
                ("omittedFilesVerified", serde_json::json!(42)),
                ("retryPolicy", serde_json::json!("retry")),
                ("candidate", serde_json::json!("/tmp/other.deb")),
                ("experimentalTransactionCompiled", serde_json::json!(true)),
            ] {
                let mut bad = good.clone();
                bad[key] = value;
                let output = Capture {
                    bytes: serde_json::to_vec(&bad).unwrap(),
                    exceeded: false,
                };
                assert!(
                    production_retire_response(target, Some(0), &output).is_err(),
                    "{key}"
                );
            }
            for key in good.as_object().unwrap().keys() {
                let mut bad = good.clone();
                bad.as_object_mut().unwrap().remove(key);
                let output = Capture {
                    bytes: serde_json::to_vec(&bad).unwrap(),
                    exceeded: false,
                };
                assert!(
                    production_retire_response(target, Some(0), &output).is_err(),
                    "missing {key}"
                );
            }
            let duplicate =
                serde_json::to_string(&good)
                    .unwrap()
                    .replacen('{', "{\"protocolVersion\":2,", 1);
            assert!(production_retire_response(
                target,
                Some(0),
                &Capture {
                    bytes: duplicate.into_bytes(),
                    exceeded: false
                }
            )
            .is_err());
            let output = Capture {
                bytes: serde_json::to_vec(&good).unwrap(),
                exceeded: false,
            };
            for code in [None, Some(1), Some(2), Some(127)] {
                assert!(production_retire_response(target, code, &output).is_err());
            }
            assert_eq!(
                production_retire_response(target, Some(126), &output).unwrap(),
                Outcome::Cancelled
            );
            assert!(production_retire_response(
                target,
                Some(0),
                &Capture {
                    bytes: output.bytes,
                    exceeded: true
                }
            )
            .is_err());
        }
    }

    #[test]
    fn production_root_selection_is_linux_only_and_never_falls_back() {
        let bytes = serde_json::to_vec(&production_inspection(Target::Mcp, false)).unwrap();
        let dev = serde_json::to_vec(&inspection()).unwrap();
        let enabled = cfg!(all(
            target_os = "linux",
            feature = "linux-production-migration"
        ));
        assert_eq!(
            super::inspect_response(Target::Mcp, &bytes).is_ok(),
            enabled
        );
        assert_eq!(super::inspect_response(Target::Mcp, &dev).is_ok(), !enabled);
        let output = Capture {
            bytes: serde_json::to_vec(&production_completion(Target::Mcp)).unwrap(),
            exceeded: false,
        };
        assert_eq!(
            super::retire_response(Target::Mcp, Some(0), &output).is_ok(),
            enabled
        );
        assert_eq!(
            super::retire_response(Target::Mcp, Some(0), &completion()).is_ok(),
            !enabled
        );
        for target in [Target::Mcp, Target::Setup] {
            let retained = serde_json::to_vec(&production_inspection(target, true)).unwrap();
            assert_eq!(super::retained_response(target, &retained).is_ok(), enabled);
            assert!(super::retained_response(target, b"{}").is_err());
        }
        let candidate = production_completion(Target::Mcp)["candidate"]
            .as_str()
            .unwrap()
            .to_owned();
        for bad in [
            candidate.replace("/runtime-only.deb", "/../runtime-only.deb"),
            candidate.replace(
                "0123456789abcdef0123456789abcdef",
                "ABCDEF0123456789ABCDEF0123456789",
            ),
            candidate.clone() + "/extra",
        ] {
            assert!(!production_candidate(Target::Mcp, &bad));
        }
    }

    fn inspection() -> serde_json::Value {
        serde_json::json!({"status":"inspected-read-only", "baselineMatches":true,
            "snapshotAuthoritative":false, "installationEnabled":false,
            "packageTransactionStarted":false, "experimentalTransactionCompiled":true,
            "nativeAcceptance":false, "blocker":"WIP"})
    }

    fn completion() -> Capture {
        Capture {
            exceeded: false,
            bytes: serde_json::to_vec(&serde_json::json!({
            "status":"experimental-transaction-verified", "experimentalTransactionCompiled":true,
            "installationEnabled":false, "packageTransactionStarted":true,
            "manualRepairRequired":false, "nativeAcceptance":false,
            "candidate":"/var/lib/creator-hub-deb-retirement/fixture/runtime-only.deb",
            "version":"2.7.7-1+hub.retention014.1", "retainedFilesVerified":9,
            "omittedFilesVerified":5, "retryPolicy":"attempt marker retained; no automatic retry"}))
            .unwrap(),
        }
    }

    #[test]
    fn commands_are_finite_with_no_shell_path_password_or_environment_input() {
        for action in [Action::Inspect, Action::InspectRetained, Action::Retire] {
            let cmd = command(Target::Mcp, action);
            assert_eq!(cmd.get_current_dir(), Some(std::path::Path::new("/")));
            assert_eq!(cmd.get_envs().count(), 3);
            if action != Action::Retire {
                assert_eq!(cmd.get_program(), HELPER);
                assert_eq!(
                    cmd.get_args().collect::<Vec<_>>(),
                    [if action == Action::Inspect {
                        "inspect"
                    } else {
                        "inspect-retained-mcp-2.7.7"
                    }]
                );
            } else {
                assert_eq!(cmd.get_program(), PKEXEC);
                assert_eq!(
                    cmd.get_args().collect::<Vec<_>>(),
                    ["--disable-internal-agent", HELPER, "retire-mcp-2.7.7"]
                );
            }
        }
    }

    #[test]
    fn capture_drains_to_eof_but_never_retains_unbounded_output() {
        let value = capture(std::io::Cursor::new(vec![b'x'; LIMIT * 3])).unwrap();
        assert_eq!(value.bytes.len(), LIMIT);
        assert!(value.exceeded);
        assert!(!capture(&b"exact"[..]).unwrap().exceeded);
    }

    #[test]
    fn independent_retained_inspection_is_not_a_cached_mutation_receipt() {
        let data = serde_json::json!({"status":"inspected-retained-read-only", "product":"mcp",
            "package":"creator-works-mcp", "packageState":"compatibility",
            "version":"2.7.7-1+hub.retention014.1", "readOnly":true, "baselineMatches":false,
            "compatibilityMatches":true, "snapshotAuthoritative":false, "installationEnabled":false,
            "experimentalTransactionCompiled":true, "packageTransactionStarted":false,
            "nativeAcceptance":false, "retainedFilesVerified":9, "omittedFilesVerified":5});
        retained_response(Target::Mcp, &serde_json::to_vec(&data).unwrap()).unwrap();
        assert!(retained_response(Target::Mcp, &completion().bytes).is_err());
        for (field, value) in [
            ("packageTransactionStarted", serde_json::json!(true)),
            ("readOnly", serde_json::json!(false)),
            ("compatibilityMatches", serde_json::json!(false)),
            ("omittedFilesVerified", serde_json::json!(0)),
            ("nativeAcceptance", serde_json::json!(true)),
        ] {
            let mut bad = data.clone();
            bad[field] = value;
            assert!(retained_response(Target::Mcp, &serde_json::to_vec(&bad).unwrap()).is_err());
        }
    }

    #[test]
    fn only_exact_read_only_experimental_baseline_is_usable() {
        inspect_response(Target::Mcp, &serde_json::to_vec(&inspection()).unwrap()).unwrap();
        for (field, value) in [
            ("installationEnabled", true),
            ("snapshotAuthoritative", true),
            ("packageTransactionStarted", true),
            ("nativeAcceptance", true),
            ("baselineMatches", false),
            ("experimentalTransactionCompiled", false),
        ] {
            let mut data = inspection();
            data[field] = value.into();
            assert!(inspect_response(Target::Mcp, &serde_json::to_vec(&data).unwrap()).is_err());
        }
        let mut data = inspection();
        data["unexpected"] = true.into();
        assert!(inspect_response(Target::Mcp, &serde_json::to_vec(&data).unwrap()).is_err());
        assert!(inspect_response(Target::Mcp, b"{\"status\":\"inspected-read-only\"}").is_err());
        assert!(inspect_response(Target::Mcp, b"{\"status\":\"x\",\"status\":\"x\"}").is_err());
    }

    #[test]
    fn cancellation_authorization_and_unknown_transaction_are_not_conflated() {
        let mut output = completion();
        assert_eq!(
            retire_response(Target::Mcp, Some(0), &output).unwrap(),
            Outcome::ExperimentalVerified
        );
        assert_eq!(
            retire_response(Target::Mcp, Some(126), &output).unwrap(),
            Outcome::Cancelled
        );
        for target in [Target::Mcp, Target::Setup] {
            let error = retire_response(target, Some(127), &output).unwrap_err();
            assert!(error.contains("authorization"));
            assert!(error.contains("pending for manual package-state review"));
            assert!(error.contains("even if the original package is still installed"));
        }
        for code in [None, Some(1), Some(2), Some(-1)] {
            assert!(retire_response(Target::Mcp, code, &output).is_err());
        }
        output.exceeded = true;
        assert!(retire_response(Target::Mcp, Some(0), &output).is_err());
    }

    #[test]
    fn partial_changed_or_unknown_receipts_never_authorize_completion_or_retry() {
        for (field, value) in [
            ("version", serde_json::json!("2.7.8")),
            ("retainedFilesVerified", serde_json::json!(8)),
            ("omittedFilesVerified", serde_json::json!(4)),
            ("manualRepairRequired", serde_json::json!(true)),
            ("installationEnabled", serde_json::json!(true)),
            ("nativeAcceptance", serde_json::json!(true)),
            ("packageTransactionStarted", serde_json::json!(false)),
            ("retryPolicy", serde_json::json!("retry")),
            ("unexpected", serde_json::json!(true)),
        ] {
            let mut output = completion();
            let mut data: serde_json::Value = serde_json::from_slice(&output.bytes).unwrap();
            data[field] = value;
            output.bytes = serde_json::to_vec(&data).unwrap();
            assert!(
                retire_response(Target::Mcp, Some(0), &output).is_err(),
                "{field}"
            );
        }
    }

    fn setup_inspection(retained: bool) -> serde_json::Value {
        serde_json::json!({"status": if retained { "inspected-retained-read-only" } else { "inspected-read-only" },
            "product":"setup", "package":"creator-project-setup",
            "packageState": if retained { "compatibility" } else { "original" },
            "version": if retained { "0.3.7-1+hub.retention014.1" } else { "0.3.7" },
            "readOnly":true, "baselineMatches":!retained, "compatibilityMatches":retained,
            "snapshotAuthoritative":false, "installationEnabled":false,
            "experimentalTransactionCompiled":true, "packageTransactionStarted":false,
            "nativeAcceptance":false, "tombstoneFilesVerified":u32::from(retained),
            "omittedFilesVerified":if retained { 5 } else { 0 }})
    }

    fn setup_completion() -> Capture {
        let mut value: serde_json::Value = serde_json::from_slice(&completion().bytes).unwrap();
        value["product"] = serde_json::json!("setup");
        value["package"] = serde_json::json!("creator-project-setup");
        value["version"] = serde_json::json!("0.3.7-1+hub.retention014.1");
        value["retainedFilesVerified"] = serde_json::json!(0);
        value["tombstoneFilesVerified"] = serde_json::json!(1);
        value["candidate"] = serde_json::json!(
            "/var/lib/creator-hub-deb-retirement-setup/fixture/gui-tombstone.deb"
        );
        Capture {
            bytes: serde_json::to_vec(&value).unwrap(),
            exceeded: false,
        }
    }

    #[test]
    fn setup_dispatch_uses_only_its_three_fixed_commands() {
        for (action, argument) in [
            (Action::Inspect, "inspect-setup-0.3.7"),
            (Action::InspectRetained, "inspect-retained-setup-0.3.7"),
            (Action::Retire, "retire-setup-0.3.7"),
        ] {
            let cmd = command(Target::Setup, action);
            assert_eq!(cmd.get_current_dir(), Some(std::path::Path::new("/")));
            assert_eq!(cmd.get_envs().count(), 3);
            if action == Action::Retire {
                assert_eq!(cmd.get_program(), PKEXEC);
                assert_eq!(
                    cmd.get_args().collect::<Vec<_>>(),
                    ["--disable-internal-agent", HELPER, argument]
                );
            } else {
                assert_eq!(cmd.get_program(), HELPER);
                assert_eq!(cmd.get_args().collect::<Vec<_>>(), [argument]);
            }
        }
    }

    #[test]
    fn setup_inspection_requires_exact_identity_version_notice_counts_and_phase() {
        for retained in [false, true] {
            let data = setup_inspection(retained);
            setup_inspection_response(&serde_json::to_vec(&data).unwrap(), retained).unwrap();
            assert!(
                setup_inspection_response(&serde_json::to_vec(&data).unwrap(), !retained).is_err()
            );
            for (field, value) in [
                ("product", serde_json::json!("mcp")),
                ("package", serde_json::json!("creator-works-mcp")),
                ("packageState", serde_json::json!("absent")),
                ("version", serde_json::json!("0.3.8")),
                ("readOnly", serde_json::json!(false)),
                ("baselineMatches", serde_json::json!(retained)),
                ("compatibilityMatches", serde_json::json!(!retained)),
                ("snapshotAuthoritative", serde_json::json!(true)),
                ("installationEnabled", serde_json::json!(true)),
                ("experimentalTransactionCompiled", serde_json::json!(false)),
                ("packageTransactionStarted", serde_json::json!(true)),
                ("nativeAcceptance", serde_json::json!(true)),
                ("tombstoneFilesVerified", serde_json::json!(2)),
                ("omittedFilesVerified", serde_json::json!(4)),
                ("retainedFilesVerified", serde_json::json!(0)),
                ("unexpected", serde_json::json!(true)),
            ] {
                let mut bad = data.clone();
                bad[field] = value;
                assert!(
                    setup_inspection_response(&serde_json::to_vec(&bad).unwrap(), retained)
                        .is_err(),
                    "{field}"
                );
            }
            for field in data.as_object().unwrap().keys() {
                let mut bad = data.clone();
                bad.as_object_mut().unwrap().remove(field);
                assert!(
                    setup_inspection_response(&serde_json::to_vec(&bad).unwrap(), retained)
                        .is_err(),
                    "missing {field}"
                );
            }
        }
    }

    #[test]
    fn product_and_phase_protocols_cannot_be_substituted() {
        let setup = serde_json::to_vec(&setup_inspection(false)).unwrap();
        inspect_response(Target::Setup, &setup).unwrap();
        assert!(inspect_response(Target::Mcp, &setup).is_err());
        assert!(
            inspect_response(Target::Setup, &serde_json::to_vec(&inspection()).unwrap()).is_err()
        );
        let retained = serde_json::to_vec(&setup_inspection(true)).unwrap();
        retained_response(Target::Setup, &retained).unwrap();
        assert!(retained_response(Target::Mcp, &retained).is_err());
        assert!(retained_response(Target::Setup, &setup_completion().bytes).is_err());
        assert!(retire_response(Target::Setup, Some(0), &completion()).is_err());
        assert!(retire_response(Target::Mcp, Some(0), &setup_completion()).is_err());
    }

    #[test]
    fn setup_completion_requires_zero_runtime_one_notice_and_five_omissions() {
        let output = setup_completion();
        assert_eq!(
            retire_response(Target::Setup, Some(0), &output).unwrap(),
            Outcome::ExperimentalVerified
        );
        assert_eq!(
            retire_response(Target::Setup, Some(126), &output).unwrap(),
            Outcome::Cancelled
        );
        for code in [None, Some(1), Some(127)] {
            assert!(retire_response(Target::Setup, code, &output).is_err());
        }
        let data: serde_json::Value = serde_json::from_slice(&output.bytes).unwrap();
        for (field, value) in [
            ("status", serde_json::json!("refused")),
            ("product", serde_json::json!("mcp")),
            ("package", serde_json::json!("creator-works-mcp")),
            ("version", serde_json::json!("0.3.7")),
            ("retainedFilesVerified", serde_json::json!(9)),
            ("tombstoneFilesVerified", serde_json::json!(0)),
            ("omittedFilesVerified", serde_json::json!(4)),
            (
                "candidate",
                serde_json::json!("/var/lib/creator-hub-deb-retirement/fixture/runtime-only.deb"),
            ),
            ("experimentalTransactionCompiled", serde_json::json!(false)),
            ("manualRepairRequired", serde_json::json!(true)),
            ("installationEnabled", serde_json::json!(true)),
            ("nativeAcceptance", serde_json::json!(true)),
            ("packageTransactionStarted", serde_json::json!(false)),
            ("retryPolicy", serde_json::json!("retry")),
            ("unexpected", serde_json::json!(true)),
        ] {
            let mut bad = data.clone();
            bad[field] = value;
            let bad = Capture {
                bytes: serde_json::to_vec(&bad).unwrap(),
                exceeded: false,
            };
            assert!(
                retire_response(Target::Setup, Some(0), &bad).is_err(),
                "{field}"
            );
        }
        for field in data.as_object().unwrap().keys() {
            let mut bad = data.clone();
            bad.as_object_mut().unwrap().remove(field);
            assert!(
                setup_completion_response(&serde_json::to_vec(&bad).unwrap()).is_err(),
                "missing {field}"
            );
        }
    }
}
