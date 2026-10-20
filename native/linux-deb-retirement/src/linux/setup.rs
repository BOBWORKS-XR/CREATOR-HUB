//! Fixed Setup checks. No caller-selected package, path, version or user-data access.
use super::*;
#[cfg(feature = "production-transaction")]
pub(super) use crate::production::setup as contract;
#[cfg(not(feature = "production-transaction"))]
pub(super) use crate::setup as contract;
use crate::setup::PackageState;
use std::collections::BTreeSet;

fn queried_state() -> Result<PackageState> {
    let (status, out, err) = capture_outcome(
        QUERY,
        &[
            "--show",
            "--showformat=${Package}\t${Version}\t${Architecture}\t${Status}\n",
            contract::PACKAGE,
        ],
    )?;
    contract::query_state(status.code().ok_or("Setup query interrupted")?, &out, &err)
}

fn absent(path: &Path) -> Result<()> {
    require(path.is_absolute(), "Fixed absolute Setup path required")?;
    let mut current = PathBuf::from("/");
    directory(&current)?;
    let parts = path.components().skip(1).collect::<Vec<_>>();
    for (index, part) in parts.iter().enumerate() {
        let Component::Normal(name) = part else {
            return Err("Noncanonical Setup path".into());
        };
        let next = current.join(name);
        match fs::symlink_metadata(&next) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                directory(&current)?;
                return Ok(());
            }
            Err(e) => return Err(e.into()),
            Ok(_) if index == parts.len() - 1 => return Err("Setup absent-path collision".into()),
            Ok(_) => {
                directory(&next)?;
                current = next;
            }
        }
    }
    Err("Expected an absent Setup file or directory".into())
}

fn unowned_absent(path: &str) -> Result<()> {
    absent(Path::new(path))?;
    let (status, out, err) = capture_outcome(QUERY, &["--search", path])?;
    require(
        status.code() == Some(1)
            && out.is_empty()
            && err == format!("dpkg-query: no path found matching pattern {path}\n").as_bytes(),
        "Setup path retains foreign/shared package ownership or query failed",
    )
}

fn original_notice_absent() -> Result<()> {
    unowned_absent(contract::NOTICE_ROOT)?;
    unowned_absent(&format!("/{}", contract::TOMBSTONE[0].path))
}

fn info_members(absent_package: bool) -> Result<()> {
    directory(Path::new(INFO))?;
    let mut members = BTreeSet::new();
    for entry in fs::read_dir(INFO)? {
        let name = entry?
            .file_name()
            .into_string()
            .map_err(|_| "Non-UTF8 dpkg info member")?;
        if name.starts_with("creator-project-setup.") || name.starts_with("creator-project-setup:")
        {
            members.insert(name);
        }
    }
    let expected = if absent_package {
        BTreeSet::new()
    } else {
        [
            "creator-project-setup.list".into(),
            "creator-project-setup.md5sums".into(),
        ]
        .into()
    };
    require(
        members == expected,
        "Unexpected Setup script/control/metadata members",
    )
}

fn health() -> Result<()> {
    require(
        capture(DPKG, &["--audit"])?.is_empty(),
        "Unhealthy/pending package database",
    )?;
    directory(Path::new("/var/lib/dpkg/updates"))?;
    require(
        fs::read_dir("/var/lib/dpkg/updates")?.next().is_none(),
        "Pending dpkg updates refused",
    )
}

pub(super) fn installed(compatibility: bool) -> Result<()> {
    contract::state(
        &capture(
            QUERY,
            &[
                "--show",
                "--showformat=${Package}\t${Version}\t${Architecture}\t${Status}\n",
                contract::PACKAGE,
            ],
        )?,
        compatibility,
    )?;
    contract::installed_metadata(
        &capture(QUERY, &["--show", METADATA_FORMAT, contract::PACKAGE])?,
        compatibility,
    )?;
    contract::listing(
        &capture(QUERY, &["--listfiles", contract::PACKAGE])?,
        compatibility,
    )?;
    health()?;
    require(
        capture(DPKG, &["--verify", contract::PACKAGE])?.is_empty(),
        "Setup package verification differs",
    )?;
    require(
        capture(
            DPKG,
            &["--compare-versions", contract::NEW, "gt", contract::OLD],
        )?
        .is_empty(),
        "Setup version order refused",
    )?;
    info_members(false)?;
    contract::listing(
        &read("/var/lib/dpkg/info/creator-project-setup.list")?,
        compatibility,
    )?;
    let sums = read("/var/lib/dpkg/info/creator-project-setup.md5sums")?;
    require(
        sha256(&sums)
            == if compatibility {
                sha256(contract::md5sums().as_bytes())
            } else {
                contract::MD5_SHA256.into()
            },
        "Setup installed md5sums pin changed",
    )?;
    metadata::Snapshot::capture_for(Target::Setup)?;
    let selected = if compatibility {
        contract::TOMBSTONE
    } else {
        contract::FILES
    };
    for name in paths(selected, true).difference(&paths(selected, false)) {
        require(
            directory(&Path::new("/").join(name))?.metadata()?.mode() & 0o7777 == 0o755,
            "Setup installed directory mode changed",
        )?;
    }
    for pin in selected {
        let path = format!("/{}", pin.path);
        require(
            capture(QUERY, &["--search", &path])?
                == format!("{}: {path}\n", contract::PACKAGE).as_bytes(),
            "Foreign/shared Setup resource ownership",
        )?;
        resource(pin, std::io::sink())?;
    }
    if compatibility {
        for pin in contract::FILES {
            unowned_absent(&format!("/{}", pin.path))?;
        }
        directory(Path::new(contract::NOTICE_ROOT))?;
        let entries = fs::read_dir(contract::NOTICE_ROOT)?
            .map(|entry| entry.map(|e| e.file_name()))
            .collect::<std::io::Result<Vec<_>>>()?;
        require(
            entries.len() == 1 && entries[0] == "retired-by-creator-hub.txt",
            "Unknown Setup tombstone namespace member",
        )?;
    } else {
        original_notice_absent()?;
    }
    Ok(())
}

pub(super) fn inspect(retained_only: bool) -> Result<serde_json::Value> {
    let metadata = metadata::Snapshot::capture_for(Target::Setup)?;
    let state = queried_state()?;
    require(
        !retained_only || state == PackageState::Compatibility,
        "Exact Setup tombstone required",
    )?;
    match state {
        PackageState::Original => installed(false)?,
        PackageState::Compatibility => installed(true)?,
        PackageState::Absent => {
            info_members(true)?;
            for pin in contract::FILES {
                unowned_absent(&format!("/{}", pin.path))?;
            }
            original_notice_absent()?;
            health()?;
        }
    }
    require(
        queried_state()? == state,
        "Setup state changed during inspection",
    )?;
    metadata.unchanged()?;
    let mut report = contract::inspection_report(state);
    if retained_only {
        report["status"] = json!("inspected-retained-read-only");
    }
    Ok(report)
}

#[cfg(any(
    feature = "experimental-transaction",
    feature = "production-transaction"
))]
pub(super) fn prepare_locked(_held: &PackageLocks) -> Result<Prepared> {
    refuse_prior_attempt_for(Target::Setup)?;
    let metadata = metadata::Snapshot::capture_for(Target::Setup)?;
    installed(false)?;
    let private = Path::new(contract::PRIVATE);
    match fs::symlink_metadata(private) {
        Ok(_) => require(
            directory(private)?.metadata()?.mode() & 0o7777 == 0o700,
            "Setup private root must be 0700",
        )?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => create_directory(private, 0o700)?,
        Err(e) => return Err(e.into()),
    }
    let mut count = 0;
    for entry in fs::read_dir(private)? {
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "Unknown Setup private member")?;
        require(
            contract::stage_name(&name),
            "Unknown Setup private namespace member; review required",
        )?;
        require(
            directory(&entry.path())?.metadata()?.mode() & 0o7777 == 0o700,
            "Setup stage must remain private",
        )?;
        count += 1;
    }
    require(
        count < 4,
        "Setup private stage limit reached; review required",
    )?;
    let work = private.join(new_stage_name_for(Target::Setup)?);
    create_directory(&work, 0o700)?;
    let tree = work.join("tree");
    create_directory(&tree, 0o755)?;
    for path in paths(contract::TOMBSTONE, true).difference(&paths(contract::TOMBSTONE, false)) {
        create_directory(&tree.join(path), 0o755)?;
    }
    write_new(&tree.join(contract::TOMBSTONE[0].path), contract::NOTICE)?;
    create_directory(&tree.join("DEBIAN"), 0o755)?;
    write_new(&tree.join("DEBIAN/control"), contract::control().as_bytes())?;
    write_new(&tree.join("DEBIAN/md5sums"), contract::md5sums().as_bytes())?;
    let candidate = work.join("gui-tombstone.deb");
    let mut cmd = command(DEB, Some(&work))?;
    cmd.args(["--root-owner-group", "-Zgzip", "-z1", "--build"])
        .arg(&tree)
        .arg(&candidate);
    parsed(cmd, |out| bounded(out, LIMIT))?;
    verify_candidate(&candidate)?;
    installed(false)?;
    metadata.unchanged()?;
    Ok(Prepared {
        candidate,
        metadata,
    })
}

#[cfg(any(
    feature = "experimental-transaction",
    feature = "production-transaction"
))]
pub(super) fn verify_candidate(candidate: &Path) -> Result<()> {
    let work = candidate
        .parent()
        .ok_or("Missing Setup private candidate directory")?;
    let before = stamp(&open(candidate, libc::O_RDONLY)?.metadata()?);
    let mut cmd = command(DEB, Some(work))?;
    cmd.arg("--ctrl-tarfile").arg(candidate);
    parsed(cmd, |out| {
        archive::verify_controls(
            out.take(LIMIT),
            contract::control().as_bytes(),
            contract::md5sums().as_bytes(),
        )
    })?;
    let mut cmd = command(DEB, Some(work))?;
    cmd.arg("--fsys-tarfile").arg(candidate);
    parsed(cmd, |out| {
        archive::verify_data(out.take(LIMIT), contract::TOMBSTONE)
    })?;
    require(
        before == stamp(&open(candidate, libc::O_RDONLY)?.metadata()?),
        "Setup candidate changed during verification",
    )?;
    open(candidate, libc::O_RDONLY)?.sync_all()?;
    open(work, libc::O_RDONLY | libc::O_DIRECTORY)?
        .sync_all()
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absence_checks_refuse_untrusted_paths_before_any_package_query() {
        let temporary = tempfile::tempdir().unwrap();
        assert!(absent(&temporary.path().join("missing")).is_err());
        assert!(absent(Path::new("/usr")).is_err());
        assert!(absent(Path::new("relative")).is_err());
        assert!(absent(Path::new("/")).is_err());
    }

    #[test]
    fn rootless_tombstone_archive_roundtrip_never_installs_or_opens_user_data() {
        assert_ne!(
            unsafe { libc::geteuid() },
            0,
            "Run native fixtures unprivileged"
        );
        let temporary = tempfile::tempdir().unwrap();
        let tree = temporary.path().join("tree");
        fs::create_dir_all(tree.join("DEBIAN")).unwrap();
        fs::create_dir_all(tree.join("usr/share/creator-project-setup")).unwrap();
        fs::write(tree.join("DEBIAN/control"), contract::control()).unwrap();
        fs::write(tree.join("DEBIAN/md5sums"), contract::md5sums()).unwrap();
        fs::write(tree.join(contract::TOMBSTONE[0].path), contract::NOTICE).unwrap();
        for name in [
            "",
            "DEBIAN",
            "usr",
            "usr/share",
            "usr/share/creator-project-setup",
        ] {
            fs::set_permissions(tree.join(name), fs::Permissions::from_mode(0o755)).unwrap();
        }
        for name in [
            "DEBIAN/control",
            "DEBIAN/md5sums",
            contract::TOMBSTONE[0].path,
        ] {
            fs::set_permissions(tree.join(name), fs::Permissions::from_mode(0o644)).unwrap();
        }
        let candidate = temporary.path().join("fixture.deb");
        let mut cmd = command(DEB, Some(temporary.path())).unwrap();
        cmd.args(["--root-owner-group", "-Zgzip", "-z1", "--build"])
            .arg(&tree)
            .arg(&candidate);
        parsed(cmd, |out| bounded(out, LIMIT)).unwrap();
        let mut cmd = command(DEB, Some(temporary.path())).unwrap();
        cmd.arg("--ctrl-tarfile").arg(&candidate);
        parsed(cmd, |out| {
            archive::verify_controls(
                out.take(LIMIT),
                contract::control().as_bytes(),
                contract::md5sums().as_bytes(),
            )
        })
        .unwrap();
        let mut cmd = command(DEB, Some(temporary.path())).unwrap();
        cmd.arg("--fsys-tarfile").arg(&candidate);
        parsed(cmd, |out| {
            archive::verify_data(out.take(LIMIT), contract::TOMBSTONE)
        })
        .unwrap();
    }
}
