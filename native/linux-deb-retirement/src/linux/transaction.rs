//! Nondefault experimental transaction. No alternate package path, root or target.
use super::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

struct Interrupts {
    requested: Arc<AtomicBool>,
    handlers: Vec<signal_hook::SigId>,
}

impl Interrupts {
    fn register() -> Result<Self> {
        let mut guard = Self {
            requested: Arc::new(AtomicBool::new(false)),
            handlers: Vec::new(),
        };
        for signal in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP, libc::SIGQUIT] {
            guard.handlers.push(signal_hook::flag::register(
                signal,
                Arc::clone(&guard.requested),
            )?);
        }
        Ok(guard)
    }
    fn requested(&self) -> bool {
        self.requested.load(Ordering::SeqCst)
    }
}

impl Drop for Interrupts {
    fn drop(&mut self) {
        for handler in self.handlers.drain(..) {
            signal_hook::low_level::unregister(handler);
        }
    }
}

fn log(path: &Path) -> Result<File> {
    directory(path.parent().ok_or("Missing private log directory")?)?;
    Ok(OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?)
}

fn mark_attempt(candidate: &Path, target: Target) -> Result<()> {
    let (package, old, new) = match target {
        Target::Mcp => (pins::PACKAGE, pins::OLD, pins::NEW),
        Target::Setup => (crate::setup::PACKAGE, crate::setup::OLD, crate::setup::NEW),
    };
    let path = Path::new(target.private()).join(ATTEMPT);
    let mut file = log(&path)?;
    file.write_all(format!("Experimental {package} {old} -> {new}\nStage: {}\nManual review required. No automatic retry or rollback.\n", candidate.display()).as_bytes())?;
    file.sync_all()?;
    open(
        Path::new(target.private()),
        libc::O_RDONLY | libc::O_DIRECTORY,
    )?
    .sync_all()?;
    Ok(())
}

fn manual(
    reason: impl std::fmt::Display,
    started: Option<bool>,
) -> Box<dyn std::error::Error + Send + Sync> {
    Box::new(ManualRepair {
        reason: reason.to_string(),
        started,
    })
}

fn install_command(candidate: &Path) -> Result<Command> {
    let work = candidate
        .parent()
        .ok_or("Missing private candidate directory")?;
    let mut cmd = command(DPKG, Some(work))?;
    cmd.env("DPKG_FRONTEND_LOCKED", "1")
        .env("DPKG_FORCE", "")
        .env("DEBIAN_FRONTEND", "noninteractive")
        .arg("--install")
        .arg(candidate)
        .stdout(Stdio::from(log(&work.join("dpkg.stdout"))?))
        .stderr(Stdio::from(log(&work.join("dpkg.stderr"))?));
    Ok(cmd)
}

pub(super) fn retire() -> Result<serde_json::Value> {
    retire_target(Target::Mcp)
}

pub(super) fn retire_setup() -> Result<serde_json::Value> {
    retire_target(Target::Setup)
}

fn retire_target(target: Target) -> Result<serde_json::Value> {
    privileged_image()?;
    let mut held = locks()?;
    refuse_prior_attempt_for(target)?;
    // Refuse a running GUI before creating a preparation stage. Keep its writer
    // descriptor in this parent through dpkg and post-verification; CLOEXEC
    // closes only the child's inherited copy.
    let _gui_guard = gui::acquire(target)?;
    // Never reopen or accept a previous preparation; rebuild after exact baseline admission.
    let Prepared {
        candidate,
        metadata,
    } = match target {
        Target::Mcp => prepare_locked(&held)?,
        Target::Setup => setup::prepare_locked(&held)?,
    };
    match target {
        Target::Mcp => verify_candidate(&candidate)?,
        Target::Setup => setup::verify_candidate(&candidate)?,
    }
    let mut cmd = install_command(&candidate)?;
    let interrupts = Interrupts::register()?;
    require(
        !interrupts.requested(),
        "Interrupted before transaction; no package transaction started",
    )?;
    // Persist refusal-on-retry before the only handoff. This is not a rollback journal.
    mark_attempt(&candidate, target).map_err(|e| manual(e, Some(false)))?;
    // Both locks still held. Standalone Root database writers are not excluded.
    metadata.unchanged().map_err(|e| manual(e, Some(false)))?;
    let mut started = false;
    let result = held.handoff(|| {
        require(!interrupts.requested(), "Interrupted before dpkg spawn")?;
        let mut child = cmd.spawn()?;
        started = true;
        // Do not time out/kill dpkg (or Node). Retain frontend ownership until child exit.
        let status = loop {
            match child.wait() {
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                other => break other?,
            }
        };
        require(
            status.success(),
            &format!("dpkg failed/interrupted ({status}); see protected dpkg logs"),
        )?;
        require(
            !interrupts.requested(),
            "Helper interrupted while waiting; review package state and protected logs",
        )
    });
    result.map_err(|e| manual(e, Some(started)))?;
    // handoff has reacquired the database lock; frontend is still held.
    match target {
        Target::Mcp => installed(true),
        Target::Setup => setup::installed(true),
    }
    .map_err(|e| manual(e, Some(true)))?;
    metadata.unchanged().map_err(|e| manual(e, Some(true)))?;
    require(
        !interrupts.requested(),
        "Helper interrupted during post-verification",
    )
    .map_err(|e| manual(e, Some(true)))?;
    let mut report = json!({ "status": "experimental-transaction-verified", "experimentalTransactionCompiled": true,
        "installationEnabled": false, "packageTransactionStarted": true, "manualRepairRequired": false,
        "nativeAcceptance": false, "candidate": candidate,
        "version": if target == Target::Mcp { pins::NEW } else { crate::setup::NEW },
        "retainedFilesVerified": if target == Target::Mcp { 9 } else { 0 }, "omittedFilesVerified": 5,
        "retryPolicy": "attempt marker retained; no automatic retry" });
    if target == Target::Setup {
        report["product"] = json!("setup");
        report["package"] = json!(crate::setup::PACKAGE);
        report["tombstoneFilesVerified"] = json!(1);
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signal_flags_do_not_kill_the_waiting_parent() {
        // Isolate signal-handler installation in a child fixture process.
        if std::env::var_os("CREATOR_SIGNAL_FIXTURE").is_some() {
            let guard = Interrupts::register().unwrap();
            assert_eq!(unsafe { libc::raise(libc::SIGTERM) }, 0);
            assert!(guard.requested());
            return;
        }
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "linux::transaction::tests::signal_flags_do_not_kill_the_waiting_parent",
            ])
            .env("CREATOR_SIGNAL_FIXTURE", "1")
            .status()
            .unwrap();
        assert!(status.success());
    }
}
