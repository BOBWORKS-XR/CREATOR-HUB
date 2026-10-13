//! Build-only unsigned transfer; no signature, activation, or payload execution.
#[path = "../../../src-tauri/src/module_archive.rs"]
mod archive;
mod files;
use files::{error, Held, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
};

const MAX_METADATA: u64 = 128 * 1024;
const MAX_FILE: u64 = 256 * 1024 * 1024;
const MAX_TOTAL: u64 = 512 * 1024 * 1024;
const NAMES: [&str; 13] = [
    "builtin-manifest.json",
    "mcp-runtime.json",
    "router-for-package",
    "modules/setup/creator-project-setup",
    "modules/mcp/creator-works-mcp-launcher",
    "modules/mcp/server/creator-works-mcp.mjs",
    "modules/mcp/server/runtime/node",
    "modules/mcp/server/runtime/LICENSE",
    "modules/mcp/server/runtime/VERSION",
    "modules/mcp/server/unity-extension/Editor/BanterMCPBridge.cs",
    "modules/mcp/server/unity-extension/Editor/CreatorWorksMCPLogo.png",
    "modules/mcp/server/LICENSE",
    "modules/mcp/server/THIRD_PARTY_NOTICES.md",
];
fn mode(name: &str) -> u32 {
    if matches!(
        name,
        "router-for-package"
            | "modules/setup/creator-project-setup"
            | "modules/mcp/creator-works-mcp-launcher"
            | "modules/mcp/server/runtime/node"
    ) {
        0o755
    } else {
        0o644
    }
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

// Map deserialization must not silently replace duplicate file records.
fn unique<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> std::result::Result<BTreeMap<String, T>, D::Error> {
    struct Visitor<T>(std::marker::PhantomData<T>);
    impl<'de, T: Deserialize<'de>> serde::de::Visitor<'de> for Visitor<T> {
        type Value = BTreeMap<String, T>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("unique file records")
        }
        fn visit_map<A: serde::de::MapAccess<'de>>(
            self,
            mut a: A,
        ) -> std::result::Result<Self::Value, A::Error> {
            let mut result = BTreeMap::new();
            while let Some((k, v)) = a.next_entry::<String, T>()? {
                if result.insert(k, v).is_some() {
                    return Err(serde::de::Error::custom("Duplicate file record."));
                }
            }
            Ok(result)
        }
    }
    d.deserialize_map(Visitor(std::marker::PhantomData))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Prepared {
    schema_version: u32,
    product: String,
    hub_version: String,
    platform: String,
    arch: String,
    rust_target: String,
    mcp_mode: String,
    compiled_flags: Flags,
    source: Source,
    #[serde(deserialize_with = "unique")]
    files: BTreeMap<String, Record>,
    unsigned: bool,
    private_key_included: bool,
    native_gui_tested: bool,
    native_consent_tested: bool,
    release_ready: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Flags {
    internal_module: bool,
    experimental_unix_hosting: bool,
    host_writable: bool,
    read_only_events: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Source {
    repository: String,
    repository_id: u64,
    workflow: String,
    event: String,
    source_commit: String,
    build_commit: String,
    source_tree: String,
    run_id: u64,
    run_attempt: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    sha256: String,
    size: u64,
    mode: u32,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    schema_version: u32,
    file: String,
    sha256: String,
    size: u64,
    unpacked_size: u64,
    #[serde(deserialize_with = "unique")]
    files: BTreeMap<String, MemberRecord>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct MemberRecord {
    size: u64,
    mode: u32,
}

impl Prepared {
    fn expected(&self) -> Result<BTreeMap<String, (String, u32)>> {
        let s = &self.source;
        let v = semver::Version::parse(&self.hub_version).map_err(error)?;
        if self.schema_version != 1
            || self.product != "com.creatorworks.hub.unix-managed-preparation"
            || !matches!(self.platform.as_str(), "linux" | "macos")
            || !matches!(self.arch.as_str(), "x86_64" | "aarch64")
            || self.rust_target
                != format!(
                    "{}-{}",
                    self.arch,
                    if self.platform == "macos" {
                        "apple-darwin"
                    } else {
                        "unknown-linux-gnu"
                    }
                )
            || v.to_string() != self.hub_version
            || !v.build.is_empty()
            || self.mcp_mode != "writable"
            || !(self.compiled_flags.internal_module
                && self.compiled_flags.experimental_unix_hosting
                && self.compiled_flags.host_writable
                && self.compiled_flags.read_only_events)
            || !self.unsigned
            || self.private_key_included
            || self.native_gui_tested
            || self.native_consent_tested
            || self.release_ready
            || s.repository != "BOBWORKS-XR/CREATOR-HUB"
            || s.repository_id != 1364807512
            || s.workflow != ".github/workflows/unix-managed-payload.yml"
            || !matches!(s.event.as_str(), "push" | "workflow_dispatch")
            || !hex(&s.source_commit, 40)
            || s.build_commit != s.source_commit
            || !hex(&s.source_tree, 40)
            || s.run_id == 0
            || s.run_attempt == 0
            || s.run_id > 9007199254740991
            || s.run_attempt > 9007199254740991
            || self
                .files
                .keys()
                .map(String::as_str)
                .collect::<BTreeSet<_>>()
                != BTreeSet::from(NAMES)
        {
            return Err("Unsupported preparation identity, flags, claims or file set.".into());
        }
        let mut total = 0u64;
        for (name, r) in &self.files {
            total = total.checked_add(r.size).ok_or("Size overflow.")?;
            if !hex(&r.sha256, 64) || r.size == 0 || r.size > MAX_FILE || r.mode != mode(name) {
                return Err("Invalid prepared hash, size or mode.".into());
            }
        }
        if total > MAX_TOTAL {
            return Err("Oversized total payload.".into());
        }
        Ok(self
            .files
            .iter()
            .map(|(n, r)| (n.clone(), (r.sha256.clone(), r.mode)))
            .collect())
    }
}

fn metadata<T: serde::de::DeserializeOwned>(path: &Path) -> Result<(Vec<u8>, T, Held)> {
    let mut held = Held::open(path, MAX_METADATA, None)?;
    let bytes = held.read(MAX_METADATA)?;
    let parsed = serde_json::from_slice(&bytes).map_err(error)?;
    Ok((bytes, parsed, held))
}
fn checked_binding(p: &Prepared, b: &Binding) -> Result<archive::Binding> {
    if b.files.len() != p.files.len()
        || b.files.iter().any(|(n, r)| {
            p.files
                .get(n)
                .is_none_or(|expected| r.size != expected.size || r.mode != expected.mode)
        })
    {
        return Err("Transfer binding differs from prepared sizes/modes.".into());
    }
    let core: archive::Binding =
        serde_json::from_value(serde_json::to_value(b).map_err(error)?).map_err(error)?;
    core.validate(&p.expected()?)?;
    Ok(core)
}
fn inventory(root: &Path) -> Result<BTreeSet<String>> {
    files::ancestors(root)?;
    let allowed = NAMES
        .into_iter()
        .chain(["prepared-unix.json"])
        .collect::<BTreeSet<_>>();
    let directories = allowed
        .iter()
        .flat_map(|n| {
            Path::new(n)
                .ancestors()
                .skip(1)
                .filter(|p| !p.as_os_str().is_empty())
                .map(|p| p.to_string_lossy().replace('\\', "/"))
        })
        .collect::<BTreeSet<_>>();
    fn visit(
        root: &Path,
        at: &Path,
        dirs: &BTreeSet<String>,
        allowed: &BTreeSet<&str>,
        found: &mut BTreeSet<String>,
    ) -> Result<()> {
        for item in fs::read_dir(at).map_err(error)? {
            let item = item.map_err(error)?;
            let name = item
                .path()
                .strip_prefix(root)
                .map_err(error)?
                .to_string_lossy()
                .replace('\\', "/");
            files::ancestors(&item.path())?;
            if item.file_type().map_err(error)?.is_dir() {
                if !dirs.contains(&name) {
                    return Err("Unlisted prepared directory.".into());
                }
                visit(root, &item.path(), dirs, allowed, found)?;
            } else if !allowed.contains(name.as_str()) || !found.insert(name) {
                return Err("Unlisted or duplicate prepared file.".into());
            }
        }
        Ok(())
    }
    let mut found = BTreeSet::new();
    visit(root, root, &directories, &allowed, &mut found)?;
    if found.iter().map(String::as_str).collect::<BTreeSet<_>>() != allowed {
        return Err("Incomplete prepared directory.".into());
    }
    Ok(found)
}

fn encode(p: &Prepared, members: &BTreeMap<String, Vec<u8>>) -> Result<(Vec<u8>, Binding)> {
    p.expected()?;
    if members.keys().collect::<Vec<_>>() != p.files.keys().collect::<Vec<_>>() {
        return Err("Incomplete raw member set.".into());
    }
    let gzip = flate2::write::GzEncoder::new(
        Limited {
            bytes: Vec::new(),
            limit: MAX_FILE as usize,
        },
        flate2::Compression::default(),
    );
    let mut tar = tar::Builder::new(gzip);
    for (name, bytes) in members {
        let r = &p.files[name];
        if bytes.len() as u64 != r.size || digest(bytes) != r.sha256 {
            return Err("Raw member differs from preparation.".into());
        }
        let mut h = tar::Header::new_ustar();
        h.set_path(name).map_err(error)?;
        h.set_mode(r.mode);
        h.set_uid(0);
        h.set_gid(0);
        h.set_mtime(0);
        h.set_size(r.size);
        h.set_entry_type(tar::EntryType::Regular);
        h.set_cksum();
        tar.append(&h, bytes.as_slice()).map_err(error)?;
    }
    let bytes = tar
        .into_inner()
        .map_err(error)?
        .finish()
        .map_err(error)?
        .bytes;
    let binding = Binding {
        schema_version: 1,
        file: "modules.tar.gz".into(),
        sha256: digest(&bytes),
        size: bytes.len() as u64,
        unpacked_size: p.files.values().map(|r| r.size).sum(),
        files: p
            .files
            .iter()
            .map(|(n, r)| {
                (
                    n.clone(),
                    MemberRecord {
                        size: r.size,
                        mode: r.mode,
                    },
                )
            })
            .collect(),
    };
    archive::decode(&bytes, &checked_binding(p, &binding)?, &p.expected()?)?;
    Ok((bytes, binding))
}
struct Limited {
    bytes: Vec<u8>,
    limit: usize,
}
impl Write for Limited {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self
            .bytes
            .len()
            .checked_add(bytes.len())
            .is_none_or(|size| size > self.limit)
        {
            return Err(std::io::Error::other(
                "Compressed transfer exceeds its bound.",
            ));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    files::ancestors(path)?;
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(error)?;
    f.write_all(bytes).map_err(error)?;
    f.sync_all().map_err(error)
}
fn pack(root: &Path, output: &Path) -> Result<()> {
    if !cfg!(unix) {
        return Err(
            "Packing requires native Unix mode capture; Windows may verify/extract only.".into(),
        );
    }
    inventory(root)?;
    let (prepared, p, receipt) = metadata::<Prepared>(&root.join("prepared-unix.json"))?;
    p.expected()?;
    let mut held = vec![receipt];
    let mut members = BTreeMap::new();
    for (name, r) in &p.files {
        let mut input = Held::open(&root.join(name), MAX_FILE, Some(r.mode))?;
        members.insert(name.clone(), input.read(r.size)?);
        held.push(input);
    }
    let (bytes, binding) = encode(&p, &members)?;
    inventory(root)?;
    for file in &held {
        file.recheck()?;
    }
    files::new_directory(output)?;
    write_new(&output.join("modules.tar.gz"), &bytes)?;
    write_new(
        &output.join("transfer-binding.json"),
        &serde_json::to_vec_pretty(&binding).map_err(error)?,
    )?;
    write_new(&output.join("prepared-unix.json"), &prepared)
}
fn verify(
    file: &Path,
    prepared: &Path,
    binding: &Path,
) -> Result<(archive::Snapshot, Vec<u8>, Prepared)> {
    let (receipt, p, receipt_file) = metadata::<Prepared>(prepared)?;
    let (_, b, binding_file) = metadata::<Binding>(binding)?;
    let core = checked_binding(&p, &b)?;
    let archive_file = Held::open(file, MAX_FILE, None)?;
    let snapshot = archive::read(file, &core, &p.expected()?)?;
    for held in [archive_file, receipt_file, binding_file] {
        held.recheck()?;
    }
    Ok((snapshot, receipt, p))
}
fn extract(file: &Path, prepared: &Path, binding: &Path, output: &Path) -> Result<()> {
    let (mut snapshot, receipt, _) = verify(file, prepared, binding)?;
    files::new_directory(output)?;
    snapshot.0.insert(
        "prepared-unix.json".into(),
        archive::Member {
            bytes: receipt,
            mode: 0o644,
        },
    );
    for name in snapshot.0.keys() {
        let target = output.join(name);
        files::ancestors(&target)?;
        fs::create_dir_all(target.parent().ok_or("Missing parent.")?).map_err(error)?;
        files::ancestors(&target)?;
        snapshot.write(name, &target)?;
    }
    Ok(())
}
fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let paths = args.iter().skip(1).map(PathBuf::from).collect::<Vec<_>>();
    match args.first().map(String::as_str) {
        Some("pack") if paths.len() == 2 => pack(&paths[0], &paths[1])?,
        Some("verify") if paths.len() == 3 => { let _ = verify(&paths[0], &paths[1], &paths[2])?; },
        Some("extract") if paths.len() == 4 => extract(&paths[0], &paths[1], &paths[2], &paths[3])?,
        _ => return Err("Use pack PREPARED_DIR NEW_DIR, verify ARCHIVE PREPARED_JSON BINDING_JSON, or extract ARCHIVE PREPARED_JSON BINDING_JSON NEW_DIR; all paths absolute.".into()),
    }
    println!("Unsigned transfer checked. No payload execution, signing, activation or release acceptance.");
    Ok(())
}
#[cfg(test)]
mod tests;
