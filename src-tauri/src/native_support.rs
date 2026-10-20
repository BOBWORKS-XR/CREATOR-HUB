//! Explicit native bootstrap role. No sandbox relay, app migration or automatic restart.
use tauri::Manager as _;

const UNAVAILABLE: &str =
    "Native support setup is available only in the dedicated Linux setup window. Close Hub normally, then open the Creator Hub Native Support setup AppImage, not the ordinary Hub AppImage.";
const COMMANDS: &[&str] = &[
    "native_support_status",
    "install_native_support",
    "review_native_support_recovery",
    "usage_terms_status",
    "accept_usage_terms",
    "cancel_download",
];

pub(crate) fn command_allowed(bootstrap: bool, command: &str) -> bool {
    !bootstrap || COMMANDS.contains(&command)
}

pub(crate) fn forwarded_guidance(
    enabled: bool,
    bootstrap: bool,
    arguments: &[String],
    current_image: Option<&std::path::Path>,
) -> Option<&'static str> {
    if !enabled || bootstrap || arguments.len() != 1 {
        return None;
    }
    let current = current_image?;
    let forwarded = std::path::Path::new(&arguments[0]);
    if !current.is_absolute()
        || !forwarded.is_absolute()
        || arguments[0].chars().any(char::is_control)
        || !current.metadata().ok()?.is_file()
        || !forwarded.metadata().ok()?.is_file()
    {
        return None;
    }
    let current = current.canonicalize().ok()?;
    let forwarded = forwarded.canonicalize().ok()?;
    if crate::platform::same_path(&current, &forwarded) {
        return None;
    }
    Some(
        "Creator Hub is already running in its normal mode. If you opened the dedicated Creator Hub Native Support setup AppImage, finish or cancel your work here and close Hub normally. Then open the setup AppImage again. The ordinary Hub AppImage opens normal Hub. This window has not switched to setup mode and no installation was started.",
    )
}

pub(crate) struct NativeSupport {
    bootstrap: bool,
    #[cfg(all(target_os = "linux", feature = "experimental-linux-portable-update"))]
    status: std::sync::Mutex<Option<model::Status>>,
}

impl NativeSupport {
    pub(crate) fn new(bootstrap: bool) -> Self {
        Self {
            bootstrap: bootstrap
                && cfg!(all(
                    target_os = "linux",
                    feature = "experimental-linux-portable-update"
                )),
            #[cfg(all(target_os = "linux", feature = "experimental-linux-portable-update"))]
            status: std::sync::Mutex::new(None),
        }
    }
}

#[derive(Clone, Copy)]
enum Action {
    Status,
    Install,
    Recovery,
}

async fn dispatch(handle: tauri::AppHandle, action: Action) -> Result<serde_json::Value, String> {
    if !handle.state::<NativeSupport>().bootstrap {
        return Err(UNAVAILABLE.into());
    }
    #[cfg(all(target_os = "linux", feature = "experimental-linux-portable-update"))]
    {
        tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
            let status = match action {
                Action::Status => enabled::status(&handle)?,
                Action::Install | Action::Recovery => enabled::install(&handle, action)?,
            };
            serde_json::to_value(status).map_err(|_| "Cannot report native setup state.".into())
        })
        .await
        .map_err(|_| "Native setup worker stopped. Check its retained state before retrying.")?
    }
    #[cfg(not(all(target_os = "linux", feature = "experimental-linux-portable-update")))]
    {
        let _ = (handle, action);
        Err(UNAVAILABLE.into())
    }
}

#[tauri::command]
pub(crate) async fn native_support_status(
    handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    dispatch(handle, Action::Status).await
}

#[tauri::command]
pub(crate) async fn install_native_support(
    handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    dispatch(handle, Action::Install).await
}

#[tauri::command]
pub(crate) async fn review_native_support_recovery(
    handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    dispatch(handle, Action::Recovery).await
}

#[cfg(any(
    test,
    all(target_os = "linux", feature = "experimental-linux-portable-update")
))]
mod model {
    use serde::Serialize;

    #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "lowercase")]
    pub(super) enum Phase {
        Available,
        Recovery,
        Complete,
        Blocked,
    }

    #[derive(Clone, Debug, Serialize)]
    pub(super) struct Status {
        mode: &'static str,
        pub(super) phase: Phase,
        pub(super) message: String,
    }

    impl Status {
        pub(super) fn new(phase: Phase, message: impl Into<String>) -> Self {
            let mut message = message.into();
            if message.len() > 4096 {
                let mut length = 4096;
                while !message.is_char_boundary(length) {
                    length -= 1;
                }
                message.truncate(length);
            }
            Self {
                mode: "bootstrap",
                phase,
                message,
            }
        }

        pub(super) fn failed(previous: Phase, error: &str) -> Self {
            let phase = if previous == Phase::Complete {
                Phase::Recovery
            } else {
                previous
            };
            Self::new(phase, format!("Native setup did not complete. Retained files and settings were kept; nothing will be replayed automatically. {error}"))
        }
    }

    #[derive(Debug, PartialEq, Eq)]
    pub(super) enum Outcome {
        Declined,
        Complete,
    }

    // The real caller and tests share the sequence, not an imitation of its effects.
    pub(super) trait Installation {
        type Package;
        type Review;
        type Store;
        fn download(&mut self) -> Result<Self::Package, String>;
        fn review(&mut self, package: &Self::Package) -> Result<Self::Review, String>;
        fn approve(&mut self, review: &Self::Review) -> Result<bool, String>;
        fn decline(&mut self, review: &Self::Review) -> Result<(), String>;
        fn pending(&mut self) -> Result<(), String>;
        fn create(&mut self, review: &Self::Review) -> Result<Self::Store, String>;
        fn install(&mut self, store: &Self::Store, package: &Self::Package) -> Result<(), String>;
        fn register(&mut self, store: &Self::Store, package: &Self::Package) -> Result<(), String>;
        fn verify(&mut self, store: &Self::Store, package: &Self::Package) -> Result<(), String>;
    }

    pub(super) fn run(flow: &mut impl Installation) -> Result<Outcome, String> {
        let package = flow.download()?;
        let review = flow.review(&package)?;
        if !flow.approve(&review)? {
            flow.decline(&review)?;
            return Ok(Outcome::Declined);
        }
        flow.pending()?;
        let store = flow.create(&review)?;
        flow.install(&store, &package)?;
        flow.register(&store, &package)?;
        flow.verify(&store, &package)?;
        Ok(Outcome::Complete)
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(super) enum ResumeOutcome {
        Kept,
        Advanced,
        Complete,
    }

    pub(super) trait Resume {
        type Package;
        type Review;
        fn approve(&mut self, review: &Self::Review) -> Result<bool, String>;
        fn pending(&mut self) -> Result<(), String>;
        fn apply(
            &mut self,
            package: &Self::Package,
            review: &Self::Review,
            approved: bool,
        ) -> Result<ResumeOutcome, String>;
    }

    // The caller supplies a fresh opaque native review on EACH command. Advanced
    // never authorizes another apply, a new review or an installation replay here.
    pub(super) fn run_resume<F: Resume>(
        flow: &mut F,
        package: &F::Package,
        review: &F::Review,
    ) -> Result<ResumeOutcome, String> {
        let approved = flow.approve(review)?;
        if approved {
            flow.pending()?;
        }
        let outcome = flow.apply(package, review, approved)?;
        if !approved && outcome != ResumeOutcome::Kept {
            return Err("Native recovery cancellation was not confirmed. Review retained evidence before retrying.".into());
        }
        Ok(outcome)
    }

    pub(super) fn resume_status(outcome: ResumeOutcome, complete_message: &str) -> Status {
        match outcome {
            ResumeOutcome::Kept => Status::new(Phase::Recovery, "Native recovery was cancelled. No reviewed step was applied; retained files and settings were kept."),
            ResumeOutcome::Advanced => Status::new(Phase::Recovery, "One reviewed native recovery step finished. Setup is not yet confirmed complete. Choose Review again for a fresh review and explicit approval of the next step. Nothing else will run automatically."),
            ResumeOutcome::Complete => Status::new(Phase::Complete, complete_message),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn status_contract_is_bounded_and_has_only_the_frontend_fields() {
            for phase in [
                Phase::Available,
                Phase::Recovery,
                Phase::Complete,
                Phase::Blocked,
            ] {
                let value =
                    serde_json::to_value(Status::new(phase, "\u{1f600}".repeat(2000))).unwrap();
                assert_eq!(value.as_object().unwrap().len(), 3);
                assert_eq!(value["mode"], "bootstrap");
                let message = value["message"].as_str().unwrap();
                assert!(message.len() <= 4096);
                assert!(message.encode_utf16().count() <= 4096);
            }
        }

        struct Fake {
            steps: Vec<&'static str>,
            fail: Option<&'static str>,
            approved: bool,
            retained: bool,
        }
        impl Fake {
            fn new(approved: bool, fail: Option<&'static str>) -> Self {
                Self {
                    steps: vec![],
                    fail,
                    approved,
                    retained: false,
                }
            }
            fn step(&mut self, name: &'static str) -> Result<(), String> {
                self.steps.push(name);
                if self.fail == Some(name) {
                    Err(format!("failure at {name}"))
                } else {
                    Ok(())
                }
            }
        }
        impl Installation for Fake {
            type Package = ();
            type Review = ();
            type Store = ();
            fn download(&mut self) -> Result<(), String> {
                self.step("verified-download")
            }
            fn review(&mut self, _: &()) -> Result<(), String> {
                self.step("bound-review")
            }
            fn approve(&mut self, _: &()) -> Result<bool, String> {
                self.step("native-consent")?;
                Ok(self.approved)
            }
            fn decline(&mut self, _: &()) -> Result<(), String> {
                self.step("native-cancel")
            }
            fn pending(&mut self) -> Result<(), String> {
                self.step("retain-recovery")?;
                self.retained = true;
                Ok(())
            }
            fn create(&mut self, _: &()) -> Result<(), String> {
                self.step("create")
            }
            fn install(&mut self, _: &(), _: &()) -> Result<(), String> {
                self.step("install-select")
            }
            fn register(&mut self, _: &(), _: &()) -> Result<(), String> {
                self.step("register")
            }
            fn verify(&mut self, _: &(), _: &()) -> Result<(), String> {
                self.step("verify-registration")
            }
        }

        #[test]
        fn cancel_never_creates_selects_registers_or_marks_complete() {
            let mut flow = Fake::new(false, None);
            assert_eq!(run(&mut flow), Ok(Outcome::Declined));
            assert_eq!(
                flow.steps,
                [
                    "verified-download",
                    "bound-review",
                    "native-consent",
                    "native-cancel"
                ]
            );
            assert!(!flow.retained);
        }

        #[test]
        fn approval_is_single_and_bound_review_precedes_all_mutations() {
            let mut flow = Fake::new(true, None);
            assert_eq!(run(&mut flow), Ok(Outcome::Complete));
            assert_eq!(
                flow.steps,
                [
                    "verified-download",
                    "bound-review",
                    "native-consent",
                    "retain-recovery",
                    "create",
                    "install-select",
                    "register",
                    "verify-registration"
                ]
            );
        }

        #[test]
        fn interrupted_steps_never_report_completion_or_replay() {
            let stages = [
                "verified-download",
                "bound-review",
                "native-consent",
                "retain-recovery",
                "create",
                "install-select",
                "register",
                "verify-registration",
            ];
            for (index, stage) in stages.into_iter().enumerate() {
                let mut flow = Fake::new(true, Some(stage));
                assert!(run(&mut flow).is_err());
                assert_eq!(flow.steps, stages[..=index]);
                assert_eq!(flow.retained, index >= 4);
            }
        }

        struct FakeResume {
            steps: Vec<&'static str>,
            approved: bool,
            outcome: ResumeOutcome,
            revision: u64,
            writes: usize,
            fail: Option<&'static str>,
        }
        impl Resume for FakeResume {
            type Package = u64;
            type Review = u64;
            fn approve(&mut self, _: &u64) -> Result<bool, String> {
                self.steps.push("fresh-native-consent");
                if self.fail == Some("consent") {
                    return Err("Consent failed".into());
                }
                Ok(self.approved)
            }
            fn pending(&mut self) -> Result<(), String> {
                self.steps.push("retain-recovery");
                if self.fail == Some("pending") {
                    return Err("Cannot retain status".into());
                }
                Ok(())
            }
            fn apply(
                &mut self,
                package: &u64,
                review: &u64,
                approved: bool,
            ) -> Result<ResumeOutcome, String> {
                if !approved {
                    self.steps.push("native-keep");
                    return Ok(ResumeOutcome::Kept);
                }
                self.steps.push("one-native-step");
                if self.fail == Some("apply") || *package != 42 || *review != self.revision {
                    return Err("Native evidence changed or step failed; retained".into());
                }
                self.writes += usize::from(self.outcome == ResumeOutcome::Advanced);
                self.revision += 1;
                Ok(self.outcome)
            }
        }
        fn resume_flow() -> FakeResume {
            FakeResume {
                steps: vec![],
                approved: true,
                outcome: ResumeOutcome::Advanced,
                revision: 1,
                writes: 0,
                fail: None,
            }
        }

        #[test]
        fn advanced_is_one_step_and_never_completion_or_automatic_replay() {
            let mut flow = resume_flow();
            let result = run_resume(&mut flow, &42, &1).unwrap();
            assert_eq!(result, ResumeOutcome::Advanced);
            let status = resume_status(result, "complete");
            assert_eq!(status.phase, Phase::Recovery);
            assert!(status
                .message
                .contains("fresh review and explicit approval"));
            assert_eq!(
                flow.steps,
                ["fresh-native-consent", "retain-recovery", "one-native-step"]
            );
            assert_eq!(flow.writes, 1);
            flow.steps.clear();
            assert!(
                run_resume(&mut flow, &42, &1).is_err(),
                "A stale review cannot authorize another step"
            );
            assert_eq!(flow.writes, 1);
            flow.steps.clear();
            flow.approved = false;
            assert_eq!(run_resume(&mut flow, &42, &2), Ok(ResumeOutcome::Kept));
            assert_eq!(flow.steps, ["fresh-native-consent", "native-keep"]);
            assert_eq!(flow.writes, 1);
            flow.approved = true;
            assert_eq!(run_resume(&mut flow, &42, &2), Ok(ResumeOutcome::Advanced));
            assert_eq!(flow.writes, 2);
        }

        #[test]
        fn recovery_cancel_and_failures_never_apply_a_following_step() {
            let mut flow = resume_flow();
            flow.approved = false;
            assert_eq!(run_resume(&mut flow, &999, &999), Ok(ResumeOutcome::Kept));
            assert_eq!(flow.writes, 0);
            assert_eq!(
                resume_status(ResumeOutcome::Kept, "complete").phase,
                Phase::Recovery
            );
            for failure in ["consent", "pending", "apply"] {
                let mut flow = resume_flow();
                flow.fail = Some(failure);
                assert!(run_resume(&mut flow, &42, &1).is_err());
                assert_eq!(flow.writes, 0);
                assert!(
                    flow.steps
                        .iter()
                        .filter(|step| **step == "one-native-step")
                        .count()
                        <= 1
                );
            }
            let mut flow = resume_flow();
            flow.outcome = ResumeOutcome::Complete;
            let outcome = run_resume(&mut flow, &42, &1).unwrap();
            assert_eq!(
                resume_status(outcome, "verified complete").phase,
                Phase::Complete
            );
            assert_eq!(flow.writes, 0);
        }

        #[test]
        fn a_failed_fresh_review_never_reuses_cached_completion() {
            for previous in [
                Phase::Available,
                Phase::Recovery,
                Phase::Complete,
                Phase::Blocked,
            ] {
                let failed = Status::failed(previous, "Native origin or evidence changed");
                assert_ne!(failed.phase, Phase::Complete);
                assert!(failed.message.contains("did not complete"));
                assert!(failed
                    .message
                    .contains("nothing will be replayed automatically"));
            }
        }
    }
}

#[cfg(all(target_os = "linux", feature = "experimental-linux-portable-update"))]
mod enabled {
    use super::{
        model::{self, Installation, Outcome, Phase, Resume, ResumeOutcome, Status},
        Action, NativeSupport,
    };
    use crate::{manager, platform, portable_package};
    use creator_hub_linux_portable_deployment::{
        self as deployment, BootstrapOutcome, BootstrapRecoveryChoice, BootstrapRecoveryOutcome,
        BootstrapRecoveryReview, BootstrapResumeChoice, BootstrapResumeOutcome,
        BootstrapResumeReview, BootstrapResumeStep, BootstrapReview, Expected, HostSession,
        InstallChoice, InstallOutcome, RecoveryState, RegistrationChoice, RegistrationOutcome,
        ReviewedBootstrapChoice, Store,
    };
    use std::{fs, sync::atomic::Ordering};
    use tauri::{Emitter, Manager as _};
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

    const COMPLETE: &str = "Native support is installed and registered. Close this setup window normally, then reopen Creator Hub from Flatpak. No MCP connection, project or settings migration was started.";

    fn saved(handle: &tauri::AppHandle) -> Result<Option<Status>, String> {
        handle
            .state::<NativeSupport>()
            .status
            .lock()
            .map(|state| state.clone())
            .map_err(|_| "Native setup state needs review.".into())
    }
    fn record(handle: &tauri::AppHandle, status: Status) -> Result<Status, String> {
        *handle
            .state::<NativeSupport>()
            .status
            .lock()
            .map_err(|_| "Native setup state needs review.")? = Some(status.clone());
        Ok(status)
    }

    pub(super) fn status(handle: &tauri::AppHandle) -> Result<Status, String> {
        if let Some(complete) = saved(handle)?.filter(|state| state.phase == Phase::Complete) {
            return Ok(complete);
        }
        // Initial status never starts a Manager operation, network request or Store writer.
        let inspection = (|| {
            let session = HostSession::capture().map_err(|e| e.to_string())?;
            platform::reject_links(session.store_path())?;
            match fs::symlink_metadata(session.store_path()) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Status::new(
                    Phase::Available,
                    "Native support is not installed. The verified Hub window will run outside the Flatpak sandbox, using your existing native settings. Installation requires your approval.",
                )),
                Ok(info) if info.is_dir() && !info.file_type().is_symlink() => Ok(Status::new(
                    Phase::Recovery,
                    "Existing native support evidence was found. Review it explicitly before continuing; no files, selection, registration or settings were changed.",
                )),
                _ => Err("The native support location is unavailable or not an ordinary directory. Existing files were kept.".to_string()),
            }
        })();
        Ok(inspection.unwrap_or_else(|error| Status::new(Phase::Blocked, error)))
    }

    pub(super) fn install(handle: &tauri::AppHandle, action: Action) -> Result<Status, String> {
        let operation = handle.state::<manager::Manager>().begin()?;
        if matches!(action, Action::Recovery) {
            match resume_one_step(handle, &operation) {
                Ok(Some(status)) => return record(handle, status),
                // The old empty-origin path is admitted only by its existing
                // typed read-only review, never after a failed resume apply.
                Ok(None) => {}
                Err(error) => return stopped(handle, &error),
            }
        }
        let mut flow = NativeInstall {
            handle,
            operation: &operation,
            action,
        };
        match model::run(&mut flow) {
            Ok(Outcome::Complete) => record(handle, Status::new(Phase::Complete, COMPLETE)),
            Ok(Outcome::Declined) => {
                let mut result = status(handle)?;
                result.message = "Native setup cancelled. No Store creation, selection or registration was performed. Verified download cache may remain; your settings were kept.".into();
                Ok(result)
            }
            Err(error) => stopped(handle, &error),
        }
    }

    fn stopped(handle: &tauri::AppHandle, error: &str) -> Result<Status, String> {
        let current = status(handle)?;
        record(handle, Status::failed(current.phase, error))
    }

    fn resume_one_step(
        handle: &tauri::AppHandle,
        operation: &manager::Operation,
    ) -> Result<Option<Status>, String> {
        let mut initial = NativeInstall {
            handle,
            operation,
            action: Action::Recovery,
        };
        let package = initial.download()?;
        let session = initial.session()?;
        let expected =
            Expected::linux_x86_64(env!("CARGO_PKG_VERSION")).map_err(|e| e.to_string())?;
        let review = match deployment::review_bootstrap_resume(
            &session,
            package.package(),
            &expected,
        ) {
            Ok(review) => review,
            Err(resume_error) => {
                deployment::review_bootstrap_recovery(&session, package.package(), &expected)
                    .map_err(|empty_error| format!("Retained setup was not admitted by the origin-bound native resume or empty-store review. No adoption or replay. {resume_error} {empty_error}"))?;
                return Ok(None);
            }
        };
        if review.version() != package.descriptor().version()
            || review.generation() != package.package().generation()
        {
            return Err(
                "Native recovery review differs from the exact external signed package.".into(),
            );
        }
        let mut flow = NativeResume { initial, session };
        let result = model::run_resume(&mut flow, &package, &review)?;
        Ok(Some(model::resume_status(result, COMPLETE)))
    }

    struct NativeResume<'a> {
        initial: NativeInstall<'a>,
        session: HostSession,
    }

    impl Resume for NativeResume<'_> {
        type Package = portable_package::VerifiedDownload;
        type Review = BootstrapResumeReview;

        fn approve(&mut self, review: &Self::Review) -> Result<bool, String> {
            if self.initial.cancelled() {
                return Ok(false);
            }
            let step = match review.step() {
                BootstrapResumeStep::Install => "Select only this already staged, signed generation. Registration is a separate later step.",
                BootstrapResumeStep::AcknowledgeDeployment(RecoveryState::PreparedOldSelectionRetained) => "Acknowledge that the interrupted deployment retained its prior selection. This step will not select or register a package.",
                BootstrapResumeStep::AcknowledgeDeployment(RecoveryState::SelectionCommitted) => "Acknowledge the already committed deployment selection. This step will not select another generation or register it.",
                BootstrapResumeStep::RestoreRegistrationBefore => "Restore only the reviewed registration before-images. The selected package stays in place; registering it requires another review and approval.",
                BootstrapResumeStep::Register => "Register this already selected, signed generation for native Flatpak activation. This step does not change the selected package.",
                BootstrapResumeStep::Complete => "Verify that this exact setup is complete. This step does not install, select, register or launch an app.",
            };
            self.initial
                .progress("Native recovery evidence verified. Waiting for approval of one step...");
            let approved = self.initial.handle.dialog().message(format!(
                "Review Creator Hub native support {}?\n\nVerified generation: {}\n\n{}\n\nOnly this reviewed step is approved. If setup advances, choose Review again for a fresh review and separate approval of the next step. Nothing is replayed or launched automatically. Your projects, MCP connections and settings are not migrated here. Cancel applies no step.",
                review.version(), review.generation(), step,
            )).title("Review native support")
                .buttons(MessageDialogButtons::OkCancelCustom("Apply reviewed step".into(), "Cancel".into()))
                .blocking_show();
            Ok(approved && !self.initial.cancelled())
        }

        fn pending(&mut self) -> Result<(), String> {
            self.initial
                .progress("Applying one reviewed native support step. Keep this window open...");
            record(self.initial.handle, Status::new(Phase::Recovery, "A native recovery step is in progress. If interrupted, keep the retained evidence and review again explicitly; no further step is approved."))?;
            Ok(())
        }

        fn apply(
            &mut self,
            package: &Self::Package,
            review: &Self::Review,
            approved: bool,
        ) -> Result<ResumeOutcome, String> {
            let choice = if approved {
                BootstrapResumeChoice::ApplyReviewedStep
            } else {
                BootstrapResumeChoice::Keep
            };
            match deployment::resume_bootstrap(
                &self.session,
                review,
                package.package(),
                choice,
                || self.initial.cancelled(),
            )
            .map_err(|e| e.to_string())?
            {
                BootstrapResumeOutcome::Kept => Ok(ResumeOutcome::Kept),
                BootstrapResumeOutcome::Advanced => Ok(ResumeOutcome::Advanced),
                BootstrapResumeOutcome::Complete => Ok(ResumeOutcome::Complete),
            }
        }
    }

    enum Review {
        New(BootstrapReview),
        Empty(BootstrapRecoveryReview),
    }
    impl Review {
        fn generation(&self) -> String {
            match self {
                Self::New(r) => r.generation(),
                Self::Empty(r) => r.generation(),
            }
        }
        fn version(&self) -> &str {
            match self {
                Self::New(r) => r.version(),
                Self::Empty(r) => r.version(),
            }
        }
    }

    struct NativeInstall<'a> {
        handle: &'a tauri::AppHandle,
        operation: &'a manager::Operation,
        action: Action,
    }
    impl NativeInstall<'_> {
        fn session(&self) -> Result<HostSession, String> {
            HostSession::capture().map_err(|e| e.to_string())
        }
        fn cancelled(&self) -> bool {
            self.handle
                .state::<manager::Manager>()
                .cancellation()
                .load(Ordering::SeqCst)
        }
        fn progress(&self, message: &str) {
            let _ = self.handle.emit(
                "app-progress",
                crate::self_update::Progress {
                    message: message.into(),
                    received: 0,
                    total: 0,
                    cancellable: false,
                },
            );
        }
    }

    impl Installation for NativeInstall<'_> {
        type Package = portable_package::VerifiedDownload;
        type Review = Review;
        type Store = Store;

        fn download(&mut self) -> Result<Self::Package, String> {
            let package = portable_package::fetch_current(self.handle, self.operation)?;
            let size = package.descriptor().archive_byte_length();
            let _ = self.handle.emit(
                "app-progress",
                crate::self_update::Progress {
                    message: "Native support download verified. Nothing has been installed.".into(),
                    received: size,
                    total: size,
                    cancellable: false,
                },
            );
            Ok(package)
        }
        fn review(&mut self, package: &Self::Package) -> Result<Review, String> {
            let session = self.session()?;
            let expected =
                Expected::linux_x86_64(env!("CARGO_PKG_VERSION")).map_err(|e| e.to_string())?;
            let review = match self.action {
                Action::Install => {
                    deployment::review_bootstrap(&session, package.package(), &expected)
                        .map(Review::New)
                        .map_err(|e| e.to_string())?
                }
                Action::Recovery => {
                    deployment::review_bootstrap_recovery(&session, package.package(), &expected)
                        .map(Review::Empty)
                        .map_err(|error| error.to_string())?
                }
                Action::Status => {
                    return Err("A read-only status cannot start native installation.".into())
                }
            };
            if review.version() != package.descriptor().version()
                || review.generation() != package.package().generation()
            {
                return Err("Native setup review differs from the exact verified package.".into());
            }
            Ok(review)
        }
        fn approve(&mut self, review: &Review) -> Result<bool, String> {
            if self.cancelled() {
                return Ok(false);
            }
            self.progress("Native download verified. Waiting for installation approval...");
            let approved = self.handle.dialog().message(format!(
                "Install Creator Hub native support {}?\n\nThis installs and registers the verified generation {} in your private native data directory. The Hub window runs OUTSIDE the Flatpak sandbox and uses your existing native settings.\n\nYour projects, MCP connections and settings will not be imported, replaced or migrated here. After installation, close this window normally and reopen Hub from Flatpak. No app will be launched or restarted automatically.\n\nCancel keeps Store creation, selection and registration unchanged.",
                review.version(), review.generation(),
            )).title("Install native support")
                .buttons(MessageDialogButtons::OkCancelCustom("Install native support".into(), "Cancel".into()))
                .blocking_show();
            Ok(approved && !self.cancelled())
        }
        fn decline(&mut self, review: &Review) -> Result<(), String> {
            let session = self.session()?;
            match review {
                Review::New(review) => match deployment::apply_bootstrap(&session, review, ReviewedBootstrapChoice::Cancel, || false).map_err(|e| e.to_string())? {
                    BootstrapOutcome::Cancelled => Ok(()),
                    BootstrapOutcome::Created(_) => Err("Unexpected native cancellation outcome; review retained evidence.".into()),
                },
                Review::Empty(review) => match deployment::recover_bootstrap(&session, review, BootstrapRecoveryChoice::Keep).map_err(|e| e.to_string())? {
                    BootstrapRecoveryOutcome::Kept => Ok(()),
                    BootstrapRecoveryOutcome::Recovered(_) => Err("Unexpected native recovery cancellation outcome; review retained evidence.".into()),
                },
            }
        }
        fn pending(&mut self) -> Result<(), String> {
            self.progress("Installing reviewed native support. Keep this window open...");
            record(self.handle, Status::new(Phase::Recovery, "Native setup is in progress. If interrupted, review the retained installation and registration evidence explicitly before retrying."))?;
            Ok(())
        }
        fn create(&mut self, review: &Review) -> Result<Store, String> {
            let session = self.session()?;
            match review {
                Review::New(review) => match deployment::apply_bootstrap(
                    &session,
                    review,
                    ReviewedBootstrapChoice::CreateReviewedStore,
                    || self.cancelled(),
                )
                .map_err(|e| e.to_string())?
                {
                    BootstrapOutcome::Created(store) => Ok(store),
                    BootstrapOutcome::Cancelled => {
                        Err("Native setup was cancelled before publication.".into())
                    }
                },
                Review::Empty(review) => {
                    if self.cancelled() {
                        return Err("Native recovery was cancelled before confirmation.".into());
                    }
                    match deployment::recover_bootstrap(
                        &session,
                        review,
                        BootstrapRecoveryChoice::ConfirmPublishedEmptyStore,
                    )
                    .map_err(|e| e.to_string())?
                    {
                        BootstrapRecoveryOutcome::Recovered(store) => Ok(store),
                        BootstrapRecoveryOutcome::Kept => {
                            Err("Native setup recovery did not confirm the empty Store.".into())
                        }
                    }
                }
            }
        }
        fn install(&mut self, store: &Store, package: &Self::Package) -> Result<(), String> {
            let review = store
                .review_install(package.package())
                .map_err(|e| e.to_string())?;
            if review.previous().is_some() {
                return Err("First native setup cannot adopt an existing selection.".into());
            }
            match store
                .install_reviewed(
                    &review,
                    package.package(),
                    InstallChoice::InstallReviewed,
                    || self.cancelled(),
                )
                .map_err(|e| e.to_string())?
            {
                InstallOutcome::Selected(_) => Ok(()),
                InstallOutcome::Declined => {
                    Err("Native package was not selected; review retained setup.".into())
                }
            }
        }
        fn register(&mut self, store: &Store, package: &Self::Package) -> Result<(), String> {
            let session = self.session()?;
            let review = store
                .review_registration(&session, package.package())
                .map_err(|e| e.to_string())?;
            match store
                .apply_registration(&session, &review, RegistrationChoice::ApplyReviewed, || {
                    self.cancelled()
                })
                .map_err(|e| e.to_string())?
            {
                RegistrationOutcome::Applied | RegistrationOutcome::Unchanged => Ok(()),
                RegistrationOutcome::Declined => Err(
                    "Native support registration was not completed; review retained setup.".into(),
                ),
            }
        }
        fn verify(&mut self, store: &Store, package: &Self::Package) -> Result<(), String> {
            let lease = store
                .selected_activation(&self.session()?)
                .map_err(|e| e.to_string())?;
            if lease.selection().version != package.descriptor().version()
                || lease.selection().generation != package.package().generation()
            {
                return Err(
                    "Native registered selection differs from the reviewed generation.".into(),
                );
            }
            lease.revalidate().map_err(|e| e.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_has_only_six_fixed_commands_and_normal_launch_is_unchanged() {
        for command in COMMANDS {
            assert!(command_allowed(true, command));
        }
        for command in [
            "feature_call",
            "move_to_hub",
            "hub_update_status",
            "install_hub_update",
            "open_unity_project",
            "get_launch_request",
            "open_resource",
            "native_support_status ",
            "exec",
        ] {
            assert!(!command_allowed(true, command), "{command}");
            assert!(command_allowed(false, command), "{command}");
        }
        assert_eq!(COMMANDS.len(), 6);
    }

    #[test]
    fn a_requested_role_cannot_enable_an_unsupported_build() {
        assert!(!NativeSupport::new(false).bootstrap);
        assert_eq!(
            NativeSupport::new(true).bootstrap,
            cfg!(all(
                target_os = "linux",
                feature = "experimental-linux-portable-update"
            ))
        );
    }

    #[test]
    fn forwarded_argless_launch_only_offers_guidance_and_never_promotes_the_role() {
        let dir = tempfile::tempdir().unwrap();
        let current = dir.path().join("installed-hub");
        let downloaded = dir.path().join("downloaded-hub");
        std::fs::write(&current, b"current image").unwrap();
        std::fs::write(&downloaded, b"different image").unwrap();
        let forwarded = vec![downloaded.to_str().unwrap().to_owned()];
        for enabled in [false, true] {
            for bootstrap in [false, true] {
                let original = NativeSupport::new(bootstrap);
                let before = original.bootstrap;
                let notice = forwarded_guidance(enabled, bootstrap, &forwarded, Some(&current));
                assert_eq!(notice.is_some(), enabled && !bootstrap);
                assert_eq!(original.bootstrap, before);
                if let Some(message) = notice {
                    assert!(message.contains("If you opened"));
                    assert!(message.contains("close Hub normally"));
                    assert!(message.contains("no installation was started"));
                    assert!(message.len() < 4096);
                }
            }
        }
        for arguments in [
            vec![],
            vec![current.to_str().unwrap().to_owned()],
            vec![current
                .parent()
                .unwrap()
                .join(".")
                .join("installed-hub")
                .to_str()
                .unwrap()
                .to_owned()],
            vec!["relative-hub".into()],
            vec![dir
                .path()
                .join("missing-image")
                .to_str()
                .unwrap()
                .to_owned()],
            vec!["bad\0image".into()],
            vec![dir.path().to_str().unwrap().to_owned()],
            vec![forwarded[0].clone(), "--open-app".into()],
        ] {
            assert!(
                forwarded_guidance(true, false, &arguments, Some(&current)).is_none(),
                "{arguments:?}"
            );
        }
        for current in [
            None,
            Some(std::path::Path::new("relative")),
            Some(dir.path()),
            Some(dir.path().join("missing-current").as_path()),
        ] {
            assert!(forwarded_guidance(true, false, &forwarded, current).is_none());
        }
    }
}
