use serde::Deserialize;
use std::{
    fs::{self, File},
    io::Read,
    os::windows::fs::MetadataExt,
    path::{Component, Path, PathBuf, Prefix},
};
use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, FILE_ATTRIBUTE_REPARSE_POINT};

const MAX_REGISTRY_BYTES: usize = 2 * 1024 * 1024;
const MAX_EDITORS: usize = 128;
const DRIVE_FIXED: u32 = 3;

#[derive(Deserialize)]
struct Entry {
    version: String,
    location: PathBuf,
}

#[derive(Deserialize)]
struct Registry {
    schema_version: u32,
    data: Vec<Entry>,
}

fn local_disk_path(path: &Path) -> bool {
    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return false;
    };
    let Prefix::Disk(drive) = prefix.kind() else {
        return false;
    };
    if components.next() != Some(Component::RootDir)
        || !components.all(
            |part| matches!(part, Component::Normal(name) if !name.to_string_lossy().contains(':')),
        )
    {
        return false;
    }
    let root = [u16::from(drive), b':' as u16, b'\\' as u16, 0];
    // Do not follow configuration paths onto network mounts or device namespaces.
    (unsafe { GetDriveTypeW(root.as_ptr()) }) == DRIVE_FIXED
}

fn has_plain_ancestors(path: &Path) -> bool {
    local_disk_path(path)
        && path
            .ancestors()
            .filter(|ancestor| ancestor.is_absolute())
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .all(|ancestor| {
                fs::symlink_metadata(ancestor)
                    .is_ok_and(|meta| meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0)
            })
}

fn read_registry(path: &Path) -> Option<Vec<u8>> {
    if !has_plain_ancestors(path) || !path.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    File::open(path)
        .ok()?
        .take((MAX_REGISTRY_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() <= MAX_REGISTRY_BYTES).then_some(bytes)
}

fn editor_root(entry: Entry) -> Option<PathBuf> {
    crate::repair::unity_version(&entry.version)?;
    let root = if entry
        .location
        .file_name()?
        .eq_ignore_ascii_case("Unity.exe")
    {
        let editor = entry.location.parent()?;
        if !editor.file_name()?.eq_ignore_ascii_case("Editor") {
            return None;
        }
        editor.parent()?.to_path_buf()
    } else {
        entry.location
    };
    if root.file_name()?.to_str()? != entry.version {
        return None;
    }
    let executable = root.join("Editor/Unity.exe");
    (has_plain_ancestors(&executable) && executable.is_file()).then_some(root)
}

pub(crate) fn registered_roots(config: &Path) -> Vec<PathBuf> {
    let current = read_registry(&config.join("editors-v2.json"))
        .and_then(|bytes| serde_json::from_slice::<Registry>(&bytes).ok())
        .filter(|registry| registry.schema_version == 2)
        .map(|registry| registry.data)
        .unwrap_or_default();
    let legacy = read_registry(&config.join("editors.json"))
        .and_then(|bytes| serde_json::from_slice::<Vec<Entry>>(&bytes).ok())
        .unwrap_or_default();
    let mut roots = Vec::new();
    for entry in current
        .into_iter()
        .take(MAX_EDITORS)
        .chain(legacy.into_iter().take(MAX_EDITORS))
    {
        if let Some(root) = editor_root(entry) {
            if !roots.contains(&root) {
                roots.push(root);
            }
        }
    }
    roots
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn custom_registered_editors_are_discovered_without_an_override() {
        let fixture = tempfile::tempdir().unwrap();
        let config = fixture.path().join("UnityHub");
        fs::create_dir(&config).unwrap();
        let root = fixture.path().join("Unity Editors/6000.3.21f1");
        let exe = root.join("Editor/Unity.exe");
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::write(&exe, b"discovery fixture only").unwrap();
        let current = config.join("editors-v2.json");
        let legacy = config.join("editors.json");
        fs::write(
            &current,
            json!({"schema_version":2,"data":[
                {"version":"6000.3.21f1","location":exe},
                {"version":"6000.3.22f1","location":exe},
                {"version":"6000.3.21f1","location":"C:6000.3.21f1"},
                {"version":"6000.3.21f1","location":root.join("..").join("6000.3.21f1")}
            ]})
            .to_string(),
        )
        .unwrap();
        assert_eq!(registered_roots(&config), vec![root.clone()]);
        fs::write(
            &legacy,
            json!([{"version":"6000.3.21f1","location":root}]).to_string(),
        )
        .unwrap();
        assert_eq!(registered_roots(&config), vec![root.clone()]);
        fs::write(&current, b"{").unwrap();
        assert_eq!(registered_roots(&config), vec![root]);
        fs::remove_file(exe).unwrap();
        assert!(registered_roots(&config).is_empty());
    }
}
