//! Protected whole-database snapshots for the cooperating-manager boundary.
//! dpkg-divert/statcmd themselves do not lock: this is not exclusion against
//! independent Root writers. No global metadata is ever created or rewritten.
use super::*;
use crate::metadata::{self, Identity, Target, Validated};
use std::collections::VecDeque;

type Stamp = (u64, u64, u64, u32, u32, u32, u64, i64, i64, i64, i64);
const DATABASES: [&str; 2] = ["/var/lib/dpkg/diversions", "/var/lib/dpkg/statoverride"];

#[derive(Debug, PartialEq, Eq)]
struct Database {
    stamp: Stamp,
    bytes: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
enum Parent {
    Directory(PathBuf, u64, u64, u32, u32, u32),
    Link(PathBuf, Stamp, PathBuf),
}

#[derive(Debug, PartialEq, Eq)]
struct State {
    databases: [Option<Database>; 2],
    validation: Validated,
    parents: Vec<Parent>,
}

pub(super) struct Snapshot {
    target: Target,
    state: State,
    // Pin original database inodes across child wait, including atomic replacement.
    _files: [Option<File>; 2],
}

fn database(path: &str) -> Result<(Option<Database>, Option<File>)> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            directory(Path::new(path).parent().ok_or("Missing database parent")?)?;
            return Ok((None, None));
        }
        Err(e) => return Err(e.into()),
        Ok(_) => {}
    }
    let file = open(Path::new(path), libc::O_RDONLY)?;
    let before = stamp(&file.metadata()?);
    let bytes = bounded(&file, 4 * 1024 * 1024)?;
    require(
        before == stamp(&file.metadata()?)
            && before == stamp(&open(Path::new(path), libc::O_RDONLY)?.metadata()?),
        "Global database changed/replaced while reading",
    )?;
    Ok((
        Some(Database {
            stamp: before,
            bytes,
        }),
        Some(file),
    ))
}

fn parent_directory(path: &Path, parents: &mut Vec<Parent>) -> Result<()> {
    let info = fs::symlink_metadata(path)?;
    require(
        info.is_dir() && info.uid() == 0 && info.mode() & 0o7022 == 0,
        &format!("Unprotected/ambiguous metadata parent: {}", path.display()),
    )?;
    // Directory times/link counts legitimately change when entries are unpacked.
    parents.push(Parent::Directory(
        path.into(),
        info.dev(),
        info.ino(),
        info.mode(),
        info.uid(),
        info.gid(),
    ));
    Ok(())
}

fn parts(path: &Path) -> VecDeque<std::ffi::OsString> {
    path.components()
        .map(|p| p.as_os_str().to_owned())
        .collect()
}

fn resolve_parent(path: &str, parents: &mut Vec<Parent>) -> Result<String> {
    resolve_parent_for(Target::Mcp, path, parents)
}

fn resolve_parent_for(target: Target, path: &str, parents: &mut Vec<Parent>) -> Result<String> {
    metadata::canonical(path)?;
    let path = Path::new(path);
    let mut pending = parts(path);
    let mut current = PathBuf::from("/");
    let mut links = 0;
    let mut steps = 0;
    parent_directory(&current, parents)?;
    while let Some(part) = pending.pop_front() {
        steps += 1;
        require(steps <= 1024, "Metadata parent walk too long")?;
        match part.as_bytes() {
            b"/" => current = PathBuf::from("/"),
            b"." => {}
            b".." => {
                current.pop();
                if current.as_os_str().is_empty() {
                    current.push("/");
                }
            }
            _ => {
                let next = current.join(&part);
                let last = pending.is_empty();
                if last {
                    // Check the directory entry AND any final alias referent.
                    // An override on /bin must not bypass an /usr/bin ancestor.
                    metadata::disjoint_for(
                        target,
                        next.to_str().ok_or("Non-UTF8 metadata entry")?,
                    )?;
                }
                let info = match fs::symlink_metadata(&next) {
                    Err(e) if last && e.kind() == std::io::ErrorKind::NotFound => {
                        return Ok(next.to_str().ok_or("Non-UTF8 metadata entry")?.into());
                    }
                    other => other?,
                };
                if info.file_type().is_symlink() {
                    links += 1;
                    require(
                        links <= 40 && info.uid() == 0 && info.nlink() == 1,
                        "Untrusted/looping parent alias",
                    )?;
                    let target = fs::read_link(&next)?;
                    require(
                        !target.as_os_str().is_empty()
                            && target.as_os_str().len() <= 4095
                            && stamp(&info) == stamp(&fs::symlink_metadata(&next)?),
                        "Parent alias changed or is invalid",
                    )?;
                    parents.push(Parent::Link(next, stamp(&info), target.clone()));
                    let mut expanded = parts(&target);
                    expanded.append(&mut pending);
                    pending = expanded;
                } else {
                    require(
                        info.is_file() || info.is_dir(),
                        "Unsupported metadata target type",
                    )?;
                    current = next;
                }
            }
        }
        // Includes each resolved alias target/..; never traverse a writable parent.
        if !pending.is_empty() {
            parent_directory(&current, parents)?;
        }
    }
    Ok(current.to_str().ok_or("Non-UTF8 metadata alias")?.into())
}

fn resolve_identity(kind: Identity, name: &str) -> Result<u32> {
    let name = CString::new(name)?;
    let mut buffer = vec![0u8; 64 * 1024];
    let id = unsafe {
        match kind {
            Identity::User => {
                let mut record: libc::passwd = std::mem::zeroed();
                let mut result = std::ptr::null_mut();
                let rc = libc::getpwnam_r(
                    name.as_ptr(),
                    &mut record,
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                    &mut result,
                );
                require(
                    rc == 0 && !result.is_null(),
                    "Unknown user/NSS lookup failed or exceeded bound",
                )?;
                record.pw_uid
            }
            Identity::Group => {
                let mut record: libc::group = std::mem::zeroed();
                let mut result = std::ptr::null_mut();
                let rc = libc::getgrnam_r(
                    name.as_ptr(),
                    &mut record,
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                    &mut result,
                );
                require(
                    rc == 0 && !result.is_null(),
                    "Unknown group/NSS lookup failed or exceeded bound",
                )?;
                record.gr_gid
            }
        }
    };
    require(id != u32::MAX, "Invalid system identity")?;
    Ok(id)
}

impl Snapshot {
    pub(super) fn capture() -> Result<Self> {
        Self::capture_for(Target::Mcp)
    }

    pub(super) fn capture_for(target: Target) -> Result<Self> {
        let (diversions, div_file) = database(DATABASES[0])?;
        let (overrides, stat_file) = database(DATABASES[1])?;
        let mut parents = Vec::new();
        let validation = metadata::validate_for(
            target,
            diversions.as_ref().map_or(&[], |d| d.bytes.as_slice()),
            overrides.as_ref().map_or(&[], |d| d.bytes.as_slice()),
            resolve_identity,
            |path| match target {
                Target::Mcp => resolve_parent(path, &mut parents),
                Target::Setup => resolve_parent_for(target, path, &mut parents),
            },
        )?;
        let snapshot = Self {
            target,
            state: State {
                databases: [diversions, overrides],
                validation,
                parents,
            },
            _files: [div_file, stat_file],
        };
        for (path, original) in DATABASES.iter().zip(&snapshot.state.databases) {
            require(
                &database(path)?.0 == original,
                "Global metadata changed during validation",
            )?;
        }
        Ok(snapshot)
    }

    pub(super) fn unchanged(&self) -> Result<()> {
        require(
            self.state == Self::capture_for(self.target)?.state,
            "Global metadata/identities/parent aliases changed",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "Opt-in unprivileged host metadata diagnostic; no installation or acceptance"]
    fn host_metadata_read_only_preflight() {
        assert_ne!(unsafe { libc::getuid() }, 0, "Run unprivileged");
        assert_ne!(unsafe { libc::geteuid() }, 0, "Run unprivileged");
        let snapshot = Snapshot::capture().expect("Host metadata admission failed");
        snapshot
            .unchanged()
            .expect("Host metadata changed during read-only preflight");
        let databases = snapshot
            .state
            .databases
            .iter()
            .map(|entry| {
                entry
                    .as_ref()
                    .map(|d| json!({ "bytes": d.bytes.len(), "sha256": sha256(&d.bytes) }))
            })
            .collect::<Vec<_>>();
        eprintln!(
            "{}",
            json!({ "scope": "read-only-host-metadata-preflight", "databases": databases,
                "parentObservations": snapshot.state.parents.len(), "metadataUnchanged": true,
                "packageTransactionStarted": false, "nativeAcceptance": false })
        );
    }

    #[test]
    fn protected_aliases_include_final_links_and_refuse_untrusted_parents() {
        let mut proof = Vec::new();
        let expected = fs::canonicalize("/bin/sh").unwrap();
        assert_eq!(
            resolve_parent("/bin/sh", &mut proof).unwrap(),
            expected.to_str().unwrap()
        );
        assert!(!proof.is_empty());
        if fs::symlink_metadata("/bin")
            .unwrap()
            .file_type()
            .is_symlink()
        {
            assert!(resolve_parent("/bin", &mut Vec::new()).is_err());
        }
        let temp = tempfile::tempdir().unwrap();
        let link = temp.path().join("alias");
        std::os::unix::fs::symlink("/usr/bin", &link).unwrap();
        assert!(resolve_parent(link.join("anything").to_str().unwrap(), &mut Vec::new()).is_err());
        assert!(resolve_parent(
            "/usr/no-such-creator-helper-parent/anything",
            &mut Vec::new()
        )
        .is_err());
    }

    #[test]
    fn nss_names_are_resolved_not_merely_lexically_accepted() {
        assert_eq!(resolve_identity(Identity::User, "root").unwrap(), 0);
        assert_eq!(resolve_identity(Identity::Group, "root").unwrap(), 0);
        assert!(
            resolve_identity(Identity::User, "creator-helper-fixture-no-such-account").is_err()
        );
        assert!(
            resolve_identity(Identity::Group, "creator-helper-fixture-no-such-account").is_err()
        );
    }

    #[test]
    fn full_snapshot_state_distinguishes_bytes_absence_identity_and_replacement() {
        let validation = || metadata::validate(b"", b"", |_, _| Ok(0), |p| Ok(p.into())).unwrap();
        let mut first = State {
            databases: [None, None],
            validation: validation(),
            parents: vec![],
        };
        let mut second = State {
            databases: [None, None],
            validation: validation(),
            parents: vec![],
        };
        assert_eq!(first, second);
        let stamp: Stamp = (1, 2, 0, 0o100644, 0, 0, 1, 0, 0, 0, 0);
        first.databases[0] = Some(Database {
            stamp,
            bytes: vec![],
        });
        assert_ne!(first, second);
        second.databases[0] = Some(Database {
            stamp,
            bytes: vec![],
        });
        assert_eq!(first, second);
        second.databases[0].as_mut().unwrap().bytes.push(b'x');
        assert_ne!(first, second);
        second.databases[0].as_mut().unwrap().bytes.clear();
        second.databases[0].as_mut().unwrap().stamp.1 += 1;
        assert_ne!(first, second);
    }
}
