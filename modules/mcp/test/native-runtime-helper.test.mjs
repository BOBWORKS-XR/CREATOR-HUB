import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateNativeInventory } from "../dist/tools/native-inventory.js";
import { getNativeInventory } from "../dist/tools/native-inventory.js";
import { createConfigForProject } from "../dist/lib/config.js";
import { projectIdForPath } from "../dist/lib/project-router.js";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const source = path.resolve("unity-extension/Runtime/CreatorNativeInventory.cs");
const exportSource = path.resolve("unity-extension/Runtime/NativeInventoryExportSession.cs");
function compiler(t) {
  const sdks = spawnSync("dotnet", ["--list-sdks"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  const match = sdks.stdout?.trim().split(/\r?\n/).map(line => /^(\S+) \[(.+)\]$/.exec(line)).filter(Boolean).at(-1);
  if (!match) { t.skip("Offline C# checks require an installed .NET SDK."); return; }
  const root = mkdtempSync(path.join(os.tmpdir(), "creator-native-helper-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, csc: path.join(match[2], match[1], "Roslyn", "bincore", "csc.dll"), dotnetRoot: path.dirname(match[2]) };
}
function compile(c, references, sources, output, target) {
  const rsp = path.join(c.root, `${target}.rsp`);
  writeFileSync(rsp, ["-nologo", "-nostdlib+", `-target:${target}`, "-define:UNITY_6000_0_OR_NEWER", `-out:\"${output}\"`,
    ...references.map(file => `-r:\"${file}\"`), ...sources.map(file => `\"${file}\"`)].join("\n"));
  const result = spawnSync("dotnet", [c.csc, `@${rsp}`], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.error?.message || result.stdout || result.stderr);
}

function buildHarness(c) {
  const packRoot = path.join(c.dotnetRoot, "packs/Microsoft.NETCore.App.Ref");
  const version = readdirSync(packRoot).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
  const refRoot = path.join(packRoot, version, "ref");
  const framework = readdirSync(refRoot).at(-1);
  const references = readdirSync(path.join(refRoot, framework)).filter(f => f.endsWith(".dll")).map(f => path.join(refRoot, framework, f));
  const output = path.join(c.root, "Harness.dll");
  compile(c, references, [source, exportSource, path.resolve("test/fixtures/NativeInventoryHarness.cs"), path.resolve("test/fixtures/NativeInventoryExportHarness.cs")], output, "exe");
  writeFileSync(path.join(c.root, "Harness.runtimeconfig.json"), JSON.stringify({ runtimeOptions: { tfm: framework, framework: { name: "Microsoft.NETCore.App", version } } }));
  return output;
}

test("opt-in helper compiles against installed Unity 6 reference assemblies without launching Unity", t => {
  const c = compiler(t); if (!c) return;
  const editor = process.env.CREATOR_UNITY_REFERENCE_EDITOR;
  if (!editor) { t.skip("Set CREATOR_UNITY_REFERENCE_EDITOR for the native Unity API compile check."); return; }
  const referenceDir = path.join(editor, "Data/NetStandard/ref/2.1.0");
  const engine = path.join(editor, "Data/Managed/UnityEngine");
  assert.ok(existsSync(referenceDir), "Explicit Unity reference path must exist");
  const references = readdirSync(referenceDir).filter(f => f.endsWith(".dll")).map(f => path.join(referenceDir, f));
  references.push(...["UnityEngine.CoreModule.dll", "UnityEngine.JSONSerializeModule.dll"].map(f => path.join(engine, f)));
  compile(c, references, [source, exportSource], path.join(c.root, "CreatorNativeInventory.dll"), "library");
});

test("opt-in helper control flow is bounded and serialized snapshots match the MCP contract (API double, not native acceptance)", t => {
  const c = compiler(t); if (!c) return;
  const output = buildHarness(c);
  const result = spawnSync("dotnet", [output], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.error?.message || result.stdout || result.stderr);
  assert.match(result.stdout, /PASS [0-9]+ isolated control-flow checks/);
  const line = result.stdout.split(/\r?\n/).find(line => line.startsWith("SNAPSHOT:"));
  assert.ok(line);
  const snapshot = JSON.parse(line.slice(9));
  validateNativeInventory(snapshot, "unity-00000000000000000000");
  t.diagnostic(result.stdout.split(/\r?\n/).find(line => line.startsWith("PASS")));
});

test("C# host export and MCP reader integrate across approval, replacement, revocation and restart without altering settings", async t => {
  const c = compiler(t); if (!c) return;
  const output = buildHarness(c);
  const project = path.join(c.root, "Disposable Project");
  mkdirSync(path.join(project, "Assets"), { recursive: true });
  mkdirSync(path.join(project, "ProjectSettings"));
  writeFileSync(path.join(project, "ProjectSettings/ProjectVersion.txt"), "m_EditorVersion: 6000.3.21f1\n");
  const sentinel = path.join(project, "Assets/unchanged.asset");
  writeFileSync(sentinel, "sentinel asset\n");
  const preferences = path.join(c.root, "launcher-config.json");
  writeFileSync(preferences, '{"preference":"keep","channels":[]}');
  const config = createConfigForProject(project, projectIdForPath(project));
  const child = spawn("dotnet", [output, project, config.projectId], { cwd: c.root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = [], waiting = [];
  let stderr = "", exited = false;
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4096); });
  const reader = createInterface({ input: child.stdout });
  reader.on("line", line => { const waiter = waiting.shift(); if (waiter) waiter.resolve(line); else lines.push(line); });
  const done = new Promise(resolve => child.once("exit", (code) => {
    exited = true; for (const waiter of waiting.splice(0)) waiter.reject(new Error(`Harness exited ${code}: ${stderr}`)); resolve(code);
  }));
  const next = () => lines.length ? Promise.resolve(lines.shift()) : new Promise((resolve, reject) => {
    if (exited) { reject(new Error(`Harness exited: ${stderr}`)); return; }
    const timer = setTimeout(() => reject(new Error(`Harness timeout: ${stderr}`)), 5000);
    waiting.push({ resolve(line) { clearTimeout(timer); resolve(line); }, reject(error) { clearTimeout(timer); reject(error); } });
  });
  const command = async value => {
    child.stdin.write(value + "\n");
    const line = await next();
    assert.ok(line.startsWith("RESULT:"), line);
    const result = JSON.parse(line.slice(7));
    if (result.error) t.diagnostic(`${value}: ${result.error}`);
    return result;
  };
  let stopped = false;
  const stop = async () => {
    if (stopped) return; stopped = true;
    child.stdin.end("quit\n");
    const timer = setTimeout(() => child.kill(), 3000);
    await done; clearTimeout(timer); reader.close();
  };
  let mcpClient;
  try {
    assert.equal(await next(), "DENIED:true");
    assert.equal(existsSync(path.join(project, ".bantworks-mcp")), false, "declined consent writes nothing");
    const approved = await command("approve");
    assert.equal(approved.ok, true, approved.error);
    const args = { expectedSessionId: approved.sessionId, expectedBuildGuid: "fixture-build" };
    assert.equal(getNativeInventory(args, config).success, false, "approval is not a completed capture");
    assert.equal((await command("publish")).ok, true);
    const first = getNativeInventory(args, config);
    assert.equal(first.success, true, JSON.stringify(first));
    assert.equal(first.nodes.length, 1);
    assert.equal(first.liveQuery, false);
    mcpClient = new Client({ name: "isolated-native-export-acceptance", version: "1" });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [path.resolve(process.env.MCP_PROTOCOL_ENTRY || "dist/index.js")], cwd: c.root, stderr: "pipe",
      env: { HOME: c.root, USERPROFILE: c.root, APPDATA: c.root, LOCALAPPDATA: c.root,
        XDG_CONFIG_HOME: c.root, UNITY_PROJECT_PATH: project, BANTER_PROJECT_PATH: "",
        CREATOR_WORKS_TOOL_GROUPS: "read", CREATOR_WORKS_LAUNCHER_CONFIG: preferences } });
    await mcpClient.connect(transport, { timeout: 10000 });
    const rpcRead = await mcpClient.callTool({ name: "get_native_inventory", arguments: args }, undefined, { timeout: 10000 });
    assert.notEqual(rpcRead.isError, true, JSON.stringify(rpcRead));
    assert.equal(JSON.parse(rpcRead.content[0].text).contentHash, first.contentHash, "stdio reads the exact C# export");
    const ownedFile = path.join(approved.directory, "snapshot.json");
    const bytes = readFileSync(ownedFile);
    getNativeInventory(args, config); assert.deepEqual(readFileSync(ownedFile), bytes);
    assert.equal((await command("publish")).ok, true);
    assert.equal(getNativeInventory({ ...args, expectedHash: first.contentHash }, config).success, false);

    const keep = path.join(approved.directory, "unrelated.txt"); writeFileSync(keep, "keep");
    writeFileSync(ownedFile, "foreign replacement");
    const cleanup = await command("revoke");
    assert.equal(cleanup.ok, false, "changed data must not be deleted");
    assert.match(cleanup.error, /cleanup could not be verified/);
    assert.equal(readFileSync(ownedFile, "utf8"), "foreign replacement");
    assert.equal(readFileSync(keep, "utf8"), "keep");
    assert.equal(JSON.parse(readFileSync(path.join(approved.directory, "session.json"))).state, "revoked");
    assert.equal(getNativeInventory(args, config).success, false);
    const revokedRead = await mcpClient.callTool({ name: "get_native_inventory", arguments: args }, undefined, { timeout: 10000 });
    assert.equal(revokedRead.isError, true);
    assert.equal((await command("publish")).ok, false);

    const renewed = await command("approve");
    assert.equal(renewed.ok, true, renewed.error); assert.notEqual(renewed.sessionId, approved.sessionId);
    assert.equal((await command("publish")).ok, true);
    const nextArgs = { ...args, expectedSessionId: renewed.sessionId };
    assert.equal(getNativeInventory(nextArgs, config).success, true);
    const disabled = await command("disable");
    assert.equal(disabled.ok, true);
    assert.equal(disabled.error, null, JSON.stringify(disabled));
    assert.equal(existsSync(path.join(renewed.directory, "snapshot.json")), false, JSON.stringify(disabled));
    assert.equal(getNativeInventory(nextArgs, config).success, false);
    const third = await command("approve");
    assert.equal(third.ok, true);
    assert.equal((await command("publish")).ok, true);
    const thirdSnapshot = path.join(third.directory, "snapshot.json");
    const retained = readFileSync(thirdSnapshot);
    const foreignReceipt = path.join(third.directory, "session.json");
    const originalReceipt = readFileSync(foreignReceipt);
    writeFileSync(foreignReceipt, '{"foreign":"keep"}');
    assert.equal((await command("publish")).ok, false, "lost receipt ownership must refuse before overwriting a snapshot");
    assert.deepEqual(readFileSync(thirdSnapshot), retained);
    assert.equal((await command("revoke")).ok, false);
    assert.equal(readFileSync(foreignReceipt, "utf8"), '{"foreign":"keep"}');
    assert.equal((await command("approve")).ok, false, "unverified receipt ownership blocks reapproval");
    writeFileSync(foreignReceipt, originalReceipt);
    assert.equal((await command("revoke")).ok, true, "the fixture restores its exact owned receipt before recovery");
    const locked = await command("approve");
    assert.equal(locked.ok, true);
    assert.equal((await command("publish")).ok, true);
    assert.equal((await command("lock-receipt")).ok, true);
    assert.equal((await command("revoke")).ok, false, "a sharing violation is not successful cleanup");
    assert.equal((await command("approve")).ok, false, "unverified live export cannot be forgotten during reapproval");
    assert.equal((await command("unlock-receipt")).ok, true);
    assert.equal((await command("revoke")).ok, true, "cleanup can retry once the owned file is unlocked");
    assert.equal(existsSync(path.join(locked.directory, "snapshot.json")), false);
    const last = await command("approve");
    assert.equal(last.ok, true); assert.equal((await command("publish")).ok, true);
    await stop();
    assert.equal(JSON.parse(readFileSync(path.join(last.directory, "session.json"))).state, "revoked", "normal host exit revokes its active export");
    const afterExit = getNativeInventory({ ...args, expectedSessionId: last.sessionId }, config);
    assert.equal(afterExit.success, false);
    const restarted = spawnSync("dotnet", [output, project, config.projectId], { cwd: c.root, windowsHide: true, input: "publish\nquit\n", encoding: "utf8", timeout: 10000 });
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.match(restarted.stdout, /DENIED:true/);
    assert.equal(JSON.parse(restarted.stdout.split(/\r?\n/).find(line => line.startsWith("RESULT:")).slice(7)).ok, false, "restart cannot restore approval");

    const linkedProject = path.join(c.root, "Linked State Project"), outside = path.join(c.root, "Outside");
    mkdirSync(path.join(linkedProject, "Assets"), { recursive: true });
    mkdirSync(path.join(linkedProject, "ProjectSettings")); mkdirSync(outside);
    writeFileSync(path.join(linkedProject, "ProjectSettings/ProjectVersion.txt"), "m_EditorVersion: 6000.3.21f1\n");
    symlinkSync(outside, path.join(linkedProject, ".bantworks-mcp"), process.platform === "win32" ? "junction" : "dir");
    const linked = spawnSync("dotnet", [output, linkedProject, config.projectId], { cwd: c.root, windowsHide: true, input: "approve\nquit\n", encoding: "utf8", timeout: 10000 });
    assert.equal(linked.status, 0, linked.stderr);
    assert.equal(JSON.parse(linked.stdout.split(/\r?\n/).find(line => line.startsWith("RESULT:")).slice(7)).ok, false);
    assert.deepEqual(readdirSync(outside), [], "linked state does not redirect exports");
    if (process.platform === "win32") {
      const driveRelative = path.parse(project).root.slice(0, 2);
      const ambiguous = spawnSync("dotnet", [output, driveRelative, config.projectId], { cwd: project, windowsHide: true, input: "approve\nquit\n", encoding: "utf8", timeout: 10000 });
      assert.equal(ambiguous.status, 0, ambiguous.stderr);
      assert.equal(JSON.parse(ambiguous.stdout.split(/\r?\n/).find(line => line.startsWith("RESULT:")).slice(7)).ok, false, "drive-relative paths must not depend on the process working directory");
    }
    assert.equal(readFileSync(sentinel, "utf8"), "sentinel asset\n");
    assert.equal(readFileSync(preferences, "utf8"), '{"preference":"keep","channels":[]}');
    assert.ok(readdirSync(renewed.directory).every(file => !file.endsWith(".tmp")));
  } finally {
    if (mcpClient) await mcpClient.close();
    await stop();
  }
});
