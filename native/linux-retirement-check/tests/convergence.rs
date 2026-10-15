//! Source fixtures only: actual Root adapter, disposable journals, simulated
//! helper/process/dependency boundaries. No installed packages or GUI are used.
use creator_hub_linux_retirement_check::Target;
use std::{
    cell::RefCell,
    fs,
    path::{Path, PathBuf},
};

#[path = "../../../src-tauri/src/convergence_linux.rs"]
mod convergence_linux;

const MCP: &str = "/usr/bin/creator-works-mcp-launcher";
const SETUP: &str = "/usr/bin/creator-project-setup";
const ROUTER: &str = "/verified/hub/router";

fn index(target: Target) -> usize {
    match target {
        Target::Mcp => 0,
        Target::Setup => 1,
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Package {
    Original,
    Retained,
    Missing,
    Damaged,
}
#[derive(Clone, Copy)]
enum Attempt {
    Verified,
    Cancelled,
    Unknown,
    Authorization127,
}
#[derive(Clone, Copy)]
enum Change {
    Dependency,
    Gui,
    OtherCopy,
    Retained,
    UnknownJournal,
}

struct World {
    root: PathBuf,
    package: [Package; 2],
    attempt: [Attempt; 2],
    gui: [bool; 2],
    other_copy: [bool; 2],
    dependencies: [bool; 2],
    revision: [u32; 2],
    package_kind: &'static str,
    calls: Vec<(Target, &'static str)>,
    snapshots: Vec<Vec<PathBuf>>,
    after_mcp: Option<Change>,
}

thread_local! { static WORLD: RefCell<Option<World>> = const { RefCell::new(None) }; }
fn world<T>(f: impl FnOnce(&mut World) -> T) -> T {
    WORLD.with(|slot| {
        f(slot
            .borrow_mut()
            .as_mut()
            .expect("disposable fixture initialized"))
    })
}

struct Fixture(tempfile::TempDir);
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        WORLD.with(|slot| {
            *slot.borrow_mut() = Some(World {
                root: temp.path().to_path_buf(),
                package: [Package::Original; 2],
                attempt: [Attempt::Verified; 2],
                gui: [false; 2],
                other_copy: [false; 2],
                dependencies: [true; 2],
                revision: [0; 2],
                package_kind: "deb",
                calls: vec![],
                snapshots: vec![],
                after_mcp: None,
            })
        });
        Self(temp)
    }

    fn journal(&self, target: Target) -> PathBuf {
        let dir = self.0.path().join("convergence");
        fs::create_dir_all(&dir).unwrap();
        dir.join(match target {
            Target::Mcp => "linux-retirement-v1.json",
            Target::Setup => "linux-retirement-setup-v1.json",
        })
    }

    fn save(&self, target: Target, state: &str) {
        fs::write(
            self.journal(target),
            format!(r#"{{"policy":1,"state":"{state}"}}"#),
        )
        .unwrap();
    }

    fn state(&self, target: Target) -> Option<String> {
        fs::read(self.journal(target)).ok().map(|bytes| {
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["state"]
                .as_str()
                .unwrap()
                .to_string()
        })
    }
}

mod catalog {
    pub enum AppId {
        Mcp,
        Setup,
    }
}

mod manager {
    use super::*;
    pub fn child_dir(name: &str) -> Result<PathBuf, String> {
        assert_eq!(name, "convergence");
        let path = world(|w| w.root.join(name));
        fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        Ok(path)
    }
    pub fn bounded_read(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
        let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if !meta.is_file() || meta.len() > limit {
            return Err("not bounded regular file".into());
        }
        fs::read(path).map_err(|e| e.to_string())
    }
    pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
        assert!(path.starts_with(world(|w| w.root.clone())));
        fs::write(path, bytes).map_err(|e| e.to_string())
    }
}

mod update_target {
    pub struct Target {
        pub package: &'static str,
    }
    impl Target {
        pub fn native() -> Result<Self, String> {
            Ok(Self {
                package: super::world(|w| w.package_kind),
            })
        }
    }
}

mod platform {
    use super::*;
    pub struct Running {
        pub gui: Vec<u32>,
        pub other_copy: bool,
    }
    pub fn running_gui(app: catalog::AppId, path: &Path) -> Result<Running, String> {
        let target = match app {
            catalog::AppId::Mcp => Target::Mcp,
            catalog::AppId::Setup => Target::Setup,
        };
        assert_eq!(
            path,
            Path::new(if target == Target::Mcp { MCP } else { SETUP })
        );
        Ok(world(|w| Running {
            gui: if w.gui[index(target)] {
                vec![42]
            } else {
                vec![]
            },
            other_copy: w.other_copy[index(target)],
        }))
    }
}

mod convergence_dependencies {
    use super::*;
    pub struct GuiRetirementSnapshot {
        target: Target,
        revision: u32,
    }
    pub fn gui_retirement_snapshot(paths: &[PathBuf], router: &Path) -> GuiRetirementSnapshot {
        assert_eq!(router, Path::new(ROUTER));
        assert_eq!(
            paths.len(),
            5,
            "do not widen the real dependency gate's eight-path limit"
        );
        let target = if paths[0] == Path::new(MCP) {
            Target::Mcp
        } else {
            assert_eq!(paths[0], Path::new(SETUP));
            Target::Setup
        };
        world(|w| {
            w.snapshots.push(paths.to_vec());
            GuiRetirementSnapshot {
                target,
                revision: w.revision[index(target)],
            }
        })
    }
    impl GuiRetirementSnapshot {
        pub fn recheck(&self) -> Result<(), String> {
            if world(|w| {
                w.dependencies[index(self.target)]
                    && w.revision[index(self.target)] == self.revision
            }) {
                Ok(())
            } else {
                Err("dependency changed or blocked".into())
            }
        }
    }
}

mod linux_retirement {
    use super::*;
    pub use creator_hub_linux_retirement_check::{Outcome, Target};
    pub struct Plan(Target);
    impl Plan {
        pub fn inspect(target: Target) -> Result<Self, String> {
            world(|w| w.calls.push((target, "inspect")));
            let plan = Self(target);
            plan.recheck_baseline()?;
            Ok(plan)
        }
        pub fn inspect_retained(target: Target) -> Result<Self, String> {
            world(|w| w.calls.push((target, "inspect-retained")));
            let plan = Self(target);
            plan.verify_retained()?;
            Ok(plan)
        }
        pub fn recheck_baseline(&self) -> Result<(), String> {
            world(|w| w.calls.push((self.0, "baseline")));
            if world(|w| w.package[index(self.0)] == Package::Original) {
                Ok(())
            } else {
                Err("original package missing or changed".into())
            }
        }
        pub fn verify_retained(&self) -> Result<(), String> {
            world(|w| w.calls.push((self.0, "retained")));
            if world(|w| w.package[index(self.0)] == Package::Retained) {
                Ok(())
            } else {
                Err("retained package/notice not verified".into())
            }
        }
        pub fn retire_after_native_review(&self) -> Result<Outcome, String> {
            let file = manager::child_dir("convergence")?.join(if self.0 == Target::Mcp {
                "linux-retirement-v1.json"
            } else {
                "linux-retirement-setup-v1.json"
            });
            let journal: serde_json::Value =
                serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
            assert_eq!(
                journal["state"], "review-required",
                "must persist before authorization"
            );
            let result = world(|w| {
                w.calls.push((self.0, "retire"));
                match w.attempt[index(self.0)] {
                    Attempt::Cancelled => Ok(Outcome::Cancelled),
                    Attempt::Authorization127 => {
                        Err("authorization 127; manual package-state review required".into())
                    }
                    Attempt::Unknown => {
                        w.package[index(self.0)] = Package::Retained;
                        Err("unknown helper outcome".into())
                    }
                    Attempt::Verified => {
                        w.package[index(self.0)] = Package::Retained;
                        Ok(Outcome::ExperimentalVerified)
                    }
                }
            });
            if self.0 == Target::Mcp && result == Ok(Outcome::ExperimentalVerified) {
                match world(|w| w.after_mcp.take()) {
                    Some(Change::Dependency) => world(|w| w.revision[1] += 1),
                    Some(Change::Gui) => world(|w| w.gui[1] = true),
                    Some(Change::OtherCopy) => world(|w| w.other_copy[1] = true),
                    Some(Change::Retained) => world(|w| w.package[0] = Package::Damaged),
                    Some(Change::UnknownJournal) => {
                        fs::write(
                            manager::child_dir("convergence")?
                                .join("linux-retirement-setup-v1.json"),
                            br#"{"policy":9,"state":"verified"}"#,
                        )
                        .unwrap();
                    }
                    None => {}
                }
            }
            result
        }
    }
}

fn paths(names: &[&str]) -> Vec<PathBuf> {
    names.iter().map(PathBuf::from).collect()
}
fn inspect(names: &[&str]) -> Result<convergence_linux::Plan, String> {
    convergence_linux::Plan::inspect(&paths(names), Path::new(ROUTER))
}
fn mutations() -> Vec<Target> {
    world(|w| {
        w.calls
            .iter()
            .filter_map(|(target, action)| (*action == "retire").then_some(*target))
            .collect()
    })
}

#[test]
fn exact_singletons_and_both_orders_dispatch_only_selected_targets() {
    for names in [
        &[MCP][..],
        &[SETUP][..],
        &[MCP, SETUP][..],
        &[SETUP, MCP][..],
    ] {
        let fixture = Fixture::new();
        let plan = inspect(names).unwrap();
        assert!(!plan.retained_only());
        assert_eq!(
            plan.retire_after_native_review().unwrap(),
            linux_retirement::Outcome::ExperimentalVerified
        );
        let expected = [Target::Mcp, Target::Setup]
            .into_iter()
            .filter(|target| names.contains(&if *target == Target::Mcp { MCP } else { SETUP }))
            .collect::<Vec<_>>();
        assert_eq!(mutations(), expected);
        assert!(convergence_linux::pending().unwrap());
        plan.complete_review().unwrap();
        assert!(!convergence_linux::pending().unwrap());
        for target in expected {
            assert_eq!(fixture.state(target).as_deref(), Some("verified"));
        }
        assert_eq!(world(|w| w.snapshots.len()), names.len());
    }
}

#[test]
fn duplicates_custom_normalized_relative_and_empty_paths_refuse_before_helper() {
    for names in [
        &[][..],
        &[MCP, MCP][..],
        &[SETUP, SETUP][..],
        &[MCP, SETUP, MCP][..],
        &["/custom/creator-project-setup"][..],
        &[MCP, "/custom/mcp"][..],
        &["/usr/bin/./creator-project-setup"][..],
        &["/usr//bin/creator-project-setup"][..],
        &["usr/bin/creator-project-setup"][..],
    ] {
        let _fixture = Fixture::new();
        assert!(inspect(names).is_err(), "{names:?}");
        assert!(world(|w| w.calls.is_empty()));
    }
}

#[test]
fn missing_original_baselines_non_deb_gui_and_dependency_blockers_are_not_bypassed() {
    for target in [Target::Mcp, Target::Setup] {
        for missing in [Package::Missing, Package::Damaged] {
            let _fixture = Fixture::new();
            world(|w| w.package[index(target)] = missing);
            assert!(inspect(&[if target == Target::Mcp { MCP } else { SETUP }]).is_err());
            assert!(mutations().is_empty());
        }
        for change in [Change::Gui, Change::OtherCopy, Change::Dependency] {
            let _fixture = Fixture::new();
            world(|w| match change {
                Change::Gui => w.gui[index(target)] = true,
                Change::OtherCopy => w.other_copy[index(target)] = true,
                _ => w.dependencies[index(target)] = false,
            });
            assert!(inspect(&[MCP, SETUP]).is_err());
            assert!(mutations().is_empty());
        }
    }
    let _fixture = Fixture::new();
    world(|w| w.package_kind = "appimage");
    assert!(inspect(&[MCP, SETUP]).is_err());
    assert!(world(|w| w.calls.is_empty()));
}

#[test]
fn second_cancel_preserves_first_pending_and_new_plan_reviews_without_replaying_first() {
    let fixture = Fixture::new();
    world(|w| w.attempt[1] = Attempt::Cancelled);
    let plan = inspect(&[MCP, SETUP]).unwrap();
    assert!(plan
        .retire_after_native_review()
        .unwrap_err()
        .contains("partially completed"));
    assert_eq!(
        fixture.state(Target::Mcp).as_deref(),
        Some("review-required")
    );
    assert_eq!(fixture.state(Target::Setup).as_deref(), Some("cancelled"));
    assert!(convergence_linux::pending().unwrap());
    assert!(plan.complete_review().is_err());
    assert!(plan.retire_after_native_review().is_err());
    assert_eq!(mutations(), [Target::Mcp, Target::Setup]);
    world(|w| w.calls.clear());
    let next = inspect(&[SETUP]).unwrap();
    assert!(!next.retained_only());
    assert!(next
        .retire_after_native_review()
        .unwrap_err()
        .contains("partially completed"));
    assert_eq!(
        fixture.state(Target::Mcp).as_deref(),
        Some("review-required")
    );
    assert_eq!(mutations(), [Target::Setup]);
    world(|w| {
        w.calls.clear();
        w.attempt[1] = Attempt::Verified;
    });
    let next = inspect(&[SETUP]).unwrap();
    next.retire_after_native_review().unwrap();
    next.complete_review().unwrap();
    assert_eq!(mutations(), [Target::Setup]);
    assert!(!convergence_linux::pending().unwrap());
}

#[test]
fn first_cancel_has_no_second_attempt_and_can_retry_after_baseline_recheck() {
    let fixture = Fixture::new();
    world(|w| w.attempt[0] = Attempt::Cancelled);
    let plan = inspect(&[MCP, SETUP]).unwrap();
    assert_eq!(
        plan.retire_after_native_review().unwrap(),
        linux_retirement::Outcome::Cancelled
    );
    assert_eq!(mutations(), [Target::Mcp]);
    assert_eq!(fixture.state(Target::Mcp).as_deref(), Some("cancelled"));
    assert_eq!(fixture.state(Target::Setup), None);
    assert!(!convergence_linux::pending().unwrap());
    assert!(plan.complete_review().is_err());
    plan.recheck().unwrap();
}

#[test]
fn unknown_results_stay_pending_and_only_independent_retained_review_can_complete() {
    for target in [Target::Mcp, Target::Setup] {
        let fixture = Fixture::new();
        world(|w| w.attempt[index(target)] = Attempt::Unknown);
        let plan = inspect(&[MCP, SETUP]).unwrap();
        assert!(plan.retire_after_native_review().is_err());
        assert_eq!(fixture.state(target).as_deref(), Some("review-required"));
        assert!(plan.complete_review().is_err());
        assert!(plan.retire_after_native_review().is_err());
        let before = mutations();
        let review = convergence_linux::Plan::inspect_retained(Path::new(ROUTER)).unwrap();
        assert!(review.retained_only());
        review.retire_after_native_review().unwrap();
        review.complete_review().unwrap();
        assert_eq!(mutations(), before);
        assert!(!convergence_linux::pending().unwrap());
    }
}

#[test]
fn old_mcp_v1_pending_journal_remains_readable_but_never_authorizes_a_replay() {
    let fixture = Fixture::new();
    fixture.save(Target::Mcp, "review-required");
    assert!(convergence_linux::pending().unwrap());
    assert!(inspect(&[MCP, SETUP]).is_err());
    assert!(convergence_linux::Plan::inspect_retained(Path::new(ROUTER)).is_err());
    assert!(mutations().is_empty());
    world(|w| w.package[0] = Package::Retained);
    let plan = inspect(&[SETUP]).unwrap();
    plan.retire_after_native_review().unwrap();
    plan.complete_review().unwrap();
    assert_eq!(mutations(), [Target::Setup]);
    assert_eq!(fixture.state(Target::Mcp).as_deref(), Some("verified"));
    assert_eq!(fixture.state(Target::Setup).as_deref(), Some("verified"));
}

#[test]
fn authorization_127_with_original_still_installed_stays_manual_review_not_replay() {
    for target in [Target::Mcp, Target::Setup] {
        let fixture = Fixture::new();
        world(|w| w.attempt[index(target)] = Attempt::Authorization127);
        let plan = inspect(&[MCP, SETUP]).unwrap();
        assert!(plan
            .retire_after_native_review()
            .unwrap_err()
            .contains("127"));
        assert!(world(|w| w.package[index(target)] == Package::Original));
        assert_eq!(fixture.state(target).as_deref(), Some("review-required"));
        assert!(convergence_linux::pending().unwrap());
        let before = mutations();
        let bytes = fs::read(fixture.journal(target)).unwrap();
        assert!(plan.recheck().is_err());
        assert!(plan.retire_after_native_review().is_err());
        assert!(plan.complete_review().is_err());
        let originals = if target == Target::Mcp {
            vec![MCP, SETUP]
        } else {
            vec![SETUP]
        };
        assert!(inspect(&originals).is_err());
        assert!(convergence_linux::Plan::inspect_retained(Path::new(ROUTER)).is_err());
        assert_eq!(mutations(), before);
        assert_eq!(fs::read(fixture.journal(target)).unwrap(), bytes);
        if target == Target::Setup {
            assert_eq!(
                fixture.state(Target::Mcp).as_deref(),
                Some("review-required")
            );
        }
    }
}

#[test]
fn changed_gui_dependencies_retained_state_or_journal_stop_before_second_authorization() {
    for change in [
        Change::Dependency,
        Change::Gui,
        Change::OtherCopy,
        Change::Retained,
        Change::UnknownJournal,
    ] {
        let fixture = Fixture::new();
        let plan = inspect(&[MCP, SETUP]).unwrap();
        world(|w| w.after_mcp = Some(change));
        assert!(plan.retire_after_native_review().is_err());
        assert_eq!(mutations(), [Target::Mcp]);
        assert_eq!(
            fixture.state(Target::Mcp).as_deref(),
            Some("review-required")
        );
    }
}

#[test]
fn unknown_saved_state_in_either_journal_blocks_all_operations_and_is_preserved() {
    for target in [Target::Mcp, Target::Setup] {
        for bytes in [
            br#"{"policy":2,"state":"verified"}"#.as_slice(),
            br#"{"policy":1,"state":"retry"}"#,
            br#"{"policy":1,"state":"verified","path":"/tmp/other"}"#,
            br#"{"policy":1,"state":"verified","state":"cancelled"}"#,
            b"{",
            &[b'x'; 2049],
        ] {
            let fixture = Fixture::new();
            fixture.save(
                if target == Target::Mcp {
                    Target::Setup
                } else {
                    Target::Mcp
                },
                "review-required",
            );
            let file = fixture.journal(target);
            fs::write(&file, bytes).unwrap();
            assert!(convergence_linux::pending().is_err());
            assert!(inspect(&[SETUP]).is_err());
            assert!(convergence_linux::Plan::inspect_retained(Path::new(ROUTER)).is_err());
            assert!(mutations().is_empty());
            assert_eq!(fs::read(file).unwrap(), bytes);
        }
    }
}

#[test]
fn completion_checks_all_products_before_clearing_any_pending_journal() {
    let fixture = Fixture::new();
    let plan = inspect(&[MCP, SETUP]).unwrap();
    plan.retire_after_native_review().unwrap();
    for change in [Change::Retained, Change::Dependency, Change::Gui] {
        world(|w| {
            w.package = [Package::Retained; 2];
            w.dependencies = [true; 2];
            w.gui = [false; 2];
            match change {
                Change::Retained => w.package[1] = Package::Damaged,
                Change::Gui => w.gui[1] = true,
                _ => w.dependencies[1] = false,
            }
        });
        assert!(plan.complete_review().is_err());
        assert_eq!(
            fixture.state(Target::Mcp).as_deref(),
            Some("review-required")
        );
        assert_eq!(
            fixture.state(Target::Setup).as_deref(),
            Some("review-required")
        );
    }
}
