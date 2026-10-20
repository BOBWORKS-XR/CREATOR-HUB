//! Windows Hub bootstrap; beta.9's Hub signature check rejects the genuine installer.
use crate::bootstrap::Progress;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::windows::{fs::OpenOptionsExt, process::CommandExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use wait_timeout::ChildExt;

const URL: &str =
    "https://public-cdn.cloud.unity3d.com/hub/prod/3.21.1/UnityHubSetup-3.21.1-x64.exe";
const SIZE: u64 = 182_869_104;
const HASH: &str = "9f62430abe9cd88f73b813118ef5a6634618c275a3f3e5df7128226cc489a63b";
const SIGNER: &str = "228FB6411B0A144478C86AAA3CD9473C43A8ABA7";
const VERSION: &str = "3.21.1";
const SIGNATURE_CHECK: &str = r#"$ErrorActionPreference='Stop'; try {
$s=Get-AuthenticodeSignature -LiteralPath $env:CREATOR_SETUP_HUB_INSTALLER
@{status=$s.Status.ToString();thumbprint=$s.SignerCertificate.Thumbprint;version=(Get-Item -LiteralPath $env:CREATOR_SETUP_HUB_INSTALLER).VersionInfo.ProductVersion} | ConvertTo-Json -Compress
} catch { Write-Error $_; exit 1 }"#;
const INSTALL: &str = r#"$ErrorActionPreference='Stop'; try {
$p=Start-Process -FilePath $env:CREATOR_SETUP_HUB_INSTALLER -ArgumentList '/S' -Verb RunAs -WindowStyle Hidden -PassThru -Wait
exit $p.ExitCode
} catch { Write-Error $_; exit 1 }"#;

#[derive(Deserialize)]
struct Signature {
    status: String,
    thumbprint: String,
    version: String,
}

fn valid_signature(report: &Signature) -> bool {
    report.status == "Valid"
        && report.thumbprint.eq_ignore_ascii_case(SIGNER)
        && report.version == VERSION
}

fn powershell(installer: &Path, script: &str) -> Result<Command, String> {
    let root = std::env::var_os("SystemRoot").ok_or("Windows system location unavailable.")?;
    let home = PathBuf::from(root).join("System32/WindowsPowerShell/v1.0");
    let mut command = Command::new(home.join("powershell.exe"));
    // User-controlled paths are data in the environment, never interpolated as code.
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("CREATOR_SETUP_HUB_INSTALLER", installer)
        // Do not inherit incompatible PowerShell 7 or user-provided modules.
        .env("PSModulePath", home.join("Modules"))
        .stdin(Stdio::null())
        .creation_flags(0x08000000);
    Ok(command)
}

fn matching_hash(reader: &mut impl Read, expected_size: u64, expected_hash: &str) -> bool {
    let mut digest = Sha256::new();
    let mut count = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let Ok(length) = reader.read(&mut buffer) else {
            return false;
        };
        if length == 0 {
            break;
        }
        count += length as u64;
        if count > expected_size {
            return false;
        }
        digest.update(&buffer[..length]);
    }
    count == expected_size && format!("{:x}", digest.finalize()) == expected_hash
}

fn verify_signature(installer: &Path, logs: &Path) -> Result<(), String> {
    let report_path = logs.join("hub-signature.json");
    let mut child = powershell(installer, SIGNATURE_CHECK)?
        .stdout(File::create(&report_path).map_err(|e| e.to_string())?)
        .stderr(File::create(logs.join("hub-signature.stderr.log")).map_err(|e| e.to_string())?)
        .spawn()
        .map_err(|e| format!("Cannot check Unity Hub's Windows signature: {e}"))?;
    let status = match child
        .wait_timeout(Duration::from_secs(120))
        .map_err(|e| e.to_string())?
    {
        Some(status) => status,
        None => {
            // Only the read-only signature query is terminated, never an installer.
            child.kill().map_err(|e| e.to_string())?;
            child.wait().map_err(|e| e.to_string())?;
            return Err("Unity Hub signature verification timed out. Nothing was executed.".into());
        }
    };
    let report: Signature = serde_json::from_reader(
        File::open(report_path)
            .map_err(|e| e.to_string())?
            .take(16384),
    )
    .map_err(|_| "Unity Hub's Windows signature could not be read. Nothing was executed.")?;
    if !status.success() || !valid_signature(&report) {
        return Err("Unity Hub's Windows signature/publisher/version could not be verified. Nothing was executed. Check the local signature report; signature checks cannot be bypassed.".into());
    }
    Ok(())
}

pub fn install(logs: &Path, emit: &impl Fn(Progress)) -> Result<(), String> {
    let folder = dirs::data_local_dir()
        .ok_or("Local application data unavailable.")?
        .join("CreatorProjectSetup/tools/unity-hub")
        .join(VERSION);
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let path = folder.join("UnityHubSetup.exe");
    let cached = File::open(&path).is_ok_and(|mut file| matching_hash(&mut file, SIZE, HASH));
    if !cached {
        let temporary = folder.join(format!("download-{}.part", crate::hub::unique_id()));
        let result = (|| {
            let client = reqwest::blocking::Client::builder()
                .https_only(true)
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(20))
                .timeout(Duration::from_secs(1800))
                .build()
                .map_err(|e| e.to_string())?;
            let mut response = client
                .get(URL)
                .send()
                .and_then(|r| r.error_for_status())
                .map_err(|e| format!("Unity Hub download failed: {e}"))?;
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|e| e.to_string())?;
            let mut digest = Sha256::new();
            let mut bytes = 0u64;
            let mut last = Instant::now();
            let started = Instant::now();
            let mut rate = crate::download_progress::Rate::default();
            rate.sample(Duration::ZERO, 0);
            let mut buffer = [0u8; 64 * 1024];
            loop {
                let count = response.read(&mut buffer).map_err(|e| e.to_string())?;
                if count == 0 {
                    break;
                }
                bytes += count as u64;
                if bytes > SIZE {
                    return Err("Unity Hub download exceeded the pinned size.".into());
                }
                digest.update(&buffer[..count]);
                file.write_all(&buffer[..count])
                    .map_err(|e| e.to_string())?;
                if last.elapsed() >= Duration::from_millis(200) || bytes == SIZE {
                    emit(Progress {
                        stage: "Downloading Unity Hub".into(),
                        detail: format!("Unity Hub {VERSION}"),
                        percent: Some(bytes as f64 * 100.0 / SIZE as f64),
                        transfer: Some(crate::download_progress::Transfer {
                            downloaded_bytes: Some(bytes),
                            total_bytes: Some(SIZE),
                            bytes_per_second: rate.sample(started.elapsed(), bytes),
                            ..Default::default()
                        }),
                    });
                    last = Instant::now();
                }
            }
            file.sync_all().map_err(|e| e.to_string())?;
            drop(file);
            if bytes != SIZE || format!("{:x}", digest.finalize()) != HASH {
                return Err(
                    "Unity Hub download failed checksum verification. Nothing was executed.".into(),
                );
            }
            if path.exists() {
                fs::remove_file(&path).map_err(|e| e.to_string())?;
            }
            fs::rename(&temporary, &path).map_err(|e| e.to_string())
        })();
        let _ = fs::remove_file(temporary);
        result?;
    }
    // Deny writes/replacement from final verification until the installer exits.
    let mut locked = OpenOptions::new()
        .read(true)
        .share_mode(1) // FILE_SHARE_READ
        .open(&path)
        .map_err(|e| format!("Cannot lock the verified Hub installer: {e}"))?;
    if !matching_hash(&mut locked, SIZE, HASH) {
        return Err("Unity Hub installer changed before launch. Nothing was executed.".into());
    }
    verify_signature(&path, logs)?;
    if crate::logic::probe_environment().hub_installed {
        return Err("Unity Hub appeared while its installer was being prepared. Check again; the existing Hub was not replaced.".into());
    }
    emit(Progress {
        stage: "Installing Unity Hub".into(),
        detail: "Approve the Windows administrator prompt if requested.".into(),
        percent: None,
        transfer: None,
    });
    let status = powershell(&path, INSTALL)?
        .stdout(File::create(logs.join("install-hub.stdout.log")).map_err(|e| e.to_string())?)
        .stderr(File::create(logs.join("install-hub.stderr.log")).map_err(|e| e.to_string())?)
        .status()
        .map_err(|e| format!("Cannot start Unity Hub installation: {e}"))?;
    if !status.success() {
        return Err(format!("Unity Hub installation did not complete (exit {}). Check for a declined Windows administrator prompt or a restart request, then retry. No project was created.", status.code().map(|n| n.to_string()).unwrap_or_else(|| "unknown".into())));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subprocess_keeps_paths_out_of_code_and_uses_system_modules() {
        let path = Path::new("C:/fixture with spaces/quote';test.exe");
        let command = powershell(path, SIGNATURE_CHECK).unwrap();
        assert!(!SIGNATURE_CHECK.contains(&path.to_string_lossy().to_string()));
        let variables: std::collections::HashMap<_, _> = command.get_envs().collect();
        assert_eq!(
            variables[std::ffi::OsStr::new("CREATOR_SETUP_HUB_INSTALLER")],
            Some(path.as_os_str())
        );
        let module_path = variables[std::ffi::OsStr::new("PSModulePath")].unwrap();
        assert_eq!(
            Path::new(module_path),
            Path::new(command.get_program())
                .parent()
                .unwrap()
                .join("Modules")
        );
        assert!(!INSTALL.contains("ExecutionPolicy"));
        assert!(!INSTALL.contains("skip-signature"));
    }

    #[test]
    fn pin_requires_exact_installer_bytes() {
        let hash = crate::hub::sha256(b"fixture");
        assert!(matching_hash(&mut &b"fixture"[..], 7, &hash));
        assert!(!matching_hash(&mut &b"changed"[..], 7, &hash));
        assert!(!matching_hash(&mut &b"fixture!"[..], 7, &hash));
        assert!(!matching_hash(&mut &b"fixtur"[..], 7, &hash));
        assert_eq!(VERSION, crate::hub::MINIMUM_HUB_VERSION);
    }

    #[test]
    fn signature_requires_valid_trust_exact_publisher_and_version() {
        let mut report = Signature {
            status: "Valid".into(),
            thumbprint: SIGNER.into(),
            version: VERSION.into(),
        };
        assert!(valid_signature(&report));
        report.status = "HashMismatch".into();
        assert!(!valid_signature(&report));
        report.status = "Valid".into();
        report.thumbprint = "another trusted publisher".into();
        assert!(!valid_signature(&report));
        report.thumbprint = SIGNER.into();
        report.version = "3.21.2".into();
        assert!(!valid_signature(&report));
    }

    #[test]
    #[ignore = "read-only signature check of an explicitly provided downloaded fixture"]
    fn genuine_download_passes_windows_verification() {
        let path = PathBuf::from(std::env::var_os("CREATOR_SETUP_HUB_FIXTURE").unwrap());
        let mut file = OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        assert!(matching_hash(&mut file, SIZE, HASH));
        let logs = tempfile::tempdir().unwrap();
        let result = verify_signature(&path, logs.path());
        assert!(
            result.is_ok(),
            "{result:?}; report: {:?}; error: {:?}",
            fs::read(logs.path().join("hub-signature.json")),
            fs::read_to_string(logs.path().join("hub-signature.stderr.log"))
        );
    }
}
