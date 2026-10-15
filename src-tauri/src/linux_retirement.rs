//! Linux-only client for the finite, protected DEB helper. Not release authority.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]
use serde::Deserialize;
use std::{io::Read, process::Command};

const HELPER: &str = "/usr/libexec/creator-hub-deb-retirement-helper";
const PKEXEC: &str = "/usr/bin/pkexec";
const LIMIT: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    Inspect,
    InspectRetained,
    Retire,
}

fn command(action: Action) -> Command {
    let mut cmd = if action == Action::Retire {
        let mut cmd = Command::new(PKEXEC);
        cmd.args(["--disable-internal-agent", HELPER, "retire-mcp-2.7.7"]);
        cmd
    } else {
        let mut cmd = Command::new(HELPER);
        cmd.arg(if action == Action::InspectRetained {
            "inspect-retained-mcp-2.7.7"
        } else {
            "inspect"
        });
        cmd
    };
    cmd.env_clear()
        .current_dir("/")
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .env("LANG", "C")
        .env("LC_ALL", "C");
    cmd
}

struct Capture {
    bytes: Vec<u8>,
    exceeded: bool,
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

fn inspect_response(bytes: &[u8]) -> Result<(), String> {
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

fn retained_response(bytes: &[u8]) -> Result<(), String> {
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

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Cancelled,
    ExperimentalVerified,
}

fn retire_response(code: Option<i32>, output: &Capture) -> Result<Outcome, String> {
    if code == Some(126) {
        return Ok(Outcome::Cancelled);
    }
    if code == Some(127) {
        return Err("System authorization was unavailable or refused. No fallback password prompt or automatic retry was opened; check the system package manager before trying again.".into());
    }
    if code != Some(0) || output.exceeded {
        return Err("Standalone cleanup did not report a verified completion. A transaction may have started. Keep all settings, backups and retained runtimes; review the system package manager before retrying.".into());
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

    fn run(action: Action) -> Result<(Option<i32>, Capture), String> {
        let mut cmd = command(action);
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
        helper: Image,
        authorization: Image,
    }

    impl Plan {
        fn images() -> Result<Self, String> {
            Ok(Self {
                helper: image(Path::new(HELPER), true)?,
                authorization: image(Path::new(PKEXEC), false)?,
            })
        }

        pub fn inspect() -> Result<Self, String> {
            let result = Self::images()?;
            let (code, output) = run(Action::Inspect)?;
            if code != Some(0) || output.exceeded {
                return Err("The exact MCP DEB baseline could not be verified. No installation was changed.".into());
            }
            inspect_response(&output.bytes)?;
            result.recheck_image()?;
            Ok(result)
        }

        pub fn inspect_retained() -> Result<Self, String> {
            let result = Self::images()?;
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
            let (code, output) = run(Action::Inspect)?;
            if code != Some(0) || output.exceeded {
                return Err(
                    "The reviewed standalone installation changed. Check again before retirement."
                        .into(),
                );
            }
            inspect_response(&output.bytes)?;
            self.recheck_image()
        }

        /// Caller must already have rechecked backups, routes, client dependencies,
        /// closed GUI state and native approval. This makes one polkit attempt only.
        pub fn retire_after_native_review(&self) -> Result<Outcome, String> {
            self.recheck_baseline()?;
            let (code, output) = run(Action::Retire)?;
            let outcome = retire_response(code, &output)?;
            self.recheck_image().map_err(|_| "Helper image changed during cleanup. Completion is unknown; inspect package state before retrying.")?;
            if outcome == Outcome::ExperimentalVerified {
                self.verify_retained()?;
            }
            Ok(outcome)
        }

        pub fn verify_retained(&self) -> Result<(), String> {
            self.recheck_image()?;
            let (code, output) = run(Action::InspectRetained)?;
            if code != Some(0) || output.exceeded {
                return Err("The helper could not independently verify the retained package after cleanup. Keep recovery records and inspect package state; no automatic retry was attempted.".into());
            }
            retained_response(&output.bytes)?;
            self.recheck_image()
        }
    }
}

#[cfg(target_os = "linux")]
pub use native::Plan;

#[cfg(test)]
mod tests {
    use super::*;

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
            let cmd = command(action);
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
        retained_response(&serde_json::to_vec(&data).unwrap()).unwrap();
        assert!(retained_response(&completion().bytes).is_err());
        for (field, value) in [
            ("packageTransactionStarted", serde_json::json!(true)),
            ("readOnly", serde_json::json!(false)),
            ("compatibilityMatches", serde_json::json!(false)),
            ("omittedFilesVerified", serde_json::json!(0)),
            ("nativeAcceptance", serde_json::json!(true)),
        ] {
            let mut bad = data.clone();
            bad[field] = value;
            assert!(retained_response(&serde_json::to_vec(&bad).unwrap()).is_err());
        }
    }

    #[test]
    fn only_exact_read_only_experimental_baseline_is_usable() {
        inspect_response(&serde_json::to_vec(&inspection()).unwrap()).unwrap();
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
            assert!(inspect_response(&serde_json::to_vec(&data).unwrap()).is_err());
        }
        let mut data = inspection();
        data["unexpected"] = true.into();
        assert!(inspect_response(&serde_json::to_vec(&data).unwrap()).is_err());
        assert!(inspect_response(b"{\"status\":\"inspected-read-only\"}").is_err());
        assert!(inspect_response(b"{\"status\":\"x\",\"status\":\"x\"}").is_err());
    }

    #[test]
    fn cancellation_authorization_and_unknown_transaction_are_not_conflated() {
        let mut output = completion();
        assert_eq!(
            retire_response(Some(0), &output).unwrap(),
            Outcome::ExperimentalVerified
        );
        assert_eq!(
            retire_response(Some(126), &output).unwrap(),
            Outcome::Cancelled
        );
        assert!(retire_response(Some(127), &output)
            .unwrap_err()
            .contains("authorization"));
        for code in [None, Some(1), Some(2), Some(-1)] {
            assert!(retire_response(code, &output).is_err());
        }
        output.exceeded = true;
        assert!(retire_response(Some(0), &output).is_err());
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
            assert!(retire_response(Some(0), &output).is_err(), "{field}");
        }
    }
}
