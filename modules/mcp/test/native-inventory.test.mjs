import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { createConfigForProject } from "../dist/lib/config.js";
import { projectIdForPath } from "../dist/lib/project-router.js";
import { getNativeInventory } from "../dist/tools/native-inventory.js";
import { getMCPReference } from "../dist/tools/get-mcp-reference.js";
import { handleToolCall, parseToolGroupSelection, registerTools } from "../dist/tools/index.js";

const NOW = 1793966400000;
function snapshot(projectId, count = 1) {
  return {
    schemaVersion: 1,
    producer: { name: "creator-works-native-inventory", version: 1, applicationId: "fixture.native", buildGuid: "build-test", unityVersion: "6000.3.21f1", platform: "WindowsPlayer", isEditor: false },
    capture: { projectId, sessionId: "a".repeat(32), snapshotId: "b".repeat(32), capturedAtUnixMs: NOW, frame: 200 },
    coverage: { scope: "loaded-scene-hierarchy", cameraSubmission: "unknown", truncated: false, reason: "none", maxNodes: 1000, maxDepth: 64, maxMilliseconds: 10, elapsedMilliseconds: 1.5 },
    nodes: Array.from({ length: count }, (_, index) => ({ id: index + 1, parentId: 0, sceneId: 2, name: `Object ${index}`, activeSelf: true, activeInHierarchy: true, firstRenderer: { present: true, enabled: true, isVisibleHint: true } })),
  };
}
async function fixture(t, count = 1) {
  const root = await mkdtemp(path.join(os.tmpdir(), "creator-native-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = createConfigForProject(root, projectIdForPath(root));
  const data = snapshot(config.projectId, count);
  const directory = path.join(root, ".bantworks-mcp", "native-inventory", data.capture.sessionId);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "snapshot.json"), receiptFile = path.join(directory, "session.json");
  const f = { root, config, directory, file, receiptFile, data, args: { expectedSessionId: data.capture.sessionId, expectedBuildGuid: data.producer.buildGuid },
    async save() {
      const json = JSON.stringify(this.data);
      await writeFile(file, json);
      this.receipt = { schemaVersion: 1, projectId: config.projectId, sessionId: this.args.expectedSessionId,
        buildGuid: this.args.expectedBuildGuid, state: "active", snapshotId: this.data.capture.snapshotId,
        snapshotSha256: createHash("sha256").update(json).digest("hex"), issuedAtUnixMs: NOW, expiresAtUnixMs: NOW + 60000 };
      await this.saveReceipt();
    },
    async saveReceipt() { await writeFile(receiptFile, JSON.stringify(this.receipt)); },
    read(args = {}) { return getNativeInventory({ ...this.args, ...args }, config, NOW); } };
  await f.save();
  return f;
}

test("native snapshot is read-only, explicitly identified and not presented as live/render evidence", async t => {
  const f = await fixture(t), before = await readFile(f.file);
  const result = f.read();
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.liveQuery, false);
  assert.equal(result.coverage.cameraSubmission, "unknown");
  assert.equal(result.nodes[0].firstRenderer.isVisibleHint, true);
  assert.match(result.identityAssurance, /not attested/);
  assert.equal(result.producer.isEditor, false);
  assert.deepEqual(await readFile(f.file), before);
  assert.equal(result.nodes[0].cameraSubmitted, undefined);
});

test("native snapshot rejects wrong project, session, build, stale capture and Editor data", async t => {
  const f = await fixture(t);
  assert.equal(f.read({ expectedSessionId: "c".repeat(32) }).success, false);
  assert.equal(f.read({ expectedBuildGuid: "wrong" }).success, false);
  for (const mutate of [
    d => d.capture.projectId = "unity-" + "0".repeat(20),
    d => d.capture.capturedAtUnixMs = NOW - 31000,
    d => d.capture.capturedAtUnixMs = NOW + 6000,
    d => d.producer.isEditor = true,
    d => d.producer.unityVersion = "2022.3.62f3",
    d => d.coverage.cameraSubmission = "confirmed",
    d => d.schemaVersion = 2,
  ]) {
    f.data = snapshot(f.config.projectId); mutate(f.data);
    await f.save();
    assert.equal(f.read().success, false);
  }
});

test("Windows player may omit application identifier without weakening required runtime identity", async t => {
  const f = await fixture(t);
  f.data.producer.applicationId = "";
  await f.save();
  assert.equal(f.read().success, true, "observed Windows standalone metadata is valid");
  assert.equal(f.read({ expectedBuildGuid: "wrong" }).success, false);
  for (const mutate of [
    d => d.producer.platform = "Android",
    d => d.producer.buildGuid = "",
    d => d.producer.applicationId = null,
    d => d.producer.applicationId = "bad\nidentity",
  ]) {
    f.data = snapshot(f.config.projectId); f.data.producer.applicationId = ""; mutate(f.data);
    await f.save();
    assert.equal(f.read().success, false);
  }
});

test("bounded paging and field filtering preserve IDs, bind the exact capture and reject changed filters", async t => {
  const f = await fixture(t, 250);
  const before = await readFile(f.file), ids = [], first = f.read({ maxResponseBytes: 4096 });
  assert.equal(first.success, true); assert.ok(first.returned < 50); assert.ok(first.nextCursor);
  let result = first;
  do {
    assert.ok(Buffer.byteLength(JSON.stringify(result, null, 2)) <= 4096);
    ids.push(...result.nodes.map(n => n.id));
    if (!result.nextCursor) break;
    result = f.read({ maxResponseBytes: 4096, cursor: result.nextCursor, expectedHash: first.contentHash });
    assert.equal(result.success, true, JSON.stringify(result));
  } while (true);
  assert.equal(ids.length, 250); assert.equal(new Set(ids).size, 250);
  assert.deepEqual(Object.keys(f.read({ fields: ["name"], limit: 1 }).nodes[0]), ["id", "name"]);
  assert.equal(f.read({ sceneId: 99 }).totalMatchingCapturedNodes, 0);
  assert.equal(f.read({ nameContains: "Object 12" }).totalMatchingCapturedNodes, 11);
  assert.equal(f.read({ cursor: first.nextCursor, nameContains: "Object" }).success, false);
  f.data.nodes[0].name = "changed"; await f.save();
  assert.equal(f.read({ cursor: first.nextCursor }).success, false);
  assert.equal(f.read({ expectedHash: first.contentHash }).success, false);
  assert.notDeepEqual(await readFile(f.file), before); // Only the fixture writer changed it.
});

test("invalid schema, forged completeness and structurally inconsistent hierarchy are refused", async t => {
  const f = await fixture(t);
  for (const mutate of [
    d => d.unexpected = "secret",
    d => d.nodes[0].extra = true,
    d => d.nodes[0].name = "x".repeat(257),
    d => d.nodes.push({ ...d.nodes[0] }),
    d => d.nodes[0].parentId = 99,
    d => d.nodes[0].activeSelf = false,
    d => d.nodes[0].firstRenderer.present = false,
    d => d.coverage.maxNodes = 0,
    d => d.coverage.maxMilliseconds = 51,
    d => d.coverage.truncated = true,
    d => d.nodes = new Array(1001).fill(d.nodes[0]),
  ]) {
    f.data = snapshot(f.config.projectId); mutate(f.data);
    await f.save();
    assert.equal(f.read().success, false, JSON.stringify(f.data).slice(0, 500));
  }
  f.data = snapshot(f.config.projectId);
  f.data.coverage.truncated = true; f.data.coverage.reason = "node-limit"; await f.save();
  assert.equal(f.read().coverage.truncated, true);
});

test("snapshot depth, parent activation and Unity version must match their declared contract", async t => {
  const f = await fixture(t, 2);
  f.data.nodes[1].parentId = 1;
  f.data.coverage.maxDepth = 0; await f.save();
  assert.equal(f.read().success, false, "children exceed a depth-zero capture");
  f.data.coverage.maxDepth = 1;
  f.data.nodes[0].activeInHierarchy = false; await f.save();
  assert.equal(f.read().success, false, "active child cannot have an inactive parent");
  f.data.nodes[0].activeInHierarchy = true;
  f.data.producer.unityVersion = "6000.3.21f1-unverified-suffix"; await f.save();
  assert.equal(f.read().success, false, "unsupported version strings are refused");
});

test("invalid requests, absent/oversized state and linked directories fail without fallback or writes", async t => {
  const f = await fixture(t);
  for (const args of [{ expectedSessionId: undefined }, { expectedHash: "bad" }, { limit: 101 }, { maxResponseBytes: 4095 },
    { maxAgeSeconds: 301 }, { fields: ["secret"] }, { fields: [] }, { nameContains: 4 }, { cursor: "bad" }, { install: true }]) assert.equal(f.read(args).success, false);
  await writeFile(f.file, "x".repeat(1024 * 1024 + 1));
  assert.equal(f.read().success, false);
  await rm(f.file);
  assert.match(f.read().error, /No approved/);
  const outside = path.join(f.root, "outside"); await mkdir(outside);
  await writeFile(path.join(outside, "snapshot.json"), JSON.stringify(f.data));
  await writeFile(path.join(outside, "session.json"), JSON.stringify(f.receipt));
  await rm(f.directory, { recursive: true });
  await symlink(outside, f.directory, process.platform === "win32" ? "junction" : "dir");
  assert.equal(f.read().success, false);
});

test("export lease rejects revocation, expiry, invalid identity and a half-published snapshot", async t => {
  const f = await fixture(t);
  for (const mutate of [
    r => r.state = "revoked", r => r.expiresAtUnixMs = NOW,
    r => r.expiresAtUnixMs = NOW + 300001, r => r.issuedAtUnixMs = NOW + 6000,
    r => r.sessionId = "c".repeat(32), r => r.buildGuid = "different",
    r => r.projectId = "unity-" + "0".repeat(20), r => r.snapshotSha256 = "f".repeat(64),
    r => r.snapshotId = "c".repeat(32), r => r.schemaVersion = 2,
  ]) {
    await f.save(); mutate(f.receipt); await f.saveReceipt();
    assert.equal(f.read().success, false, JSON.stringify(f.receipt));
  }
  await f.save();
  f.data.nodes[0].name = "partially-published";
  await writeFile(f.file, JSON.stringify(f.data));
  assert.match(f.read().error, /incomplete or changed/);
  await f.save();
  assert.equal(f.read().success, true);
  await rm(f.receiptFile);
  assert.equal(f.read().success, false, "snapshot cannot bypass its missing lease");
});

test("native read is an optional read-profile tool and tool failures set isError", async t => {
  const f = await fixture(t);
  assert.ok(registerTools(parseToolGroupSelection("read")).some(tool => tool.name === "get_native_inventory"));
  assert.ok(!registerTools(parseToolGroupSelection("core")).some(tool => tool.name === "get_native_inventory"));
  const result = await handleToolCall("get_native_inventory", {}, f.config);
  assert.equal(result.isError, true); assert.equal(JSON.parse(result.content[0].text).success, false);
});

test("native guidance is bounded, offline and explicit about consent and evidence", () => {
  const first = getMCPReference({ source: "native-diagnostics", query: "approved", limit: 1 });
  assert.equal(first.success, true); assert.equal(first.returned, 1);
  assert.match(first.entries[0].text, /not a\s+live player/);
  assert.match(first.entries[0].text, /explicitly/);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 16384);
  assert.deepEqual(getMCPReference({ source: "native-diagnostics", query: "approved", limit: 1 }), first);
  assert.match(getMCPReference({ source: "native-diagnostics", query: "EventMachine", limit: 1 }).entries[0].text, /not by itself/);
});
