//! Protected whole-database snapshots for the cooperating-manager boundary.
//! dpkg-divert/statcmd themselves do not lock: this is not exclusion against
//! independent Root writers. No global metadata is ever created or rewritten.
//!
//! dpkg 1.21.1 db-fsys-{divert,override}.c bind records through
//! fsys_hash_find_node(): pathname keys, not realpath() results. Keep the complete
//! strict parser, but stop filesystem observations beneath an ordinary directory
//! disjoint from BOTH compiled products. Nested aliases/alias collisions there
//! are deliberately not resolved or snapshotted; their original dpkg keys remain
//! distinct. Protected-prefix aliases (including merged /bin) still resolve.
//! These comparison keys never choose a package, resource path or write target;
//! fixed Creator resource operations retain linux::open's protected no-follow walk.
use super::*;
use crate::metadata::{self, Identity, Target, Validated};
use std::collections::VecDeque;

type Stamp = (u64, u64, u64, u32, u32, u32, u64, i64, i64, i64, i64);
const DATABASES: [&str; 2] = ["/var/lib/dpkg/diversions", "/var/lib/dpkg/statoverride"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Node {
    stamp: Stamp,
}

impl Node {
    fn directory(self) -> bool {
        self.stamp.3 & libc::S_IFMT == libc::S_IFDIR
    }

    fn file(self) -> bool {
        self.stamp.3 & libc::S_IFMT == libc::S_IFREG
    }

    fn link(self) -> bool {
        self.stamp.3 & libc::S_IFMT == libc::S_IFLNK
    }
}

fn disjoint_products(path: &str) -> Result<()> {
    metadata::disjoint_for(Target::Mcp, path)?;
    metadata::disjoint_for(Target::Setup, path)
}

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

fn parent_directory(
    path: &Path,
    parents: &mut Vec<Parent>,
    inspect: &mut impl FnMut(&Path) -> std::io::Result<Node>,
) -> Result<()> {
    let Node {
        stamp: (dev, ino, _, mode, uid, gid, ..),
    } = inspect(path)?;
    require(
        mode & libc::S_IFMT == libc::S_IFDIR && uid == 0 && mode & 0o7022 == 0,
        &format!("Unprotected/ambiguous metadata parent: {}", path.display()),
    )?;
    // Directory times/link counts legitimately change when entries are unpacked.
    parents.push(Parent::Directory(path.into(), dev, ino, mode, uid, gid));
    Ok(())
}

fn parts(path: &Path) -> VecDeque<std::ffi::OsString> {
    path.components()
        .map(|p| p.as_os_str().to_owned())
        .collect()
}

fn resolve_parent(path: &str, parents: &mut Vec<Parent>) -> Result<String> {
    resolve_parent_using(
        path,
        parents,
        &mut |path| {
            fs::symlink_metadata(path).map(|info| Node {
                stamp: stamp(&info),
            })
        },
        &mut |path| fs::read_link(path),
    )
}

fn resolve_parent_using(
    path: &str,
    parents: &mut Vec<Parent>,
    inspect: &mut impl FnMut(&Path) -> std::io::Result<Node>,
    read_link: &mut impl FnMut(&Path) -> std::io::Result<PathBuf>,
) -> Result<String> {
    disjoint_products(path)?;
    let original = path;
    let path = Path::new(path);
    let mut pending = parts(path);
    let mut current = PathBuf::from("/");
    let mut links = 0;
    let mut steps = 0;
    parent_directory(&current, parents, inspect)?;
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
                    disjoint_products(next.to_str().ok_or("Non-UTF8 metadata entry")?)?;
                }
                let info = match inspect(&next) {
                    Err(e) if last && e.kind() == std::io::ErrorKind::NotFound => {
                        return Ok(next.to_str().ok_or("Non-UTF8 metadata entry")?.into());
                    }
                    other => other?,
                };
                if info.link() {
                    links += 1;
                    require(
                        links <= 40 && info.stamp.4 == 0 && info.stamp.6 == 1,
                        "Untrusted/looping parent alias",
                    )?;
                    let target = read_link(&next)?;
                    require(
                        !target.as_os_str().is_empty()
                            && target.as_os_str().len() <= 4095
                            && info == inspect(&next)?,
                        "Parent alias changed or is invalid",
                    )?;
                    parents.push(Parent::Link(next, info.stamp, target.clone()));
                    let mut expanded = parts(&target);
                    expanded.append(&mut pending);
                    pending = expanded;
                } else {
                    require(
                        info.file() || info.directory(),
                        "Unsupported metadata target type",
                    )?;
                    if info.directory()
                        && !pending.is_empty()
                        && pending
                            .iter()
                            .all(|part| !matches!(part.as_bytes(), b"/" | b"." | b".."))
                        && disjoint_products(next.to_str().ok_or("Non-UTF8 metadata parent")?)
                            .is_ok()
                    {
                        // No descendant access, permission exception or realpath authority.
                        // An expanded alias containing '..' must keep the strict walk.
                        return Ok(original.into());
                    }
                    current = next;
                }
            }
        }
        // Includes each resolved alias target/..; never traverse a writable parent.
        if !pending.is_empty() {
            parent_directory(&current, parents, inspect)?;
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
            |path| resolve_parent(path, &mut parents),
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
    use std::{cell::RefCell, collections::BTreeMap};

    #[derive(Default)]
    struct Namespace {
        nodes: BTreeMap<PathBuf, Node>,
        links: BTreeMap<PathBuf, PathBuf>,
        inspected: RefCell<Vec<PathBuf>>,
        followed: RefCell<Vec<PathBuf>>,
    }

    impl Namespace {
        fn node(&mut self, path: &str, kind: u32, mode: u32, gid: u32) {
            let ino = self.nodes.len() as u64 + 1;
            self.nodes.insert(
                path.into(),
                Node {
                    stamp: (1, ino, 0, kind | mode, 0, gid, 1, 0, 0, 0, 0),
                },
            );
        }

        fn parents(&mut self, path: &str) {
            for parent in Path::new(path).ancestors().skip(1) {
                if !self.nodes.contains_key(parent) {
                    self.node(parent.to_str().unwrap(), libc::S_IFDIR, 0o755, 0);
                }
            }
        }

        fn alias(&mut self, path: &str, target: &str) {
            self.parents(path);
            self.node(path, libc::S_IFLNK, 0o777, 0);
            self.links.insert(path.into(), target.into());
        }

        fn resolve(&self, target: Target, path: &str) -> Result<String> {
            metadata::disjoint_for(target, path)?;
            resolve_parent_using(
                path,
                &mut Vec::new(),
                &mut |path| {
                    self.inspected.borrow_mut().push(path.into());
                    self.nodes
                        .get(path)
                        .copied()
                        .ok_or_else(|| std::io::ErrorKind::NotFound.into())
                },
                &mut |path| {
                    self.followed.borrow_mut().push(path.into());
                    self.links
                        .get(path)
                        .cloned()
                        .ok_or_else(|| std::io::ErrorKind::NotFound.into())
                },
            )
        }
    }

    fn compiled_files() -> impl Iterator<Item = &'static pins::Pin> {
        pins::FILES
            .iter()
            .chain(crate::setup::FILES)
            .chain(crate::setup::TOMBSTONE)
            .chain(crate::production::setup::TOMBSTONE)
    }

    #[test]
    fn unrelated_writable_log_parents_are_not_walked_or_changed() {
        let diversions = include_bytes!("../../tests/fixtures/38655921324.diversions");
        let overrides = include_bytes!("../../tests/fixtures/38655921324.statoverride");
        let mut namespace = Namespace::default();
        for triple in std::str::from_utf8(diversions)
            .unwrap()
            .lines()
            .collect::<Vec<_>>()
            .as_chunks::<3>()
            .0
        {
            for path in &triple[..2] {
                namespace.parents(path);
            }
        }
        for line in std::str::from_utf8(overrides).unwrap().lines() {
            namespace.parents(line.splitn(4, ' ').nth(3).unwrap());
        }
        namespace.node("/var/log", libc::S_IFDIR, 0o775, 111);
        let before = namespace.nodes.clone();
        for target in [Target::Mcp, Target::Setup] {
            let mut identities = 0;
            metadata::validate_for(
                target,
                diversions,
                overrides,
                |_, name| {
                    identities += 1;
                    match name {
                        "root" => Ok(0),
                        "_chrony" | "crontab" | "ssl-cert" | "messagebus" => Ok(1),
                        _ => Err("Unknown fixture identity".into()),
                    }
                },
                |path| namespace.resolve(target, path),
            )
            .unwrap();
            assert_eq!(identities, 12);
        }
        assert_eq!(namespace.nodes, before);
        assert!(namespace
            .inspected
            .borrow()
            .iter()
            .all(|path| !path.starts_with("/var/log")));
    }

    #[test]
    fn traversal_covers_both_products_and_protected_prefix_aliases() {
        let mut namespace = Namespace::default();
        namespace.alias("/bin", "/usr/bin");
        for pin in compiled_files() {
            let path = format!("/{}", pin.path);
            namespace.parents(&path);
            assert!(disjoint_products(&path).is_err());
            for parent in Path::new(&path).ancestors() {
                assert!(disjoint_products(parent.to_str().unwrap()).is_err());
            }
            for target in [Target::Mcp, Target::Setup] {
                assert!(namespace.resolve(target, &path).is_err(), "{path}");
            }
        }
        for (alias, target_path) in [
            ("/usr/mcp-alias", "/usr/lib/Creator Works MCP"),
            ("/usr/setup-alias", crate::setup::NOTICE_ROOT),
        ] {
            namespace.alias(alias, target_path);
            for target in [Target::Mcp, Target::Setup] {
                assert!(namespace
                    .resolve(target, &format!("{alias}/retired-by-creator-hub.txt"))
                    .is_err());
            }
        }
        for target in [Target::Mcp, Target::Setup] {
            for path in [
                "/bin/creator-works-mcp-launcher",
                "/bin/creator-project-setup",
            ] {
                assert!(namespace.resolve(target, path).is_err(), "{path}");
            }
            namespace.node("/usr/bin", libc::S_IFDIR, 0o775, 111);
            assert!(namespace.resolve(target, "/usr/bin/unrelated").is_err());
        }
    }

    #[test]
    fn pruned_nested_aliases_remain_dpkg_keys_not_creator_write_paths() {
        let mut namespace = Namespace::default();
        namespace.alias("/var/lib/unrelated/alias", "/usr/lib/Creator Works MCP");
        namespace.node("/var/log", libc::S_IFDIR, 0o775, 111);
        let path = "/var/lib/unrelated/alias/server/creator-works-mcp.mjs";
        for target in [Target::Mcp, Target::Setup] {
            let mut keys = Vec::new();
            metadata::validate_for(
                target,
                b"",
                format!("#0 #0 644 {path}\n").as_bytes(),
                |_, _| Err("Numeric IDs must not query NSS".into()),
                |value| {
                    let resolved = namespace.resolve(target, value)?;
                    keys.push(resolved.clone());
                    Ok(resolved)
                },
            )
            .unwrap();
            assert_eq!(keys, [path]);
            for pin in compiled_files() {
                let creator = format!("/{}", pin.path);
                assert_ne!(keys[0], creator);
                assert!(namespace.resolve(target, &creator).is_err());
            }
        }
        assert!(namespace.followed.borrow().is_empty());
        assert!(namespace
            .inspected
            .borrow()
            .iter()
            .all(|path| !path.starts_with("/var/lib")));
    }

    #[test]
    fn alias_parent_segments_cannot_prune_a_return_into_creator_paths() {
        let mut namespace = Namespace::default();
        namespace.alias("/entry", "/usr/unrelated/../bin/creator-works-mcp-launcher");
        namespace.parents("/usr/unrelated/child");
        namespace.parents("/usr/bin/creator-works-mcp-launcher");
        for mode in [0o755, 0o775] {
            namespace.node("/usr/unrelated", libc::S_IFDIR, mode, 0);
            for target in [Target::Mcp, Target::Setup] {
                assert!(namespace.resolve(target, "/entry").is_err());
            }
        }
    }

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
    fn protected_prefix_aliases_resolve_but_unrelated_branches_keep_their_keys() {
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
        let key = link.join("anything");
        assert_eq!(
            resolve_parent(key.to_str().unwrap(), &mut Vec::new()).unwrap(),
            key.to_str().unwrap()
        );
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
