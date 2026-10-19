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

pub struct Plan {
    installations: Vec<Installation>,
    outcome_reviewed: Cell<bool>,
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
            let paths = match target {
                Target::Mcp => MCP_GUI,
                Target::Setup => SETUP_GUI,
            }
            .map(PathBuf::from);
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

    fn recheck_with(&self, completed: &[Target]) -> Result<(), String> {
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
            app.dependencies.recheck().map_err(|_| {
                "Client configuration changed or depends on the old GUI. Check again before cleanup."
            })?;
            if app.retained_only || completed.contains(&app.target) {
                app.helper.verify_retained()?;
            } else {
                app.helper.recheck_baseline()?;
            }
        }
        Ok(())
    }

    pub fn retire_after_native_review(&self) -> Result<linux_retirement::Outcome, String> {
        self.outcome_reviewed.set(false);
        self.recheck()?;
        let mut completed = Vec::new();
        for app in &self.installations {
            if app.retained_only {
                // A saved pending outcome permits independent inspection only.
                continue;
            }
            self.recheck_with(&completed)?;
            // Persist per product before elevation. Never clear another product's
            // pending outcome when this authorization is cancelled or unknown.
            save(app.target, State::ReviewRequired)?;
            match app.helper.retire_after_native_review()? {
                linux_retirement::Outcome::Cancelled => {
                    save(app.target, State::Cancelled)?;
                    if !completed.is_empty()
                        || self.installations.iter().any(|app| app.retained_only)
                    {
                        return Err("Cleanup partially completed; a later system authorization was cancelled. Earlier outcomes remain pending review. Check again; no package transaction was replayed.".into());
                    }
                    return Ok(linux_retirement::Outcome::Cancelled);
                }
                linux_retirement::Outcome::ExperimentalVerified => completed.push(app.target),
            }
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

#[cfg(test)]
mod tests {
    use super::*;

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
