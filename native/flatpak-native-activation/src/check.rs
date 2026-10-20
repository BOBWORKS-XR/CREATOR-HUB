use creator_hub_flatpak_native_activation::verify_native_input;
use std::path::Path;

fn main() {
    let arguments = std::env::args_os().collect::<Vec<_>>();
    if arguments.len() != 2 {
        eprintln!("Use creator-hub-flatpak-check-native-input CANONICAL_INPUT_DIRECTORY. Verification only; never installation.");
        std::process::exit(2);
    }
    let directory = match Path::new(&arguments[1]).canonicalize() {
        Ok(directory) => directory,
        Err(_) => {
            eprintln!("Missing native verification input directory.");
            std::process::exit(1);
        }
    };
    match verify_native_input(&directory) {
        Ok(proof) => println!("{}", serde_json::to_string(&proof).unwrap()),
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(1);
        }
    }
}
