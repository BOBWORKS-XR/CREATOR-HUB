use super::*;
use minisign_verify::PublicKey;
use std::cell::Cell;

struct Fixture {
    _temp: tempfile::TempDir,
    store: Store,
    records: PathBuf,
    path: PathBuf,
    route_root: PathBuf,
    old: Vec<u8>,
    bytes: Vec<u8>,
    signature: Vec<u8>,
    target: RouteTarget,
    from: String,
    to: String,
}
fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("native/mcp-router/tests/fixtures")
}
fn packet(name: &str) -> (Vec<u8>, Vec<u8>) {
    let base = fixture_dir().join(format!(
        "{}-{}-{name}",
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
    (
        fs::read(base.with_extension("json")).unwrap(),
        fs::read(base.with_extension("minisig")).unwrap(),
    )
}
fn stage(base: &Path, store: &Store, name: &str) -> (Vec<u8>, Vec<u8>) {
    let (bytes, signature) = packet(name);
    let descriptor = store.verify_descriptor(&bytes, &signature).unwrap();
    let generation = creator_hub_mcp_router::generation(&descriptor.module).unwrap();
    let root = base
        .join("runtime-generations")
        .join(format!(
            "{}-{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        ))
        .join(generation);
    for name_in_module in descriptor.module.files.keys() {
        let file = root.join(name_in_module);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        let data = if name_in_module.ends_with(".mjs") {
            if name == "a" {
                "server-a".into()
            } else {
                "server-b".into()
            }
        } else {
            format!("payload:{name_in_module}")
        };
        fs::write(file, data).unwrap();
    }
    (bytes, signature)
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let key = PublicKey::decode(&fs::read_to_string(fixture_dir().join("public.txt")).unwrap())
            .unwrap();
        let store = Store::new(&base, key).unwrap();
        let (a, sig) = stage(&base, &store, "a");
        let from = store.verify_descriptor(&a, &sig).unwrap().hub_version;
        store.activate(&a, &sig, None).unwrap();
        let old = store.snapshot().unwrap().unwrap();
        let (bytes, signature) = stage(&base, &store, "b");
        let descriptor = store.verify_descriptor(&bytes, &signature).unwrap();
        let target = RouteTarget {
            descriptor_sha256: digest(&bytes),
            generation: creator_hub_mcp_router::generation(&descriptor.module).unwrap(),
        };
        let records = base.join("records");
        fs::create_dir(&records).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&records, fs::Permissions::from_mode(0o700)).unwrap();
        }
        Self {
            _temp: temp,
            store,
            path: records.join("mcp-route-update.json"),
            records,
            route_root: base.join("mcp-route-v1").join(format!(
                "{}-{}",
                std::env::consts::OS,
                std::env::consts::ARCH
            )),
            old,
            bytes,
            signature,
            target,
            from,
            to: descriptor.hub_version,
        }
    }
    fn current(&self, new: bool) -> Current {
        Current {
            version: if new {
                self.to.clone()
            } else {
                self.from.clone()
            },
            executable_sha256: digest(if new { b"new-root" } else { b"old-root" }),
            installed: "/usr/bin/creator-hub".into(),
        }
    }
    fn verify(&self, bytes: &[u8], signature: &[u8]) -> Result<VerifiedRelease, String> {
        // Unit seam only: real signed Store fixtures stand in for catalog envelopes.
        // Production glue always uses catalog::verify_signed_target and its release executable hash.
        let descriptor = self.store.verify_descriptor(bytes, signature)?;
        Ok(VerifiedRelease {
            version: descriptor.hub_version,
            executable_sha256: digest(b"new-root"),
        })
    }
    fn prepared(&self) -> Prepared {
        Prepared::capture(
            &self.path,
            &self.store,
            &self.current(false),
            (self.bytes.clone(), self.signature.clone()),
            |b, s| self.verify(b, s),
        )
        .unwrap()
        .unwrap()
    }
    fn publish(&self) {
        self.prepared()
            .publish(&crate::linux_update::Outcome::Installed, &self.store)
            .unwrap();
    }
    fn resume(&self, count: &Cell<usize>, fail: Option<bool>) -> Result<Resumed, String> {
        resume(
            &self.path,
            &self.route_root,
            &self.store,
            &self.current(true),
            |b, s| self.verify(b, s),
            || Ok(self.target.clone()),
            |previous| {
                let previous = previous.to_vec();
                Ok(move |authority: Activation| {
                    count.set(count.get() + 1);
                    authority.authorize(Some(&previous), &self.target)?;
                    if fail == Some(false) {
                        return Err("before commit".into());
                    }
                    self.store
                        .activate(&self.bytes, &self.signature, Some(&previous))?;
                    if fail == Some(true) {
                        return Err("unknown after commit".into());
                    }
                    Ok(())
                })
            },
        )
    }
}

#[test]
fn absent_authority_never_prepares_or_activates_even_with_a_new_signed_payload() {
    let f = Fixture::new();
    let count = Cell::new(0);
    assert_eq!(f.resume(&count, None).unwrap(), Resumed::Absent);
    assert_eq!(count.get(), 0);
    assert_eq!(fs::read_dir(&f.records).unwrap().count(), 0);
    assert_eq!(f.store.snapshot().unwrap().unwrap(), f.old);
}

#[test]
fn system_cancel_publishes_nothing_and_keeps_the_original_receipt() {
    let f = Fixture::new();
    f.prepared()
        .publish(&crate::linux_update::Outcome::Cancelled, &f.store)
        .unwrap();
    assert!(!f.path.exists());
    assert_eq!(fs::read_dir(&f.records).unwrap().count(), 0);
    assert_eq!(f.store.snapshot().unwrap().unwrap(), f.old);
}

#[test]
fn successful_handoff_activates_exact_b_once_and_preserves_resolved_a_and_history() {
    let f = Fixture::new();
    let old_runtime = f.store.resolve().unwrap();
    f.publish();
    let count = Cell::new(0);
    assert_eq!(f.resume(&count, None).unwrap(), Resumed::Activated);
    assert_eq!(f.resume(&count, None).unwrap(), Resumed::KnownCommitted);
    assert_eq!(count.get(), 1);
    assert_eq!(fs::read(old_runtime.server).unwrap(), b"server-a");
    assert_eq!(
        fs::read(f.store.resolve().unwrap().server).unwrap(),
        b"server-b"
    );
    assert_eq!(
        f.store.snapshot().unwrap().unwrap(),
        f.target.receipt().unwrap()
    );
    assert_eq!(
        read(
            &f.route_root
                .join("history")
                .join(format!("{}.json", digest(&f.old)))
        )
        .unwrap()
        .unwrap(),
        f.old
    );
}

#[test]
fn unknown_precommit_is_spent_without_retry_or_rollback() {
    let f = Fixture::new();
    f.publish();
    let count = Cell::new(0);
    assert!(f.resume(&count, Some(false)).is_err());
    assert!(f.resume(&count, None).is_err());
    assert_eq!(count.get(), 1);
    assert_eq!(f.store.snapshot().unwrap().unwrap(), f.old);
}

#[test]
fn unknown_postcommit_requires_exact_b_history_and_intent_and_never_reactivates() {
    let f = Fixture::new();
    f.publish();
    let count = Cell::new(0);
    assert!(f.resume(&count, Some(true)).is_err());
    assert_eq!(f.resume(&count, None).unwrap(), Resumed::KnownCommitted);
    assert_eq!(count.get(), 1);
    fs::remove_file(
        f.route_root
            .join("history")
            .join(format!("{}.json", digest(&f.old))),
    )
    .unwrap();
    assert!(f.resume(&count, None).is_err());
    assert_eq!(count.get(), 1);
}

#[test]
fn an_unrelated_already_active_b_is_not_adopted_from_a_ready_intent() {
    let f = Fixture::new();
    f.publish();
    f.store
        .activate(&f.bytes, &f.signature, Some(&f.old))
        .unwrap();
    let count = Cell::new(0);
    assert!(f.resume(&count, None).is_err());
    assert_eq!(count.get(), 0);
}

#[test]
fn wrong_self_image_version_location_or_release_signature_refuses_before_staging() {
    for field in ["hash", "version", "path", "signature"] {
        let f = Fixture::new();
        f.publish();
        let mut current = f.current(true);
        match field {
            "hash" => current.executable_sha256 = "0".repeat(64),
            "version" => current.version = f.from.clone(),
            "path" => current.installed = "/tmp/creator-hub".into(),
            _ => {}
        }
        let prepared = Cell::new(false);
        let result = resume(
            &f.path,
            &f.route_root,
            &f.store,
            &current,
            |b, s| {
                if field == "signature" {
                    f.verify(b, b"bad signature")
                } else {
                    f.verify(b, s)
                }
            },
            || Ok(f.target.clone()),
            |_| {
                prepared.set(true);
                Ok(|_: Activation| Ok(()))
            },
        );
        assert!(result.is_err(), "{field}");
        assert!(!prepared.get());
        assert_eq!(f.store.snapshot().unwrap().unwrap(), f.old);
    }
}

#[test]
fn target_binding_and_activation_permit_cannot_be_substituted() {
    let f = Fixture::new();
    f.publish();
    let wrong = RouteTarget {
        descriptor_sha256: "0".repeat(64),
        generation: f.target.generation.clone(),
    };
    let exact = f.target.clone();
    let result = resume(
        &f.path,
        &f.route_root,
        &f.store,
        &f.current(true),
        |b, s| f.verify(b, s),
        || Ok(wrong),
        |previous| {
            let previous = previous.to_vec();
            Ok(move |authority: Activation| authority.authorize(Some(&previous), &exact))
        },
    );
    assert!(result.is_err());
    assert_eq!(f.store.snapshot().unwrap().unwrap(), f.old);
    let count = Cell::new(0);
    assert!(f.resume(&count, None).is_err());
    assert_eq!(count.get(), 0);
}

#[test]
fn failed_target_preparation_is_also_spent_before_any_automatic_retry() {
    let f = Fixture::new();
    f.publish();
    let count = Cell::new(0);
    let result = resume(
        &f.path,
        &f.route_root,
        &f.store,
        &f.current(true),
        |b, s| f.verify(b, s),
        || Ok(f.target.clone()),
        |_| {
            count.set(count.get() + 1);
            Err::<fn(Activation) -> Result<(), String>, _>("target staging refused".into())
        },
    );
    assert!(result.is_err());
    assert!(f.resume(&count, None).is_err());
    assert_eq!(count.get(), 1);
    assert_eq!(f.store.snapshot().unwrap().unwrap(), f.old);
}

#[test]
fn no_prior_route_invalid_signature_and_same_version_never_create_authority() {
    let f = Fixture::new();
    assert!(Prepared::capture(
        &f.path,
        &f.store,
        &f.current(false),
        (f.bytes.clone(), b"unsigned".to_vec()),
        |b, s| f.verify(b, s)
    )
    .is_err());
    let (collision, sig) = packet("collision");
    assert!(Prepared::capture(
        &f.path,
        &f.store,
        &f.current(false),
        (collision.clone(), sig.clone()),
        |b, s| f.verify(b, s)
    )
    .is_err());
    assert!(f.store.activate(&collision, &sig, Some(&f.old)).is_err());
    let other = tempfile::tempdir().unwrap();
    let empty = Store::new(
        &other.path().canonicalize().unwrap(),
        PublicKey::decode(&fs::read_to_string(fixture_dir().join("public.txt")).unwrap()).unwrap(),
    )
    .unwrap();
    assert!(Prepared::capture(
        &f.path,
        &empty,
        &f.current(false),
        (f.bytes.clone(), f.signature.clone()),
        |b, s| f.verify(b, s)
    )
    .unwrap()
    .is_none());
    assert!(!f.path.exists());
}

#[test]
fn changed_store_or_raw_handoff_during_install_blocks_publication() {
    let f = Fixture::new();
    let prepared = f.prepared();
    f.store
        .activate(&f.bytes, &f.signature, Some(&f.old))
        .unwrap();
    assert!(prepared
        .publish(&crate::linux_update::Outcome::Installed, &f.store)
        .is_err());
    assert!(!f.path.exists());
    let f = Fixture::new();
    let prepared = f.prepared();
    f.publish();
    let concurrent = fs::read(&f.path).unwrap();
    assert!(prepared
        .publish(&crate::linux_update::Outcome::Installed, &f.store)
        .is_err());
    assert_eq!(fs::read(&f.path).unwrap(), concurrent);
}

#[test]
fn real_store_payload_refusal_preserves_a_and_does_not_retry() {
    let f = Fixture::new();
    f.publish();
    let descriptor = f.store.verify_descriptor(&f.bytes, &f.signature).unwrap();
    let base = f._temp.path().canonicalize().unwrap();
    let server = base
        .join("runtime-generations")
        .join(format!(
            "{}-{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        ))
        .join(creator_hub_mcp_router::generation(&descriptor.module).unwrap())
        .join("mcp/server/creator-works-mcp.mjs");
    fs::write(server, b"changed").unwrap();
    let count = Cell::new(0);
    assert!(f.resume(&count, None).is_err());
    assert!(f.resume(&count, None).is_err());
    assert_eq!(count.get(), 1);
    assert_eq!(f.store.snapshot().unwrap().unwrap(), f.old);
}

#[test]
fn malformed_or_oversize_records_do_not_invoke_the_activation_callback() {
    for data in [b"{bad".to_vec(), vec![b'x'; LIMIT as usize + 1]] {
        let f = Fixture::new();
        f.publish();
        fs::write(&f.path, data).unwrap();
        let count = Cell::new(0);
        assert!(f.resume(&count, None).is_err());
        assert_eq!(count.get(), 0);
        assert_eq!(f.store.snapshot().unwrap().unwrap(), f.old);
    }
}

#[test]
fn outcome_readback_is_read_only_and_keeps_network_and_runtime_ready_out_of_the_proof() {
    let f = Fixture::new();
    f.publish();
    let count = Cell::new(0);
    let inspect = || {
        readback(
            &f.path,
            &f.route_root,
            &f.store,
            &f.current(true),
            |b, s| f.verify(b, s),
            &f.target,
        )
    };
    let ready = inspect();
    assert_eq!(ready.outcome, "not-attempted");
    let before = fs::read(&f.path).unwrap();
    let entries = fs::read_dir(&f.records).unwrap().count();
    assert_eq!(inspect().route, "verified-prior");
    assert_eq!(fs::read(&f.path).unwrap(), before);
    assert_eq!(fs::read_dir(&f.records).unwrap().count(), entries);
    assert!(f.resume(&count, Some(false)).is_err());
    let failed = inspect();
    assert_eq!(failed.route, "verified-prior");
    assert_eq!(failed.recovery, "explicit-client-apply");
    assert_eq!(failed.reason.as_deref(), Some("before commit"));
    assert_eq!(failed.intent_sha256, ready.intent_sha256);
    assert_eq!(count.get(), 1);
    assert!(f.resume(&count, None).is_err());
    assert_eq!(count.get(), 1);
}

#[test]
fn outcome_recheck_requires_exact_target_plus_history_and_never_retries() {
    let f = Fixture::new();
    f.publish();
    let count = Cell::new(0);
    assert!(f.resume(&count, Some(true)).is_err());
    let inspect = || {
        readback(
            &f.path,
            &f.route_root,
            &f.store,
            &f.current(true),
            |b, s| f.verify(b, s),
            &f.target,
        )
    };
    assert_eq!(inspect().outcome, "known-committed");
    assert_eq!(inspect().route, "verified-target");
    let before = fs::read(&f.path).unwrap();
    assert_eq!(inspect().recovery, "none");
    assert_eq!(fs::read(&f.path).unwrap(), before);
    fs::remove_file(
        f.route_root
            .join("history")
            .join(format!("{}.json", digest(&f.old))),
    )
    .unwrap();
    let unknown = inspect();
    assert_eq!(unknown.route, "verified-target");
    assert_eq!(unknown.outcome, "verified-current");
    assert_eq!(
        unknown.active_generation.as_deref(),
        Some(f.target.generation.as_str())
    );
    assert_eq!(unknown.intent_sha256, None);
    assert_eq!(unknown.recovery, "none");
    assert!(matches!(
        decode(&fs::read(&f.path).unwrap()).unwrap().phase,
        Phase::Attempting(_)
    ));
    assert_eq!(count.get(), 1);
}

#[cfg(unix)]
#[test]
fn linked_or_nonprivate_handoff_and_linked_lock_refuse() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let f = Fixture::new();
    f.publish();
    fs::set_permissions(&f.path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(f.resume(&Cell::new(0), None).is_err());
    fs::set_permissions(&f.path, fs::Permissions::from_mode(0o600)).unwrap();
    let target = f.records.join("original.json");
    fs::rename(&f.path, &target).unwrap();
    symlink(&target, &f.path).unwrap();
    assert!(f.resume(&Cell::new(0), None).is_err());
    fs::remove_file(&f.path).unwrap();
    fs::rename(&target, &f.path).unwrap();
    let lock = f.records.join("mcp-route-update.lock");
    fs::remove_file(&lock).unwrap();
    symlink(&f.path, &lock).unwrap();
    assert!(f.resume(&Cell::new(0), None).is_err());
}

#[test]
fn no_handoff_and_different_older_generation_is_visible_legacy_recovery_not_automatic_ready() {
    let f = Fixture::new();
    let status = legacy_readback(&f.store, &f.current(true), &f.target).unwrap();
    assert_eq!(status.outcome, "legacy-review-required");
    assert_eq!(status.route, "verified-prior");
    assert_eq!(status.recovery, "explicit-client-apply");
    assert_eq!(status.intent_sha256, None);
    assert_ne!(status.active_generation, status.expected_generation);
    assert!(!f.path.exists());
    assert_eq!(fs::read_dir(&f.records).unwrap().count(), 0);
    assert_eq!(f.store.snapshot().unwrap().unwrap(), f.old);
}

#[test]
fn explicit_legacy_apply_to_bound_b_has_positive_readback_without_claiming_an_update_operation() {
    let f = Fixture::new();
    assert_eq!(
        legacy_readback(&f.store, &f.current(true), &f.target)
            .unwrap()
            .outcome,
        "legacy-review-required"
    );
    // Existing per-client Apply uses this same signed Store CAS after its own approval.
    f.store
        .activate(&f.bytes, &f.signature, Some(&f.old))
        .unwrap();
    let before = f.store.snapshot().unwrap();
    let positive = legacy_readback(&f.store, &f.current(true), &f.target)
        .expect("Verified B must clear the prior legacy notice, not disappear as None");
    assert_eq!(positive.outcome, "verified-current");
    assert_eq!(positive.route, "verified-target");
    assert_eq!(positive.active_generation, positive.expected_generation);
    assert_eq!(
        positive.expected_generation.as_deref(),
        Some(f.target.generation.as_str())
    );
    assert_eq!(positive.recovery, "none");
    assert_eq!(positive.reason, None);
    assert_eq!(positive.intent_sha256, None);
    assert_eq!(positive.hub_only_manual_install, None);
    assert_eq!(f.store.snapshot().unwrap(), before);
    assert!(!f.path.exists());
    assert_eq!(fs::read_dir(&f.records).unwrap().count(), 0);
}

#[test]
fn same_payload_is_explicitly_verified_but_absent_route_is_still_none_without_authority() {
    let f = Fixture::new();
    let (bytes, signature) = packet("a");
    let old = f.store.verify_descriptor(&bytes, &signature).unwrap();
    let target = RouteTarget {
        descriptor_sha256: digest(&bytes),
        generation: creator_hub_mcp_router::generation(&old.module).unwrap(),
    };
    let status = legacy_readback(&f.store, &f.current(true), &target).unwrap();
    assert_eq!(status.outcome, "verified-current");
    assert_eq!(status.route, "verified-target");
    assert_eq!(status.intent_sha256, None);
    let temp = tempfile::tempdir().unwrap();
    let empty = Store::new(
        &temp.path().canonicalize().unwrap(),
        PublicKey::decode(&fs::read_to_string(fixture_dir().join("public.txt")).unwrap()).unwrap(),
    )
    .unwrap();
    assert!(legacy_readback(&empty, &f.current(true), &f.target).is_none());
    assert!(!f.path.exists());
}

#[test]
fn legacy_same_version_collision_or_unreadable_route_is_unknown_not_a_safe_apply_offer() {
    let f = Fixture::new();
    let status = legacy_readback(&f.store, &f.current(false), &f.target).unwrap();
    assert_eq!(status.route, "unknown");
    assert_eq!(status.recovery, "read-only-recheck");
    let active = f.route_root.join("active.json");
    fs::write(active, b"invalid fixture receipt").unwrap();
    assert_eq!(
        legacy_readback(&f.store, &f.current(true), &f.target)
            .unwrap()
            .route,
        "unknown"
    );
    assert!(!f.path.exists());
}

#[test]
fn unknown_mcp_state_has_a_separate_hub_only_manual_way_without_route_authority() {
    let f = Fixture::new();
    let before = f.store.snapshot().unwrap();
    let status = Readback::unavailable("MCP record cannot be verified");
    assert_eq!(status.route, "unknown");
    assert_eq!(status.recovery, "read-only-recheck");
    assert!(status
        .hub_only_manual_install
        .as_deref()
        .unwrap()
        .contains("Hub-only manual installation remains available"));
    let message = manual_install_message(
        Path::new("/fixture/signed-hub.deb"),
        "0.1.17",
        "unresolved MCP outcome",
    );
    assert!(message.contains("has not installed Hub"));
    assert!(message.contains("/fixture/signed-hub.deb"));
    assert!(message.contains("Recheck its hash against the signed release"));
    assert_eq!(f.store.snapshot().unwrap(), before);
    assert!(!f.path.exists());
    assert_eq!(fs::read_dir(&f.records).unwrap().count(), 0);
}

struct RestartFixture {
    _temp: tempfile::TempDir,
    path: PathBuf,
    sha256: String,
}
impl RestartFixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().canonicalize().unwrap().join("replacement-root");
        let bytes = b"signed-release-replacement-fixture-not-executed";
        fs::write(&path, bytes).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        Self {
            _temp: temp,
            path,
            sha256: digest(bytes),
        }
    }
    fn verify(&self) -> Result<VerifiedRestartImage, String> {
        #[cfg(unix)]
        let owner = unsafe { libc::geteuid() };
        #[cfg(not(unix))]
        let owner = 0;
        // Qualify the same held-file/hash verifier with this fixture's actual owner.
        // Production native_deb separately fixes both /usr/bin/creator-hub and uid0.
        VerifiedRestartImage::capture(&self.path, &self.path, &self.sha256, owner)
    }
}

#[test]
fn publication_error_after_ready_rename_still_restarts_verified_b_and_ready_is_consumed_once() {
    let f = Fixture::new();
    let image = RestartFixture::new();
    let old_runtime = f.store.resolve().unwrap();
    let prepared = f.prepared();
    let completion = complete_deb_install(
        &crate::linux_update::Outcome::Installed,
        || image.verify(),
        || {
            prepared.publish_after_rename(
                &crate::linux_update::Outcome::Installed,
                &f.store,
                || Err("injected directory fsync acknowledgement failure after rename".into()),
            )?;
            Ok(Publication::Published)
        },
    );
    assert!(matches!(
        decode(&fs::read(&f.path).unwrap()).unwrap().phase,
        Phase::Ready
    ));
    assert_eq!(f.store.snapshot().unwrap().unwrap(), f.old);
    let restarts = Cell::new(0);
    let mut notices = Vec::new();
    let result = completion.finish(
        &f.to,
        |notice| notices.push(notice.to_owned()),
        || restarts.set(restarts.get() + 1),
    );
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(restarts.get(), 1);
    assert!(notices[0].contains("was installed"));
    assert!(notices[0].contains("publication is unknown"));
    assert!(notices[0].contains("after rename"));
    let attempts = Cell::new(0);
    assert_eq!(f.resume(&attempts, None).unwrap(), Resumed::Activated);
    assert_eq!(f.resume(&attempts, None).unwrap(), Resumed::KnownCommitted);
    assert_eq!(attempts.get(), 1);
    assert_eq!(fs::read(old_runtime.server).unwrap(), b"server-a");
}

#[test]
fn publication_failure_before_write_restarts_verified_binary_without_creating_route_authority() {
    let f = Fixture::new();
    let image = RestartFixture::new();
    let completion = complete_deb_install(
        &crate::linux_update::Outcome::Installed,
        || image.verify(),
        || Err("metadata path unavailable before publication".into()),
    );
    let restarts = Cell::new(0);
    let result = completion.finish(&f.to, |_| {}, || restarts.set(restarts.get() + 1));
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(restarts.get(), 1);
    assert!(!f.path.exists());
    assert_eq!(f.resume(&Cell::new(0), None).unwrap(), Resumed::Absent);
    assert_eq!(
        legacy_readback(&f.store, &f.current(true), &f.target)
            .unwrap()
            .outcome,
        "legacy-review-required"
    );
    assert_eq!(f.store.snapshot().unwrap().unwrap(), f.old);
}

#[test]
fn cancel_does_not_verify_publish_or_restart() {
    let completion = complete_deb_install(
        &crate::linux_update::Outcome::Cancelled,
        || panic!("Cancel cannot reach image verification"),
        || panic!("Cancel cannot reach publication"),
    );
    assert!(matches!(&completion, DebCompletion::Cancelled));
    let restarts = Cell::new(0);
    let result = completion
        .finish("0.1.17", |_| {}, || restarts.set(restarts.get() + 1))
        .unwrap();
    assert!(result.contains("Nothing was installed"));
    assert_eq!(restarts.get(), 0);
}

#[test]
fn wrong_replacement_hash_blocks_restart_and_does_not_publish() {
    let mut image = RestartFixture::new();
    image.sha256 = "0".repeat(64);
    let completion = complete_deb_install(
        &crate::linux_update::Outcome::Installed,
        || image.verify(),
        || panic!("Wrong signed hash cannot reach metadata publication"),
    );
    assert!(matches!(
        &completion,
        DebCompletion::InstalledRestartBlocked {
            publication: None,
            ..
        }
    ));
    let restarts = Cell::new(0);
    let mut notices = Vec::new();
    let result = completion.finish(
        "0.1.17",
        |notice| notices.push(notice.to_owned()),
        || restarts.set(1),
    );
    assert!(result.is_err());
    assert_eq!(restarts.get(), 0);
    assert!(notices[0].contains("installation returned Installed"));
    assert!(notices[0].contains("signed executable SHA256"));
}

#[test]
fn native_restart_constructor_does_not_accept_a_fixture_or_different_restart_path() {
    let image = RestartFixture::new();
    assert!(VerifiedRestartImage::native_deb(&image.path, &image.path, &image.sha256).is_err());
    assert!(VerifiedRestartImage::capture(
        &image.path,
        Path::new("/wrong/restart"),
        &image.sha256,
        0
    )
    .is_err());
}

#[test]
fn correct_image_and_published_handoff_emit_pending_not_activation_success_then_restart_once() {
    let image = RestartFixture::new();
    let publications = Cell::new(0);
    let completion = complete_deb_install(
        &crate::linux_update::Outcome::Installed,
        || image.verify(),
        || {
            publications.set(publications.get() + 1);
            Ok(Publication::Published)
        },
    );
    assert!(matches!(
        &completion,
        DebCompletion::Installed {
            publication: Publication::Published,
            ..
        }
    ));
    let restarts = Cell::new(0);
    let mut notices = Vec::new();
    assert!(completion
        .finish(
            "0.1.17",
            |notice| notices.push(notice.to_owned()),
            || restarts.set(restarts.get() + 1)
        )
        .is_ok());
    assert_eq!(publications.get(), 1);
    assert_eq!(restarts.get(), 1);
    assert!(notices[0].contains("new Root must validate and complete"));
}

#[test]
fn metadata_failure_never_overrides_a_failed_final_image_verification() {
    let image = RestartFixture::new();
    let completion = complete_deb_install(
        &crate::linux_update::Outcome::Installed,
        || image.verify(),
        || {
            fs::write(
                &image.path,
                b"foreign replacement after initial verification",
            )
            .unwrap();
            Err("metadata publication also failed".into())
        },
    );
    let restarts = Cell::new(0);
    let mut notices = Vec::new();
    assert!(completion
        .finish(
            "0.1.17",
            |notice| notices.push(notice.to_owned()),
            || restarts.set(1)
        )
        .is_err());
    assert_eq!(restarts.get(), 0);
    assert!(notices[0].contains("metadata publication also failed"));
    assert!(notices[0].contains("restart is blocked"));
}

#[test]
fn image_change_after_completion_is_checked_again_immediately_before_restart() {
    let image = RestartFixture::new();
    let completion = complete_deb_install(
        &crate::linux_update::Outcome::Installed,
        || image.verify(),
        || Ok(Publication::NotRequired),
    );
    fs::write(&image.path, b"changed before final callback").unwrap();
    let restarts = Cell::new(0);
    assert!(completion
        .finish("0.1.17", |_| {}, || restarts.set(1))
        .is_err());
    assert_eq!(restarts.get(), 0);
}

#[test]
fn older_ready_left_by_a_prewrite_refusal_cannot_activate_a_different_root_version() {
    type Activate = fn(Activation) -> Result<(), String>;
    let f = Fixture::new();
    f.publish();
    let ready = fs::read(&f.path).unwrap();
    let image = RestartFixture::new();
    let completion = complete_deb_install(
        &crate::linux_update::Outcome::Installed,
        || image.verify(),
        || Err("prewrite refusal preserves old record".into()),
    );
    assert!(completion.finish("9.0.0", |_| {}, || {}).is_ok());
    assert_eq!(fs::read(&f.path).unwrap(), ready);
    let mut current = f.current(true);
    current.version = "9.0.0".into();
    current.executable_sha256 = image.sha256;
    let result = resume(
        &f.path,
        &f.route_root,
        &f.store,
        &current,
        |b, s| f.verify(b, s),
        || Ok(f.target.clone()),
        |_| -> Result<Activate, String> { panic!("Old-version handoff cannot reach preparation") },
    );
    assert!(result.is_err());
    assert_eq!(f.store.snapshot().unwrap().unwrap(), f.old);
}

#[cfg(unix)]
#[test]
fn replacement_verifier_refuses_writable_linked_or_foreign_owned_fixture_images() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let image = RestartFixture::new();
    let owner = unsafe { libc::geteuid() };
    assert!(image.verify().is_ok());
    fs::set_permissions(&image.path, fs::Permissions::from_mode(0o777)).unwrap();
    assert!(image.verify().is_err());
    fs::set_permissions(&image.path, fs::Permissions::from_mode(0o755)).unwrap();
    let alias = image.path.with_extension("alias");
    fs::hard_link(&image.path, &alias).unwrap();
    assert!(image.verify().is_err());
    fs::remove_file(&alias).unwrap();
    symlink(&image.path, &alias).unwrap();
    assert!(VerifiedRestartImage::capture(&alias, &alias, &image.sha256, owner).is_err());
    assert!(VerifiedRestartImage::capture(
        &image.path,
        &image.path,
        &image.sha256,
        owner.wrapping_add(1)
    )
    .is_err());
}

#[test]
fn completion_hint_runs_after_both_busy_state_and_real_file_lock_are_released() {
    struct Guard<'a> {
        _file: File,
        busy: &'a Cell<bool>,
    }
    impl Drop for Guard<'_> {
        fn drop(&mut self) {
            self.busy.set(false);
        }
    }
    for fail in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("operation.lock");
        let first = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        first.try_lock_exclusive().unwrap();
        let busy = Cell::new(true);
        let hinted = Cell::new(0);
        let result = after_operation(
            Ok::<_, String>(Guard {
                _file: first,
                busy: &busy,
            }),
            || {
                assert!(busy.get());
                if fail {
                    Err("unknown activation outcome".into())
                } else {
                    Ok(())
                }
            },
            || {
                assert!(!busy.get());
                let second = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&path)
                    .unwrap();
                second
                    .try_lock_exclusive()
                    .expect("Manager-style file lease must be gone before the read-only UI hint");
                hinted.set(hinted.get() + 1);
            },
        );
        assert_eq!(hinted.get(), 1);
        if fail {
            assert_eq!(result.unwrap_err(), "unknown activation outcome");
        } else {
            assert!(result.is_ok());
        }
    }
}

fn fresh_hub_packet() -> (Vec<u8>, Vec<u8>) {
    let base = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("tests/fixtures/root-handoff/creator-hub-linux-x86_64-deb.json");
    let bytes = fs::read(&base).unwrap();
    let signature = fs::read(base.with_extension("json.minisig")).unwrap();
    assert_eq!(
        digest(&bytes),
        "c602b641380ea1e7a16ef5c9be0676088ad8d1b3283d27a2256896f294e633cf"
    );
    assert_eq!(
        digest(&signature),
        "2eb01a05a2f7e46b30f194d0827632510cb1a0f06d38d2c1bf95064c660c1306"
    );
    (bytes, signature)
}

fn verify_fresh_hub(bytes: &[u8], signature: &[u8]) -> Result<VerifiedRelease, String> {
    let key = PublicKey::decode(include_str!("catalog-key.pub"))
        .map_err(|_| "Invalid pinned catalog key.")?;
    let signature = minisign_verify::Signature::decode(
        std::str::from_utf8(signature).map_err(|_| "Invalid signature text.")?,
    )
    .map_err(|_| "Invalid catalog signature.")?;
    key.verify(bytes, &signature, false)
        .map_err(|_| "Signed Hub catalog verification refused.")?;
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| "Invalid signed Hub fixture.")?;
    require(
        value["schemaVersion"] == 1
            && value["appId"] == "creator-hub"
            && value["platform"] == "linux"
            && value["architecture"] == "x86_64"
            && value["packageType"] == "deb"
            && value["installerProtocol"] == 1,
        "Exact existing signed Linux-DEB Hub fixture required.",
    )?;
    Ok(VerifiedRelease {
        version: value["version"]
            .as_str()
            .ok_or("Missing signed version.")?
            .into(),
        executable_sha256: value["executableSha256"]
            .as_str()
            .ok_or("Missing signed executable hash.")?
            .into(),
    })
}

fn manually_updated_root() -> Current {
    Current {
        version: "0.1.16".into(),
        executable_sha256: digest(b"manually-updated-root16-unit-context"),
        installed: "/usr/bin/creator-hub".into(),
    }
}

#[test]
fn fresh_signed_higher_update_supersedes_old_ready_after_explicit_apply_using_actual_current_store()
{
    let f = Fixture::new();
    f.publish();
    let old_raw = fs::read(&f.path).unwrap();
    f.store
        .activate(&f.bytes, &f.signature, Some(&f.old))
        .unwrap();
    let actual = f.store.snapshot().unwrap().unwrap();
    let (bytes, signature) = fresh_hub_packet();
    let prepared = Prepared::capture(
        &f.path,
        &f.store,
        &manually_updated_root(),
        (bytes.clone(), signature.clone()),
        verify_fresh_hub,
    )
    .expect("A fresh approved higher update must not need old Ready to belong to this Root")
    .unwrap();
    assert_eq!(fs::read(&f.path).unwrap(), old_raw);
    prepared
        .publish(&crate::linux_update::Outcome::Installed, &f.store)
        .unwrap();
    let saved = f
        .records
        .join(format!("mcp-route-history-{}.json", digest(&old_raw)));
    assert_eq!(fs::read(saved).unwrap(), old_raw);
    let new = decode(&fs::read(&f.path).unwrap()).unwrap();
    assert_eq!(new.from_version, "0.1.16");
    assert_eq!(new.previous, actual);
    assert_eq!(new.release, bytes);
    assert_eq!(new.signature, signature);
    assert!(matches!(new.phase, Phase::Ready));
    assert_eq!(f.store.snapshot().unwrap().unwrap(), actual);
}

#[test]
fn fresh_signed_update_retains_owned_non_json_old_record_as_opaque_bytes() {
    let f = Fixture::new();
    f.publish();
    let opaque = b"\xff\0future-or-damaged-old-metadata\n";
    fs::write(&f.path, opaque).unwrap();
    let (bytes, signature) = fresh_hub_packet();
    let prepared = Prepared::capture(
        &f.path,
        &f.store,
        &manually_updated_root(),
        (bytes, signature),
        verify_fresh_hub,
    )
    .expect("Old data is not new authority")
    .unwrap();
    prepared
        .publish(&crate::linux_update::Outcome::Installed, &f.store)
        .unwrap();
    assert_eq!(
        fs::read(
            f.records
                .join(format!("mcp-route-history-{}.json", digest(opaque)))
        )
        .unwrap(),
        opaque
    );
    assert_eq!(f.store.snapshot().unwrap().unwrap(), f.old);
}

#[test]
fn fresh_update_target_must_exceed_active_hub_version_not_only_the_running_root() {
    let f = Fixture::new();
    f.store
        .activate(&f.bytes, &f.signature, Some(&f.old))
        .unwrap();
    assert!(
        Prepared::capture(
            &f.path,
            &f.store,
            &f.current(false),
            (f.bytes.clone(), f.signature.clone()),
            |b, s| f.verify(b, s)
        )
        .is_err(),
        "A target equal to the actual newer active Hub route must be refused"
    );
    assert!(!f.path.exists());
}

#[test]
fn fresh_supersession_cancel_does_not_archive_or_change_old_record_or_store() {
    let f = Fixture::new();
    f.publish();
    let before = fs::read(&f.path).unwrap();
    let entries = fs::read_dir(&f.records).unwrap().count();
    let (bytes, signature) = fresh_hub_packet();
    let prepared = Prepared::capture(
        &f.path,
        &f.store,
        &manually_updated_root(),
        (bytes, signature),
        verify_fresh_hub,
    )
    .unwrap()
    .unwrap();
    prepared
        .publish(&crate::linux_update::Outcome::Cancelled, &f.store)
        .unwrap();
    assert_eq!(fs::read(&f.path).unwrap(), before);
    assert_eq!(fs::read_dir(&f.records).unwrap().count(), entries);
    assert_eq!(f.store.snapshot().unwrap().unwrap(), f.old);
}

#[test]
fn independent_current_payload_readback_does_not_adopt_an_old_ready_operation() {
    let f = Fixture::new();
    f.publish();
    f.store
        .activate(&f.bytes, &f.signature, Some(&f.old))
        .unwrap();
    let before = fs::read(&f.path).unwrap();
    let active = f.store.snapshot().unwrap();
    let result = readback(
        &f.path,
        &f.route_root,
        &f.store,
        &f.current(true),
        |b, s| f.verify(b, s),
        &f.target,
    );
    assert_eq!(result.outcome, "verified-current");
    assert_eq!(result.route, "verified-target");
    assert_eq!(result.intent_sha256, None);
    assert_eq!(result.recovery, "none");
    assert_eq!(fs::read(&f.path).unwrap(), before);
    assert!(matches!(decode(&before).unwrap().phase, Phase::Ready));
    let attempts = Cell::new(0);
    assert!(f.resume(&attempts, None).is_err());
    assert_eq!(attempts.get(), 0);
    assert_eq!(fs::read(&f.path).unwrap(), before);
    assert_eq!(f.store.snapshot().unwrap(), active);
}

fn prepared_fresh(f: &Fixture) -> Prepared {
    let (bytes, signature) = fresh_hub_packet();
    Prepared::capture(
        &f.path,
        &f.store,
        &manually_updated_root(),
        (bytes, signature),
        verify_fresh_hub,
    )
    .unwrap()
    .unwrap()
}

#[test]
fn fresh_publication_rechecks_old_raw_after_backup_and_never_overwrites_a_concurrent_record() {
    let f = Fixture::new();
    f.publish();
    let old = fs::read(&f.path).unwrap();
    let prepared = prepared_fresh(&f);
    let changed = b"a different owned record from a concurrent operation";
    assert!(prepared
        .publish_with_check(
            &crate::linux_update::Outcome::Installed,
            &f.store,
            || {
                fs::write(&f.path, changed).unwrap();
                Ok(())
            },
            || panic!("Changed raw CAS cannot reach rename")
        )
        .is_err());
    assert_eq!(fs::read(&f.path).unwrap(), changed);
    assert_eq!(
        fs::read(
            f.records
                .join(format!("mcp-route-history-{}.json", digest(&old)))
        )
        .unwrap(),
        old
    );
    assert_eq!(f.store.snapshot().unwrap().unwrap(), f.old);
}

#[test]
fn fresh_publication_rechecks_actual_store_after_backup_without_rolling_it_back() {
    let f = Fixture::new();
    f.publish();
    let old = fs::read(&f.path).unwrap();
    let prepared = prepared_fresh(&f);
    assert!(prepared
        .publish_with_check(
            &crate::linux_update::Outcome::Installed,
            &f.store,
            || {
                f.store.activate(&f.bytes, &f.signature, Some(&f.old))?;
                Ok(())
            },
            || panic!("Changed Store CAS cannot reach rename")
        )
        .is_err());
    assert_eq!(fs::read(&f.path).unwrap(), old);
    assert_eq!(
        f.store.snapshot().unwrap().unwrap(),
        f.target.receipt().unwrap()
    );
}

#[test]
fn damaged_opaque_backup_is_not_repaired_or_used_to_overwrite_the_original() {
    let f = Fixture::new();
    f.publish();
    let old = fs::read(&f.path).unwrap();
    let prepared = prepared_fresh(&f);
    let backup = f
        .records
        .join(format!("mcp-route-history-{}.json", digest(&old)));
    assert!(prepared
        .publish_with_check(
            &crate::linux_update::Outcome::Installed,
            &f.store,
            || {
                fs::write(&backup, b"changed archive").unwrap();
                Ok(())
            },
            || panic!("Bad backup cannot reach rename")
        )
        .is_err());
    assert_eq!(fs::read(&f.path).unwrap(), old);
    assert_eq!(fs::read(backup).unwrap(), b"changed archive");
}

#[test]
fn fresh_user_approved_update_is_not_a_retry_of_a_spent_old_attempt() {
    let f = Fixture::new();
    f.publish();
    let attempts = Cell::new(0);
    assert!(f.resume(&attempts, Some(false)).is_err());
    let old = fs::read(&f.path).unwrap();
    assert!(matches!(decode(&old).unwrap().phase, Phase::Attempting(_)));
    prepared_fresh(&f)
        .publish(&crate::linux_update::Outcome::Installed, &f.store)
        .unwrap();
    assert_eq!(attempts.get(), 1);
    assert_eq!(
        fs::read(
            f.records
                .join(format!("mcp-route-history-{}.json", digest(&old)))
        )
        .unwrap(),
        old
    );
    let fresh = decode(&fs::read(&f.path).unwrap()).unwrap();
    assert!(matches!(fresh.phase, Phase::Ready));
    assert_eq!(fresh.from_version, "0.1.16");
    assert_eq!(
        verify_fresh_hub(&fresh.release, &fresh.signature)
            .unwrap()
            .version,
        "0.1.17"
    );
    assert_eq!(f.store.snapshot().unwrap().unwrap(), f.old);
}

#[test]
fn failed_new_signature_cannot_supersede_old_bytes_or_create_a_backup() {
    let f = Fixture::new();
    f.publish();
    let old = fs::read(&f.path).unwrap();
    let entries = fs::read_dir(&f.records).unwrap().count();
    let (mut bytes, signature) = fresh_hub_packet();
    bytes[0] ^= 1;
    assert!(Prepared::capture(
        &f.path,
        &f.store,
        &manually_updated_root(),
        (bytes, signature),
        verify_fresh_hub
    )
    .is_err());
    assert_eq!(fs::read(&f.path).unwrap(), old);
    assert_eq!(fs::read_dir(&f.records).unwrap().count(), entries);
}

#[test]
fn no_actual_current_route_still_creates_no_first_time_handoff_even_with_old_metadata() {
    let f = Fixture::new();
    f.publish();
    let old = fs::read(&f.path).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let empty = Store::new(
        &temp.path().canonicalize().unwrap(),
        PublicKey::decode(&fs::read_to_string(fixture_dir().join("public.txt")).unwrap()).unwrap(),
    )
    .unwrap();
    let (bytes, signature) = fresh_hub_packet();
    assert!(Prepared::capture(
        &f.path,
        &empty,
        &manually_updated_root(),
        (bytes, signature),
        verify_fresh_hub
    )
    .unwrap()
    .is_none());
    assert_eq!(fs::read(&f.path).unwrap(), old);
}

#[test]
fn opaque_retention_keeps_the_existing_bound_before_any_new_authority() {
    let f = Fixture::new();
    f.publish();
    let too_large = vec![b'x'; LIMIT as usize + 1];
    fs::write(&f.path, &too_large).unwrap();
    let (bytes, signature) = fresh_hub_packet();
    assert!(Prepared::capture(
        &f.path,
        &f.store,
        &manually_updated_root(),
        (bytes, signature),
        verify_fresh_hub
    )
    .is_err());
    assert_eq!(fs::read(&f.path).unwrap(), too_large);
}

#[test]
fn skipped_root_version_ordering_requires_new_target_above_both_current_and_active() {
    // Pure ordering only: no fabricated 0.1.20 signed release or admission.
    assert!(require_higher_target("0.1.20", "0.1.19", "0.1.17").is_ok());
    assert!(require_higher_target("0.1.19", "0.1.19", "0.1.17").is_err());
    assert!(require_higher_target("0.1.20", "0.1.19", "0.1.20").is_err());
    assert!(require_higher_target("0.1.20", "0.1.19", "0.1.21").is_err());
}
