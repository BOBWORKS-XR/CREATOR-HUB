import assert from "node:assert/strict";
import test from "node:test";
import { inspectVSGraphSource } from "../dist/tools/vs-source-inventory.js";
import { validateVSGraphReceipt } from "../dist/tools/vs-validation-result.js";

const guid = "fab120e8-b203-4a14-98d6-4aaf94d36764";
const json = JSON.stringify({ graph: { elements: [{ guid, $type: "Unity.VisualScripting.Start" }], $version: "A" } });
const asset = content => `%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n--- !u!114 &11400000\nMonoBehaviour:\n  _data:\n    _json: '${content.replaceAll("'", "''")}'\n    _objectReferences: []\n`;

test("read-only inventory supports Unity YAML strings without changing bytes", () => {
  const raw = asset(json);
  const result = inspectVSGraphSource(raw);
  assert.match(result.contentHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.elementIdentities, [`${guid}\tUnity.VisualScripting.Start`]);
  assert.notEqual(inspectVSGraphSource(`${raw}\n`).contentHash, result.contentHash);
  const empty = asset(JSON.stringify({ graph: { $version: "A", elements: [] } }));
  assert.deepEqual(inspectVSGraphSource(empty).elementIdentities, []);
});

test("inventory rejects malformed/mixed containers, duplicate GUIDs and YAML aliases", () => {
  for (const value of [{ elements: {} }, { elements: [], units: { $content: [] } },
    { elements: [{ guid, $type: "A" }, { guid, $type: "B" }] }, { elements: [{ $type: "A" }] }]) {
    assert.throws(() => inspectVSGraphSource(asset(JSON.stringify({ graph: value }))));
  }
  assert.throws(() => inspectVSGraphSource("x: &x [1]\ny: *x\n"));
  assert.throws(() => inspectVSGraphSource(asset("not json")));
  assert.throws(() => inspectVSGraphSource("MonoBehaviour: {}\nMonoBehaviour: {}\n"));
});

test("successful zero-element receipts cannot validate nonempty source", () => {
  const source = inspectVSGraphSource(asset(json));
  const base = { commandId: "id", success: true, assetPath: "Assets/G.asset", timestamp: 1, warnings: [],
    assetGuid: "a04d1e4043d04631a951b74c897aad7f", dependencyHash: "f472562b293649f2abe4218952a12299",
    assetType: "Unity.VisualScripting.ScriptGraphAsset", graphType: "Unity.VisualScripting.FlowGraph",
    elementCount: 0, nodeCount: 0, controlConnectionCount: 0, valueConnectionCount: 0, groupCount: 0,
    missingElementCount: 0, invalidConnectionCount: 0, failedUnitDefinitionCount: 0, valueInputCount: 0,
    unboundValueInputCount: 0, valuePortInspectionErrorCount: 0, allowUnboundValueInputs: false,
    valuePortInspectionAvailable: false, unboundValueInputsTruncated: false, elementTypes: [],
    unboundValueInputs: [], sourceContentHash: source.contentHash, elementIdentities: [] };
  assert.throws(() => validateVSGraphReceipt(base, "id", "Assets/G.asset", false, source), /inventory is incomplete/);
  assert.throws(() => validateVSGraphReceipt({ ...base, sourceContentHash: "wrong" }, "id", "Assets/G.asset", false, source), /source hash mismatch/);
  assert.throws(() => validateVSGraphReceipt({ ...base, elementIdentities: [`${guid}\tWrong`] }, "id", "Assets/G.asset", false, source), /changed element/);
  assert.equal(validateVSGraphReceipt({ ...base, elementCount: 1, nodeCount: 1, elementIdentities: source.elementIdentities }, "id", "Assets/G.asset", false, source).success, true);
});
