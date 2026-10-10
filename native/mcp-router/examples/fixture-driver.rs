//! Disposable acceptance fixture. Never package this executable or its test key.
use creator_hub_mcp_router::{generation, Descriptor, Store};
use minisign_verify::PublicKey;
use std::{fs, path::Path};

fn run() -> Result<i32, String> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() < 4 {
        return Err("Fixture requires ACTION BASE PUBLIC_KEY [DESCRIPTOR SIGNATURE].".into());
    }
    let key = PublicKey::decode(
        &fs::read_to_string(&args[3]).map_err(|_| "Missing fixture public key.")?,
    )
    .map_err(|_| "Invalid fixture public key.")?;
    let store = Store::new(Path::new(&args[2]), key)?;
    match args[1].as_str() {
        "activate" if args.len() == 6 => {
            let bytes = fs::read(&args[4]).map_err(|_| "Missing fixture descriptor.")?;
            let signature = fs::read(&args[5]).map_err(|_| "Missing fixture signature.")?;
            let expected = store.snapshot()?;
            store.activate(&bytes, &signature, expected.as_deref())?;
            Ok(0)
        }
        "connect" if args.len() == 4 => Ok(store.resolve()?.run()?.code().unwrap_or(1)),
        "generation" if args.len() == 5 => {
            let descriptor: Descriptor = serde_json::from_slice(
                &fs::read(&args[4]).map_err(|_| "Missing fixture descriptor.")?,
            )
            .map_err(|_| "Invalid fixture descriptor.")?;
            println!("{}", generation(&descriptor.module)?);
            Ok(0)
        }
        _ => Err("Invalid fixture action.".into()),
    }
}

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
