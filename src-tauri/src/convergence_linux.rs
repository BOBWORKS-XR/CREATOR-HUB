//! Nondefault development route. TEST ONLY helper packages are never shipping payloads.
use crate::{catalog::AppId, convergence_dependencies, linux_retirement, manager, platform};
use linux_retirement::Target;
use serde::{Deserialize, Serialize};
use std::{
    cell::Cell,
    fs,
    path::{Path, PathBuf},
};

const TARGETS: [Target; 2] = [Target::Mcp, Target::Setup];
const MCP: &str = "/usr/bin/creator-works-mcp-launcher";
const SETUP: &str = "/usr/bin/creator-project-setup";
const MCP_GUI: [&str; 5] = [
    MCP,
    "/usr/share/applications/Creator Works MCP.desktop",
    "/usr/share/icons/hicolor/128x128/apps/creator-works-mcp-launcher.png",
    "/usr/share/icons/hicolor/256x256@2/apps/creator-works-mcp-launcher.png",
    "/usr/share/icons/hicolor/32x32/apps/creator-works-mcp-launcher.png",
];
const SETUP_GUI: [&str; 5] = [
    SETUP,
    "/usr/share/applications/Creator Project Setup.desktop",
    "/usr/share/icons/hicolor/128x128/apps/creator-project-setup.png",
    "/usr/share/icons/hicolor/256x256@2/apps/creator-project-setup.png",
    "/usr/share/icons/hicolor/32x32/apps/creator-project-setup.png",
];

fn executable(target: Target) -> &'static str {
    match target {
        Target::Mcp => MCP,
        Target::Setup => SETUP,
    }
}

fn targets(paths: &[PathBuf]) -> Result<Vec<Target>, String> {
    let mut found = Vec::new();
    for path in paths {
        let target = TARGETS
            .into_iter()
            .find(|target| path.as_os_str() == std::ffi::OsStr::new(executable(*target)))
            .ok_or("Only exact original MCP 2.7.7 and Setup 0.3.7 DEB locations are admitted; custom locations were kept.")?;
        if found.contains(&target) {
            return Err("Duplicate standalone locations need review; no app was removed.".into());
        }
        found.push(target);
    }
    if found.is_empty() {
        return Err("No standalone location was supplied for native baseline inspection.".into());
    }
    Ok(TARGETS
        .into_iter()
        .filter(|target| found.contains(target))
        .collect())
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Journal {
    policy: u32,
    state: State,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum State {
    ReviewRequired,
    Cancelled,
    Verified,
}

fn journal_path(target: Target) -> Result<PathBuf, String> {
    // Keep the original MCP journal readable; never downgrade an interrupted attempt.
    Ok(manager::child_dir("convergence")?.join(match target {
        Target::Mcp => "linux-retirement-v1.json",
        Target::Setup => "linux-retirement-setup-v1.json",
    }))
}

fn read_at(path: &Path) -> Result<Option<Journal>, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err("Cannot inspect the Linux cleanup record. Keep retained files.".into())
        }
        Ok(_) => {}
    }
    let saved: Journal =
        serde_json::from_slice(&manager::bounded_read(path, 2048)?).map_err(|_| {
            "The Linux cleanup record needs manual review; no transaction was replayed."
        })?;
    if saved.policy != 1 {
        return Err(
            "Unknown Linux cleanup policy. Keep retained files and review package state.".into(),
        );
    }
    Ok(Some(saved))
}

fn save(target: Target, state: State) -> Result<(), String> {
    let path = journal_path(target)?;
    read_at(&path)?;
    manager::atomic_write(
        &path,
        &serde_json::to_vec(&Journal { policy: 1, state })
            .map_err(|_| "Cannot encode Linux cleanup review.")?,
    )
}

fn journals() -> Result<[Option<Journal>; 2], String> {
    Ok([
        read_at(&journal_path(Target::Mcp)?)?,
        read_at(&journal_path(Target::Setup)?)?,
    ])
}

pub fn pending() -> Result<bool, String> {
    // Parse both even if the first is pending, so unknown saved state cannot hide.
    Ok(journals()?
        .iter()
        .flatten()
        .any(|saved| saved.state == State::ReviewRequired))
}

fn idle(target: Target) -> Result<(), String> {
    let app = match target {
        Target::Mcp => AppId::Mcp,
        Target::Setup => AppId::Setup,
    };
    let state = platform::running_gui(app, Path::new(executable(target)))?;
    if !state.gui.is_empty() || state.other_copy {
        return Err("Close the standalone Creator app window and check again. No Node, AI client or Unity process was stopped.".into());
    }
    Ok(())
}

fn native_deb() -> Result<(), String> {
    if crate::update_target::Target::native()?.package != "deb" {
        return Err("This experimental migration route supports only the native DEB installation. Existing apps and data were kept.".into());
    }
    Ok(())
}

struct Installation {
    target: Target,
    helper: linux_retirement::Plan,
    dependencies: convergence_dependencies::GuiRetirementSnapshot,
    retained_only: bool,
}

fn gui_paths(target: Target) -> [PathBuf; 5] {
    match target {
        Target::Mcp => MCP_GUI,
        Target::Setup => SETUP_GUI,
    }
    .map(PathBuf::from)
}

/// Original package/helper identities, captured before the guide's consent.
/// A fresh installation need not have an activated Hub router yet.
#[cfg(feature = "integrated-features")]
pub struct Originals {
    installations: Vec<(Target, linux_retirement::Plan)>,
}

#[cfg(feature = "integrated-features")]
impl Originals {
    pub fn inspect(paths: &[PathBuf]) -> Result<Self, String> {
        native_deb()?;
        let mut installations = Vec::new();
        for target in targets(paths)? {
            idle(target)?;
            installations.push((target, linux_retirement::Plan::inspect(target)?));
        }
        let originals = Self { installations };
        originals.recheck()?;
        Ok(originals)
    }

    pub fn recheck(&self) -> Result<(), String> {
        native_deb()?;
        if pending()? {
            return Err("An earlier Linux cleanup needs outcome review. No package transaction was replayed.".into());
        }
        for (target, helper) in &self.installations {
            idle(*target)?;
            helper.recheck_baseline()?;
        }
        Ok(())
    }

    pub fn bind(self, router: &Path) -> Result<Plan, String> {
        self.recheck()?;
        let mut installations = Vec::new();
        for (target, helper) in self.installations {
            let dependencies =
                convergence_dependencies::gui_retirement_snapshot(&gui_paths(target), router);
            dependencies.recheck().map_err(|_| {
                "A client setting or GUI dependency needs review. Original apps were kept."
            })?;
            installations.push(Installation {
                target,
                helper,
                dependencies,
                retained_only: false,
            });
        }
        let plan = Plan {
            installations,
            outcome_reviewed: Cell::new(false),
            transition_blocked: Cell::new(false),
            router: router.to_owned(),
        };
        plan.recheck()?;
        Ok(plan)
    }
}

pub struct Plan {
    installations: Vec<Installation>,
    outcome_reviewed: Cell<bool>,
    transition_blocked: Cell<bool>,
    #[cfg(feature = "integrated-features")]
    router: PathBuf,
}

/// Borrowed, native-only renewal boundary. Dropping it after any failed transfer
/// leaves the original plan blocked; a renderer or saved record cannot renew it.
#[cfg(feature = "integrated-features")]
pub struct ConnectionTransfer<'a> {
    plan: &'a mut Plan,
}

#[cfg(any(feature = "integrated-features", test))]
fn begin_transfer(
    blocked: &Cell<bool>,
    recheck: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if blocked.get() {
        return Err(
            "A previous connection transfer needs outcome review; cleanup cannot be replayed."
                .into(),
        );
    }
    recheck()?;
    blocked.set(true);
    Ok(())
}

#[cfg(any(feature = "integrated-features", test))]
fn renew_transfer<T>(
    blocked: &Cell<bool>,
    recheck: impl Fn() -> Result<(), String>,
    capture: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    if !blocked.get() {
        return Err("No approved connection transfer is awaiting renewal.".into());
    }
    recheck()?;
    let renewed = capture()?;
    recheck()?;
    blocked.set(false);
    Ok(renewed)
}

#[cfg(feature = "integrated-features")]
impl ConnectionTransfer<'_> {
    // Root calls this only after the approved service writes, workflow finish,
    // idle check and exact settings/outcome verification have all succeeded.
    pub fn complete(self) -> Result<(), String> {
        let plan = self.plan;
        let renewed = renew_transfer(
            &plan.transition_blocked,
            || plan.recheck_native_with(&[]),
            || {
                let mut renewed = Vec::new();
                for app in &plan.installations {
                    let dependencies = convergence_dependencies::gui_retirement_snapshot(
                        &gui_paths(app.target),
                        &plan.router,
                    );
                    dependencies.recheck().map_err(|_| "The completed connection transfer has a GUI dependency or unreviewable client state. Apps were kept.")?;
                    renewed.push(dependencies);
                }
                Ok(renewed)
            },
        )?;
        for (app, dependencies) in plan.installations.iter_mut().zip(renewed) {
            app.dependencies = dependencies;
        }
        if let Err(reason) = plan.recheck() {
            plan.transition_blocked.set(true);
            return Err(reason);
        }
        Ok(())
    }
}

impl Plan {
    pub fn inspect(paths: &[PathBuf], router: &Path) -> Result<Self, String> {
        native_deb()?;
        let originals = targets(paths)?;
        Self::inspect_targets(&originals, router)
    }

    pub fn inspect_retained(router: &Path) -> Result<Self, String> {
        native_deb()?;
        Self::inspect_targets(&[], router)
    }

    fn inspect_targets(originals: &[Target], router: &Path) -> Result<Self, String> {
        let saved = journals()?;
        let mut installations = Vec::new();
        for (target, journal) in TARGETS.into_iter().zip(saved) {
            let retained_only = journal.is_some_and(|saved| saved.state == State::ReviewRequired);
            if retained_only && originals.contains(&target) {
                return Err("An earlier cleanup still has a GUI location. Its outcome needs review; no package transaction was replayed.".into());
            }
            if !retained_only && !originals.contains(&target) {
                continue;
            }
            idle(target)?;
            let helper = if retained_only {
                linux_retirement::Plan::inspect_retained(target)?
            } else {
                linux_retirement::Plan::inspect(target)?
            };
            // Each product has five GUI files. Separate snapshots preserve the
            // existing dependency gate's eight-path bound instead of widening it.
            let paths = gui_paths(target);
            let dependencies = convergence_dependencies::gui_retirement_snapshot(&paths, router);
            dependencies.recheck().map_err(|_| {
                "A client setting or GUI dependency needs review. Existing apps and records were kept."
            })?;
            installations.push(Installation {
                target,
                helper,
                dependencies,
                retained_only,
            });
        }
        if installations.is_empty() {
            return Err("No pending Linux cleanup was found for outcome review.".into());
        }
        let plan = Self {
            installations,
            outcome_reviewed: Cell::new(false),
            transition_blocked: Cell::new(false),
            #[cfg(feature = "integrated-features")]
            router: router.to_owned(),
        };
        plan.recheck()?;
        Ok(plan)
    }

    pub fn retained_only(&self) -> bool {
        self.installations.iter().all(|app| app.retained_only)
    }

    pub fn recheck(&self) -> Result<(), String> {
        self.recheck_with(&[])
    }

    #[cfg(feature = "integrated-features")]
    pub fn begin_connection_transfer(&mut self) -> Result<ConnectionTransfer<'_>, String> {
        if self.installations.iter().any(|app| app.retained_only) {
            return Err(
                "A retained cleanup outcome cannot start a new connection transfer.".into(),
            );
        }
        begin_transfer(&self.transition_blocked, || self.recheck())?;
        Ok(ConnectionTransfer { plan: self })
    }

    fn recheck_with(&self, completed: &[Target]) -> Result<(), String> {
        if self.transition_blocked.get() {
            return Err("The approved connection transfer did not finish its checks. Keep recovery records; no cleanup was started.".into());
        }
        self.recheck_native_with(completed)?;
        for app in &self.installations {
            app.dependencies.recheck().map_err(|_| {
                "Client configuration changed or depends on the old GUI. Check again before cleanup."
            })?;
        }
        Ok(())
    }

    fn recheck_native_with(&self, completed: &[Target]) -> Result<(), String> {
        native_deb()?;
        for (target, journal) in TARGETS.into_iter().zip(journals()?) {
            let retained = self
                .installations
                .iter()
                .any(|app| app.target == target && app.retained_only)
                || completed.contains(&target);
            if journal.is_some_and(|saved| saved.state == State::ReviewRequired) != retained {
                return Err("A Linux cleanup outcome changed. Keep recovery records and check again; no retry was started.".into());
            }
        }
        for app in &self.installations {
            idle(app.target)?;
            if app.retained_only || completed.contains(&app.target) {
                app.helper.verify_retained()?;
            } else {
                app.helper.recheck_baseline()?;
            }
        }
        Ok(())
    }

    pub fn retire_after_native_review(&self) -> Result<linux_retirement::Outcome, String> {
        self.retire_after_native_review_batch(|| Ok(()), || {})
    }

    pub fn retire_after_native_review_batch(
        &self,
        preflight: impl Fn() -> Result<(), String>,
        attempted: impl Fn(),
    ) -> Result<linux_retirement::Outcome, String> {
        self.outcome_reviewed.set(false);
        preflight()?;
        self.recheck()?;
        let mut completed = Vec::new();
        for app in &self.installations {
            if app.retained_only {
                // A saved pending outcome permits independent inspection only.
                continue;
            }
            preflight()?;
            self.recheck_with(&completed)?;
            // Persist per product before elevation. Never clear another product's
            // pending outcome when this authorization is cancelled or unknown.
            attempted();
            save(app.target, State::ReviewRequired)?;
            match app.helper.retire_after_native_review()? {
                linux_retirement::Outcome::Cancelled => {
                    save(app.target, State::Cancelled)?;
                    return cancelled_retirement(
                        &completed,
                        self.installations.iter().any(|app| app.retained_only),
                    );
                }
                linux_retirement::Outcome::ExperimentalVerified => completed.push(app.target),
            }
            preflight()?;
            self.recheck_with(&completed)?;
        }
        self.outcome_reviewed.set(true);
        Ok(linux_retirement::Outcome::ExperimentalVerified)
    }

    pub fn complete_review(&self) -> Result<(), String> {
        if !self.outcome_reviewed.get() {
            return Err("The Linux cleanup outcome needs a fresh native review before completion. No transaction was replayed.".into());
        }
        let completed = self
            .installations
            .iter()
            .map(|app| app.target)
            .collect::<Vec<_>>();
        // Verify every product, journal, GUI and dependency before clearing any
        // pending review. Partial verification never publishes batch completion.
        self.recheck_with(&completed)?;
        for app in &self.installations {
            save(app.target, State::Verified)?;
        }
        Ok(())
    }
}

fn cancelled_retirement(
    completed: &[Target],
    retained: bool,
) -> Result<linux_retirement::Outcome, String> {
    if !completed.is_empty() || retained {
        return Err("Cleanup partially completed; a later system authorization was cancelled. Earlier outcomes remain pending review. Check again; no package transaction was replayed.".into());
    }
    Ok(linux_retirement::Outcome::Cancelled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn original_targets_are_finite_deduplicated_and_keep_the_two_product_order() {
        assert_eq!(
            targets(&[PathBuf::from(SETUP), PathBuf::from(MCP)]).unwrap(),
            TARGETS
        );
        assert!(targets(&[]).is_err());
        assert!(targets(&[PathBuf::from(MCP), PathBuf::from(MCP)]).is_err());
        assert!(targets(&[PathBuf::from("/opt/custom-mcp")]).is_err());
        assert_eq!(gui_paths(Target::Mcp).len(), 5);
        assert_eq!(gui_paths(Target::Setup).len(), 5);
    }

    #[test]
    fn a_failed_or_dropped_transfer_cannot_start_another_or_authorize_cleanup() {
        let blocked = Cell::new(false);
        assert!(begin_transfer(&blocked, || Err("original changed".into())).is_err());
        assert!(!blocked.get());
        begin_transfer(&blocked, || Ok(())).unwrap();
        assert!(blocked.get());
        let rechecked = Cell::new(false);
        assert!(begin_transfer(&blocked, || {
            rechecked.set(true);
            Ok(())
        })
        .is_err());
        assert!(!rechecked.get());
        // The borrowed ConnectionTransfer is consumed only on checked success.
        // Dropping it leaves this gate blocked, including on a service error.
        assert!(blocked.get());
    }

    #[test]
    fn known_transfer_renews_only_between_two_checks_of_the_same_originals() {
        let blocked = Cell::new(true);
        let events = std::cell::RefCell::new(Vec::new());
        let renewed = renew_transfer(
            &blocked,
            || {
                events.borrow_mut().push("originals");
                Ok(())
            },
            || {
                events.borrow_mut().push("client-dependencies");
                Ok(vec![Target::Mcp, Target::Setup])
            },
        )
        .unwrap();
        assert_eq!(renewed, TARGETS);
        assert_eq!(
            *events.borrow(),
            ["originals", "client-dependencies", "originals"]
        );
        assert!(!blocked.get());
        assert!(renew_transfer(&blocked, || Ok(()), || Ok(())).is_err());
    }

    #[test]
    fn unknown_transition_or_drift_cannot_publish_a_renewed_plan() {
        for failure in 0..3 {
            let blocked = Cell::new(true);
            let step = Cell::new(0);
            let check = || {
                let current = step.replace(step.get() + 1);
                if current == failure {
                    Err("changed".to_owned())
                } else {
                    Ok(())
                }
            };
            let capture = || {
                check()?;
                Ok(vec![Target::Mcp, Target::Setup])
            };
            assert!(renew_transfer(&blocked, check, capture).is_err());
            assert!(blocked.get());
            assert!(begin_transfer(&blocked, || Ok(())).is_err());
        }
    }

    #[test]
    fn first_elevation_cancel_is_distinct_from_partial_or_retained_cleanup() {
        assert_eq!(
            cancelled_retirement(&[], false).unwrap(),
            linux_retirement::Outcome::Cancelled
        );
        for (completed, retained) in [
            (vec![Target::Mcp], false),
            (vec![], true),
            (vec![Target::Mcp], true),
        ] {
            assert!(cancelled_retirement(&completed, retained)
                .unwrap_err()
                .contains("no package transaction was replayed"));
        }
    }

    #[test]
    fn journal_records_review_not_mutation_authority_and_rejects_unknown_state() {
        for state in [State::ReviewRequired, State::Cancelled, State::Verified] {
            let value = Journal { policy: 1, state };
            let bytes = serde_json::to_vec(&value).unwrap();
            assert_eq!(serde_json::from_slice::<Journal>(&bytes).unwrap(), value);
            assert!(!String::from_utf8(bytes).unwrap().contains("path"));
        }
        for bytes in [
            br#"{"policy":1,"state":"retry"}"#.as_slice(),
            br#"{"policy":1,"state":"verified","path":"/tmp/other"}"#,
        ] {
            assert!(serde_json::from_slice::<Journal>(bytes).is_err());
        }
    }
}
