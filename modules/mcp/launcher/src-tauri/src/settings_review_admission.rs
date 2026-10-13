//! Native review stays private-module-only; Unix requires an explicit test build.
pub(crate) fn enabled() -> bool {
    policy(
        std::env::consts::OS,
        cfg!(feature = "experimental-unix-hosting"),
        option_env!("CREATOR_HUB_INTERNAL_MODULE"),
    )
}

fn policy(os: &str, experimental: bool, internal: Option<&str>) -> bool {
    internal == Some("1") && (os == "windows" || experimental && matches!(os, "linux" | "macos"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standalone_and_unrecognized_builds_cannot_review_settings() {
        for os in ["windows", "linux", "macos", "freebsd"] {
            for internal in [None, Some("0"), Some("true")] {
                for experimental in [false, true] {
                    assert!(!policy(os, experimental, internal));
                }
            }
        }
    }

    #[test]
    fn unix_review_is_explicit_and_does_not_enable_production() {
        assert!(policy("windows", false, Some("1")));
        for os in ["linux", "macos"] {
            assert!(!policy(os, false, Some("1")));
            assert!(policy(os, true, Some("1")));
        }
        assert!(!policy("freebsd", true, Some("1")));
    }

    #[test]
    fn native_entry_uses_compiled_not_process_runtime_flags() {
        assert_eq!(
            enabled(),
            policy(
                std::env::consts::OS,
                cfg!(feature = "experimental-unix-hosting"),
                option_env!("CREATOR_HUB_INTERNAL_MODULE"),
            )
        );
    }
}
