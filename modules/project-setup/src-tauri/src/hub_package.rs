//! Unity Hub's current-user Windows package, separate from its legacy EXE.
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS};
use windows_sys::Win32::Storage::Packaging::Appx::{
    FindPackagesByPackageFamily, PACKAGE_FILTER_HEAD,
};

const FAMILY: &str = "UnityTechnologies.UnityHub_2vrhnee42bhxm";
const APP: &str = "shell:AppsFolder\\UnityTechnologies.UnityHub_2vrhnee42bhxm!UnityHub";

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain([0]).collect()
}

fn package_version(name: &str) -> Option<[u16; 4]> {
    // Windows package full names encode name_version_architecture_resource_publisher.
    let [product, version, _, resource, publisher] = name.split('_').collect::<Vec<_>>()[..] else {
        return None;
    };
    if product != "UnityTechnologies.UnityHub"
        || publisher != "2vrhnee42bhxm"
        || !resource.is_empty()
    {
        return None;
    }
    version
        .split('.')
        .map(str::parse::<u16>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?
        .try_into()
        .ok()
}

pub(crate) fn version() -> Option<String> {
    let family = wide(FAMILY);
    let (mut count, mut length) = (0, 0);
    let result = unsafe {
        FindPackagesByPackageFamily(
            family.as_ptr(),
            PACKAGE_FILTER_HEAD,
            &mut count,
            null_mut(),
            &mut length,
            null_mut(),
            null_mut(),
        )
    };
    if result != ERROR_INSUFFICIENT_BUFFER
        || !(1..=32).contains(&count)
        || !(1..=8192).contains(&length)
    {
        return None;
    }
    let mut names = vec![null_mut(); count as usize];
    let mut buffer = vec![0u16; length as usize];
    let result = unsafe {
        FindPackagesByPackageFamily(
            family.as_ptr(),
            PACKAGE_FILTER_HEAD,
            &mut count,
            names.as_mut_ptr(),
            &mut length,
            buffer.as_mut_ptr(),
            null_mut(),
        )
    };
    if result != ERROR_SUCCESS || count as usize > names.len() || length as usize > buffer.len() {
        return None;
    }
    let version = buffer[..length as usize]
        .split(|unit| *unit == 0)
        .filter_map(|name| package_version(&String::from_utf16(name).ok()?))
        .max()?;
    Some(format!("{}.{}.{}", version[0], version[1], version[2]))
}

pub(crate) fn launch() -> Result<(), String> {
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
    let target = wide(APP);
    // Ask Windows to activate the packaged app; never run an EXE from its changing install path.
    let result = unsafe {
        ShellExecuteW(
            null_mut(),
            std::ptr::null(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize <= 32 {
        return Err("Could not open Unity Hub. Open it from the Windows Start menu.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_and_future_package_versions_use_the_same_identity() {
        assert_eq!(
            package_version("UnityTechnologies.UnityHub_4.0.1.65535_x64__2vrhnee42bhxm"),
            Some([4, 0, 1, 65535])
        );
        assert_eq!(
            package_version("UnityTechnologies.UnityHub_5.12.1.2_arm64__2vrhnee42bhxm"),
            Some([5, 12, 1, 2])
        );
        for invalid in [
            "",
            "UnityTechnologies.UnityHub_4.0.1_x64__2vrhnee42bhxm",
            "UnityTechnologies.UnityHub_4.0.1.0_x64_en-us_2vrhnee42bhxm",
            "UnityTechnologies.UnityHub_4.0.1.0_x64__wrong",
        ] {
            assert_eq!(package_version(invalid), None);
        }
    }

    #[test]
    #[ignore = "read-only check requiring a real packaged Unity Hub 4+ installation"]
    fn detects_installed_packaged_hub() {
        let version = version().expect("Packaged Unity Hub is not detected");
        assert!(version.split('.').next().unwrap().parse::<u16>().unwrap() >= 4);
        let report = crate::logic::probe_environment();
        assert!(report.hub_installed);
        assert_eq!(report.hub_version.as_deref(), Some(version.as_str()));
        assert!(report.hub_path.is_none());
        assert!(report.hub_auto_registration);
        assert!(crate::hub::restart_hub()
            .unwrap_err()
            .contains("Start menu"));
    }
}
