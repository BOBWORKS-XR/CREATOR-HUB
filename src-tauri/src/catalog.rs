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
    pub fn required_hub_version(&self) -> Option<&str> {
        let minimum = Version::parse(&self.min_hub_version).ok()?;
        (minimum > Version::parse(env!("CARGO_PKG_VERSION")).unwrap())
            .then_some(self.min_hub_version.as_str())
    }

    pub fn install_block_reason(&self, app: AppId) -> Option<String> {
        if app == AppId::Mcp && self.sha256 == bootstrap(AppId::Mcp).sha256 {
            Some("This MCP installer has a setup problem, so Hub won't run it. Your current MCP can still be used. Check for an update before installing.".into())
        } else {
            self.required_hub_version().map(|version| format!("Update Creator Hub to {version} or later first. Your current app can still be used."))
        }
    }

    pub fn validate(&self, app: AppId, preview: bool) -> Result<Version, String> {
        self.validate_id(app.id(), preview)
    }

    pub(crate) fn validate_id(&self, app_id: &str, preview: bool) -> Result<Version, String> {
        let version = Version::parse(&self.version).map_err(|_| "Invalid release version.")?;
        Version::parse(&self.min_hub_version).map_err(|_| "Invalid minimum Hub version.")?;
        if self.schema_version != 1
            || self.app_id != app_id
            || self.platform != "windows"
            || self.architecture != "x86_64"
            || self.identity_protocol > 1
            || self.lifecycle_protocol > 1
            || self.installer_protocol > 1
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
    verify_signed_id(app.id(), data, signature, preview)
}

pub(crate) fn verify_signed_id(
    app_id: &str,
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
    release.validate_id(app_id, preview)?;
    Ok(release)
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
}

fn candidate_versions(
    items: Vec<GithubRelease>,
    preview: bool,
    baseline: &Version,
) -> Vec<Version> {
    let signature_name = format!("{DESCRIPTOR_NAME}.minisig");
    let mut versions: Vec<_> = items
        .into_iter()
        .filter(|r| !r.draft && (preview || !r.prerelease))
        // Old/manual releases without both signed catalog files are not Hub updates.
        .filter(|r| {
            r.assets.iter().any(|a| a.name == DESCRIPTOR_NAME)
                && r.assets.iter().any(|a| a.name == signature_name)
        })
        .filter_map(|r| {
            let tag = r.tag_name.strip_prefix('v')?;
            let version = Version::parse(tag).ok()?;
            (version.to_string() == tag).then_some(version)
        })
        .filter(|v| (preview || v.pre.is_empty()) && v.build.is_empty() && v > baseline)
        .collect();
    versions.sort();
    versions.dedup();
    versions.reverse();
    versions
}

pub type SignedRelease = (Release, Vec<u8>, Vec<u8>);

pub fn discover(
    client: &Client,
    app: AppId,
    preview: bool,
) -> Result<Option<SignedRelease>, String> {
    discover_from(
        client,
        app.repo(),
        app.id(),
        preview,
        &Version::parse(&bootstrap(app).version).unwrap(),
    )
}

pub(crate) fn release_url(repo: &str, version: &str, asset: &str) -> String {
    format!("https://github.com/BOBWORKS-XR/{repo}/releases/download/v{version}/{asset}")
}

pub(crate) fn discover_from(
    client: &Client,
    repo: &str,
    app_id: &str,
    preview: bool,
    baseline: &Version,
) -> Result<Option<SignedRelease>, String> {
    let url = format!(
        "https://api.github.com/repos/BOBWORKS-XR/{}/releases?per_page=10",
        repo
    );
    let items: Vec<GithubRelease> = serde_json::from_slice(&fetch_small(client, &url, 256 * 1024)?)
        .map_err(|_| "GitHub returned invalid release metadata.")?;
    let versions = candidate_versions(items, preview, baseline);
    let Some(version) = versions.first() else {
        return Ok(None);
    };
    let url = release_url(repo, &version.to_string(), DESCRIPTOR_NAME);
    let bytes = fetch_small(client, &url, MAX_METADATA)?;
    let signature = fetch_small(client, &format!("{url}.minisig"), 4096)?;
    let release = verify_signed_id(app_id, &bytes, &signature, preview)?;
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
    fn defective_installer_is_blocked_by_artifact_not_version_label() {
        let mut mcp = bootstrap(AppId::Mcp);
        assert!(mcp.install_block_reason(AppId::Mcp).is_some());
        mcp.version = "2.9.0".into();
        assert!(mcp.install_block_reason(AppId::Mcp).is_some());
        mcp.sha256 = "a".repeat(64);
        assert!(mcp.install_block_reason(AppId::Mcp).is_none());
        assert!(bootstrap(AppId::Setup)
            .install_block_reason(AppId::Setup)
            .is_none());
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
        assert!(r.validate(AppId::Setup, true).is_ok());
        assert_eq!(r.required_hub_version(), Some("99.0.0"));
        assert!(r
            .install_block_reason(AppId::Setup)
            .unwrap()
            .contains("Update Creator Hub"));
        r.min_hub_version = "not-a-version".into();
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
    fn staged_setup_signature_and_hub_minimum_are_bound_to_the_real_fixture() {
        let bytes =
            include_bytes!("../../tests/fixtures/staged-setup/creator-hub-windows-x86_64.json");
        let sig = include_bytes!(
            "../../tests/fixtures/staged-setup/creator-hub-windows-x86_64.json.minisig"
        );
        let release = verify_signed(AppId::Setup, bytes, sig, true).unwrap();
        assert_eq!(release.version, "0.3.0-alpha.2");
        assert_eq!(release.min_hub_version, "0.1.0-alpha.5");
        assert!(
            Version::parse(&release.min_hub_version).unwrap()
                > Version::parse("0.1.0-alpha.4").unwrap()
        );
        assert_eq!(release.required_hub_version(), None);
        let mut tampered = bytes.to_vec();
        tampered[0] ^= 1;
        assert!(verify_signed(AppId::Setup, &tampered, sig, true).is_err());
        assert!(verify_signed(AppId::Setup, bytes, sig, false).is_err());
    }

    #[test]
    fn channel_changes_accept_only_newer_releases() {
        let item = |version: &str, prerelease| GithubRelease {
            tag_name: format!("v{version}"),
            draft: false,
            prerelease,
            assets: vec![
                GithubAsset {
                    name: DESCRIPTOR_NAME.into(),
                },
                GithubAsset {
                    name: format!("{DESCRIPTOR_NAME}.minisig"),
                },
            ],
        };
        let stable = Version::parse("2.6.0").unwrap();
        let preview = Version::parse("2.7.0-alpha.1").unwrap();
        assert_eq!(
            candidate_versions(vec![item("2.7.0-alpha.1", true)], true, &stable),
            vec![preview.clone()]
        );
        assert!(candidate_versions(vec![item("2.7.0-alpha.1", true)], false, &stable).is_empty());
        assert_eq!(
            candidate_versions(vec![item("2.7.0", false)], false, &preview),
            vec![Version::parse("2.7.0").unwrap()]
        );
        assert!(candidate_versions(vec![item("2.6.0", false)], false, &preview).is_empty());
    }

    #[test]
    fn unsigned_newer_release_does_not_hide_a_ready_update() {
        let items = serde_json::json!([
            {"tag_name":"v3.0.0", "draft":false, "prerelease":false, "assets":[]},
            {"tag_name":"v2.8.0", "draft":false, "prerelease":false,
             "assets":[{"name":DESCRIPTOR_NAME}]},
            {"tag_name":"v2.7.0", "draft":false, "prerelease":false,
             "assets":[{"name":DESCRIPTOR_NAME},{"name":format!("{DESCRIPTOR_NAME}.minisig")}]}
        ]);
        let versions = candidate_versions(
            serde_json::from_value(items).unwrap(),
            false,
            &Version::parse("2.6.0").unwrap(),
        );
        assert_eq!(versions, vec![Version::parse("2.7.0").unwrap()]);
    }

    #[test]
    fn discovery_respects_drafts_channel_and_baseline() {
        let make = |tag: &str, draft, prerelease| GithubRelease {
            tag_name: tag.into(),
            draft,
            prerelease,
            assets: vec![
                GithubAsset {
                    name: DESCRIPTOR_NAME.into(),
                },
                GithubAsset {
                    name: format!("{DESCRIPTOR_NAME}.minisig"),
                },
            ],
        };
        let items = || {
            vec![
                make("v2.7.0-alpha.1", false, true),
                make("v2.8.0", true, false),
                make("v2.9.0-beta.1", false, false),
                make("v2.6.0", false, false),
                make("v2.6.1", false, false),
                make("v2.6.1", false, false),
                make("v3.0.0+build", false, false),
                make("bad", false, false),
            ]
        };
        let baseline = Version::parse("2.6.0").unwrap();
        assert_eq!(
            candidate_versions(items(), false, &baseline),
            vec![Version::parse("2.6.1").unwrap()]
        );
        assert_eq!(candidate_versions(items(), true, &baseline).len(), 3);
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
