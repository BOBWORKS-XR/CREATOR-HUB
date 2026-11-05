import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const file = fileURLToPath(new URL("../src/tools/vs-performance-advice.ts", import.meta.url));
const source = fs.readFileSync(file, "utf8");
const compiled = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} });
assert.equal(compiled.diagnostics?.length || 0, 0);
const module = { exports: {} };
vm.runInNewContext(`(function(module,exports){${compiled.outputText}\n})`, {})(module, module.exports);
const { getVSPerformanceAdvice: getAdvice, VS_PERFORMANCE_GUIDANCE: guidance } = module.exports;
const advice = (...args) => JSON.parse(JSON.stringify(getAdvice(...args)));
const node = (id, type, extra = {}) => ({ $id: id, $type: "Unity.VisualScripting." + type, ...extra });
const edge = (from, to, type = "value", sourceKey = "output", destinationKey = "input") => ({ type, conn: {
  sourceUnit: { $ref: from }, destinationUnit: { $ref: to }, sourceKey, destinationKey,
} });
const codes = items => items.map(item => item.code);
const move = (id, target = "UnityEngine.Rigidbody", name = "MovePosition") => node(id, "InvokeMember", {
  member: { name, targetType: target },
});

test("every recognized tick gets advice, including gated, disabled-labelled or coroutine units", () => {
  const types = ["Update", "FixedUpdate", "LateUpdate", "OnTriggerStay", "OnTriggerStay2D"];
  const items = advice("", types.map((t, i) => node(String(i), t, { enabled: false, coroutine: true })), []);
  assert.equal(items.length, 5);
  for (const item of items) {
    assert.equal(item.graph, "(unnamed graph)");
    assert.match(item.message, /Why must/);
    assert.deepEqual(Object.keys(item).sort(), ["code", "graph", "message", "suggestion", "unitId", "unitType"]);
  }
  assert.match(items.find(i => i.unitType.endsWith("FixedUpdate")).message, /maximumDeltaTime\/fixedDeltaTime/);
  assert.match(items.find(i => i.unitType.endsWith("OnTriggerStay")).suggestion, /collider active/);
});

test("assembly-qualified types and shorthand work without matching unrelated type names", () => {
  const items = advice("Graph", [{ id: "a", type: "Update" }, node("b", "LateUpdate, Unity.VisualScripting.Flow"),
    { $id: "c", $type: "Example.Update" }, { $id: "d", $type: "Unity.VisualScripting.UpdateCustom" }], []);
  assert.equal(items.length, 2);
});

test("fanout counts distinct consumer inputs on the same value output, not duplicate edges", () => {
  const nodes = [node("s", "GetMember"), node("a", "Add"), node("b", "Add"), node("c", "Add")];
  const connections = [edge("s", "a"), edge("s", "a"), edge("s", "b")];
  assert.equal(advice("G", nodes, connections).length, 1);
  assert.match(advice("G", nodes, connections)[0].message, /2 distinct/);
  connections.push(edge("s", "c"));
  const result = advice("G", nodes, connections);
  assert.equal(result.length, 1);
  assert.equal(result[0].code, "VS_PERF_VALUE_FANOUT");
  assert.match(result[0].message, /unmeasured/);
  assert.match(result[0].message, /does not prove any cost multiplier/);
  assert.equal(advice("G", nodes, [edge("s", "a", "value", "x"), edge("s", "b", "value", "y"), edge("s", "c", "value", "z")]).length, 0);
});

test("Cache, SetVariable and stored-value outputs do not get recomputation fanout advice", () => {
  for (const type of ["Cache", "SetVariable", "GetVariable", "Literal"]) {
    const result = advice("G", [node("s", type), node("a", "Add"), node("b", "Add"), node("c", "Add")],
      [edge("s", "a"), edge("s", "b"), edge("s", "c")]);
    assert.equal(result.length, 0, type);
  }
});

test("long value chains are advisory and stop at explicit cached-value boundaries", () => {
  const nodes = Array.from({ length: 8 }, (_, i) => node(String(i), "GetMember"));
  const edges = nodes.slice(1).map((_, i) => edge(String(i), String(i + 1)));
  const found = advice("G", nodes, edges);
  assert.deepEqual(codes(found), ["VS_PERF_VALUE_CHAIN"]);
  assert.match(found[0].message, /unmeasured/);
  for (const type of ["Cache", "SetVariable"]) {
    const broken = nodes.map(n => n.$id === "4" ? node("4", type) : n);
    assert.equal(advice("G", broken, edges).length, 0);
  }
});

test("MovePosition warning requires exact InvokeMember metadata and a rendered-frame control path", () => {
  const nodes = [node("u", "Update"), node("gate", "Branch"), move("m")];
  const controls = [edge("u", "gate", "control"), edge("gate", "m", "control")];
  const result = advice("G", nodes, controls);
  const warning = result.find(i => i.code === "VS_PERF_MOVEPOSITION_FRAME_PATH");
  assert.ok(warning);
  assert.match(warning.message, /unmeasured/);
  assert.match(warning.suggestion, /Do not assume Rigidbody2D/);
  assert.equal(advice("G", nodes, [edge("u", "m")]).some(i => i.code === warning.code), false);
  for (const replacement of [move("m", "UnityEngine.Rigidbody2D"), move("m", "Example.Rigidbody"), move("m", "Rigidbody"),
    move("m", "UnityEngine.Rigidbody", "MoveRotation"), node("m", "GetMember", { member: nodes[2].member }),
    move("m", "UnityEngine.Rigidbody", "MovePosition(Vector3)")]) {
    assert.equal(advice("G", [nodes[0], nodes[1], replacement], controls).some(i => i.code === warning.code), false);
  }
  assert.equal(advice("G", [node("u", "FixedUpdate"), nodes[1], nodes[2]], controls).some(i => i.code === warning.code), false);
});

test("MovePosition supports generator properties and rejects contradictory target metadata", () => {
  const n = { id: "m", type: "InvokeMember", properties: { member: { name: "MovePosition", targetTypeName: "UnityEngine.Rigidbody, UnityEngine.PhysicsModule" } } };
  const connections = [{ type: "control", conn: { from: "u", to: "m", fromPort: "trigger", toPort: "enter" } }];
  assert.ok(advice("G", [{ id: "u", type: "LateUpdate" }, n], connections).some(i => i.code === "VS_PERF_MOVEPOSITION_FRAME_PATH"));
  n.properties.member.targetType = "UnityEngine.Rigidbody2D";
  assert.equal(advice("G", [{ id: "u", type: "LateUpdate" }, n], connections).some(i => i.code === "VS_PERF_MOVEPOSITION_FRAME_PATH"), false);
});

test("results are deterministic, pure and unaffected by connection/node ordering with stable IDs", () => {
  const nodes = [node("u", "Update"), move("m"), node("f", "FixedUpdate")];
  const connections = [edge("u", "m", "control")];
  for (const n of nodes) Object.freeze(n);
  Object.freeze(nodes); Object.freeze(connections);
  assert.deepEqual(advice(" G ", nodes, connections), advice("G", [...nodes].reverse(), [...connections].reverse()));
  assert.equal(nodes[0].$id, "u");
});

test("cycles terminate with incomplete-analysis advice rather than an error or recursive DFS", () => {
  const nodes = [node("u", "Update"), move("m")];
  const connections = [edge("u", "m", "control"), edge("m", "u", "control"), edge("m", "m")];
  const result = advice("G", nodes, connections);
  assert.ok(codes(result).includes("VS_PERF_ANALYSIS_INCOMPLETE"));
  assert.ok(codes(result).includes("VS_PERF_MOVEPOSITION_FRAME_PATH"));
});

test("deep graphs do not use recursive traversal and oversize input reports bounded scope", () => {
  const nodes = Array.from({ length: 12000 }, (_, i) => node(String(i), "GetMember"));
  const edges = nodes.slice(1).map((_, i) => edge(String(i), String(i + 1)));
  assert.equal(advice("Large", nodes, edges).filter(i => i.code === "VS_PERF_VALUE_CHAIN").length, 1);
  assert.ok(codes(advice("Large", new Array(20001), new Array(80001))).includes("VS_PERF_ANALYSIS_LIMIT"));
});

test("invalid/disconnected references stay nonfatal and an empty graph stays quiet", () => {
  assert.deepEqual(advice("G", [], []), []);
  assert.deepEqual(advice("G", [null, {}, node("a", "Add")], [{ type: "value", conn: null }, edge("missing", "a")]), []);
});

test("compact Markdown guidance has primary links and qualified scheduling/physics advice", () => {
  assert.match(guidance, /### Values and caches/);
  assert.match(guidance, /current flow, not across events/);
  assert.match(guidance, /0\.5s \(2Hz\).*0\.1s \(10Hz\)/);
  assert.match(guidance, /dynamic physics/);
  assert.match(guidance, /scaled, approximate timing/);
  assert.match(guidance, /docs\.unity3d\.com/);
  assert.ok(guidance.length < 4000);
});

test("the pure helper type-checks without emitting files", () => {
  const program = ts.createProgram([file], { noEmit: true, strict: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true,
    types: [], typeRoots: [path.resolve(path.dirname(file), "../../node_modules/@types")] });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);
});
