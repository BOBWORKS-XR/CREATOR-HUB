// Build-only consumer: uses the same decoder as Hub, never a general TAR extractor.
#[path = "../../../src-tauri/src/module_archive.rs"]
mod archive;

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io::Read, path::PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    platform: String,
    arch: String,
    modules: BTreeMap<String, Module>,
    #[serde(default)]
    managed_routing: Option<Routing>,
    payload_archive: archive::Binding,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Module {
    executable: String,
    version: String,
    files: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Routing {
    protocol: u32,
    files: BTreeMap<String, String>,
}

fn run() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() < 2
        || !matches!(args[0].as_str(), "verify" | "extract")
        || (args[0] == "verify" && args.len() != 2)
        || (args[0] == "extract" && args.len() != 3)
    {
        return Err(
            "Use verify ARCHIVE or extract ARCHIVE NEW_DIRECTORY with a bound manifest on stdin."
                .into(),
        );
    }
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(65537)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 65536 {
        return Err("Oversized build-bound manifest.".into());
    }
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if manifest.schema_version != 1
        || manifest.platform != "linux"
        || !matches!(manifest.arch.as_str(), "x86_64" | "aarch64")
        || manifest
            .modules
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>()
            != ["mcp", "setup"]
    {
        return Err("Invalid Linux module manifest identity.".into());
    }
    let mut expected = BTreeMap::new();
    for (id, module) in &manifest.modules {
        let executable = format!(
            "{id}/{}",
            if id == "mcp" {
                "creator-works-mcp-launcher"
            } else {
                "creator-project-setup"
            }
        );
        let mut required = vec![executable.clone()];
        if id == "mcp" {
            required.extend(
                [
                    "mcp/server/creator-works-mcp.mjs",
                    "mcp/server/runtime/node",
                    "mcp/server/runtime/LICENSE",
                    "mcp/server/runtime/VERSION",
                    "mcp/server/unity-extension/Editor/BanterMCPBridge.cs",
                    "mcp/server/unity-extension/Editor/CreatorWorksMCPLogo.png",
                    "mcp/server/LICENSE",
                    "mcp/server/THIRD_PARTY_NOTICES.md",
                ]
                .map(str::to_owned),
            );
        }
        required.sort();
        if module.executable != executable
            || semver::Version::parse(&module.version).is_err()
            || module.files.keys().cloned().collect::<Vec<_>>() != required
        {
            return Err("Invalid raw module identity.".into());
        }
        for (name, hash) in &module.files {
            expected.insert(
                name.clone(),
                (
                    hash.clone(),
                    if name == &executable || name == "mcp/server/runtime/node" {
                        0o755
                    } else {
                        0o644
                    },
                ),
            );
        }
    }
    if let Some(routing) = &manifest.managed_routing {
        let names = [
            "routing/creator-hub-mcp-router",
            "routing/router.json",
            "routing/router.minisig",
            "routing/runtime.json",
            "routing/runtime.minisig",
        ];
        if routing.protocol != 1
            || routing.files.keys().map(String::as_str).collect::<Vec<_>>() != names
        {
            return Err("Invalid router protocol.".into());
        }
        for (name, hash) in &routing.files {
            expected.insert(
                name.clone(),
                (
                    hash.clone(),
                    if name == "routing/creator-hub-mcp-router" {
                        0o755
                    } else {
                        0o644
                    },
                ),
            );
        }
    }
    let snapshot = archive::read(
        &PathBuf::from(&args[1]),
        &manifest.payload_archive,
        &expected,
    )?;
    if args[0] == "extract" {
        let root = PathBuf::from(&args[2]);
        if !root.is_absolute() {
            return Err("Extraction requires an absolute new directory.".into());
        }
        for ancestor in root.ancestors() {
            match std::fs::symlink_metadata(ancestor) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err("Redirected extraction ancestor.".into())
                }
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    return Err(error.to_string())
                }
                _ => {}
            }
        }
        std::fs::create_dir(&root).map_err(|e| e.to_string())?;
        for name in snapshot.0.keys() {
            let target = root.join(name);
            std::fs::create_dir_all(target.parent().ok_or("Invalid member directory.")?)
                .map_err(|e| e.to_string())?;
            snapshot.write(name, &target)?;
        }
    }
    let files = snapshot
        .0
        .iter()
        .map(|(name, member)| (name, format!("{:x}", Sha256::digest(&member.bytes))))
        .collect::<BTreeMap<_, _>>();
    println!("{}", serde_json::json!({ "files": files }));
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
