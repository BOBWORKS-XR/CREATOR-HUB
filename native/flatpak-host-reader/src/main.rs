mod cli;

use creator_hub_flatpak_host_reader::NativeHostSettings;
use std::{
    io::{self, Write},
    process::ExitCode,
};

fn main() -> ExitCode {
    let args = std::env::args_os().collect::<Vec<_>>();
    let result = cli::execute(&args, || {
        let mut native = NativeHostSettings::current_user()?;
        Ok(cli::SETTINGS.map(|(_, setting)| native.inspect_status(setting)))
    });
    match result {
        Ok(report) => {
            if io::stdout()
                .lock()
                .write_all(report.body.as_bytes())
                .is_err()
            {
                return ExitCode::from(74);
            }
            ExitCode::from(report.exit_code)
        }
        Err(cli::Error::Invocation) => {
            eprintln!("Only inspect-local is supported. No paths, overrides or external caller claims are accepted.");
            ExitCode::from(64)
        }
        Err(cli::Error::Admission(kind)) => {
            eprintln!(
                "Native self-inspection refused ({kind:?}). No external caller was authenticated."
            );
            ExitCode::from(77)
        }
    }
}
