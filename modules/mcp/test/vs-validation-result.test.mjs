import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readVSGraphValidationResult, validateVSGraphReceipt } from "../dist/tools/vs-validation-result.js";

const id = "1da4619a-c157-4b5a-9b43-ceab8f34d50b";
const assetPath = "Assets/Graph.asset";
function valid() {
  return { commandId: id, assetPath, success: true, timestamp: 1, warnings: [],
    assetGuid: "a04d1e4043d04631a951b74c897aad7f", dependencyHash: "f472562b293649f2abe4218952a12299",
    assetType: "Unity.VisualScripting.ScriptGraphAsset", graphType: "Unity.VisualScripting.FlowGraph",
    elementCount: 0, nodeCount: 0, controlConnectionCount: 0, valueConnectionCount: 0, groupCount: 0,
    missingElementCount: 0, invalidConnectionCount: 0, failedUnitDefinitionCount: 0,
    valueInputCount: 0, unboundValueInputCount: 0, valuePortInspectionErrorCount: 0,
    allowUnboundValueInputs: false, valuePortInspectionAvailable: false,
    unboundValueInputsTruncated: false, elementTypes: [], unboundValueInputs: [] };
}

test("graph receipts accept genuine empty graphs and preserve explicit failures", () => {
  assert.equal(validateVSGraphReceipt(valid(), id, assetPath).success, true);
  const failure = { commandId: id, assetPath, success: false, timestamp: 1, warnings: [], error: "Missing graph" };
  assert.deepEqual(validateVSGraphReceipt(failure, id, assetPath), failure);
});

test("graph receipts reject malformed success, wrong identities and inconsistent evidence", () => {
  for (const changes of [
    { success: "false" }, { success: null }, { success: undefined },
    { commandId: "other" }, { assetPath: "Assets/Other.asset" }, { timestamp: NaN },
    { nodeCount: -1 }, { nodeCount: 1.1 }, { elementCount: 3 },
    { assetGuid: "bad" }, { assetType: "Other" }, { graphType: "Other" },
    { dependencyHash: "bad" }, { missingElementCount: 1 },
    { warnings: [false] }, { allowUnboundValueInputs: true }, { unboundValueInputCount: 1 },
  ]) assert.throws(() => validateVSGraphReceipt({ ...valid(), ...changes }, id, assetPath), /Invalid Visual Scripting/);
  assert.throws(() => validateVSGraphReceipt({ commandId: id, assetPath, success: true }, id, assetPath));
});

test("receipt reader retains invalid evidence, consumes only validated evidence, confines IDs", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "creator-vs-receipt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const folder = path.join(dir, "vs-validation-results"); fs.mkdirSync(folder);
  const file = path.join(folder, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...valid(), assetPath: "Assets/Wrong.asset" }));
  assert.throws(() => readVSGraphValidationResult(dir, id, assetPath), /receipt was kept/);
  assert.ok(fs.existsSync(file));
  fs.writeFileSync(file, "{broken");
  assert.throws(() => readVSGraphValidationResult(dir, id, assetPath), /malformed JSON/);
  assert.ok(fs.existsSync(file));
  fs.writeFileSync(file, JSON.stringify(valid()));
  assert.equal(readVSGraphValidationResult(dir, id, assetPath).success, true);
  assert.ok(!fs.existsSync(file));
  assert.equal(readVSGraphValidationResult(dir, id, assetPath), undefined);
  assert.throws(() => readVSGraphValidationResult(dir, "../../outside", assetPath), /command ID/);
});
