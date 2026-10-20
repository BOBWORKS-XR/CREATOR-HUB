//! Disposable Unix use-binding tests only. Never package this example.
#[cfg(unix)]
fn run() -> Result<i32, String> {
    use creator_hub_mcp_router::Store;
    use minisign_verify::PublicKey;
    use std::{fs, path::Path};
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 5 {
        return Err("Unix fixture requires ACTION BASE PUBLIC_KEY REPLACEMENT.".into());
    }
    let key = PublicKey::decode(
        &fs::read_to_string(&args[3]).map_err(|_| "Missing fixture public key.")?,
    )
    .map_err(|_| "Invalid fixture public key.")?;
    let runtime = Store::new(Path::new(&args[2]), key)?.resolve()?;
    match args[1].as_str() {
        "server-write" => fs::write(
            &runtime.server,
            fs::read(&args[4]).map_err(|_| "Missing replacement.")?,
        )
        .map_err(|_| "Cannot mutate test server.")?,
        "server-replace" => {
            fs::rename(&args[4], &runtime.server).map_err(|_| "Cannot replace test server.")?;
        }
        "node-replace" => {
            fs::rename(&args[4], &runtime.node).map_err(|_| "Cannot replace test Node.")?;
        }
        "node-write" => fs::write(
            &runtime.node,
            fs::read(&args[4]).map_err(|_| "Missing replacement.")?,
        )
        .map_err(|_| "Cannot mutate test Node.")?,
        _ => return Err("Unknown Unix fixture action.".into()),
    }
    Ok(runtime.run()?.code().unwrap_or(1))
}

fn main() {
    #[cfg(unix)]
    match run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
    #[cfg(not(unix))]
    {
        eprintln!("This disposable test is Unix only.");
        std::process::exit(64);
    }
}
