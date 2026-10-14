use creator_hub_linux_deb_retirement::{action, refusal, Result};
#[cfg(not(feature = "experimental-transaction"))]
use creator_hub_linux_deb_retirement::{Action, INSTALL_REFUSAL};

fn run() -> Result<serde_json::Value> {
    let action = action(&std::env::args().skip(1).collect::<Vec<_>>())?;
    #[cfg(not(feature = "experimental-transaction"))]
    if action == Action::Retire {
        return Err(INSTALL_REFUSAL.into());
    }
    #[cfg(target_os = "linux")]
    {
        creator_hub_linux_deb_retirement::linux::run(action)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = action;
        Err("Native Linux only; no package or system changes performed".into())
    }
}

fn main() {
    match run() {
        Ok(report) => println!("{report}"),
        Err(error) => {
            println!("{}", refusal(error.as_ref()));
            std::process::exit(2);
        }
    }
}
