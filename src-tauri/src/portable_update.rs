//! Default-off portable updater policy and reviewed restart orchestration.
//! Shared package identity does not relax strictly-newer/coordinator admission.
use crate::portable_package::{
    self as package, cache_root, regular, signed_descriptor, stable,
    SignedDescriptor as Descriptor, VerifiedDownload,
};
use crate::{catalog, manager, platform, self_update};
use creator_hub_linux_portable_deployment::{
    self as deployment, Expected, HostSession, RestartChoice, RestartDisposition, RestartReady,
    RestartReview, RestartStageOutcome, RootRestart, StagedRestart, Store,
};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Mutex},
};
use tauri::{Emitter, Manager as _};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

const REOPEN: &str = "Portable updates need the registered Hub helper. Close Hub and reopen it through the helper; your settings and current generation were kept.";
const UNCERTAIN: &str = "Portable restart coordination could not be confirmed. Hub has retained its operation lock and has not reported an installed update. Keep Hub open; the coordinator state needs review before a normal close or another update.";

impl Descriptor {
    fn installable(&self) -> Result<(), String> {
        if self.validate()? <= stable(env!("CARGO_PKG_VERSION"))? {
            return Err("Hub is already using this version or a newer one.".into());
        }
        if stable(self.min_hub_version())? > stable(env!("CARGO_PKG_VERSION"))? {
            return Err("This portable update needs an intermediate Hub version first.".into());
        }
        Ok(())
    }
}

#[derive(Default)]
struct Runtime {
    portable: bool,
    unsupported: Option<String>,
    restart: Option<RootRestart>,
    release: Option<Descriptor>,
    uncertain: Option<manager::Operation>,
}

#[derive(Default)]
pub(crate) struct PortableUpdate(Mutex<Runtime>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryState {
    retained: bool,
    message: Option<String>,
}

fn recovery_state(runtime: &Runtime) -> RecoveryState {
    RecoveryState {
        retained: runtime.uncertain.is_some(),
        message: runtime.unsupported.clone(),
    }
}

pub(crate) fn recovery_status(handle: &tauri::AppHandle) -> Result<RecoveryState, String> {
    let state = handle.state::<PortableUpdate>();
    let runtime = match state.0.try_lock() {
        Ok(runtime) => runtime,
        Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
        Err(std::sync::TryLockError::WouldBlock) => {
            return Err("A portable restart review is already running.".into());
        }
    };
    Ok(recovery_state(&runtime))
}

// Only a terminal native abort resolution can release a retained lease. No
// Manager::begin, Store operation, selection, download or process exit belongs here.
fn resolve_retained<R, L>(
    restart: &mut Option<R>,
    lease: &mut Option<L>,
    abort: impl FnOnce(&mut R) -> Result<RestartDisposition, String>,
) -> Result<bool, String> {
    if lease.is_none() {
        return Ok(false);
    }
    let client = restart.as_mut().ok_or(UNCERTAIN)?;
    let disposition = abort(client)?;
    if !matches!(
        disposition,
        RestartDisposition::Aborted
            | RestartDisposition::SafeNotArmed
            | RestartDisposition::PeerClosedSafe
    ) {
        return Err(UNCERTAIN.into());
    }
    restart.take();
    lease.take();
    Ok(true)
}

pub(crate) fn review_retained(handle: &tauri::AppHandle) -> Result<RecoveryState, String> {
    let state = handle.state::<PortableUpdate>();
    let mut runtime = match state.0.try_lock() {
        Ok(runtime) => runtime,
        Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
        Err(std::sync::TryLockError::WouldBlock) => {
            return Err("A portable restart review is already running.".into());
        }
    };
    let Runtime {
        restart, uncertain, ..
    } = &mut *runtime;
    match resolve_retained(restart, uncertain, |client| {
        client.abort_pending().map_err(|e| e.to_string())?;
        Ok(client.disposition())
    }) {
        Ok(true) => {
            runtime.unsupported = Some(format!(
                "Restart coordination is safe to close. No update restart was requested. {REOPEN}"
            ));
            Ok(recovery_state(&runtime))
        }
        Ok(false) => Ok(recovery_state(&runtime)),
        Err(error) => {
            let message = if error == UNCERTAIN {
                error
            } else {
                format!("{UNCERTAIN} {error}")
            };
            runtime.unsupported = Some(message.clone());
            Err(message)
        }
    }
}

pub(crate) fn initialize(handle: &tauri::AppHandle) {
    let hinted = std::env::var_os(deployment::HOST_MARKER).is_some();
    let mut runtime = Runtime::default();
    let admission = (|| {
        let session = HostSession::capture().map_err(|e| e.to_string())?;
        let store = Store::open(session.store_path()).map_err(|e| e.to_string())?;
        let expected =
            Expected::linux_x86_64(env!("CARGO_PKG_VERSION")).map_err(|e| e.to_string())?;
        // A hint cannot confer authority or redirect the DEB update path.
        store
            .bind_current_process(&expected)
            .map_err(|e| e.to_string())?;
        runtime.portable = true;
        RootRestart::admit(&session, &store).map_err(|e| e.to_string())
    })();
    match admission {
        Ok(Some(restart)) => runtime.restart = Some(restart),
        Ok(None) => runtime.unsupported = Some(REOPEN.into()),
        Err(error) if hinted || runtime.portable => {
            runtime.unsupported = Some(format!("{REOPEN} {error}"))
        }
        Err(_) => {}
    }
    runtime.portable |= hinted;
    if let Ok(mut state) = handle.state::<PortableUpdate>().0.lock() {
        *state = runtime;
    }
}

pub(crate) fn handles(handle: &tauri::AppHandle) -> bool {
    handle
        .state::<PortableUpdate>()
        .0
        .lock()
        .map(|state| state.portable || state.uncertain.is_some())
        .unwrap_or(true)
}

fn records() -> Result<PathBuf, String> {
    let dir = manager::child_dir("hub-portable-updates")?.join("records");
    platform::reject_links(&dir)?;
    fs::create_dir_all(&dir).map_err(|_| "Cannot prepare portable update records.")?;
    Ok(dir)
}

fn verify_download(release: &Descriptor, directory: &Path) -> Result<VerifiedDownload, String> {
    release.installable()?;
    package::verify_download(release, directory)
}

fn downloaded(release: &Descriptor) -> bool {
    cache_root()
        .is_ok_and(|dir| verify_download(release, &dir.join(release.manifest_sha256())).is_ok())
}

pub(crate) fn check(handle: &tauri::AppHandle, online: bool) -> Result<self_update::State, String> {
    let _operation = handle.state::<manager::Manager>().begin()?;
    let dir = records()?;
    let mut warning = None;
    if online {
        let result = catalog::client().and_then(|client| {
            catalog::discover_portable(&client, &stable(env!("CARGO_PKG_VERSION"))?)
        });
        match result {
            Ok(Some((tag, bytes, sig))) => {
                let release = signed_descriptor(&bytes, &sig)?;
                if release.version() != tag.to_string() {
                    return Err("Portable tag and signed version differ.".into());
                }
                let file = dir.join(format!("{}.json", release.version()));
                if file.exists() {
                    if regular(&file, catalog::MAX_METADATA)? != bytes {
                        warning = Some("Portable metadata changed after publication. Keeping the previously verified record.".into());
                    }
                } else {
                    manager::atomic_write(&file.with_extension("minisig"), &sig)?;
                    manager::atomic_write(&file, &bytes)?;
                }
            }
            Ok(None) => {}
            Err(error) => warning = Some(error),
        }
    }
    let mut releases = Vec::new();
    for (index, entry) in fs::read_dir(&dir)
        .map_err(|_| "Cannot read portable update records.")?
        .enumerate()
    {
        if index >= 128 {
            return Err("Too many portable update records.".into());
        }
        let file = entry
            .map_err(|_| "Cannot inspect portable update record.")?
            .path();
        if file.extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        if let (Ok(bytes), Ok(sig)) = (
            regular(&file, catalog::MAX_METADATA),
            regular(&file.with_extension("minisig"), 4096),
        ) {
            if let Ok(release) = signed_descriptor(&bytes, &sig) {
                if release.validate()? > stable(env!("CARGO_PKG_VERSION"))? {
                    releases.push(release);
                }
            }
        }
    }
    let release = releases
        .into_iter()
        .max_by_key(|r| stable(r.version()).unwrap());
    let state = handle.state::<PortableUpdate>();
    let mut runtime = state
        .0
        .lock()
        .map_err(|_| "Portable updater state is unavailable.")?;
    let result = self_update::State {
        current_version: env!("CARGO_PKG_VERSION"),
        available_version: release.as_ref().map(|r| r.version().to_owned()),
        downloaded: release.as_ref().is_some_and(downloaded),
        install_blocked: runtime
            .unsupported
            .clone()
            .or_else(|| release.as_ref().and_then(|r| r.installable().err())),
        warning,
    };
    runtime.release = release;
    Ok(result)
}

fn selected(handle: &tauri::AppHandle, expected: &str) -> Result<Descriptor, String> {
    let state = handle.state::<PortableUpdate>();
    let runtime = state
        .0
        .lock()
        .map_err(|_| "Portable updater state is unavailable.")?;
    if let Some(error) = &runtime.unsupported {
        return Err(error.clone());
    }
    if runtime.restart.is_none() {
        return Err(REOPEN.into());
    }
    let release = runtime
        .release
        .clone()
        .ok_or("Check for a portable Hub update first.")?;
    if release.version() != expected {
        return Err("The portable update changed. Check again.".into());
    }
    release.installable()?;
    Ok(release)
}

pub(crate) fn download(handle: &tauri::AppHandle, version: &str) -> Result<String, String> {
    let operation = handle.state::<manager::Manager>().begin()?;
    let release = selected(handle, version)?;
    prepare_download(handle, &release, &operation)?;
    Ok("Portable update verified and downloaded. Nothing was installed.".into())
}

fn prepare_download(
    handle: &tauri::AppHandle,
    release: &Descriptor,
    operation: &manager::Operation,
) -> Result<VerifiedDownload, String> {
    release.installable()?;
    package::prepare_download(handle, release, operation)
}

fn retain_uncertain(
    handle: &tauri::AppHandle,
    operation: manager::Operation,
    error: &str,
) -> String {
    let state = handle.state::<PortableUpdate>();
    // Keep the close lease even if a prior coordinator operation poisoned state.
    let mut runtime = state.0.lock().unwrap_or_else(|error| error.into_inner());
    // Unknown exit intent needs the same client and its abort authority intact.
    runtime.uncertain = Some(operation);
    let message = format!("{UNCERTAIN} {error}");
    runtime.unsupported = Some(message.clone());
    message
}

pub(crate) fn install(
    handle: &tauri::AppHandle,
    version: &str,
    restore_views: bool,
) -> Result<String, String> {
    let operation = handle.state::<manager::Manager>().begin()?;
    let release = selected(handle, version)?;
    let mut flow = NativeInstall {
        handle,
        release,
        restore_views,
        operation: Some(operation),
    };
    match run_install(&mut flow)? {
        InstallOutcome::Declined => Ok(
            "Portable update cancelled. Selection and settings were kept; nothing was installed."
                .into(),
        ),
        InstallOutcome::ExitRequested => Ok("Portable update staged. Hub is closing normally; its helper will select the new generation only after this Hub exits.".into()),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum InstallOutcome {
    Declined,
    ExitRequested,
}

// This boundary executes the same sequence for UI and direct command callers.
// Tests supply effects, not an alternative implementation of the sequencing.
trait InstallFlow {
    type Verified;
    type Review;
    type Staged;
    type Ready;
    fn prepare_download(&mut self) -> Result<Self::Verified, String>;
    fn review(&mut self, package: &Self::Verified) -> Result<Self::Review, String>;
    fn approve(&mut self, review: &Self::Review) -> Result<bool, String>;
    fn stage(
        &mut self,
        package: &Self::Verified,
        review: &Self::Review,
        approved: bool,
    ) -> Result<Option<Self::Staged>, String>;
    fn before_restart(
        &mut self,
        package: &Self::Verified,
        review: &Self::Review,
    ) -> Result<(), String>;
    fn prepare_restart(&mut self, staged: Self::Staged) -> Result<Self::Ready, String>;
    fn authorize_exit(&mut self, ready: Self::Ready) -> Result<(), String>;
    fn disposition(&self) -> RestartDisposition;
    fn close_for_restart(&mut self) -> Result<(), String>;
    fn abort_pending(&mut self) -> RestartDisposition;
    fn retain_uncertain(&mut self, error: &str) -> String;
    fn request_normal_exit(&mut self);
}

fn run_install(flow: &mut impl InstallFlow) -> Result<InstallOutcome, String> {
    let package = flow.prepare_download()?;
    let review = flow.review(&package)?;
    let approved = flow.approve(&review)?;
    let staged = flow.stage(&package, &review, approved)?;
    if !approved {
        if staged.is_some() {
            return Err(
                "The declined update unexpectedly staged; no restart was requested.".into(),
            );
        }
        return Ok(InstallOutcome::Declined);
    }
    let Some(staged) = staged else {
        return Ok(InstallOutcome::Declined);
    };
    flow.before_restart(&package, &review)?;
    let ready = match flow.prepare_restart(staged) {
        Ok(ready) => ready,
        Err(error) => return Err(restart_failure(flow, &error)),
    };
    // The operation lease still blocks ordinary exit while intent is unresolved.
    // Prepared alone never permits this path to request an update exit.
    if let Err(error) = flow.authorize_exit(ready) {
        return Err(restart_failure(flow, &error));
    }
    if flow.disposition() != RestartDisposition::ExitAuthorized {
        return Err(restart_failure(
            flow,
            "The helper did not authorize the portable update exit.",
        ));
    }
    if let Err(error) = flow.close_for_restart() {
        return Err(restart_failure(flow, &error));
    }
    // No fallible work, Tauri restart, selection or new launch after this point.
    // Only the authenticated selector can commit after observing our exit zero.
    flow.request_normal_exit();
    Ok(InstallOutcome::ExitRequested)
}

fn restart_failure(flow: &mut impl InstallFlow, error: &str) -> String {
    match flow.abort_pending() {
        RestartDisposition::Aborted => format!(
            "{error} The helper acknowledged cancellation; no update restart was requested. Close and reopen Hub through its helper before retrying."
        ),
        RestartDisposition::SafeNotArmed
        | RestartDisposition::Idle
        | RestartDisposition::Prepared => format!(
            "{error} No update exit is authorized. You can close Hub normally; reopen it through its helper before retrying."
        ),
        RestartDisposition::PeerClosedSafe => format!(
            "{error} The restart peer closed safely. You can close Hub normally; reopen it through its helper before retrying."
        ),
        // ExitAuthorized after abort would violate the native API contract. Do
        // not turn that contradiction into an ordinary zero-code exit either.
        RestartDisposition::Unknown | RestartDisposition::ExitAuthorized => {
            flow.retain_uncertain(error)
        }
    }
}

struct NativeInstall<'a> {
    handle: &'a tauri::AppHandle,
    release: Descriptor,
    restore_views: bool,
    operation: Option<manager::Operation>,
}

struct ReviewedInstall {
    store: Store,
    review: RestartReview,
    views: Vec<crate::hosted_restore::View>,
}

impl InstallFlow for NativeInstall<'_> {
    type Verified = VerifiedDownload;
    type Review = ReviewedInstall;
    type Staged = StagedRestart;
    type Ready = RestartReady;

    fn prepare_download(&mut self) -> Result<Self::Verified, String> {
        prepare_download(
            self.handle,
            &self.release,
            self.operation.as_ref().ok_or(UNCERTAIN)?,
        )
    }
    fn review(&mut self, package: &Self::Verified) -> Result<Self::Review, String> {
        let session = HostSession::capture().map_err(|e| e.to_string())?;
        let store = Store::open(session.store_path()).map_err(|e| e.to_string())?;
        store
            .bind_current_process(
                &Expected::linux_x86_64(env!("CARGO_PKG_VERSION")).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
        let review = store
            .review_restart(&session, package.package())
            .map_err(|e| e.to_string())?;
        Ok(ReviewedInstall {
            store,
            review,
            views: crate::features::update_views(self.handle)?,
        })
    }
    fn approve(&mut self, reviewed: &Self::Review) -> Result<bool, String> {
        if self
            .handle
            .state::<manager::Manager>()
            .cancellation()
            .load(Ordering::SeqCst)
        {
            return Err(
                "Portable update cancelled before approval. Nothing was staged or installed."
                    .into(),
            );
        }
        let notice = if reviewed.views.is_empty() {
            String::new()
        } else if self.restore_views {
            "\n\nYour open Hub tool page will reopen. Unsaved form entries will be discarded."
                .into()
        } else {
            "\n\nAutomatic reopening is turned off. Unsaved form entries will be discarded.".into()
        };
        let _ = self.handle.emit(
            "app-progress",
            self_update::Progress {
                message: "Portable download verified. Waiting for update approval...".into(),
                received: 0,
                total: 0,
                cancellable: false,
            },
        );
        Ok(self.handle.dialog().message(format!(
            "Update portable Creator Hub from {} to {}?\n\nThe signed download has been verified. Hub will close normally; its registered helper will then select and open the new generation. Your old generations, settings, projects and MCP connections will stay in place. Cancelling keeps the current selection unchanged.{}",
            reviewed.review.before().version, self.release.version(), notice))
            .title("Update Creator Hub")
            .buttons(MessageDialogButtons::OkCancelCustom("Update Hub".into(), "Not now".into()))
            .blocking_show())
    }
    fn stage(
        &mut self,
        package: &Self::Verified,
        reviewed: &Self::Review,
        approved: bool,
    ) -> Result<Option<Self::Staged>, String> {
        let manager = self.handle.state::<manager::Manager>();
        let choice = if approved {
            RestartChoice::StageReviewed
        } else {
            RestartChoice::KeepCurrent
        };
        match reviewed
            .store
            .stage_restart(&reviewed.review, package.package(), choice, || {
                manager.cancellation().load(Ordering::SeqCst)
            })
            .map_err(|e| e.to_string())?
        {
            RestartStageOutcome::Declined => Ok(None),
            RestartStageOutcome::Staged(staged) => Ok(Some(staged)),
        }
    }
    fn before_restart(
        &mut self,
        package: &Self::Verified,
        reviewed: &Self::Review,
    ) -> Result<(), String> {
        if self
            .handle
            .state::<manager::Manager>()
            .cancellation()
            .load(Ordering::SeqCst)
        {
            return Err(
                "Portable update cancelled. The staged generation was retained but not selected."
                    .into(),
            );
        }
        if self.restore_views && !reviewed.views.is_empty() {
            self.handle
                .state::<crate::hosted_restore::Restore>()
                .remember(reviewed.views.clone(), package.descriptor().version())?;
        }
        Ok(())
    }
    fn prepare_restart(&mut self, staged: Self::Staged) -> Result<Self::Ready, String> {
        let state = self.handle.state::<PortableUpdate>();
        let mut runtime = state
            .0
            .lock()
            .map_err(|_| "Portable updater state is unavailable.")?;
        runtime
            .restart
            .as_mut()
            .ok_or(REOPEN)?
            .prepare(staged)
            .map_err(|e| e.to_string())
    }
    fn authorize_exit(&mut self, ready: Self::Ready) -> Result<(), String> {
        let state = self.handle.state::<PortableUpdate>();
        let mut runtime = state
            .0
            .lock()
            .map_err(|_| "Portable updater state is unavailable.")?;
        runtime
            .restart
            .as_mut()
            .ok_or(REOPEN)?
            .authorize_exit(ready)
            .map_err(|e| e.to_string())
    }
    fn disposition(&self) -> RestartDisposition {
        self.handle
            .state::<PortableUpdate>()
            .0
            .lock()
            .map(|runtime| {
                runtime
                    .restart
                    .as_ref()
                    .map(RootRestart::disposition)
                    .unwrap_or(RestartDisposition::Unknown)
            })
            .unwrap_or(RestartDisposition::Unknown)
    }
    fn close_for_restart(&mut self) -> Result<(), String> {
        let _ = self.handle.emit(
            "app-progress",
            self_update::Progress {
                message: "Portable update staged. Preparing normal Hub exit...".into(),
                received: 0,
                total: 0,
                cancellable: false,
            },
        );
        self.handle
            .state::<manager::Manager>()
            .close_for_portable_restart(self.operation.as_ref().ok_or(UNCERTAIN)?)
    }
    fn abort_pending(&mut self) -> RestartDisposition {
        let state = self.handle.state::<PortableUpdate>();
        let mut runtime = state.0.lock().unwrap_or_else(|error| error.into_inner());
        let disposition = match runtime.restart.as_mut() {
            Some(restart) => {
                // Classify the native disposition even when abort reports an
                // error: pre-intent failures can already be safe to close.
                let _ = restart.abort_pending();
                restart.disposition()
            }
            None => RestartDisposition::Unknown,
        };
        if !matches!(
            disposition,
            RestartDisposition::Unknown | RestartDisposition::ExitAuthorized
        ) {
            runtime.restart.take();
            runtime.unsupported = Some(REOPEN.into());
        }
        disposition
    }
    fn retain_uncertain(&mut self, error: &str) -> String {
        match self.operation.take() {
            Some(operation) => retain_uncertain(self.handle, operation, error),
            None => UNCERTAIN.into(),
        }
    }
    fn request_normal_exit(&mut self) {
        self.handle.exit(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retained_unknown_review_retries_abort_then_releases_only_on_safe_terminal_without_replay() {
        use std::{cell::Cell, collections::VecDeque, rc::Rc};
        struct Lease(Rc<Cell<usize>>);
        impl Drop for Lease {
            fn drop(&mut self) {
                self.0.set(self.0.get() + 1);
            }
        }
        for safe in [
            RestartDisposition::Aborted,
            RestartDisposition::SafeNotArmed,
            RestartDisposition::PeerClosedSafe,
        ] {
            let released = Rc::new(Cell::new(0));
            let mut lease = Some(Lease(Rc::clone(&released)));
            let mut client = Some(VecDeque::from([
                Ok(RestartDisposition::Unknown),
                Err("Abort acknowledgement is still unavailable.".into()),
                Ok(safe),
            ]));
            let calls = Cell::new(0);
            let abort = |client: &mut VecDeque<Result<RestartDisposition, String>>| {
                calls.set(calls.get() + 1);
                client
                    .pop_front()
                    .expect("A resolved review must not replay abort")
            };
            for _ in 0..2 {
                assert!(resolve_retained(&mut client, &mut lease, abort).is_err());
                assert!(client.is_some() && lease.is_some());
                assert_eq!(released.get(), 0);
            }
            assert_eq!(resolve_retained(&mut client, &mut lease, abort), Ok(true));
            assert!(client.is_none() && lease.is_none());
            assert_eq!(released.get(), 1);
            assert_eq!(calls.get(), 3);
            assert_eq!(resolve_retained(&mut client, &mut lease, abort), Ok(false));
            assert_eq!(calls.get(), 3);
            assert_eq!(released.get(), 1);
        }
    }

    #[test]
    fn retained_review_refuses_missing_client_or_nonterminal_states_without_dropping_lease() {
        let mut lease = Some(());
        let mut missing: Option<()> = None;
        assert!(resolve_retained(&mut missing, &mut lease, |_| panic!("No client")).is_err());
        assert!(lease.is_some());
        for disposition in [
            RestartDisposition::Idle,
            RestartDisposition::Prepared,
            RestartDisposition::ExitAuthorized,
            RestartDisposition::Unknown,
        ] {
            let mut client = Some(());
            assert!(resolve_retained(&mut client, &mut lease, |_| Ok(disposition)).is_err());
            assert!(client.is_some() && lease.is_some());
        }
    }

    struct FlowFixture {
        steps: Vec<&'static str>,
        fail: Vec<&'static str>,
        cached: bool,
        approved: bool,
        staged: bool,
        retained: bool,
        exited: bool,
        disposition: RestartDisposition,
        authorized_disposition: RestartDisposition,
        abort_disposition: RestartDisposition,
    }

    impl Default for FlowFixture {
        fn default() -> Self {
            Self {
                steps: Vec::new(),
                fail: Vec::new(),
                cached: false,
                approved: true,
                staged: false,
                retained: false,
                exited: false,
                disposition: RestartDisposition::Idle,
                authorized_disposition: RestartDisposition::ExitAuthorized,
                abort_disposition: RestartDisposition::Aborted,
            }
        }
    }

    impl FlowFixture {
        fn step(&mut self, phase: &'static str) -> Result<(), String> {
            self.steps.push(phase);
            if self.fail.contains(&phase) {
                Err(format!("injected {phase} failure"))
            } else {
                Ok(())
            }
        }
    }

    impl InstallFlow for FlowFixture {
        type Verified = ();
        type Review = ();
        type Staged = ();
        type Ready = ();

        fn prepare_download(&mut self) -> Result<(), String> {
            if self.cached {
                self.step("verify-cache")?;
            } else {
                self.step("download")?;
                self.step("verify-download")?;
                self.step("publish-cache")?;
                self.cached = true;
            }
            Ok(())
        }
        fn review(&mut self, _: &()) -> Result<(), String> {
            self.step("review")
        }
        fn approve(&mut self, _: &()) -> Result<bool, String> {
            self.step("approval")?;
            Ok(self.approved)
        }
        fn stage(&mut self, _: &(), _: &(), approved: bool) -> Result<Option<()>, String> {
            assert_eq!(approved, self.approved);
            if !approved {
                self.step("decline")?;
                return Ok(None);
            }
            self.step("stage")?;
            self.staged = true;
            Ok(Some(()))
        }
        fn before_restart(&mut self, _: &(), _: &()) -> Result<(), String> {
            self.step("before-restart")
        }
        fn prepare_restart(&mut self, _: ()) -> Result<(), String> {
            self.step("readiness")?;
            self.disposition = RestartDisposition::Prepared;
            Ok(())
        }
        fn authorize_exit(&mut self, _: ()) -> Result<(), String> {
            assert_eq!(self.disposition, RestartDisposition::Prepared);
            self.disposition = RestartDisposition::Unknown;
            self.step("exit-authorization")?;
            self.disposition = self.authorized_disposition;
            Ok(())
        }
        fn disposition(&self) -> RestartDisposition {
            self.disposition
        }
        fn close_for_restart(&mut self) -> Result<(), String> {
            assert_eq!(self.disposition, RestartDisposition::ExitAuthorized);
            self.step("close-transfer")
        }
        fn abort_pending(&mut self) -> RestartDisposition {
            self.steps.push("abort-resolution");
            self.disposition = self.abort_disposition;
            self.disposition
        }
        fn retain_uncertain(&mut self, error: &str) -> String {
            self.steps.push("retain-close-lease");
            self.retained = true;
            format!("{UNCERTAIN} {error}")
        }
        fn request_normal_exit(&mut self) {
            assert_eq!(self.disposition, RestartDisposition::ExitAuthorized);
            self.steps.push("exit-zero");
            self.exited = true;
        }
    }

    #[test]
    fn direct_install_without_automatic_download_prepares_cache_before_approval() {
        let mut flow = FlowFixture::default();
        assert_eq!(run_install(&mut flow), Ok(InstallOutcome::ExitRequested));
        assert_eq!(
            flow.steps,
            [
                "download",
                "verify-download",
                "publish-cache",
                "review",
                "approval",
                "stage",
                "before-restart",
                "readiness",
                "exit-authorization",
                "close-transfer",
                "exit-zero"
            ]
        );
        assert!(flow.cached && flow.staged && flow.exited && !flow.retained);
    }

    #[test]
    fn cached_direct_install_still_verifies_and_never_downloads_again() {
        let mut flow = FlowFixture {
            cached: true,
            ..Default::default()
        };
        assert_eq!(run_install(&mut flow), Ok(InstallOutcome::ExitRequested));
        assert_eq!(flow.steps[0], "verify-cache");
        assert!(!flow.steps.contains(&"download"));
        let mut corrupt = FlowFixture {
            cached: true,
            fail: vec!["verify-cache"],
            ..Default::default()
        };
        assert!(run_install(&mut corrupt).is_err());
        assert_eq!(corrupt.steps, ["verify-cache"]);
        assert!(!corrupt.staged && !corrupt.exited);
    }

    #[test]
    fn native_approval_cancel_retains_verified_cache_without_staging_or_restart() {
        let mut flow = FlowFixture {
            approved: false,
            ..Default::default()
        };
        assert_eq!(run_install(&mut flow), Ok(InstallOutcome::Declined));
        assert_eq!(
            flow.steps,
            [
                "download",
                "verify-download",
                "publish-cache",
                "review",
                "approval",
                "decline"
            ]
        );
        assert!(flow.cached && !flow.staged && !flow.exited && !flow.retained);
    }

    #[test]
    fn download_verification_review_and_staging_failures_never_request_exit() {
        for phase in [
            "download",
            "verify-download",
            "publish-cache",
            "review",
            "approval",
            "stage",
            "before-restart",
        ] {
            let mut flow = FlowFixture {
                fail: vec![phase],
                ..Default::default()
            };
            assert!(run_install(&mut flow).unwrap_err().contains(phase));
            assert!(!flow.exited && !flow.retained);
            assert!(!flow.steps.contains(&"readiness"));
            if ["download", "verify-download", "publish-cache", "review"].contains(&phase) {
                assert!(!flow.steps.contains(&"approval"));
                assert!(!flow.staged);
            }
        }
    }

    #[test]
    fn failed_readiness_resolves_abort_without_authorizing_or_blocking_ordinary_close() {
        for disposition in [
            RestartDisposition::Idle,
            RestartDisposition::Aborted,
            RestartDisposition::SafeNotArmed,
            RestartDisposition::PeerClosedSafe,
        ] {
            let mut flow = FlowFixture {
                fail: vec!["readiness"],
                abort_disposition: disposition,
                ..Default::default()
            };
            let error = run_install(&mut flow).unwrap_err();
            assert!(flow.staged && !flow.retained && !flow.exited);
            assert!(!error.contains(UNCERTAIN));
            assert_eq!(flow.steps.last(), Some(&"abort-resolution"));
            assert!(!flow.steps.contains(&"exit-authorization"));
            assert!(!flow.steps.contains(&"close-transfer"));
        }
    }

    #[test]
    fn failed_exit_authorization_or_close_uses_native_abort_disposition() {
        for phase in ["exit-authorization", "close-transfer"] {
            for disposition in [
                RestartDisposition::Aborted,
                RestartDisposition::SafeNotArmed,
                RestartDisposition::PeerClosedSafe,
                RestartDisposition::Unknown,
            ] {
                let mut flow = FlowFixture {
                    fail: vec![phase],
                    abort_disposition: disposition,
                    ..Default::default()
                };
                let error = run_install(&mut flow).unwrap_err();
                assert!(!flow.exited);
                let uncertain = disposition == RestartDisposition::Unknown;
                assert_eq!(flow.retained, uncertain);
                assert_eq!(error.contains(UNCERTAIN), uncertain);
                assert!(!error.contains("selection was kept"));
                assert!(flow.steps.contains(&"abort-resolution"));
                if phase == "exit-authorization" {
                    assert!(!flow.steps.contains(&"close-transfer"));
                }
            }
        }
    }

    #[test]
    fn successful_call_without_exit_authorized_disposition_never_transfers_close_or_exits() {
        for disposition in [
            RestartDisposition::Idle,
            RestartDisposition::Prepared,
            RestartDisposition::Aborted,
            RestartDisposition::SafeNotArmed,
            RestartDisposition::PeerClosedSafe,
            RestartDisposition::Unknown,
        ] {
            let mut flow = FlowFixture {
                authorized_disposition: disposition,
                ..Default::default()
            };
            let error = run_install(&mut flow).unwrap_err();
            assert!(error.contains("did not authorize"));
            assert!(!flow.exited && !flow.retained);
            assert!(flow.steps.contains(&"abort-resolution"));
            assert!(!flow.steps.contains(&"close-transfer"));
        }
    }

    #[test]
    fn abort_cannot_leave_an_authorized_exit_released_as_a_normal_failure() {
        let mut flow = FlowFixture {
            fail: vec!["close-transfer"],
            abort_disposition: RestartDisposition::ExitAuthorized,
            ..Default::default()
        };
        assert!(run_install(&mut flow).unwrap_err().contains(UNCERTAIN));
        assert!(flow.retained && !flow.exited);
    }

    #[test]
    fn strictly_newer_update_policy_is_not_weakened_by_shared_identity() {
        let current = stable(env!("CARGO_PKG_VERSION")).unwrap();
        let older = semver::Version::new(
            current.major,
            current.minor,
            current.patch.checked_sub(1).unwrap(),
        );
        let newer = semver::Version::new(current.major, current.minor, current.patch + 1);
        for version in [&older, &current, &newer] {
            let descriptor = package::test_descriptor(&version.to_string(), "0.0.0");
            assert!(descriptor.validate().is_ok());
            assert_eq!(descriptor.installable().is_ok(), *version > current);
        }
        let incompatible = package::test_descriptor(&newer.to_string(), &newer.to_string());
        assert!(incompatible.validate().is_ok());
        assert!(incompatible
            .installable()
            .unwrap_err()
            .contains("intermediate Hub version"));
    }
}
