//! Default-off, stage-only update review. Only the supervising selector may
//! select a target, after authenticated readiness and its own wait of exit zero.
use super::*;
use crate::HostSession;
#[cfg(any(target_os = "linux", test))]
use std::time::Duration;

#[cfg(target_os = "linux")]
#[path = "restart_linux.rs"]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::{RestartDisposition, RestartReady, RootRestart, SupervisionOutcome};

pub struct RestartReview {
    root: PathBuf,
    before: SelectionSnapshot,
    target: Target,
}

impl RestartReview {
    pub fn before(&self) -> &Selection {
        self.before.selection()
    }
    pub fn version(&self) -> &str {
        &self.target.version
    }
    pub fn generation(&self) -> &str {
        &self.target.generation
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RestartChoice {
    KeepCurrent,
    StageReviewed,
}

pub enum RestartStageOutcome {
    Declined,
    Staged(StagedRestart),
}

/// Cannot be constructed from a caller path, PID or supplied digest.
pub struct StagedRestart {
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    root: PathBuf,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    before: SelectionSnapshot,
    target: Target,
}
impl StagedRestart {
    pub fn version(&self) -> &str {
        &self.target.version
    }
    pub fn generation(&self) -> &str {
        &self.target.generation
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Target {
    generation: String,
    version: String,
}

#[cfg(any(target_os = "linux", test))]
const ADMISSION_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(any(target_os = "linux", test))]
const EXIT_TIMEOUT: Duration = Duration::from_secs(60);

#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Hello = 1,
    HelloAck,
    Prepare,
    Ready,
    Arm,
    Armed,
    Cancel,
    Cancelled,
    ExitIntent,
    ExitGranted,
}

#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Debug)]
enum Phase {
    Admission,
    Idle,
    Offered(Target, Duration),
    Prepared(Target, Duration),
    Exiting(Target, Duration),
    Disarmed,
}

#[cfg(any(target_os = "linux", test))]
struct Machine {
    phase: Phase,
}

#[cfg(any(target_os = "linux", test))]
impl Machine {
    fn new() -> Self {
        Self {
            phase: Phase::Admission,
        }
    }
    fn disarm(&mut self) {
        self.phase = Phase::Disarmed;
    }
    fn expired(&self, now: Duration) -> bool {
        match &self.phase {
            Phase::Admission => now >= ADMISSION_TIMEOUT,
            Phase::Offered(_, at) | Phase::Prepared(_, at) | Phase::Exiting(_, at) => {
                now.saturating_sub(*at) >= EXIT_TIMEOUT
            }
            _ => false,
        }
    }
    fn accept(
        &mut self,
        kind: Kind,
        target: Target,
        before: &Target,
        now: Duration,
    ) -> Result<Option<Kind>> {
        if self.expired(now) {
            self.disarm();
            return Err(refused("Restart deadline expired; selection unchanged"));
        }
        match (&self.phase, kind) {
            (Phase::Admission, Kind::HelloAck) if target == *before => {
                self.phase = Phase::Idle;
                Ok(None)
            }
            (Phase::Idle, Kind::Prepare) => {
                self.phase = Phase::Offered(target, now);
                Ok(Some(Kind::Ready))
            }
            (Phase::Offered(expected, at), Kind::Arm) if *expected == target => {
                self.phase = Phase::Prepared(target, *at);
                Ok(Some(Kind::Armed))
            }
            (Phase::Prepared(expected, at), Kind::ExitIntent) if *expected == target => {
                self.phase = Phase::Exiting(target, *at);
                Ok(Some(Kind::ExitGranted))
            }
            (
                Phase::Offered(expected, _)
                | Phase::Prepared(expected, _)
                | Phase::Exiting(expected, _),
                Kind::Cancel,
            ) if *expected == target => {
                self.disarm();
                Ok(Some(Kind::Cancelled))
            }
            _ => {
                self.disarm();
                Err(refused(
                    "Unexpected restart protocol state; selection unchanged",
                ))
            }
        }
    }
    fn exited(&mut self, normal_code: Option<i32>, now: Duration) -> Option<Target> {
        let approved = match &self.phase {
            Phase::Exiting(target, _) if normal_code == Some(0) && !self.expired(now) => {
                Some(target.clone())
            }
            _ => None,
        };
        self.disarm();
        approved
    }
}

impl Store {
    pub fn review_restart(
        &self,
        session: &HostSession,
        package: &VerifiedPackage,
    ) -> Result<RestartReview> {
        disk::admit()?;
        require(
            self.root == session.store_path(),
            "Restart review must use the fixed native store",
        )?;
        self.review_restart_with(package, &production_verify)
    }

    fn review_restart_with(
        &self,
        package: &VerifiedPackage,
        verifier: &Verifier,
    ) -> Result<RestartReview> {
        self.no_registration_recovery()?;
        // Reuse signed AppRun/host-profile and upgrade checks, not its installer.
        let install = self.review_install_with(package, verifier)?;
        let before = self
            .snapshot_with(verifier)?
            .ok_or_else(|| refused("Restart requires a verified existing selection"))?;
        require(
            install.previous() == Some(before.selection()),
            "Selection changed while reviewing restart",
        )?;
        let target = Target {
            generation: package.generation(),
            version: install.version().into(),
        };
        require(
            semver::Version::parse(&target.version).unwrap()
                > semver::Version::parse(&before.selection().version).unwrap(),
            "Restart requires a strictly newer signed generation",
        )?;
        Ok(RestartReview {
            root: self.root.clone(),
            before,
            target,
        })
    }

    pub fn stage_restart(
        &self,
        review: &RestartReview,
        package: &VerifiedPackage,
        choice: RestartChoice,
        cancelled: impl Fn() -> bool,
    ) -> Result<RestartStageOutcome> {
        if choice == RestartChoice::KeepCurrent {
            return Ok(RestartStageOutcome::Declined);
        }
        disk::admit()?;
        self.stage_restart_with(review, package, &cancelled, &production_verify)
    }

    fn stage_restart_with(
        &self,
        review: &RestartReview,
        package: &VerifiedPackage,
        cancelled: &dyn Fn() -> bool,
        verifier: &Verifier,
    ) -> Result<RestartStageOutcome> {
        require(
            review.root == self.root
                && review.target.generation == package.generation()
                && review.target.version == package.manifest.version,
            "Reviewed restart target/store changed",
        )?;
        self.no_registration_recovery()?;
        require(
            self.snapshot_with(verifier)?.as_ref() == Some(&review.before),
            "Restart selection changed after review",
        )?;
        cancel(cancelled)?;
        let generation = self.stage_with(package, cancelled, &|_| Ok(()), verifier)?;
        require(
            generation == review.target.generation,
            "Staged restart identity differs",
        )?;
        self.no_registration_recovery()?;
        require(
            self.snapshot_with(verifier)?.as_ref() == Some(&review.before),
            "Selection changed while staging; target retained unselected",
        )?;
        cancel(cancelled)?;
        Ok(RestartStageOutcome::Staged(StagedRestart {
            root: self.root.clone(),
            before: review.before.clone(),
            target: review.target.clone(),
        }))
    }

    #[cfg(any(target_os = "linux", test))]
    fn check_restart_target(
        &self,
        before: &SelectionSnapshot,
        target: &Target,
        verifier: &Verifier,
    ) -> Result<()> {
        self.no_registration_recovery()?;
        require(
            self.snapshot_with(verifier)?.as_ref() == Some(before),
            "Restart old selection changed; no target selected",
        )?;
        let manifest = self.generation(
            &target.generation,
            &Expected::linux_x86_64(&target.version)?,
            verifier,
        )?;
        require(
            semver::Version::parse(&manifest.version).unwrap()
                > semver::Version::parse(&before.selection().version).unwrap(),
            "Restart target is not a strict upgrade",
        )?;
        // A retained tree alone is not enough: require the existing launch guard.
        super::host::require_runner(&manifest)?;
        let appdir = self
            .root
            .join("generations")
            .join(&target.generation)
            .join("AppDir");
        super::host::host_profile(
            &manifest,
            &disk::read_regular(&appdir.join(crate::HOST_PROFILE), 4096, true)?,
        )
    }
}

#[cfg(test)]
#[path = "restart_tests.rs"]
mod tests;
