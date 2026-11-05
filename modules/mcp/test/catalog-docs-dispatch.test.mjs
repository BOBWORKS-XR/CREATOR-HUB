import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createConfigForProject } from "../dist/lib/config.js";
import { handleToolCall } from "../dist/tools/index.js";
import { generateVSGraph } from "../dist/tools/generate-vs-graph.js";
import { validateVSGraph } from "../dist/tools/validate-vs-graph.js";

test("actual tool dispatch exposes Creator additions and retains the legacy source", async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "creator-catalog-dispatch-"));
  fs.mkdirSync(path.join(folder, "Assets"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const config = createConfigForProject(folder);
  for (const name of ["PersistFileSet", "SetSpaceStateValue"]) {
    const result = JSON.parse((await handleToolCall("search_sidequest_vs_nodes", { query: name, source: "creator", limit: 1 }, config)).content[0].text);
    assert.equal(result.count, 1);
    assert.equal(result.nodes[0].fullType, `BS.VisualScripting.${name}`);
    assert.equal(result.nodes[0].catalogSource, "creator");
    assert.match(result.guidance, /not the selected installed package/);
  }
  const old = JSON.parse((await handleToolCall("search_sidequest_vs_nodes", { query: "OnGrab", source: "legacy", limit: 1 }, config)).content[0].text);
  assert.equal(old.catalogSize, 162);
  assert.match(old.nodes[0].fullType, /^Banter\./);
  const docs = JSON.parse((await handleToolCall("get_mcp_reference", { source: "creator-docs", query: "authenticated player storage", limit: 1 }, config)).content[0].text);
  assert.ok(docs.entries.length > 0);
  assert.match(docs.entries[0].entryId, /saving-data/);
  assert.match(docs.entries[0].guidance, /not private per-player/);
});

test("new Creator aliases generate proper namespaces, event flags and only supported defaults", () => {
  const result = generateVSGraph({ sdkProfile: "creator", graphName: "Persistence", nodes: [
    { id: "save", type: "PersistFileSet" }, { id: "saved", type: "OnPersistFileSaved" },
  ] });
  assert.equal(result.success, true);
  const nodes = JSON.parse(result.graphJson).graph.elements;
  const save = nodes.find(n => n.$type === "BS.VisualScripting.PersistFileSet");
  assert.deepEqual(save.defaultValues.Name, { $type: "System.String", $content: "" });
  assert.equal(nodes.find(n => n.$type === "BS.VisualScripting.OnPersistFileSaved").coroutine, false);
  assert.equal(validateVSGraph(result.graphJson, { sdkProfile: "creator" }).valid, true);
  assert.equal(generateVSGraph({ sdkProfile: "none", graphName: "Wrong", nodes: [{ id: "save", type: "PersistFileSet" }] }).success, false);
});
