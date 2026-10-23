import assert from "node:assert/strict";
import test from "node:test";

import {
  parseToolGroupSelection,
  registerTools,
} from "../dist/tools/index.js";

function schemaBytes(selection) {
  return Buffer.byteLength(JSON.stringify({ tools: registerTools(selection) }), "utf8");
}

test("token-saver profile keeps its advertised tool context bounded", () => {
  const all = parseToolGroupSelection("all");
  const core = parseToolGroupSelection("core");
  const allBytes = schemaBytes(all);
  const coreBytes = schemaBytes(core);
  const coreTools = registerTools(core);
  const names = new Set(coreTools.map((tool) => tool.name));

  assert.equal(coreTools.length, 27);
  // Online topic lookup and offline continuation add 2,490 schema bytes.
  assert.ok(coreBytes <= 26000, "core schema grew to " + coreBytes + " bytes");
  assert.ok(
    coreBytes <= allBytes * 0.6,
    "core is no longer at least 40% smaller than all (" + coreBytes + "/" + allBytes + ")",
  );
  assert.ok(names.has("query_project_state"));
  assert.ok(names.has("lookup_creator_docs"));
  assert.ok(names.has("get_mcp_reference"));
  assert.ok(names.has("set_component_property"));
  assert.ok(names.has("instantiate_prefab"));
  assert.ok(!names.has("generate_vs_graph"));
  assert.ok(!names.has("run_unity_tests"));
  assert.ok(!names.has("create_shader_graph"));
});
