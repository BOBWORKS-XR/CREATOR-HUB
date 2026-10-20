use creator_hub_flatpak_host_reader::{paths::Setting, InspectionStatus};
use std::{ffi::OsString, io};

pub const SETTINGS: [(&str, Setting); 5] = [
    ("opencode-json", Setting::OpenCodeJson),
    ("opencode-jsonc", Setting::OpenCodeJsonc),
    ("creator-mcp", Setting::CreatorMcp),
    ("legacy-mcp", Setting::LegacyMcp),
    ("setup-editors", Setting::SetupEditors),
];

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Invocation,
    Admission(io::ErrorKind),
}

pub struct Report {
    pub body: String,
    pub exit_code: u8,
}

pub fn execute(
    args: &[OsString],
    inspect: impl FnOnce() -> io::Result<[InspectionStatus; 5]>,
) -> Result<Report, Error> {
    if args.len() != 2 || args[1] != "inspect-local" {
        return Err(Error::Invocation);
    }
    let statuses = inspect().map_err(|error| Error::Admission(error.kind()))?;
    let mut body = String::from(
        "{\"schemaVersion\":1,\"scope\":\"native-self-settings-inventory-only\",\"readOnly\":true,\"externalCallerAuthenticated\":false,\"hostIntegrationAccepted\":false,\"settings\":{",
    );
    for (index, ((id, _), status)) in SETTINGS.iter().zip(statuses.iter()).enumerate() {
        if index != 0 {
            body.push(',');
        }
        // Only fixed IDs/states and unsigned lengths are serialized; no user text enters JSON.
        body.push_str(&format!("\"{id}\":"));
        body.push_str(&match status {
            InspectionStatus::Present { byte_length } => {
                format!("{{\"state\":\"present\",\"byteLength\":{byte_length}}}")
            }
            InspectionStatus::Absent => "{\"state\":\"absent\"}".into(),
            InspectionStatus::Unavailable => "{\"state\":\"unavailable\"}".into(),
        });
    }
    body.push_str("}}\n");
    Ok(Report {
        body,
        exit_code: if statuses.contains(&InspectionStatus::Unavailable) {
            2
        } else {
            0
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn invalid_invocations_never_reach_admission_or_settings() {
        for values in [
            vec![],
            vec!["helper"],
            vec!["helper", "--inspect-local"],
            vec!["helper", "inspect-local", "/foreign/config"],
            vec!["helper", "inspect-local", "--approved=true"],
            vec!["helper", "GetStatus"],
            vec!["helper", "inspect-local "],
        ] {
            assert!(matches!(
                execute(&args(&values), || panic!("No I/O permitted")),
                Err(Error::Invocation)
            ));
        }
    }

    #[test]
    fn native_admission_refusal_returns_no_inventory_or_error_text() {
        let called = Cell::new(0);
        let result = execute(&args(&["helper", "inspect-local"]), || {
            called.set(called.get() + 1);
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "sensitive /native/path",
            ))
        });
        assert_eq!(called.get(), 1);
        assert!(matches!(
            result,
            Err(Error::Admission(io::ErrorKind::PermissionDenied))
        ));
    }

    #[test]
    fn exact_redacted_report_has_fixed_fields_and_cannot_claim_external_admission() {
        let report = execute(&args(&["helper", "inspect-local"]), || {
            Ok([
                InspectionStatus::Present { byte_length: 0 },
                InspectionStatus::Absent,
                InspectionStatus::Unavailable,
                InspectionStatus::Present { byte_length: 19 },
                InspectionStatus::Absent,
            ])
        })
        .unwrap();
        assert_eq!(report.exit_code, 2);
        assert_eq!(report.body, concat!(
            "{\"schemaVersion\":1,\"scope\":\"native-self-settings-inventory-only\",\"readOnly\":true,",
            "\"externalCallerAuthenticated\":false,\"hostIntegrationAccepted\":false,\"settings\":{",
            "\"opencode-json\":{\"state\":\"present\",\"byteLength\":0},",
            "\"opencode-jsonc\":{\"state\":\"absent\"},\"creator-mcp\":{\"state\":\"unavailable\"},",
            "\"legacy-mcp\":{\"state\":\"present\",\"byteLength\":19},\"setup-editors\":{\"state\":\"absent\"}}}\n"
        ));
    }

    #[test]
    fn absence_is_complete_but_unavailability_never_looks_like_absence() {
        for (status, exit_code, state) in [
            (InspectionStatus::Absent, 0, "absent"),
            (InspectionStatus::Unavailable, 2, "unavailable"),
        ] {
            let report = execute(&args(&["helper", "inspect-local"]), || Ok([status; 5])).unwrap();
            assert_eq!(report.exit_code, exit_code);
            assert_eq!(
                report
                    .body
                    .matches(&format!("\"state\":\"{state}\""))
                    .count(),
                5
            );
        }
    }

    #[test]
    fn even_maximum_integer_lengths_keep_output_under_two_kib() {
        let report = execute(&args(&["helper", "inspect-local"]), || {
            Ok([InspectionStatus::Present {
                byte_length: usize::MAX,
            }; 5])
        })
        .unwrap();
        assert_eq!(report.exit_code, 0);
        assert!(report.body.len() < 2048);
    }
}
