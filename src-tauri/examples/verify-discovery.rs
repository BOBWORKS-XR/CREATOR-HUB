//! Read-only live discovery through the same catalog code shipped in Hub 0.1.2.
#[allow(dead_code)]
#[path = "../src/catalog.rs"]
mod catalog;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = catalog::client()?;
    let baseline = semver::Version::parse("0.1.2")?;
    for preview in [false, true] {
        let (release, _, _) =
            catalog::discover_from(&client, "CREATOR-HUB", "creator-hub", preview, &baseline)?
                .ok_or("No signed update discovered for Hub 0.1.2")?;
        if release.version != "0.1.3"
            || semver::Version::parse(&release.min_hub_version)? > baseline
            || release.installer_protocol != 1
        {
            return Err("Discovered release is not the compatible reviewed 0.1.3 update".into());
        }
        println!(
            "Hub 0.1.2 baseline, preview={preview}: discovered signed {} (minimum Hub {}).",
            release.version, release.min_hub_version
        );
    }
    Ok(())
}
