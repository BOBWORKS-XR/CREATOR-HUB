//! Nondefault development route. TEST ONLY helper packages are never shipping payloads.
use crate::{catalog::AppId, convergence_dependencies, linux_retirement, manager, platform};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

const MCP: &str = "/usr/bin/creator-works-mcp-launcher";
const GUI: [&str; 5] = [
    MCP,
    "/usr/share/applications/Creator Works MCP.desktop",
    "/usr/share/icons/hicolor/128x128/apps/creator-works-mcp-launcher.png",
    "/usr/share/icons/hicolor/256x256@2/apps/creator-works-mcp-launcher.png",
    "/usr/share/icons/hicolor/32x32/apps/creator-works-mcp-launcher.png",
];

#[derive(Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Journal {
    policy: u32,
    state: State,
}

#[derive(Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum State {
    ReviewRequired,
    Cancelled,
    Verified,
}

fn journal_path() -> Result<PathBuf, String> {
    Ok(manager::child_dir("convergence")?.join("linux-retirement-v1.json"))
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

fn save(state: State) -> Result<(), String> {
    let path = journal_path()?;
    read_at(&path)?;
    manager::atomic_write(
        &path,
        &serde_json::to_vec(&Journal { policy: 1, state })
            .map_err(|_| "Cannot encode Linux cleanup review.")?,
    )
}

pub fn pending() -> Result<bool, String> {
    Ok(read_at(&journal_path()?)?.is_some_and(|saved| saved.state == State::ReviewRequired))
}

fn idle() -> Result<(), String> {
    let state = platform::running_gui(AppId::Mcp, Path::new(MCP))?;
    if !state.gui.is_empty() || state.other_copy {
        return Err("Close the standalone MCP window and check again. No Node, AI client or Unity process was stopped.".into());
    }
    Ok(())
}

fn native_deb() -> Result<(), String> {
    if crate::update_target::Target::native()?.package != "deb" {
        return Err("This experimental migration route supports only the native DEB installation. Existing apps and data were kept.".into());
    }
    Ok(())
}

pub struct Plan {
    helper: linux_retirement::Plan,
    dependencies: convergence_dependencies::GuiRetirementSnapshot,
}

impl Plan {
    pub fn inspect(paths: &[PathBuf], router: &Path) -> Result<Self, String> {
        native_deb()?;
        if paths != [PathBuf::from(MCP)] {
            return Err("Only the exact original MCP 2.7.7 DEB is currently admitted. Setup or other locations need separate native retirement verification; no app was removed.".into());
        }
        if pending()? {
            return Err("An earlier Linux cleanup needs outcome review. No package transaction was replayed.".into());
        }
        idle()?;
        let helper = linux_retirement::Plan::inspect()?;
        let paths = GUI.map(PathBuf::from);
        let dependencies = convergence_dependencies::gui_retirement_snapshot(&paths, router);
        dependencies.recheck().map_err(|_| {
            "A client setting or GUI dependency needs review. Existing apps were kept."
        })?;
        Ok(Self {
            helper,
            dependencies,
        })
    }

    pub fn recheck(&self) -> Result<(), String> {
        native_deb()?;
        if pending()? {
            return Err(
                "A Linux cleanup is already pending. Keep recovery records; no retry was started."
                    .into(),
            );
        }
        idle()?;
        self.dependencies.recheck().map_err(|_| {
            "Client configuration changed or depends on the old GUI. Check again before cleanup."
        })?;
        self.helper.recheck_baseline()
    }

    pub fn retire_after_native_review(&self) -> Result<linux_retirement::Outcome, String> {
        self.recheck()?;
        // Persist before elevation: parent death or an unknown helper result must
        // never make a missing launcher look like an accepted completed migration.
        save(State::ReviewRequired)?;
        let result = self.helper.retire_after_native_review()?;
        match result {
            linux_retirement::Outcome::Cancelled => save(State::Cancelled)?,
            linux_retirement::Outcome::ExperimentalVerified => {
                self.helper.verify_retained()?;
                self.dependencies.recheck().map_err(|_| "Client configuration changed during cleanup. Review retained files before completing migration.")?;
            }
        }
        Ok(result)
    }

    pub fn complete_review(&self) -> Result<(), String> {
        self.helper.verify_retained()?;
        self.dependencies.recheck().map_err(|_| "Client configuration changed after cleanup. Review retained files before completing migration.")?;
        save(State::Verified)
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
            let parsed: Journal = serde_json::from_slice(&bytes).unwrap();
            assert!(parsed.state == value.state);
            assert!(!String::from_utf8(bytes).unwrap().contains("path"));
        }
        assert!(serde_json::from_slice::<Journal>(br#"{"policy":1,"state":"retry"}"#).is_err());
        assert!(serde_json::from_slice::<Journal>(
            br#"{"policy":1,"state":"verified","path":"/tmp/other"}"#
        )
        .is_err());
    }
}
