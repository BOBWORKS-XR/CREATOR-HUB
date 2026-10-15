import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { releaseChecksums } from "./release-checksums.mjs";

const fixture = () => ({
  assets: ["setup.exe", "app.AppImage", "app.deb", "app.rpm", "app.dmg"]
    .map(name => ({ name, state: "uploaded", digest: `sha256:${"a".repeat(64)}` })),
});

const windowsScope = {
  platform: "windows-x86_64",
  installerAssetName: "Creator-Hub-0.1.14-windows-x64-setup.exe",
};
const windowsNames = [windowsScope.installerAssetName, `${windowsScope.installerAssetName}.sig`,
  "creator-hub-windows-x86_64.json", "creator-hub-windows-x86_64.json.minisig", "latest.json"];
const windowsFixture = () => ({ assets: windowsNames.map(name => ({
  name, state: "uploaded", digest: `sha256:${"b".repeat(64)}`,
})) });

test("checksums include every platform and ignore the previous checksum asset", () => {
  const data = fixture();
  data.assets.push({ name: "SHA256SUMS.txt" });
  const result = releaseChecksums(data);
  assert.equal(result.trim().split("\n").length, 5);
  assert.ok(result.includes(`${"a".repeat(64)}  setup.exe\n`));
});

test("checksums fail closed on partial uploads, missing platforms, unsafe names and invalid digests", () => {
  for (const change of [
    data => data.assets.pop(),
    data => { data.assets[0].digest = null; },
    data => { data.assets[0].digest = `sha512:${"a".repeat(64)}`; },
    data => { data.assets[0].state = "new"; },
    data => { data.assets[0].name = "bad\nname.exe"; },
    data => { data.assets[0].name = "../setup.exe"; },
    data => data.assets.push({ ...data.assets[0] }),
  ]) {
    const data = fixture();
    change(data);
    assert.throws(() => releaseChecksums(data));
  }
});

test("explicit Windows scope emits exactly five product checksums and ignores one previous checksum asset", () => {
  const data = windowsFixture();
  data.assets.reverse();
  data.assets.push({ name: "SHA256SUMS.txt" });
  assert.equal(releaseChecksums(data, windowsScope), [...windowsNames].sort()
    .map(name => `${"b".repeat(64)}  ${name}\n`).join(""));
});

test("Windows-only metadata does not silently change the historical multiplatform default", () => {
  assert.throws(() => releaseChecksums(windowsFixture()), /Missing release artifact: \.AppImage/);
});

test("explicit Windows scope requires every exact product asset", () => {
  for (const name of windowsNames) {
    const data = windowsFixture();
    data.assets = data.assets.filter(asset => asset.name !== name);
    assert.throws(() => releaseChecksums(data, windowsScope), /Missing Windows release asset/, name);
  }
});

test("Windows scope rejects foreign platforms, alternate installers and extra draft attachments", () => {
  for (const name of ["app.AppImage", "app.deb", "app.rpm", "app.dmg", "app.flatpak",
    "other.exe", "other.exe.sig", "creator-hub-windows-arm64.json",
    "creator-hub-windows-x86_64.json.sig", "evidence.zip", "SHA256SUMS.TXT"]) {
    const data = windowsFixture();
    data.assets.push({ name, state: "uploaded", digest: `sha256:${"c".repeat(64)}` });
    assert.throws(() => releaseChecksums(data, windowsScope), /Unexpected Windows release asset/, name);
  }
  const duplicate = windowsFixture();
  duplicate.assets.push({ name: "SHA256SUMS.txt" }, { name: "SHA256SUMS.txt" });
  assert.throws(() => releaseChecksums(duplicate, windowsScope), /Duplicate.*SHA256SUMS/);
});

test("an explicit scope cannot fall back to historical requirements on invalid platform or installer", () => {
  for (const scope of [null, {}, { platform: "linux" }, { installerAssetName: "setup.exe" },
    { ...windowsScope, platform: "windows-arm64" },
    ...["", "../setup.exe", "setup.exe\n", "setup.exe.sig"].map(installerAssetName => ({ ...windowsScope, installerAssetName }))]) {
    assert.throws(() => releaseChecksums(fixture(), scope), /Invalid Windows release scope/);
  }
});

test("Windows scope retains uploaded-state, digest and duplicate-name refusal", () => {
  for (const change of [
    data => { data.assets[0].state = "new"; },
    data => { data.assets[0].digest = null; },
    data => { data.assets[0].digest = `sha512:${"a".repeat(64)}`; },
    data => { data.assets[0].name = "bad\nname.exe"; },
    data => data.assets.push({ ...data.assets[0] }),
    data => data.assets.push({ ...data.assets[0], name: data.assets[0].name.toUpperCase() }),
  ]) {
    const data = windowsFixture();
    change(data);
    assert.throws(() => releaseChecksums(data, windowsScope));
  }
});

test("checksum CLI requires explicit Windows platform and installer while preserving legacy invocation", t => {
  const directory = mkdtempSync(path.join(tmpdir(), "creator-checksums-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const metadata = path.join(directory, "assets.json");
  const script = fileURLToPath(new URL("./release-checksums.mjs", import.meta.url));
  const run = args => spawnSync(process.execPath, [script, metadata, ...args], { encoding: "utf8" });
  writeFileSync(metadata, JSON.stringify(fixture()));
  const historical = run([]);
  assert.equal(historical.status, 0, historical.stderr);
  assert.equal(historical.stdout, releaseChecksums(fixture()));
  writeFileSync(metadata, JSON.stringify(windowsFixture()));
  const explicit = run(["--platform", windowsScope.platform, "--installer", windowsScope.installerAssetName]);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(explicit.stdout, releaseChecksums(windowsFixture(), windowsScope));
  for (const args of [[], ["--platform", windowsScope.platform],
    ["--installer", windowsScope.installerAssetName], ["--unknown"],
    ["--platform", "linux", "--installer", windowsScope.installerAssetName]]) {
    const refused = run(args);
    assert.notEqual(refused.status, 0, args.join(" "));
    assert.equal(refused.stdout, "", "Refusals must not produce partial checksum output");
  }
});
