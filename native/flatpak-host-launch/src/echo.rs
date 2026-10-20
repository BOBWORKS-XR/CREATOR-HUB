fn main() {
    let args = std::env::args_os().collect::<Vec<_>>();
    if args.len() != 2 || args[1] != "echo-v1" {
        std::process::exit(64);
    }
    std::process::exit(if creator_hub_flatpak_host_launch::echo() {
        0
    } else {
        77
    });
}
