//! Read-only native metadata. The caller owns native-path validation, a read-only
//! file reservation, byte/identity snapshots and retirement authorization.
use std::{
    marker::PhantomData,
    os::windows::ffi::OsStrExt,
    path::{Component, Path, Prefix},
    rc::Rc,
};
use windows::{
    core::{Interface, HRESULT, PCWSTR},
    Win32::{
        Foundation::{MAX_PATH, RPC_E_CHANGED_MODE, S_FALSE, S_OK},
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
            COINIT_APARTMENTTHREADED, STGM_READ, STGM_SHARE_DENY_WRITE,
        },
        UI::Shell::{IShellLinkW, ShellLink, SLGP_RAWPATH},
    },
};

const PATH_UNITS: usize = MAX_PATH as usize;
const ARGUMENT_UNITS: usize = 4097;
const UNWRITTEN: u16 = 0xffff;

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Routing {
    pub(super) target: String,
    pub(super) arguments: String,
    pub(super) working_directory: String,
}

fn failure(stage: &str, status: HRESULT) -> String {
    format!(
        "Native shortcut {stage} failed (HRESULT 0x{:08x}); preserve it.",
        status.0 as u32
    )
}

fn initialized(status: HRESULT) -> Result<(), String> {
    if status == S_OK || status == S_FALSE {
        Ok(())
    } else if status == RPC_E_CHANGED_MODE {
        Err("Native shortcut COM apartment mismatch (HRESULT 0x80010106); preserve it.".into())
    } else {
        Err(failure("CoInitializeEx", status))
    }
}

// Not Send/Sync: every successful initialization, including S_FALSE, must be
// balanced on the same thread, after all acquired COM interfaces are released.
struct Apartment(PhantomData<Rc<()>>);

impl Apartment {
    fn enter() -> Result<Self, String> {
        initialized(unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) })?;
        Ok(Self(PhantomData))
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

fn filename(path: &Path) -> Result<Vec<u16>, String> {
    if !path.is_absolute()
        || !matches!(path.components().next(), Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::Disk(_)))
        || path.components().any(|part| part == Component::ParentDir)
    {
        return Err(
            "Native shortcut load requires an absolute local-drive path; preserve it.".into(),
        );
    }
    let mut wide: Vec<_> = path.as_os_str().encode_wide().collect();
    if wide.len() >= 32768 || wide.contains(&0) || String::from_utf16(&wide).is_err() {
        return Err(
            "Native shortcut filename is oversized or invalid Unicode/NUL; preserve it.".into(),
        );
    }
    wide.push(0);
    Ok(wide)
}

fn text(buffer: &[u16], field: &str) -> Result<String, String> {
    let end = buffer
        .iter()
        .position(|unit| *unit == 0)
        .ok_or_else(|| format!("Native shortcut {field} has no NUL terminator; preserve it."))?;
    // GetArguments can silently truncate. A terminator at the last slot does
    // not prove completeness; conservatively refuse even an exact-size string.
    if end + 1 >= buffer.len() {
        return Err(format!(
            "Native shortcut {field} reaches its buffer boundary; preserve it."
        ));
    }
    let value = String::from_utf16(&buffer[..end])
        .map_err(|_| format!("Native shortcut {field} is invalid Unicode; preserve it."))?;
    if value.chars().any(char::is_control) {
        return Err(format!(
            "Native shortcut {field} contains control characters; preserve it."
        ));
    }
    Ok(value)
}

// Microsoft: GetPath(SLGP_RAWPATH) may return an absent/unexpanded raw target.
// https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ishelllinkw-getpath
// Load is initialization, not a user File Open operation; request explicit read sharing.
// https://learn.microsoft.com/en-us/windows/win32/api/objidl/nf-objidl-ipersistfile-load
pub(super) fn read(path: &Path) -> Result<Routing, String> {
    let path = filename(path)?;
    #[cfg(test)]
    eprintln!("native ShellLink read: before-CoInitializeEx");
    let _apartment = Apartment::enter()?;
    #[cfg(test)]
    eprintln!("native ShellLink read: before-CoCreateInstance");
    let link: IShellLinkW = unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }
        .map_err(|error| failure("CoCreateInstance(ShellLink)", error.code()))?;
    let persisted: IPersistFile = link
        .cast()
        .map_err(|error| failure("QueryInterface(IPersistFile)", error.code()))?;
    #[cfg(test)]
    eprintln!("native ShellLink read: before-Load");
    unsafe { persisted.Load(PCWSTR(path.as_ptr()), STGM_READ | STGM_SHARE_DENY_WRITE) }
        .map_err(|error| failure("IPersistFile::Load", error.code()))?;
    let mut target = [UNWRITTEN; PATH_UNITS];
    let mut arguments = [UNWRITTEN; ARGUMENT_UNITS];
    let mut working_directory = [UNWRITTEN; PATH_UNITS];
    // The 0.61.3 typed binding takes a raw pointer, not Option. Null is the
    // documented no-find-data request; no target stat or resolution is requested.
    unsafe { link.GetPath(&mut target, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32) }
        .map_err(|error| failure("IShellLinkW::GetPath", error.code()))?;
    unsafe { link.GetArguments(&mut arguments) }
        .map_err(|error| failure("IShellLinkW::GetArguments", error.code()))?;
    unsafe { link.GetWorkingDirectory(&mut working_directory) }
        .map_err(|error| failure("IShellLinkW::GetWorkingDirectory", error.code()))?;
    let target = text(&target, "target")?;
    // GetPath maps S_FALSE to Ok in this binding; its documented empty result
    // cannot establish routing and must not become a successful snapshot.
    if target.is_empty() {
        return Err("Native shortcut has no raw filesystem target; preserve it.".into());
    }
    let routing = Routing {
        target,
        arguments: text(&arguments, "arguments")?,
        working_directory: text(&working_directory, "working directory")?,
    };
    #[cfg(test)]
    eprintln!("native ShellLink read: metadata-complete");
    Ok(routing)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs::{self, File, OpenOptions},
        io::Write,
        os::windows::fs::OpenOptionsExt,
        time::Instant,
    };
    use windows::Win32::{Foundation::E_FAIL, System::Com::COINIT_MULTITHREADED};

    fn fixture(path: &Path, target: &Path, arguments: &str, working_directory: &Path) {
        assert!(!path.exists());
        eprintln!("native fixture: before-CoInitializeEx");
        let _apartment = Apartment::enter().unwrap();
        eprintln!("native fixture: before-CoCreateInstance");
        let link: IShellLinkW =
            unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }.unwrap();
        let target = filename(target).unwrap();
        let workdir = filename(working_directory).unwrap();
        let arguments: Vec<_> = arguments.encode_utf16().chain([0]).collect();
        // All setters and Save are confined to new owned temporary fixtures.
        unsafe {
            link.SetPath(PCWSTR(target.as_ptr())).unwrap();
            link.SetArguments(PCWSTR(arguments.as_ptr())).unwrap();
            link.SetWorkingDirectory(PCWSTR(workdir.as_ptr())).unwrap();
        }
        let persisted: IPersistFile = link.cast().unwrap();
        let path = filename(path).unwrap();
        eprintln!("native fixture: before-Save");
        unsafe { persisted.Save(PCWSTR(path.as_ptr()), true) }.unwrap();
        eprintln!("native fixture: saved");
    }

    fn reserve(path: &Path) -> File {
        OpenOptions::new()
            .read(true)
            .share_mode(1)
            .custom_flags(0x00200000)
            .open(path)
            .unwrap()
    }

    fn identity(file: &File) -> (u64, std::time::SystemTime, std::time::SystemTime) {
        let metadata = file.metadata().unwrap();
        (
            metadata.len(),
            metadata.created().unwrap(),
            metadata.modified().unwrap(),
        )
    }

    #[test]
    fn native_owned_fixture_absent_and_present_target_under_readonly_reservation() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("fixtur\u{00e9} with spaces.lnk");
        let target = root.path().join("fixture gu\u{00ed}.exe");
        let marker = b"Owned marker only; not an executable.\r\n";
        fixture(&path, &target, "", root.path());
        let reserved = reserve(&path);
        let before = fs::read(&path).unwrap();
        let before_identity = identity(&reserved);
        for present in [false, true] {
            if present {
                OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&target)
                    .unwrap()
                    .write_all(marker)
                    .unwrap();
            }
            assert_eq!(target.exists(), present);
            assert!(OpenOptions::new().write(true).open(&path).is_err());
            assert!(fs::rename(&path, path.with_extension("moved")).is_err());
            let started = Instant::now();
            let routing = read(&path).unwrap();
            eprintln!(
                "native fixture target_exists={present}: result=ok elapsed_us={}",
                started.elapsed().as_micros()
            );
            assert_eq!(
                routing,
                Routing {
                    target: target.to_str().unwrap().into(),
                    arguments: String::new(),
                    working_directory: root.path().to_str().unwrap().into(),
                }
            );
            assert_eq!(fs::read(&path).unwrap(), before);
            assert_eq!(identity(&reserved), before_identity);
            if present {
                assert_eq!(fs::read(&target).unwrap(), marker);
            }
        }
        drop(reserved);
    }

    #[test]
    fn native_extractor_reports_custom_metadata_without_authorizing_it() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("custom.lnk");
        let target = root.path().join("foreign.exe");
        let workdir = root.path().join("custom workdir");
        fs::create_dir(&workdir).unwrap();
        fixture(&path, &target, "--fixture \u{03a9}", &workdir);
        let _reservation = reserve(&path);
        let routing = read(&path).unwrap();
        assert_eq!(routing.target, target.to_str().unwrap());
        assert_eq!(routing.arguments, "--fixture \u{03a9}");
        assert_eq!(routing.working_directory, workdir.to_str().unwrap());
    }

    #[test]
    fn native_missing_and_malformed_links_refuse_without_writing() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("missing.lnk");
        assert!(read(&missing).unwrap_err().contains("IPersistFile::Load"));
        assert!(!missing.exists());
        let malformed = root.path().join("malformed.lnk");
        fs::write(&malformed, b"not a Shell Link").unwrap();
        let reserved = reserve(&malformed);
        let before = fs::read(&malformed).unwrap();
        let before_identity = identity(&reserved);
        assert!(read(&malformed).is_err());
        assert_eq!(fs::read(&malformed).unwrap(), before);
        assert_eq!(identity(&reserved), before_identity);
    }

    #[test]
    fn native_oversized_arguments_refuse_silent_truncation() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("long arguments.lnk");
        fixture(
            &path,
            &root.path().join("absent.exe"),
            &"x".repeat(ARGUMENT_UNITS + 100),
            root.path(),
        );
        let _reservation = reserve(&path);
        assert!(read(&path).unwrap_err().contains("buffer boundary"));
    }

    #[test]
    fn buffers_refuse_unwritten_truncated_invalid_unicode_and_controls() {
        assert_eq!(text(&[0, UNWRITTEN], "arguments").unwrap(), "");
        assert_eq!(text(&[0x03a9, 0, UNWRITTEN], "target").unwrap(), "\u{03a9}");
        for buffer in [
            &[][..],
            &[UNWRITTEN, UNWRITTEN],
            &[65, 0],
            &[0xd800, 0, UNWRITTEN],
            &[9, 0, UNWRITTEN],
        ] {
            assert!(text(buffer, "fixture").is_err());
        }
    }

    #[test]
    fn input_paths_refuse_nonlocal_relative_nul_invalid_unicode_and_oversize() {
        use std::os::windows::ffi::OsStringExt;
        for path in [
            r"relative.lnk",
            r"C:relative.lnk",
            r"\\host\share\fixture.lnk",
            r"\\?\C:\fixture.lnk",
            r"C:\fixture\..\other.lnk",
            "C:\\fixture\0.lnk",
        ] {
            assert!(filename(Path::new(path)).is_err());
        }
        let invalid = std::ffi::OsString::from_wide(&[67, 58, 92, 0xd800]);
        assert!(filename(Path::new(&invalid)).is_err());
        assert!(filename(Path::new(&format!("C:\\{}", "x".repeat(32768)))).is_err());
    }

    #[test]
    fn apartment_initialization_classifies_success_and_refuses_mismatch() {
        assert!(initialized(S_OK).is_ok());
        assert!(initialized(S_FALSE).is_ok());
        assert!(initialized(RPC_E_CHANGED_MODE)
            .unwrap_err()
            .contains("apartment mismatch"));
        assert!(initialized(E_FAIL).unwrap_err().contains("0x80004005"));
    }

    #[test]
    fn native_apartment_balance_survives_load_error_and_mismatch() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("missing.lnk");
        let sta = Apartment::enter().unwrap();
        assert!(read(&missing).unwrap_err().contains("IPersistFile::Load"));
        assert_eq!(
            unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) },
            RPC_E_CHANGED_MODE
        );
        drop(sta);
        initialized(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }).unwrap();
        let mta = Apartment(PhantomData);
        assert!(read(&missing).unwrap_err().contains("apartment mismatch"));
        assert_eq!(
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) },
            RPC_E_CHANGED_MODE
        );
        drop(mta);
        assert!(Apartment::enter().is_ok());
    }

    #[test]
    fn source_contract_has_no_production_mutation_resolution_or_fallback() {
        let source = include_str!("legacy_shortcut_native_windows.rs");
        let production = source.split("mod tests {").next().unwrap();
        assert!(production.contains("STGM_READ | STGM_SHARE_DENY_WRITE"));
        assert!(production.contains("SLGP_RAWPATH.0"));
        assert!(production.contains("GetPath(&mut target, std::ptr::null_mut()"));
        assert!(production.contains("CLSCTX_INPROC_SERVER"));
        for forbidden in [
            ".Save(",
            ".SaveCompleted(",
            ".Resolve(",
            ".SetPath(",
            ".SetArguments(",
            ".SetWorkingDirectory(",
            "ShellExecute",
            "WScript.",
            "powershell",
            "std::process",
            "thread::",
            "CLSCTX_LOCAL_SERVER",
            "CLSCTX_REMOTE_SERVER",
            "SLGP_UNCPRIORITY",
            ".canonicalize(",
            ".exists(",
        ] {
            assert!(!production.contains(forbidden), "{forbidden}");
        }
    }
}
