//! Default-off portable startup admission. No installer, migration, service
//! registration or sandbox RPC is added to the ordinary native DEB path.
use creator_hub_linux_portable_deployment::{Expected, HostSession, Store, HOST_MARKER};

pub(super) fn admit_startup() -> Result<(), String> {
    if !requested(std::env::var_os(HOST_MARKER).as_deref())? {
        return Ok(());
    }
    // Environment values are hints only. The store verifies the production
    // signature, exact selected version and running /proc/self/exe identity.
    let session = HostSession::capture().map_err(|error| error.to_string())?;
    let store = Store::open(session.store_path()).map_err(|error| error.to_string())?;
    let expected =
        Expected::linux_x86_64(env!("CARGO_PKG_VERSION")).map_err(|error| error.to_string())?;
    store
        .bind_current_process(&expected)
        .map_err(|error| error.to_string())
}

fn requested(marker: Option<&std::ffi::OsStr>) -> Result<bool, String> {
    match marker {
        None => Ok(false),
        Some(value) if value == "1" => Ok(true),
        Some(_) => Err("Unrecognized portable Hub activation. No settings were changed.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_deb_has_no_portable_admission_and_hints_are_not_paths_or_commands() {
        assert_eq!(requested(None), Ok(false));
        assert_eq!(requested(Some(std::ffi::OsStr::new("1"))), Ok(true));
        for value in [
            "",
            "true",
            "0",
            "../host",
            "1 --install",
            "/tmp/creator-hub",
        ] {
            assert!(requested(Some(std::ffi::OsStr::new(value))).is_err());
        }
    }
}
