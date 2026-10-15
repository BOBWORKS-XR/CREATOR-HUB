import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export function releaseChecksums(metadata, scope) {
  if (!Array.isArray(metadata?.assets)) throw new Error("Release asset metadata is missing.");
  let expected;
  if (scope !== undefined) {
    const installer = scope?.installerAssetName;
    if (scope?.platform !== "windows-x86_64" || typeof installer !== "string"
      || !/^[a-zA-Z0-9._-]+\.exe$/.test(installer) || installer.trim() !== installer || installer.includes("..")) {
      throw new Error("Invalid Windows release scope; require windows-x86_64 and the exact installer asset name.");
    }
    // The publication guard must derive this allowlist from its independently verified receipt.
    expected = new Set([installer, `${installer}.sig`, "creator-hub-windows-x86_64.json",
      "creator-hub-windows-x86_64.json.minisig", "latest.json"]);
    if (metadata.assets.filter(asset => asset.name === "SHA256SUMS.txt").length > 1) {
      throw new Error("Duplicate release asset: SHA256SUMS.txt");
    }
  }
  const assets = metadata.assets.filter(asset => asset.name !== "SHA256SUMS.txt");
  const names = new Set();
  for (const asset of assets) {
    if (typeof asset.name !== "string" || !asset.name.length || /[\x00-\x1f\x7f/\\]/.test(asset.name)) {
      throw new Error("Invalid release asset filename.");
    }
    const key = asset.name.toLowerCase();
    if (names.has(key)) throw new Error(`Duplicate release asset: ${asset.name}`);
    names.add(key);
    if (asset.state !== "uploaded" || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest ?? "")) {
      throw new Error(`Asset is not fully uploaded with a SHA256 digest: ${asset.name}`);
    }
    if (expected && !expected.has(asset.name)) throw new Error(`Unexpected Windows release asset: ${asset.name}`);
  }
  if (expected) {
    for (const name of expected) {
      if (!assets.some(asset => asset.name === name)) throw new Error(`Missing Windows release asset: ${name}`);
    }
  } else {
    for (const suffix of [".exe", ".AppImage", ".deb", ".rpm", ".dmg"]) {
      if (!assets.some(asset => asset.name.endsWith(suffix))) throw new Error(`Missing release artifact: ${suffix}`);
    }
  }
  return assets.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .map(asset => `${asset.digest.slice(7).toLowerCase()}  ${asset.name}\n`).join("");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseArgs({
    options: { platform: { type: "string" }, installer: { type: "string" } },
    allowPositionals: true,
  });
  if (positionals.length !== 1) throw new Error("Usage: release-checksums.mjs METADATA [--platform windows-x86_64 --installer EXACT-ASSET.exe]");
  const scope = values.platform === undefined && values.installer === undefined ? undefined
    : { platform: values.platform, installerAssetName: values.installer };
  process.stdout.write(releaseChecksums(JSON.parse(readFileSync(positionals[0], "utf8")), scope));
}
