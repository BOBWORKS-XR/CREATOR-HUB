//! Explicit native bootstrap role. No sandbox relay, app migration or automatic restart.
use tauri::Manager as _;

const UNAVAILABLE: &str =
    "Native support setup requires the explicit Linux --install-native-support launch role.";
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
    }
}

#[cfg(all(target_os = "linux", feature = "experimental-linux-portable-update"))]
mod enabled {
    use super::{
        model::{self, Installation, Outcome, Phase, Status},
        Action, NativeSupport,
    };
    use crate::{manager, platform, portable_package};
    use creator_hub_linux_portable_deployment::{
        self as deployment, BootstrapOutcome, BootstrapRecoveryChoice, BootstrapRecoveryOutcome,
        BootstrapRecoveryReview, BootstrapReview, Expected, HostSession, InstallChoice,
        InstallOutcome, RegistrationChoice, RegistrationOutcome, ReviewedBootstrapChoice, Store,
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
            Err(error) => {
                let current = status(handle)?;
                record(handle, Status::new(current.phase, format!(
                    "Native setup did not complete. Retained files and settings were kept; nothing will be replayed automatically. {error}"
                )))
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
                        .map_err(|error| retained_review(&session, package, &error.to_string()))?
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

    // Later transaction journals may be inspected, but the empty-origin recovery
    // API cannot authorize adopting or replaying a staged/selected Store.
    fn retained_review(
        session: &HostSession,
        package: &portable_package::VerifiedDownload,
        original: &str,
    ) -> String {
        let inspection = (|| -> Result<bool, String> {
            let store = Store::open(session.store_path()).map_err(|e| e.to_string())?;
            let selection = store.recovery().map_err(|e| e.to_string())?;
            if selection
                .as_ref()
                .is_some_and(|review| review.target_generation != package.package().generation())
            {
                return Err("Retained selection journal belongs to another generation; no adoption or replay.".into());
            }
            let registration = store
                .registration_recovery(session)
                .map_err(|e| e.to_string())?;
            Ok(selection.is_some() || registration.is_some())
        })();
        match inspection {
            Ok(true) => format!("A retained native selection or registration journal was inspected only. Safe post-selection bootstrap recovery is not enabled; no journal was acknowledged, replayed or removed. {original}"),
            Ok(false) => format!("This is not a recoverable origin-bound empty bootstrap Store. It was not adopted or changed. {original}"),
            Err(error) => format!("Retained native setup could not be verified and was kept without adoption or replay. {error} {original}"),
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
}
