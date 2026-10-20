use std::io::{self, Write};

fn main() {
    let args = std::env::args_os().collect::<Vec<_>>();
    if args.len() != 2 || args[1] != "prove-installed" {
        eprintln!("Only prove-installed is supported; no paths or overrides are accepted.");
        std::process::exit(64);
    }
    let report = creator_hub_flatpak_host_launch::run();
    let passed = report.contains("\"syntheticLaunchProofPassed\":true");
    if io::stdout().lock().write_all(report.as_bytes()).is_err() {
        std::process::exit(74);
    }
    std::process::exit(if passed { 0 } else { 77 });
}
