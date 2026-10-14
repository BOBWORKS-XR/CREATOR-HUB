//! One system-authentication attempt, with the approved package held in sealed memory.
#![cfg(any(target_os = "linux", test))]
use std::process::Command;

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Installed,
    Cancelled,
}

fn package_command(package: &str) -> Result<Command, String> {
    let mut command = Command::new("/usr/bin/pkexec");
    command.arg("--disable-internal-agent");
    match package {
        "deb" => command.args(["/usr/bin/dpkg", "--install", "/proc/self/fd/0"]),
        // Other formats keep their separate acceptance boundary; never fall back.
        _ => return Err("This Linux package has no accepted automatic installer. Use your system's package manager to update Hub; your settings were kept.".into()),
    };
    command
        .env_clear()
        .current_dir("/")
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .env("LANG", "C")
        .env("LC_ALL", "C");
    Ok(command)
}

fn outcome(code: Option<i32>) -> Result<Outcome, String> {
    match code {
        Some(0) => Ok(Outcome::Installed),
        Some(126) => Ok(Outcome::Cancelled),
        Some(127) => Err("System authorization was unavailable or refused. Hub did not try another password prompt. Use your system's package manager to update; your settings and retained MCP runtimes were kept.".into()),
        other => {
            let detail = other.map(|value| value.to_string()).unwrap_or_else(|| "signal or unknown".into());
            Err(format!("The system package installer did not complete (exit {detail}). Check your system's package manager before retrying. Hub did not force a repair, roll back files or remove your settings or retained MCP runtimes."))
        }
    }
}

#[cfg(target_os = "linux")]
mod native {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::{
        fs::File,
        io::{Seek, SeekFrom, Write},
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::MetadataExt,
        },
        path::Path,
        process::Stdio,
    };

    fn trusted_tool(path: &Path) -> Result<(), String> {
        let actual = path
            .canonicalize()
            .map_err(|_| "System authorization or package installer is not installed.")?;
        for entry in actual.ancestors() {
            let info = entry
                .symlink_metadata()
                .map_err(|_| "Cannot check the system installer path.")?;
            if info.uid() != 0 || info.mode() & 0o022 != 0 || info.file_type().is_symlink() {
                return Err("The system installer path is not protected. Automatic installation was refused.".into());
            }
        }
        let info = actual
            .metadata()
            .map_err(|_| "Cannot check the system installer.")?;
        if !info.is_file() || info.mode() & 0o111 == 0 {
            return Err(
                "The system installer is unavailable. Use your package manager to update Hub."
                    .into(),
            );
        }
        Ok(())
    }

    fn sealed(bytes: &[u8], length: u64, hash: &str) -> Result<File, String> {
        if length == 0
            || length > 512 * 1024 * 1024
            || bytes.len() as u64 != length
            || hash.len() != 64
            || !hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || format!("{:x}", Sha256::digest(bytes)) != hash
        {
            return Err("The approved Hub package bytes changed. Nothing was installed.".into());
        }
        let fd = unsafe {
            libc::memfd_create(
                c"creator-hub-update".as_ptr(),
                libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
            )
        };
        if fd < 0 {
            return Err("This Linux kernel cannot lock the update bytes. Automatic installation was refused.".into());
        }
        let mut file = unsafe { File::from_raw_fd(fd) };
        file.write_all(bytes)
            .and_then(|_| file.flush())
            .and_then(|_| file.seek(SeekFrom::Start(0)).map(|_| ()))
            .map_err(|_| "Cannot prepare the sealed Hub update. Nothing was installed.")?;
        let seals =
            libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL;
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_ADD_SEALS, seals) } != 0
            || unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GET_SEALS) } != seals
        {
            return Err(
                "Linux could not lock the approved update bytes. Nothing was installed.".into(),
            );
        }
        Ok(file)
    }

    pub fn preflight(package: &str) -> Result<(), String> {
        package_command(package)?;
        trusted_tool(Path::new("/usr/bin/pkexec"))?;
        trusted_tool(Path::new("/usr/bin/dpkg"))
    }

    pub fn install(
        bytes: &[u8],
        length: u64,
        hash: &str,
        package: &str,
    ) -> Result<Outcome, String> {
        let mut command = package_command(package)?;
        preflight(package)?;
        let input = sealed(bytes, length, hash)?;
        // pkexec closes descriptors >=3. Stdin survives exec and dpkg opens it
        // as a seekable, kernel-sealed package, with no mutable pathname handoff.
        command
            .stdin(Stdio::from(input))
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let status = command.status().map_err(|_| "The system authorization could not start. No fallback password prompt was opened; your settings and retained runtimes were kept.")?;
        outcome(status.code())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::io::Read;

        #[test]
        fn actual_kernel_seals_keep_the_exact_approved_package() {
            let bytes = b"signed package fixture";
            let hash = format!("{:x}", Sha256::digest(bytes));
            let mut file = sealed(bytes, bytes.len() as u64, &hash).unwrap();
            assert!(file.write_all(b"tamper").is_err());
            assert!(file.set_len(1).is_err());
            assert!(file.set_len(100).is_err());
            let mut actual = Vec::new();
            file.read_to_end(&mut actual).unwrap();
            assert_eq!(actual, bytes);
        }

        #[test]
        fn changed_length_hash_empty_or_noncanonical_hash_never_gets_a_sealed_package() {
            let bytes = b"fixture";
            let hash = format!("{:x}", Sha256::digest(bytes));
            for (length, digest) in [
                (0, hash.clone()),
                (8, hash.clone()),
                (7, "0".repeat(64)),
                (7, hash.to_uppercase()),
            ] {
                assert!(sealed(bytes, length, &digest).is_err());
            }
            assert!(sealed(b"", 0, &hash).is_err());
        }
    }
}

#[cfg(target_os = "linux")]
pub use native::{install, preflight};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_fixed_command_has_no_shell_path_argument_password_or_terminal_fallback() {
        let command = package_command("deb").unwrap();
        assert_eq!(command.get_program(), "/usr/bin/pkexec");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                "--disable-internal-agent",
                "/usr/bin/dpkg",
                "--install",
                "/proc/self/fd/0"
            ]
        );
        assert_eq!(command.get_current_dir(), Some(std::path::Path::new("/")));
        assert_eq!(command.get_envs().count(), 3);
        for format in ["rpm", "appimage", "flatpak", "", "deb --force"] {
            assert!(package_command(format).is_err());
        }
    }

    #[test]
    fn cancellation_authorization_failure_and_uncertain_installs_are_distinct_and_never_restart() {
        assert_eq!(outcome(Some(0)).unwrap(), Outcome::Installed);
        assert_eq!(outcome(Some(126)).unwrap(), Outcome::Cancelled);
        assert!(outcome(Some(127)).unwrap_err().contains("authorization"));
        for code in [None, Some(1), Some(2), Some(-1)] {
            assert!(outcome(code).unwrap_err().contains("before retrying"));
        }
    }
}
