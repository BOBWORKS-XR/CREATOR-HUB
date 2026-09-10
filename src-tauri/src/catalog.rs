use minisign_verify::{PublicKey, Signature};
use reqwest::blocking::Client;
use semver::Version;
use serde::{Deserialize, Serialize};
use std::{io::Read, time::Duration};

pub const DESCRIPTOR_NAME: &str = "creator-hub-windows-x86_64.json";
pub const MAX_METADATA: u64 = 32 * 1024;
pub const MAX_ARTIFACT: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum AppId {
    #[serde(rename = "mcp")]
    Mcp,
    #[serde(rename = "setup")]
    Setup,
}

impl AppId {
    pub const ALL: [Self; 2] = [Self::Mcp, Self::Setup];
    pub fn id(self) -> &'static str {
        match self {
            Self::Mcp => "creator-works-mcp",
            Self::Setup => "creator-project-setup",
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Mcp => "Creator Works MCP",
            Self::Setup => "Creator Project Setup",
        }
    }
    pub fn repo(self) -> &'static str {
        match self {
            Self::Mcp => "CREATOR-WORKS-UNITY-MCP",
            Self::Setup => "CREATOR-PROJECT-SETUP",
        }
    }
    pub fn exe(self) -> &'static str {
        match self {
            Self::Mcp => "creator-works-mcp-launcher.exe",
            Self::Setup => "creator-project-setup.exe",
        }
    }
    pub fn download_url(self, version: &str, asset: &str) -> String {
        format!(
            "https://github.com/BOBWORKS-XR/{}/releases/download/v{version}/{asset}",
            self.repo()
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Release {
    pub schema_version: u32,
    pub app_id: String,
    pub version: String,
    pub platform: String,
    pub architecture: String,
    pub package_type: String,
    pub asset_name: String,
    pub byte_length: u64,
    pub sha256: String,
    pub executable_sha256: String,
    pub identity_protocol: u32,
    pub lifecycle_protocol: u32,
    pub installer_protocol: u32,
    pub min_hub_version: String,
}

impl Release {
    pub fn validate(&self, app: AppId, preview: bool) -> Result<Version, String> {
        let version = Version::parse(&self.version).map_err(|_| "Invalid release version.")?;
        let min =
            Version::parse(&self.min_hub_version).map_err(|_| "Invalid minimum Hub version.")?;
        if self.schema_version != 1
            || self.app_id != app.id()
            || self.platform != "windows"
            || self.architecture != "x86_64"
            || self.identity_protocol > 1
            || self.lifecycle_protocol > 1
            || self.installer_protocol > 1
            || min > Version::parse(env!("CARGO_PKG_VERSION")).unwrap()
            || (!preview && !version.pre.is_empty())
            || !version.build.is_empty()
        {
            return Err("Release is incompatible with this Hub or channel.".into());
        }
        let package = "nsis";
        if self.package_type != package
            || self.byte_length == 0
            || self.byte_length > MAX_ARTIFACT
            || !hash_valid(&self.sha256)
            || !hash_valid(&self.executable_sha256)
            || self.asset_name.len() > 160
            || !self.asset_name.ends_with(".exe")
            || !self
                .asset_name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            || self.asset_name.contains("..")
        {
            return Err("Release artifact is invalid.".into());
        }
        Ok(version)
    }
}

pub fn hash_valid(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn bootstrap(app: AppId) -> Release {
    let (version, asset, bytes, sha, executable) = match app {
        AppId::Setup => (
            "0.2.2",
            "Creator-Project-Setup-0.2.2-Windows-setup.exe",
            2_577_201,
            "b3f9ed80e9319c4ce7339836310bbfbf7342da665fef155937a5701eda2229e5",
            "23006194bd8214b92c980dc1042466d598d6d1daaed26819ab697d67159db49b",
        ),
        AppId::Mcp => (
            "2.6.0",
            "Creator.Works.MCP_2.6.0_x64-setup.exe",
            26_247_422,
            "11d6fc0fb95e33023a90a8722cf9234f82de6e175689bd915401bac3d49bc8c2",
            "b712aadd91ac63ea64b5bbead28d7dc2fc83d4102f989999d7ea85b427649676",
        ),
    };
    Release {
        schema_version: 1,
        app_id: app.id().into(),
        version: version.into(),
        platform: "windows".into(),
        architecture: "x86_64".into(),
        package_type: "nsis".into(),
        asset_name: asset.into(),
        byte_length: bytes,
        sha256: sha.into(),
        executable_sha256: executable.into(),
        identity_protocol: 0,
        lifecycle_protocol: 0,
        installer_protocol: 0,
        min_hub_version: "0.1.0-alpha.1".into(),
    }
}

pub fn client() -> Result<Client, String> {
    Client::builder()
        .https_only(true)
        .user_agent("Creator-Hub/0.1")
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .redirect(redirect_policy())
        .build()
        .map_err(|_| "Could not initialize secure downloads.".into())
}

pub fn streaming_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .https_only(true)
        .user_agent("Creator-Hub/0.1")
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(600))
        .redirect(redirect_policy())
        .build()
        .map_err(|_| "Could not initialize secure downloads.".into())
}

fn redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        let url = attempt.url();
        let allowed = matches!(
            url.host_str(),
            Some(
                "github.com"
                    | "api.github.com"
                    | "release-assets.githubusercontent.com"
                    | "objects.githubusercontent.com"
            )
        );
        if attempt.previous().len() >= 5 || url.scheme() != "https" || !allowed {
            attempt.error("Unapproved download redirect")
        } else {
            attempt.follow()
        }
    })
}

pub fn fetch_small(client: &Client, url: &str, max: u64) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .timeout(Duration::from_secs(30))
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|_| "Release metadata is unavailable. Check your connection or retry later.")?;
    let mut bytes = Vec::new();
    response
        .take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Metadata download failed.")?;
    if bytes.len() as u64 > max {
        return Err("Release metadata exceeds its size limit.".into());
    }
    Ok(bytes)
}

pub fn verify_signed(
    app: AppId,
    data: &[u8],
    signature: &[u8],
    preview: bool,
) -> Result<Release, String> {
    if data.len() > MAX_METADATA as usize || signature.len() > 4096 {
        return Err("Signed metadata is too large.".into());
    }
    let key = PublicKey::decode(include_str!("catalog-key.pub"))
        .map_err(|_| "Invalid embedded catalog key.")?;
    let sig = Signature::decode(
        std::str::from_utf8(signature).map_err(|_| "Invalid signature encoding.")?,
    )
    .map_err(|_| "Invalid release signature.")?;
    key.verify(data, &sig, false)
        .map_err(|_| "Release signature verification failed.")?;
    let release: Release =
        serde_json::from_slice(data).map_err(|_| "Invalid signed release descriptor.")?;
    release.validate(app, preview)?;
    Ok(release)
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
}

pub type SignedRelease = (Release, Vec<u8>, Vec<u8>);

pub fn discover(
    client: &Client,
    app: AppId,
    preview: bool,
) -> Result<Option<SignedRelease>, String> {
    let url = format!(
        "https://api.github.com/repos/BOBWORKS-XR/{}/releases?per_page=10",
        app.repo()
    );
    let items: Vec<GithubRelease> = serde_json::from_slice(&fetch_small(client, &url, 256 * 1024)?)
        .map_err(|_| "GitHub returned invalid release metadata.")?;
    let mut versions: Vec<Version> = items
        .into_iter()
        .filter(|r| !r.draft && (preview || !r.prerelease))
        .filter_map(|r| {
            r.tag_name
                .strip_prefix('v')
                .and_then(|v| Version::parse(v).ok())
        })
        .filter(|v| (preview || v.pre.is_empty()) && v.build.is_empty())
        .collect();
    versions.sort();
    versions.dedup();
    let baseline = Version::parse(&bootstrap(app).version).unwrap();
    let Some(version) = versions.last().filter(|v| **v > baseline) else {
        return Ok(None);
    };
    let url = app.download_url(&version.to_string(), DESCRIPTOR_NAME);
    let bytes = fetch_small(client, &url, MAX_METADATA)?;
    let signature = fetch_small(client, &format!("{url}.minisig"), 4096)?;
    let release = verify_signed(app, &bytes, &signature, preview)?;
    if release.version != version.to_string() {
        return Err("Release tag and signed version differ.".into());
    }
    Ok(Some((release, bytes, signature)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pinned_releases_are_valid() {
        for app in AppId::ALL {
            bootstrap(app).validate(app, false).unwrap();
        }
    }
    #[test]
    fn no_command_or_path_can_be_injected() {
        for name in [
            "../evil.exe",
            "a.exe /S",
            "C:\\a.exe",
            "x\n.exe",
            "bad.exe?x=1",
            "..exe",
            "a%2f.exe",
        ] {
            let mut r = bootstrap(AppId::Mcp);
            r.asset_name = name.into();
            assert!(r.validate(AppId::Mcp, false).is_err());
        }
    }
    #[test]
    fn incompatible_and_untrusted_releases_fail_closed() {
        let mut r = bootstrap(AppId::Setup);
        r.version = "9.0.0-beta.1".into();
        assert!(r.validate(AppId::Setup, false).is_err());
        assert!(r.validate(AppId::Setup, true).is_ok());
        r.min_hub_version = "99.0.0".into();
        assert!(r.validate(AppId::Setup, true).is_err());
        assert!(verify_signed(AppId::Setup, b"{}", b"bad", false).is_err());
        assert!(verify_signed(
            AppId::Setup,
            &vec![0; MAX_METADATA as usize + 1],
            b"bad",
            false
        )
        .is_err());
    }
    #[test]
    fn versions_compare_numerically() {
        assert!(Version::parse("2.10.0").unwrap() > Version::parse("2.9.9").unwrap());
        assert!(Version::parse("2.7.0-alpha.1").unwrap() < Version::parse("2.7.0").unwrap());
    }
    #[test]
    fn real_signed_release_fixture_verifies_and_tampering_is_rejected() {
        let bytes =
            include_bytes!("../../tests/fixtures/setup-0.2.2/creator-hub-windows-x86_64.json");
        let signature = include_bytes!(
            "../../tests/fixtures/setup-0.2.2/creator-hub-windows-x86_64.json.minisig"
        );
        assert_eq!(
            verify_signed(AppId::Setup, bytes, signature, false).unwrap(),
            bootstrap(AppId::Setup)
        );
        let mut changed = bytes.to_vec();
        changed[0] = b' ';
        assert!(verify_signed(AppId::Setup, &changed, signature, false).is_err());
        assert!(verify_signed(AppId::Mcp, bytes, signature, false).is_err());
    }
}
