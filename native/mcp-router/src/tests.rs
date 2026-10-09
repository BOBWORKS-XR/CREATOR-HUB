use super::*;

fn fixture(name: &str) -> (Vec<u8>, Vec<u8>) {
    let prefix = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(format!("{}-{}-{name}", platform(), std::env::consts::ARCH));
    (
        fs::read(prefix.with_extension("json")).unwrap(),
        fs::read(prefix.with_extension("minisig")).unwrap(),
    )
}

fn setup() -> (tempfile::TempDir, Store) {
    let temporary = tempfile::tempdir().unwrap();
    let base = temporary.path().canonicalize().unwrap();
    let key = PublicKey::decode(include_str!("../tests/fixtures/public.txt")).unwrap();
    let store = Store::new(&base, key).unwrap();
    (temporary, store)
}

fn stage(store: &Store, name: &str) -> (Vec<u8>, Vec<u8>) {
    let (bytes, signature) = fixture(name);
    let descriptor = store.descriptor(&bytes, &signature).unwrap();
    let root = store
        .generations
        .join(generation(&descriptor.module).unwrap());
    for file in descriptor.module.files.keys() {
        let path = root.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let contents = if file.ends_with(".mjs") {
            if name == "a" {
                "server-a".into()
            } else {
                "server-b".into()
            }
        } else {
            format!("payload:{file}")
        };
        fs::write(path, contents).unwrap();
    }
    (bytes, signature)
}

fn activate_a(store: &Store) -> Vec<u8> {
    let (bytes, signature) = stage(store, "a");
    store.activate(&bytes, &signature, None).unwrap();
    store.snapshot().unwrap().unwrap()
}

#[test]
fn fresh_discovery_is_read_only_and_missing_routes_fail_clearly() {
    let (_temporary, store) = setup();
    assert_eq!(store.snapshot().unwrap(), None);
    assert!(store
        .resolve()
        .err()
        .unwrap()
        .contains("No managed MCP runtime"));
    assert!(!store.root.exists());
    assert!(!store.generations.exists());
}

#[test]
fn activation_requires_the_signature_and_the_complete_matching_payload() {
    let (_temporary, store) = setup();
    let (bytes, signature) = fixture("a");
    assert!(store.activate(&bytes, &signature, None).is_err());
    assert!(!store.root.exists());
    let (bytes, signature) = stage(&store, "a");
    let mut changed = bytes.clone();
    changed.push(b' ');
    assert!(store.activate(&changed, &signature, None).is_err());
    assert!(store.activate(&bytes, b"unsigned", None).is_err());
    let descriptor: Descriptor = serde_json::from_slice(&bytes).unwrap();
    let path = store
        .generations
        .join(generation(&descriptor.module).unwrap())
        .join("mcp/server/runtime/LICENSE");
    fs::remove_file(path).unwrap();
    assert!(store.activate(&bytes, &signature, None).is_err());
    assert!(!store.root.exists());
}

#[test]
fn repeated_approved_activation_is_idempotent_and_does_not_edit_payloads() {
    let (_temporary, store) = setup();
    let previous = activate_a(&store);
    let (bytes, signature) = fixture("a");
    let first = store.resolve().unwrap();
    let second = store.activate(&bytes, &signature, Some(&previous)).unwrap();
    assert_eq!(first.generation, second);
    assert_eq!(store.snapshot().unwrap().unwrap(), previous);
    assert_eq!(fs::read(&first.server).unwrap(), b"server-a");
}

#[test]
fn a_new_route_does_not_replace_an_active_old_generation() {
    let (_temporary, store) = setup();
    let previous = activate_a(&store);
    let old_runtime = store.resolve().unwrap();
    let (bytes, signature) = stage(&store, "b");
    let id = store.activate(&bytes, &signature, Some(&previous)).unwrap();
    let new_runtime = store.resolve().unwrap();
    assert_eq!(new_runtime.generation, id);
    assert_ne!(old_runtime.generation, new_runtime.generation);
    assert_eq!(fs::read(&old_runtime.server).unwrap(), b"server-a");
    assert_eq!(fs::read(&new_runtime.server).unwrap(), b"server-b");
    assert_eq!(
        fs::read(
            store
                .root
                .join("history")
                .join(format!("{}.json", digest(&previous)))
        )
        .unwrap(),
        previous
    );
}

#[test]
fn stale_review_and_downgrade_and_same_version_collision_refuse_without_change() {
    let (_temporary, store) = setup();
    let previous = activate_a(&store);
    let (collision, collision_sig) = stage(&store, "collision");
    assert!(store
        .activate(&collision, &collision_sig, Some(&previous))
        .is_err());
    let (next, next_sig) = stage(&store, "b");
    assert!(store.activate(&next, &next_sig, None).is_err());
    assert_eq!(store.snapshot().unwrap().unwrap(), previous);
    store.activate(&next, &next_sig, Some(&previous)).unwrap();
    let current = store.snapshot().unwrap().unwrap();
    let (old, old_sig) = fixture("a");
    assert!(store.activate(&old, &old_sig, Some(&current)).is_err());
    assert!(store.activate(&next, &next_sig, Some(&previous)).is_err());
    assert_eq!(store.snapshot().unwrap().unwrap(), current);
}

#[test]
fn interrupted_activation_keeps_the_previous_receipt_and_retries_safely() {
    for point in ["descriptor", "backup", "receipt"] {
        let (_temporary, store) = setup();
        let previous = activate_a(&store);
        let (next, signature) = stage(&store, "b");
        assert!(store
            .activate_with(&next, &signature, Some(&previous), |step| {
                if step == point {
                    Err("injected power-loss boundary".into())
                } else {
                    Ok(())
                }
            })
            .is_err());
        assert_eq!(store.snapshot().unwrap().unwrap(), previous);
        assert_eq!(store.resolve().unwrap().hub_version, "0.1.12");
        assert!(!fs::read_dir(&store.root).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".activation-")));
        store.activate(&next, &signature, Some(&previous)).unwrap();
        assert_eq!(store.resolve().unwrap().hub_version, "0.1.13");
    }
}

#[test]
fn an_interruption_after_commit_is_rechecked_as_a_complete_new_route() {
    let (_temporary, store) = setup();
    let previous = activate_a(&store);
    let (next, signature) = stage(&store, "b");
    assert!(store
        .activate_with(&next, &signature, Some(&previous), |step| {
            if step == "published" {
                Err("interrupted after atomic commit".into())
            } else {
                Ok(())
            }
        })
        .is_err());
    let current = store.snapshot().unwrap().unwrap();
    assert_eq!(store.resolve().unwrap().hub_version, "0.1.13");
    assert!(store.activate(&next, &signature, Some(&previous)).is_err());
    store.activate(&next, &signature, Some(&current)).unwrap();
    assert_eq!(store.snapshot().unwrap().unwrap(), current);
}

#[test]
fn recomputing_an_editable_checksum_does_not_authorize_an_unsigned_descriptor() {
    let (_temporary, store) = setup();
    let previous = activate_a(&store);
    let (bytes, signature) = fixture("a");
    let mut descriptor: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    descriptor["hubVersion"] = "99.0.0".into();
    let forged = serde_json::to_vec(&descriptor).unwrap();
    let descriptor_id = digest(&forged);
    let path = store.root.join("descriptors").join(&descriptor_id);
    fs::create_dir(&path).unwrap();
    fs::write(path.join("runtime.json"), forged).unwrap();
    fs::write(path.join("runtime.minisig"), signature).unwrap();
    let mut receipt: Receipt = serde_json::from_slice(&previous).unwrap();
    receipt.descriptor_sha256 = descriptor_id;
    assert!(store
        .resolve_receipt(&serde_json::to_vec(&receipt).unwrap())
        .err()
        .unwrap()
        .contains("signature verification failed"));
    assert_eq!(store.snapshot().unwrap().unwrap(), previous);
}

#[test]
fn forged_receipts_changed_descriptors_and_untrusted_keys_cannot_authorize_bytes() {
    let (_temporary, store) = setup();
    let previous = activate_a(&store);
    let mut receipt: serde_json::Value = serde_json::from_slice(&previous).unwrap();
    receipt["generation"] = "../escape".into();
    assert!(store
        .resolve_receipt(&serde_json::to_vec(&receipt).unwrap())
        .is_err());
    receipt["generation"] = "a".repeat(64).into();
    assert!(store
        .resolve_receipt(&serde_json::to_vec(&receipt).unwrap())
        .is_err());
    receipt["unexpected"] = true.into();
    assert!(store
        .resolve_receipt(&serde_json::to_vec(&receipt).unwrap())
        .is_err());
    let receipt: Receipt = serde_json::from_slice(&previous).unwrap();
    let path = store
        .root
        .join("descriptors")
        .join(&receipt.descriptor_sha256)
        .join("runtime.json");
    fs::write(path, b"{}").unwrap();
    assert!(store.resolve().is_err());
    let (bytes, signature) = fixture("a");
    let release_key = PublicKey::decode(KEY).unwrap();
    let production =
        Store::new(store.root.parent().unwrap().parent().unwrap(), release_key).unwrap();
    assert!(production.descriptor(&bytes, &signature).is_err());
}

#[test]
fn bounded_records_and_invalid_roots_fail_without_creating_a_route() {
    assert!(Store::new(Path::new("relative"), PublicKey::decode(KEY).unwrap()).is_err());
    let (_temporary, store) = setup();
    private_dir(&store.root).unwrap();
    fs::write(
        store.root.join("active.json"),
        vec![b' '; MAX_RECEIPT as usize + 1],
    )
    .unwrap();
    assert!(store.snapshot().is_err());
    let (bytes, signature) = stage(&store, "a");
    assert!(store.activate(&bytes, &signature, None).is_err());
    assert_eq!(
        fs::metadata(store.root.join("active.json")).unwrap().len(),
        MAX_RECEIPT + 1
    );
}

#[test]
fn retained_backup_corruption_blocks_activation_and_preserves_the_active_route() {
    let (_temporary, store) = setup();
    let previous = activate_a(&store);
    let history = store.root.join("history");
    fs::create_dir_all(&history).unwrap();
    fs::write(
        history.join(format!("{}.json", digest(&previous))),
        b"corrupted",
    )
    .unwrap();
    let (bytes, signature) = stage(&store, "b");
    assert!(store.activate(&bytes, &signature, Some(&previous)).is_err());
    assert_eq!(store.snapshot().unwrap().unwrap(), previous);
}

#[test]
fn concurrent_activation_is_refused_and_lock_is_released_after_failure() {
    let (_temporary, store) = setup();
    let previous = activate_a(&store);
    let (bytes, signature) = stage(&store, "b");
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .open(store.root.join("activate.lock"))
        .unwrap();
    lock.try_lock_exclusive().unwrap();
    assert!(store.activate(&bytes, &signature, Some(&previous)).is_err());
    FileExt::unlock(&lock).unwrap();
    assert!(store
        .activate_with(&bytes, &signature, Some(&previous), |_| Err("stop".into()))
        .is_err());
    store.activate(&bytes, &signature, Some(&previous)).unwrap();
}

#[cfg(windows)]
#[test]
fn verified_payload_is_write_delete_locked_until_the_runtime_lease_ends() {
    let (_temporary, store) = setup();
    activate_a(&store);
    let runtime = store.resolve().unwrap();
    let path = runtime.server.clone();
    assert!(fs::write(&path, b"tampered").is_err());
    assert!(fs::remove_file(&path).is_err());
    drop(runtime);
    fs::write(path, b"tampered").unwrap();
    assert!(store.resolve().is_err());
}

#[cfg(windows)]
#[test]
fn verified_payload_parent_paths_cannot_be_renamed_during_the_runtime_lease() {
    let (_temporary, store) = setup();
    activate_a(&store);
    let runtime = store.resolve().unwrap();
    let parent = runtime.server.parent().unwrap().to_path_buf();
    let moved = parent.with_file_name("server-moved");
    let renamed = fs::rename(&parent, &moved);
    if renamed.is_ok() {
        fs::rename(&moved, &parent).unwrap();
    }
    assert!(
        renamed.is_err(),
        "A verified runtime's parent path remained replaceable"
    );
    drop(runtime);
    fs::rename(parent, moved).unwrap();
}

#[cfg(windows)]
#[test]
fn routing_storage_junction_is_rejected_without_writing_to_its_target() {
    let (temporary, store) = setup();
    let (bytes, signature) = stage(&store, "a");
    let outside = temporary.path().join("outside");
    fs::create_dir(&outside).unwrap();
    let link = store.root.parent().unwrap();
    let result = Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(link)
        .arg(&outside)
        .output()
        .unwrap();
    assert!(result.status.success());
    assert!(store.snapshot().is_err());
    assert!(store.activate(&bytes, &signature, None).is_err());
    assert_eq!(fs::read_dir(outside).unwrap().count(), 0);
    fs::remove_dir(link).unwrap();
}

#[cfg(unix)]
#[test]
fn unix_execution_does_not_silently_replace_missing_payload_binding_with_advisory_locks() {
    let (_temporary, store) = setup();
    activate_a(&store);
    assert!(store
        .resolve()
        .unwrap()
        .run()
        .err()
        .unwrap()
        .contains("payload binding acceptance"));
}

#[cfg(unix)]
#[test]
fn linked_receipts_and_payloads_refuse_without_following_the_link() {
    use std::os::unix::fs::symlink;
    let (_temporary, store) = setup();
    let previous = activate_a(&store);
    let runtime = store.resolve().unwrap();
    drop(runtime);
    let path = store.root.join("active.json");
    let target = store.root.join("original.json");
    fs::rename(&path, &target).unwrap();
    symlink(&target, &path).unwrap();
    assert!(store.snapshot().is_err());
    assert_eq!(fs::read(target).unwrap(), previous);
}
