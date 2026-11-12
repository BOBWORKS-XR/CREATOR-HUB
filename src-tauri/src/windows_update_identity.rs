use std::path::{Path, PathBuf};

fn version_label(value: &str) -> &str {
    if !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".+-".contains(&byte))
    {
        value
    } else {
        "unrecognised"
    }
}

pub fn verify_registration(
    running_exe: &Path,
    recorded_folder: &str,
    recorded_version: &str,
    running_version: &str,
) -> Result<(), String> {
    if recorded_version != running_version {
        return Err(format!(
            "This window is running Hub {}, but Windows records version {}. Close Hub and reopen it from Start, then check again. If this continues, run the official Hub installer over this installation to repair it. Updating is paused.",
            version_label(running_version), version_label(recorded_version)
        ));
    }
    let running = running_exe.canonicalize().map_err(|_| {
        "Hub could not verify its running file. Close Hub and reopen it from Start, then check again. Updating is paused.".to_string()
    })?;
    let recorded_exe = PathBuf::from(recorded_folder.trim_matches('"')).join("creator-hub.exe");
    let recorded = recorded_exe.canonicalize().map_err(|_| {
        "Hub could not verify the file listed in Windows' installation record. Close Hub and reopen it from Start. If this continues, run the official Hub installer over your current installation to repair it; keep app data. Updating is paused.".to_string()
    })?;
    let same = if cfg!(windows) {
        running
            .to_string_lossy()
            .eq_ignore_ascii_case(&recorded.to_string_lossy())
    } else {
        running == recorded
    };
    if !same {
        return Err(format!(
            "Windows records Hub in a different folder: {}. Close Hub and reopen it from Start. If this continues, run the official Hub installer over your current installation to repair it; keep app data. Updating is paused.",
            recorded_exe.display()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "creator-update-identity-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            fs::create_dir(&path).unwrap();
            fs::write(path.join("creator-hub.exe"), b"inert fixture").unwrap();
            Self(path)
        }
        fn exe(&self) -> PathBuf {
            self.0.join("creator-hub.exe")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_file(self.exe());
            let _ = fs::remove_dir(&self.0);
        }
    }

    #[test]
    fn same_quoted_registered_installation_passes_without_changing_the_file() {
        let f = Fixture::new();
        verify_registration(
            &f.exe(),
            &format!("\"{}\"", f.0.display()),
            "0.1.22",
            "0.1.22",
        )
        .unwrap();
        assert_eq!(fs::read(f.exe()).unwrap(), b"inert fixture");
    }

    #[test]
    fn version_mismatch_names_the_evidence_and_restart_without_claiming_a_duplicate() {
        let f = Fixture::new();
        let error =
            verify_registration(&f.exe(), &f.0.to_string_lossy(), "0.1.21", "0.1.19").unwrap_err();
        assert!(error.contains("running Hub 0.1.19"));
        assert!(error.contains("Windows records version 0.1.21"));
        assert!(error.contains("reopen it from Start"));
        assert!(error.contains("official Hub installer"));
        assert!(!error.contains("Another Hub copy"));
        assert_eq!(fs::read(f.exe()).unwrap(), b"inert fixture");
    }

    #[test]
    fn another_valid_path_is_refused_with_its_location() {
        let a = Fixture::new();
        let b = Fixture::new();
        let error =
            verify_registration(&a.exe(), &b.0.to_string_lossy(), "0.1.22", "0.1.22").unwrap_err();
        assert!(error.contains("different folder"));
        assert!(error.contains(&b.exe().display().to_string()));
        assert_eq!(fs::read(a.exe()).unwrap(), fs::read(b.exe()).unwrap());
    }

    #[test]
    fn unverifiable_record_is_not_reported_as_another_installation() {
        let f = Fixture::new();
        let error = verify_registration(
            &f.exe(),
            &f.0.join("missing").to_string_lossy(),
            "0.1.22",
            "0.1.22",
        )
        .unwrap_err();
        assert!(error.contains("could not verify the file"));
        assert!(error.contains("repair it; keep app data"));
        assert!(!error.contains("another"));
    }

    #[test]
    fn unrecognised_version_is_not_echoed_as_untrusted_text() {
        let f = Fixture::new();
        let error = verify_registration(&f.exe(), &f.0.to_string_lossy(), "bad\nvalue", "0.1.22")
            .unwrap_err();
        assert!(error.contains("version unrecognised"));
        assert!(!error.contains("bad\nvalue"));
    }
}
