#[cfg(any(
    feature = "experimental-transaction",
    feature = "production-transaction",
    test
))]
use super::require;
use super::{lock, File, Result};
#[cfg(any(
    feature = "experimental-transaction",
    feature = "production-transaction",
    test
))]
use std::os::fd::AsRawFd;

pub(super) struct PackageLocks {
    // Process-associated frontend lock is retained in the parent, not inherited.
    _frontend: File,
    _database: File,
}

impl PackageLocks {
    pub(super) fn acquire(frontend: File, database: File) -> Result<Self> {
        lock(&frontend)?;
        lock(&database)?;
        Ok(Self {
            _frontend: frontend,
            _database: database,
        })
    }

    #[cfg(any(
        feature = "experimental-transaction",
        feature = "production-transaction",
        test
    ))]
    pub(super) fn handoff<T>(&mut self, operation: impl FnOnce() -> Result<T>) -> Result<T> {
        let mut region: libc::flock = unsafe { std::mem::zeroed() };
        region.l_type = libc::F_UNLCK as _;
        region.l_whence = libc::SEEK_SET as _;
        require(
            unsafe { libc::fcntl(self._database.as_raw_fd(), libc::F_SETLK, &region) } == 0,
            "Cannot release database lock for dpkg",
        )?;
        let result = operation();
        // Reuse the existing FD. Closing another FD for either lock would release it.
        lock(&self._database).map_err(|e| {
            format!("Cannot reacquire database lock; manual repair/review required: {e}")
        })?;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs::{self, OpenOptions},
        path::Path,
        process::Command,
    };

    fn child(root: &Path, phase: &str) -> std::process::Output {
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "linux::handoff::tests::child_fixture"])
            .env("CREATOR_HANDOFF_FIXTURE", root)
            .env("CREATOR_HANDOFF_PHASE", phase)
            .env("DPKG_FRONTEND_LOCKED", "1")
            .output()
            .unwrap()
    }

    fn files(root: &Path) -> (File, File) {
        let file = |name| {
            OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(root.join(name))
                .unwrap()
        };
        (file("frontend"), file("database"))
    }

    #[test]
    fn child_fixture() {
        let Some(root) = std::env::var_os("CREATOR_HANDOFF_FIXTURE") else {
            return;
        };
        let root = Path::new(&root);
        // Check CLOEXEC before deliberately opening the fixture lock files.
        for entry in fs::read_dir("/proc/self/fd").unwrap().flatten() {
            if let Ok(target) = fs::read_link(entry.path()) {
                assert_ne!(target, root.join("frontend"));
                assert_ne!(target, root.join("database"));
            }
        }
        let (frontend, database) = files(root);
        assert!(
            lock(&frontend).is_err(),
            "parent must continuously own frontend"
        );
        match std::env::var("CREATOR_HANDOFF_PHASE").unwrap().as_str() {
            "both-busy" => assert!(lock(&database).is_err()),
            "child" | "child-failure" => {
                assert_eq!(std::env::var("DPKG_FRONTEND_LOCKED").unwrap(), "1");
                lock(&database).expect("parent released only database lock");
                assert!(child(root, "both-busy").status.success());
                if std::env::var("CREATOR_HANDOFF_PHASE").unwrap() == "child-failure" {
                    panic!("deliberate fixture child failure after acquiring database");
                }
            }
            _ => panic!("unknown fixture phase"),
        }
    }

    #[test]
    fn database_handoff_keeps_frontend_and_reacquires_after_child_exit() {
        let temp = tempfile::tempdir().unwrap();
        let (frontend, database) = files(temp.path());
        let mut held = PackageLocks::acquire(frontend, database).unwrap();
        assert!(child(temp.path(), "both-busy").status.success());
        held.handoff(|| {
            assert!(child(temp.path(), "child").status.success());
            Ok(())
        })
        .unwrap();
        assert!(child(temp.path(), "both-busy").status.success());
    }

    #[test]
    fn failed_spawn_and_failed_child_still_reacquire_before_return() {
        let temp = tempfile::tempdir().unwrap();
        let (frontend, database) = files(temp.path());
        let mut held = PackageLocks::acquire(frontend, database).unwrap();
        let result = held.handoff(|| -> Result<()> {
            Command::new(temp.path().join("does-not-exist")).spawn()?;
            Ok(())
        });
        assert!(result.is_err());
        assert!(child(temp.path(), "both-busy").status.success());
        let result = held.handoff(|| {
            require(
                child(temp.path(), "child-failure").status.success(),
                "fixture child failed",
            )
        });
        assert!(result.is_err());
        assert!(child(temp.path(), "both-busy").status.success());
    }
}
