//! Compiled from run 38643248531 plan.json, not caller-supplied metadata.
pub const PACKAGE: &str = "creator-works-mcp";
pub const OLD: &str = "2.7.7";
pub const NEW: &str = "2.7.7-1+hub.retention014.1";
pub const HELPER: &str = "/usr/libexec/creator-hub-deb-retirement-helper";
pub const PRIVATE: &str = "/var/lib/creator-hub-deb-retirement";
pub const MD5_SHA256: &str = "556261ac6789876557ddbff925a8652f94ca8649ad251acac64a07f501b1208f";

#[derive(Clone, Debug)]
pub struct Pin {
    pub path: &'static str,
    pub bytes: u64,
    pub mode: u32,
    pub sha256: &'static str,
    pub md5: &'static str,
    pub retained: bool,
}

macro_rules! pin {
    ($path:literal, $bytes:literal, $mode:literal, $sha:literal, $md5:literal, $keep:literal) => {
        Pin {
            path: $path,
            bytes: $bytes,
            mode: $mode,
            sha256: $sha,
            md5: $md5,
            retained: $keep,
        }
    };
}

pub const FILES: &[Pin] = &[
    pin!(
        "usr/bin/creator-works-mcp-launcher",
        20525304,
        0o755,
        "6cc50ba3c770c1774512a99dc24d514f4350f51d03fd27bb4259ec16249c2ab2",
        "bf84a0b7f3878b6cec82ae0d54086874",
        false
    ),
    pin!(
        "usr/lib/Creator Works MCP/server/LICENSE",
        1068,
        0o644,
        "b1cfe8ff7191d3e9c6c6b0f832adcd2ebece8e6070ef72d2f7afc1c082fb757f",
        "de9b393fbf70c5c04281320d8aa3aaa5",
        true
    ),
    pin!(
        "usr/lib/Creator Works MCP/server/THIRD_PARTY_NOTICES.md",
        7433,
        0o644,
        "1a9baf94795f84f17fd692cb7c14de19d94905d5bec494a9e9ee090a8f7b69d1",
        "095e91481555e8b8110482d97656da69",
        true
    ),
    pin!(
        "usr/lib/Creator Works MCP/server/creator-works-mcp.mjs",
        1221209,
        0o755,
        "8d7cbe21d3b3691d6b1aa052846d6ee36f4274c18bd4228c6d4a73583be74149",
        "00f6894f0bb765ee3bf261d7294da74f",
        true
    ),
    pin!(
        "usr/lib/Creator Works MCP/server/runtime/LICENSE",
        156926,
        0o644,
        "4573185d56580da2b890ba34a85a409257640f1c5632eade4300137266194d18",
        "9f816753e8bdfe4576cb87159a0cd60c",
        true
    ),
    pin!(
        "usr/lib/Creator Works MCP/server/runtime/VERSION",
        8,
        0o644,
        "98182b41c9ce3357797985cf12dc3b0124490ef88bc918a905373e7688e6aec9",
        "22c03d8fb1a8cc942889b0bdfd9b20aa",
        true
    ),
    pin!(
        "usr/lib/Creator Works MCP/server/runtime/node",
        123459976,
        0o755,
        "62d66443847de1f527f74afe715900b12884ace52136dc9cd8e91e61acc2f527",
        "a8fd0b69281376109c05f7653b5319b2",
        true
    ),
    pin!(
        "usr/lib/Creator Works MCP/server/runtime/node.exe",
        123459976,
        0o755,
        "62d66443847de1f527f74afe715900b12884ace52136dc9cd8e91e61acc2f527",
        "a8fd0b69281376109c05f7653b5319b2",
        true
    ),
    pin!(
        "usr/lib/Creator Works MCP/server/unity-extension/Editor/BanterMCPBridge.cs",
        358150,
        0o644,
        "eaa70b9696c05e3ebce0abe3d98d8ebb5188f37d0747e6b143fa43ae48f32aca",
        "3a6b0553e63305f9924fcd9687216e4d",
        true
    ),
    pin!(
        "usr/lib/Creator Works MCP/server/unity-extension/Editor/CreatorWorksMCPLogo.png",
        52329,
        0o644,
        "f3f68baa0d887de92e6cf7aba8beae7ff8ea5c44b13444f018413041ade19ea7",
        "1a47746f06cf946a3b704bbc72c0eb2c",
        true
    ),
    pin!(
        "usr/share/applications/Creator Works MCP.desktop",
        236,
        0o644,
        "735562f1441694a3ca1384cb34016251b9f05323d6fbca7de372d50fb6ff4087",
        "7ff43b0ec3db5f1e99685e9949f0b84f",
        false
    ),
    pin!(
        "usr/share/icons/hicolor/128x128/apps/creator-works-mcp-launcher.png",
        6966,
        0o644,
        "cff3b008e6e0379beee23305e683a00ce0013a73cbb7b6a445cdc73217b3ecbe",
        "bca29252eb7a62eb635251168fb2fc57",
        false
    ),
    pin!(
        "usr/share/icons/hicolor/256x256@2/apps/creator-works-mcp-launcher.png",
        14336,
        0o644,
        "840d17fe62d8d5230cc9a3611f6e2492f9f9e29bdb6c7c278f762d4d9774f712",
        "04f313816675353ed974afb822ebb742",
        false
    ),
    pin!(
        "usr/share/icons/hicolor/32x32/apps/creator-works-mcp-launcher.png",
        1533,
        0o644,
        "cd24c1c5d53c558422571b466b6f1950ea0ddca76e1e3de9330fb00a5a174e10",
        "316cfb65fe2870aa87039bf7c2f7c399",
        false
    ),
];
