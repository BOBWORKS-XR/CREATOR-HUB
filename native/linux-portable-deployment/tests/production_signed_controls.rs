//! Explicit test-only controls for the retained 4d9 016 -> private 017 cohort.
#![cfg(feature = "experimental-restart")]

use creator_hub_linux_portable_deployment::{verify, ErrorKind, Expected, VerifiedPackage};
use minisign_verify::{PublicKey, Signature};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::Read,
    path::{Component, Path, PathBuf},
};

const KEY: &str = include_str!("../../../src-tauri/src/catalog-key.pub");
const KEY_LINE: &str = "RWT+ay+R2gfWMYih7RvbGIueJl/HWLefIoYABjB2O68PaDXh4W7zu8VP";
const INPUT_ENV: &str = "CREATOR_SIGNED_CONTROLS_INPUT_ROOT";
#[cfg(target_os = "linux")]
const OUTPUT_ENV: &str = "CREATOR_SIGNED_CONTROLS_OUTPUT";
#[cfg(target_os = "linux")]
const CHILD_ENV: &str = "CREATOR_SIGNED_CONTROLS_CHILD";
const PROFILE: &str = "artifacts/release-016-updater-20261019/reviewed016-update-portable-39435741602-profile.candidate.json";
const DIR16: &str = "artifacts/signed-reviewed016-portable-39435741602";
const DIR17: &str = "artifacts/signed-private-portable017-39358518825";

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

#[derive(Clone, Copy)]
struct Pin {
    size: u64,
    sha256: &'static str,
}
const PROFILE_PIN: Pin = Pin {
    size: 20258,
    sha256: "1412daac05451789cbd99a400fa9fbd0a67f4c44f888844c0855112103b70325",
};
const PINS16: [Pin; 3] = [
    Pin {
        size: 68007,
        sha256: "e999031faf52382dc93145e8195df50d9d86f6b4d3d138f3546881d74882e013",
    },
    Pin {
        size: 305,
        sha256: "edfc1d1befcbcdd3074e878bacbb5122289ff0f0827dc6b9e098340195344e32",
    },
    Pin {
        size: 164473696,
        sha256: "a1df9859259bab9038bad737cadc0480c10a3a03ac388d16e589afbf364ebbf1",
    },
];
const PINS17: [Pin; 3] = [
    Pin {
        size: 68007,
        sha256: "adc0f083247357bc4686e95b706a559c0b62b85017c1451703ce0d554d2dda24",
    },
    Pin {
        size: 305,
        sha256: "a43f110f262ea683b65f0e65a7273de2e285e614daba401138f0c61b23e9dc67",
    },
    Pin {
        size: 164407188,
        sha256: "18aba08b24e4e73971a86197a5b908dcb9a514e7c148c51f35dec38770dd385d",
    },
];

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn same(a: &Metadata, b: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if (
            a.dev(),
            a.ino(),
            a.uid(),
            a.gid(),
            a.mode(),
            a.nlink(),
            a.ctime(),
            a.ctime_nsec(),
        ) != (
            b.dev(),
            b.ino(),
            b.uid(),
            b.gid(),
            b.mode(),
            b.nlink(),
            b.ctime(),
            b.ctime_nsec(),
        ) {
            return false;
        }
    }
    a.len() == b.len() && a.modified().ok() == b.modified().ok()
}

fn ordinary(path: &Path) -> TestResult<Metadata> {
    for part in path.ancestors() {
        let info = fs::symlink_metadata(part)?;
        assert!(
            !info.file_type().is_symlink(),
            "linked input/ancestor refused"
        );
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            assert_eq!(info.file_attributes() & 0x400, 0, "reparse input refused");
        }
    }
    let info = fs::symlink_metadata(path)?;
    assert!(info.is_file(), "ordinary input required");
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(info.nlink(), 1, "hard-linked input refused");
    }
    Ok(info)
}

struct HeldInput {
    path: PathBuf,
    file: File,
    metadata: Metadata,
    pin: Pin,
}
impl HeldInput {
    fn open(path: PathBuf, pin: Pin) -> TestResult<Self> {
        let named = ordinary(&path)?;
        assert_eq!(named.len(), pin.size, "fixed input size differs");
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(1);
        }
        let file = options.open(&path)?;
        let metadata = file.metadata()?;
        assert!(same(&named, &metadata), "input changed while opening");
        let held = Self {
            path,
            file,
            metadata,
            pin,
        };
        held.check()?;
        Ok(held)
    }
    fn check(&self) -> TestResult {
        use std::io::{Seek, SeekFrom};
        assert!(same(&self.metadata, &self.file.metadata()?));
        assert!(same(&self.metadata, &ordinary(&self.path)?));
        let mut file = self.file.try_clone()?;
        file.seek(SeekFrom::Start(0))?;
        let mut hash = Sha256::new();
        let mut count = 0u64;
        let mut buffer = [0u8; 65536];
        loop {
            let n = file.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            count += n as u64;
            assert!(count <= self.pin.size);
            hash.update(&buffer[..n]);
        }
        assert_eq!(count, self.pin.size);
        assert_eq!(format!("{:x}", hash.finalize()), self.pin.sha256);
        assert!(same(&self.metadata, &self.file.metadata()?));
        assert!(same(&self.metadata, &ordinary(&self.path)?));
        Ok(())
    }
    fn bytes(&self) -> TestResult<Vec<u8>> {
        use std::io::{Seek, SeekFrom};
        assert!(self.pin.size <= 128 * 1024);
        let mut file = self.file.try_clone()?;
        file.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::new();
        file.take(self.pin.size + 1).read_to_end(&mut bytes)?;
        assert_eq!(bytes.len() as u64, self.pin.size);
        assert_eq!(sha(&bytes), self.pin.sha256);
        Ok(bytes)
    }
    #[cfg(target_os = "linux")]
    fn record(&self) -> Value {
        json!({"size": self.pin.size, "sha256": self.pin.sha256})
    }
}

struct Inputs {
    profile: HeldInput,
    packages: [[HeldInput; 3]; 2],
}
impl Inputs {
    fn load() -> TestResult<Self> {
        check_key();
        let root = absolute_env(INPUT_ENV)?;
        let package = |version: &str, dir: &str, pins: [Pin; 3]| -> TestResult<_> {
            let stem = format!("creator-hub-linux-x86_64-{version}");
            Ok([
                HeldInput::open(
                    root.join(dir)
                        .join(format!("{stem}.portable-manifest.json")),
                    pins[0],
                )?,
                HeldInput::open(
                    root.join(dir)
                        .join(format!("{stem}.portable-manifest.json.minisig")),
                    pins[1],
                )?,
                HeldInput::open(
                    root.join(dir).join(format!("{stem}.appdir.tar.gz")),
                    pins[2],
                )?,
            ])
        };
        let inputs = Self {
            profile: HeldInput::open(root.join(PROFILE), PROFILE_PIN)?,
            packages: [
                package("0.1.16", DIR16, PINS16)?,
                package("0.1.17", DIR17, PINS17)?,
            ],
        };
        // The exact profile pins the previously reviewed API/source/ZIP/member proof.
        // It is provenance input, not a fresh API query or qualification authority.
        for package in &inputs.packages {
            PublicKey::decode(KEY)?.verify(
                &package[0].bytes()?,
                &Signature::decode(std::str::from_utf8(&package[1].bytes()?)?)?,
                false,
            )?;
        }
        Ok(inputs)
    }
    fn verify(&self, index: usize) -> TestResult<VerifiedPackage> {
        let p = &self.packages[index];
        let version = ["0.1.16", "0.1.17"][index];
        let package = verify(
            &p[0].bytes()?,
            &p[1].bytes()?,
            &p[2].path,
            &Expected::linux_x86_64(version)?,
        )?;
        assert_eq!(package.generation(), p[0].pin.sha256);
        let source = [
            "4d9e073465928b9e00719d5ba594343281cd1280",
            "75a99ff4a267064aaa3ac9e30039bc91dc791d89",
        ][index];
        assert_eq!(package.manifest().source_commit, source);
        assert_eq!(package.manifest().archive.sha256, p[2].pin.sha256);
        Ok(package)
    }
    fn check(&self) -> TestResult {
        self.profile.check()?;
        for package in &self.packages {
            for file in package {
                file.check()?;
            }
        }
        Ok(())
    }
    #[cfg(target_os = "linux")]
    fn record(&self) -> Value {
        json!({"profile": self.profile.record(), "portable16": self.packages[0].each_ref().map(HeldInput::record), "privatePortable17": self.packages[1].each_ref().map(HeldInput::record)})
    }
}

fn check_key() {
    let canonical = KEY.replace("\r\n", "\n");
    assert_eq!(canonical.lines().nth(1), Some(KEY_LINE));
    assert_eq!(
        sha(canonical.as_bytes()),
        "23b3eee2d1c8cb7d705120953cda67ff94a722a207d5be1679c250be8ca90308"
    );
}

fn absolute_env(name: &str) -> TestResult<PathBuf> {
    let path = PathBuf::from(std::env::var_os(name).ok_or("explicit fixture path required")?);
    assert!(path.is_absolute() && !path.components().any(|p| matches!(p, Component::ParentDir)));
    Ok(path)
}

fn tamper_manifest(bytes: &[u8]) -> Vec<u8> {
    let mut changed = bytes.to_vec();
    let marker = b"\"sourceCommit\": \"";
    let index = bytes
        .windows(marker.len())
        .position(|w| w == marker)
        .expect("fixed manifest shape")
        + marker.len();
    changed[index] = if changed[index] == b'a' { b'b' } else { b'a' };
    changed
}

fn tamper_signature(bytes: &[u8]) -> Vec<u8> {
    let mut changed = bytes.to_vec();
    let index = bytes.iter().position(|b| *b == b'\n').unwrap() + 1 + 20;
    changed[index] = if changed[index] == b'A' { b'B' } else { b'A' };
    changed
}

fn signature_refusals(inputs: &Inputs) -> TestResult<Value> {
    let p = &inputs.packages[1];
    let manifest = p[0].bytes()?;
    let signature = p[1].bytes()?;
    let expected = Expected::linux_x86_64("0.1.17")?;
    let mut records = Vec::new();
    for (name, body, sig) in [
        (
            "manifest-byte-tamper",
            tamper_manifest(&manifest),
            signature.clone(),
        ),
        (
            "signature-byte-tamper",
            manifest,
            tamper_signature(&signature),
        ),
    ] {
        let error = match verify(&body, &sig, &p[2].path, &expected) {
            Ok(_) => panic!("tampered signed input admitted"),
            Err(error) => error,
        };
        assert_eq!(error.kind, ErrorKind::Refused);
        assert_eq!(error.message, "Catalogue signature verification failed");
        records.push(json!({"control": name, "kind": "Refused", "message": error.message, "manifestSha256": sha(&body), "signatureSha256": sha(&sig)}));
    }
    Ok(json!(records))
}

fn sources() -> Value {
    macro_rules! source {
        ($name:literal) => {
            ($name, sha(include_bytes!($name)))
        };
    }
    let files = [
        source!("production_signed_controls.rs"),
        source!("../Cargo.toml"),
        source!("../Cargo.lock"),
        source!("../src/lib.rs"),
        source!("../src/archive.rs"),
        source!("../src/filesystem.rs"),
        source!("../src/store.rs"),
        source!("../src/host.rs"),
        source!("../src/registration.rs"),
        source!("../src/bootstrap.rs"),
        source!("../src/restart.rs"),
        source!("../src/restart_linux.rs"),
    ];
    json!(files
        .into_iter()
        .collect::<std::collections::BTreeMap<_, _>>())
}

#[cfg(target_os = "linux")]
fn write_receipt(path: &Path, value: &Value) -> TestResult {
    use std::io::Write;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(&serde_json::to_vec_pretty(value)?)?;
    file.sync_all()?;
    Ok(())
}

#[cfg(target_os = "linux")]
mod native {
    use super::*;
    use creator_hub_linux_portable_deployment::{
        Activation, HostSession, RestartChoice, RestartStageOutcome, Store,
    };
    use std::{
        process::{Command, Stdio},
        time::{Duration, Instant},
    };

    fn private_dir(path: &Path) -> TestResult {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(path)?;
        Ok(())
    }
    fn state(path: &Path) -> TestResult<Value> {
        let names = |path: &Path| -> TestResult<Vec<String>> {
            let mut values = fs::read_dir(path)?
                .map(|v| {
                    Ok(v?
                        .file_name()
                        .into_string()
                        .map_err(|_| "non-UTF8 fixture file")?)
                })
                .collect::<TestResult<Vec<_>>>()?;
            values.sort();
            Ok(values)
        };
        let mut records = std::collections::BTreeMap::new();
        for name in names(path)? {
            if ["generations", "history"].contains(&name.as_str()) {
                continue;
            }
            let file = path.join(&name);
            assert!(ordinary(&file)?.len() <= 16384);
            records.insert(name, sha(&fs::read(file)?));
        }
        let mut history = std::collections::BTreeMap::new();
        for name in names(&path.join("history"))? {
            let file = path.join("history").join(&name);
            assert!(ordinary(&file)?.len() <= 16384);
            history.insert(name, sha(&fs::read(file)?));
        }
        let selection: Value = serde_json::from_slice(&fs::read(path.join("current.json"))?)?;
        Ok(
            json!({"selection": selection, "records": records, "generations": names(&path.join("generations"))?, "history": history}),
        )
    }
    pub fn child() -> TestResult {
        let output = absolute_env(OUTPUT_ENV)?;
        let inputs = Inputs::load()?;
        write_receipt(
            &output.join("01-inputs.json"),
            &json!({"pid": std::process::id(), "inputs": inputs.record(), "compiledSources": sources()}),
        )?;
        let package16 = inputs.verify(0)?;
        let package17 = inputs.verify(1)?;
        let session = HostSession::capture()?;
        assert_eq!(
            session.store_path(),
            output.join("data/creator-hub-portable")
        );
        let store = Store::create(session.store_path())?;
        let generation16 = store.stage(&package16, || false)?;
        assert!(matches!(
            store.activate(
                &generation16,
                &Expected::linux_x86_64("0.1.16")?,
                None,
                || false
            )?,
            Activation::Committed(_)
        ));
        drop(package16);
        let before = state(session.store_path())?;
        let refused = signature_refusals(&inputs)?;
        assert_eq!(state(session.store_path())?, before);
        write_receipt(
            &output.join("02-signature.json"),
            &json!({"controls": refused, "before": before, "after": state(session.store_path())?}),
        )?;

        let old = store.snapshot()?.expect("selected 016");
        let review = store.review_restart(&session, &package17)?;
        let old_bytes = fs::read(session.store_path().join("current.json"))?;
        let staged =
            store.stage_restart(&review, &package17, RestartChoice::StageReviewed, || false)?;
        let RestartStageOutcome::Staged(staged) = staged else {
            panic!("not staged")
        };
        assert_eq!(staged.generation(), package17.generation());
        assert_eq!(store.snapshot()?.as_ref(), Some(&old));
        assert_eq!(
            fs::read(session.store_path().join("current.json"))?,
            old_bytes
        );
        assert!(session
            .store_path()
            .join("generations")
            .join(staged.generation())
            .is_dir());
        write_receipt(
            &output.join("03-stage.json"),
            &json!({"oldSelectionSha256": sha(&old_bytes), "stagedGeneration": staged.generation(), "after": state(session.store_path())?, "rootOrSelectorExecuted": false}),
        )?;

        // Deliberate fixture-only CAS: this is not a selector/normal-exit proof.
        assert!(matches!(
            store.activate(
                staged.generation(),
                &Expected::linux_x86_64("0.1.17")?,
                Some(&old),
                || false
            )?,
            Activation::Committed(_)
        ));
        let advanced = state(session.store_path())?;
        let stale_stage = match store.stage_restart(
            &review,
            &package17,
            RestartChoice::StageReviewed,
            || false,
        ) {
            Ok(_) => panic!("stale restart review admitted"),
            Err(error) => error,
        };
        assert_eq!(stale_stage.kind, ErrorKind::Refused);
        assert_eq!(
            stale_stage.message,
            "Restart selection changed after review"
        );
        assert_eq!(state(session.store_path())?, advanced);
        let stale_cas = store
            .activate(
                staged.generation(),
                &Expected::linux_x86_64("0.1.17")?,
                Some(&old),
                || false,
            )
            .unwrap_err();
        assert_eq!(stale_cas.kind, ErrorKind::Refused);
        assert_eq!(stale_cas.message, "Current selection changed after review");
        assert_eq!(state(session.store_path())?, advanced);
        write_receipt(
            &output.join("04-stale.json"),
            &json!({"fixtureAdvancedViaStoreActivate": true, "stageRefusal": stale_stage.message, "casRefusal": stale_cas.message, "before": advanced, "after": state(session.store_path())?}),
        )?;
        inputs.check()?;
        write_receipt(
            &output.join("05-complete.json"),
            &json!({"schemaVersion": 1, "scope": "signed-4d9-016-to-private-017-filesystem-controls-only", "pid": std::process::id(), "inputsUnchanged": true, "controlsCompleted": ["signature-tamper", "stage-keeps-old-selection", "stale-selection"], "rootExecuted": false, "selectorExecuted": false, "guiAcceptance": false, "normalExitAcceptance": false, "abnormalExitAcceptance": false, "authenticatedReadyAcceptance": false, "mcpAcceptance": false, "finalSourceAcceptance": false, "releaseReady": false}),
        )
    }
    pub fn parent() -> TestResult {
        use std::os::unix::process::CommandExt;
        let inputs = Inputs::load()?; // Exact seven pins + production signatures before output creation.
        let output = absolute_env(OUTPUT_ENV)?;
        private_dir(&output)?; // No reuse/adoption, recursive cleanup, or chmod of an existing path.
        for name in ["home", "config", "data", "state", "cache"] {
            private_dir(&output.join(name))?;
        }
        let mut log_options = OpenOptions::new();
        use std::os::unix::fs::OpenOptionsExt;
        log_options.write(true).create_new(true).mode(0o600);
        let log = log_options.open(output.join("child.log"))?;
        let exe = std::env::current_exe()?;
        let executable_sha256 = sha(&fs::read(&exe)?);
        let mut command = Command::new(exe);
        command
            .args([
                "--exact",
                "signed_input_filesystem_controls",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env_clear()
            .env(INPUT_ENV, absolute_env(INPUT_ENV)?)
            .env(OUTPUT_ENV, &output)
            .env(CHILD_ENV, "1")
            .env("HOME", output.join("home"))
            .env("XDG_CONFIG_HOME", output.join("config"))
            .env("XDG_DATA_HOME", output.join("data"))
            .env("XDG_STATE_HOME", output.join("state"))
            .env("XDG_CACHE_HOME", output.join("cache"))
            .env("PATH", "/usr/bin:/bin")
            .current_dir(&output)
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log);
        // Bound only this owned test executable; no packaged Root is started/signalled.
        unsafe {
            command.pre_exec(|| {
                libc::alarm(180);
                Ok(())
            });
        }
        let mut child = command.spawn()?;
        let deadline = Instant::now() + Duration::from_secs(185);
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break Some(status);
            }
            if Instant::now() >= deadline {
                break None;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let completed_sha256 = if status.as_ref().is_some_and(|s| s.success()) {
            let bytes = fs::read(output.join("05-complete.json"))?;
            let completed: Value = serde_json::from_slice(&bytes)?;
            assert_eq!(completed["pid"], child.id());
            inputs.check()?;
            Some(sha(&bytes))
        } else {
            None
        };
        write_receipt(
            &output.join("run.json"),
            &json!({"schemaVersion": 1, "childPid": child.id(), "testExecutableSha256": executable_sha256, "compiledSources": sources(), "inputs": inputs.record(), "completedReceiptSha256": completed_sha256, "childExitCode": status.as_ref().and_then(|s| s.code()), "childSuccess": status.as_ref().is_some_and(|s| s.success()), "outcomeUnknown": status.is_none(), "noAutomaticCleanup": true, "releaseReady": false}),
        )?;
        assert!(
            status.is_some_and(|s| s.success()),
            "fixture failed/unknown; retain output, do not retry/adopt"
        );
        Ok(())
    }
}

#[test]
fn compiled_key_and_closed_cohort_are_fixed() {
    check_key();
    assert_ne!(PINS16[0].sha256, PINS17[0].sha256);
    assert!(PROFILE.contains("39435741602"));
    assert_eq!(sources().as_object().unwrap().len(), 12);
}

#[test]
fn tamper_mutations_change_one_byte_without_changing_length() {
    for (original, changed) in [
        (
            br#"{"sourceCommit": "4d9abc"}"#.to_vec(),
            tamper_manifest(br#"{"sourceCommit": "4d9abc"}"#),
        ),
        (
            format!("comment\n{}\n", "A".repeat(100)).into_bytes(),
            tamper_signature(format!("comment\n{}\n", "A".repeat(100)).as_bytes()),
        ),
    ] {
        assert_eq!(original.len(), changed.len());
        assert_eq!(
            original
                .iter()
                .zip(&changed)
                .filter(|(a, b)| a != b)
                .count(),
            1
        );
    }
}

#[test]
fn changed_input_hash_is_refused() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("file");
    fs::write(&path, b"changed").unwrap();
    let result = std::panic::catch_unwind(|| {
        HeldInput::open(
            path,
            Pin {
                size: 7,
                sha256: "wrong",
            },
        )
    });
    assert!(result.is_err());
}

#[test]
#[ignore = "Explicit exact signed inputs required; read-only, usable on Windows too"]
fn verify_fixed_signed_inputs() -> TestResult {
    let inputs = Inputs::load()?;
    drop(inputs.verify(0)?);
    drop(inputs.verify(1)?);
    signature_refusals(&inputs)?;
    inputs.check()
}

#[test]
#[ignore = "Explicit Linux x86_64 unprivileged private filesystem fixture only"]
fn signed_input_filesystem_controls() -> TestResult {
    #[cfg(target_os = "linux")]
    {
        if std::env::var(CHILD_ENV).as_deref() == Ok("1") {
            native::child()
        } else {
            native::parent()
        }
    }
    #[cfg(not(target_os = "linux"))]
    Err("native filesystem controls must run on Linux; not a skipped acceptance pass".into())
}
