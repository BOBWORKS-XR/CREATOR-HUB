import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createConfigForProject } from "../dist/lib/config.js";
import { handleToolCall, registerTools } from "../dist/tools/index.js";
import { generateVSGraph } from "../dist/tools/generate-vs-graph.js";
import { validateVSGraph } from "../dist/tools/validate-vs-graph.js";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "creator-feedback-safety-"));
  fs.mkdirSync(path.join(dir, "Assets"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createConfigForProject(dir);
}

test("omitted or blank reference targets are rejected before any command is written", async t => {
  const config = fixture(t);
  for (const fields of [{}, { targetId: " " }, { targetPath: "\t" }, { targetId: null }, { targetId: "id", targetPath: "null" }]) {
    const result = await handleToolCall("set_object_reference", { objectPath: "Owner", componentType: "Example", propertyName: "target", ...fields }, config);
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).success, false);
  }
  assert.ok(!fs.existsSync(config.mcpCommandsPath) || fs.readdirSync(config.mcpCommandsPath).length === 0);
});

test("foreign project arguments fail explicitly before reads or commands", async t => {
  const config = fixture(t);
  for (const name of ["get_bridge_status", "query_project_state"]) {
    const schema = registerTools().find(tool => tool.name === name).inputSchema;
    assert.equal(schema.additionalProperties, false);
    const result = await handleToolCall(name, { projectId: "foreign", ...(name === "query_project_state" ? { query: "hierarchy" } : {}) }, config);
    assert.equal(result.isError, true);
    assert.match(JSON.parse(result.content[0].text).error, /select_unity_project/);
  }
  assert.ok(!fs.existsSync(config.mcpCommandsPath));
});

test("malformed containers are errors while canonical and legacy empty graphs remain valid", () => {
  for (const graph of [{ elements: {} }, { elements: null }, { units: {} }, { elements: [null] }, { elements: [{ broken: true }] }, { elements: [], units: { $content: [] } }, {}]) {
    assert.equal(validateVSGraph(JSON.stringify({ graph: { $version: "A", ...graph } })).valid, false, JSON.stringify(graph));
  }
  for (const graph of [{ elements: [] }, { units: { $content: [] }, controlConnections: { $content: [] }, valueConnections: { $content: [] } }]) {
    assert.equal(validateVSGraph(JSON.stringify({ graph: { $version: "A", ...graph } })).valid, true);
  }
});

test("Start ports reject the reported invalid edge without rejecting trigger", () => {
  const graph = generateVSGraph({ graphName: "Ports", nodes: [{ id: "start", type: "Start" }, { id: "sequence", type: "Unity.VisualScripting.Sequence" }],
    connections: [{ from: "start", fromPort: "trigger", to: "sequence", toPort: "enter", type: "control" }] });
  assert.equal(graph.success, true);
  assert.equal(validateVSGraph(graph.graphJson).valid, true);
  const wrong = JSON.parse(graph.graphJson);
  wrong.graph.elements.find(element => element.$type === "Unity.VisualScripting.ControlConnection").sourceKey = "start";
  assert.equal(validateVSGraph(JSON.stringify(wrong)).valid, false);
});

test("static graph failure is marked as MCP tool error while warnings alone are not", async t => {
  const config = fixture(t);
  assert.equal((await handleToolCall("validate_vs_graph", { graphJson: "not json" }, config)).isError, true);
  assert.notEqual((await handleToolCall("validate_vs_graph", { graphJson: JSON.stringify({ graph: { $version: "A", elements: [] } }) }, config)).isError, true);
});

test("ordinary not-ready bridge status remains diagnostic data, not a failed tool invocation", async t => {
  const config = fixture(t);
  const result = await handleToolCall("get_bridge_status", {}, config);
  assert.notEqual(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).ready, false);
});
