#[cfg(target_os = "linux")]
mod linux;

fn main() {
    #[cfg(target_os = "linux")]
    if let Err(message) = linux::run() {
        eprintln!("{message}");
        std::process::exit(1);
    }
    #[cfg(not(target_os = "linux"))]
    {
        eprintln!("This isolated launcher supports native Linux Flatpak only.");
        std::process::exit(78);
    }
}
