import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { waitForUnityCompile } from "../dist/tools/check-import-status.js";
import { handleToolCall, registerTools } from "../dist/tools/index.js";

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "creator-feedback-boundary-"));
  const config = { projectId: "fixture", unityProjectPath: root, assetsPath: path.join(root, "Assets"),
    mcpStatePath: path.join(root, ".bantworks-mcp/state"), mcpCommandsPath: path.join(root, ".bantworks-mcp/commands"),
    webRootPath: path.join(root, "Assets/WebRoot"), hasUnityExtension: true };
  await mkdir(config.mcpStatePath, { recursive: true });
  await mkdir(config.mcpCommandsPath, { recursive: true });
  const write = (name, value) => writeFile(path.join(config.mcpStatePath, name), JSON.stringify(value));
  try { await run(config, write); } finally { await rm(root, { recursive: true, force: true }); }
}

async function idle(write, timestamp = Date.now()) {
  await write("editor-state.json", { timestamp: Date.now(), isCompiling: false, isUpdating: false });
  await write("compilation-status.json", { timestamp, completed: true, hasErrors: false, errors: [], warnings: [] });
}

test("a compile boundary rejects a previously completed compilation even with a fresh idle heartbeat", async () => {
  await fixture(async (config, write) => {
    const boundary = Date.now();
    await idle(write, boundary - 1000);
    const result = await waitForUnityCompile(1000, config, { sinceTimestamp: boundary });
    assert.equal(result.success, false);
    assert.equal(result.settled, false);
    assert.equal(result.sinceTimestamp, boundary);
    assert.equal(result.compilationSinceVerified, false);
  });
});

test("pending refresh cannot be replaced by an old idle state and its original command stays queued", async () => {
  await fixture(async (config, write) => {
    await idle(write);
    const id = randomUUID(), file = path.join(config.mcpCommandsPath, `${id}.json`);
    const original = JSON.stringify({ id, type: "refresh" });
    await writeFile(file, original);
    const result = await waitForUnityCompile(1000, config, { afterCommandId: id });
    assert.equal(result.success, false);
    assert.equal(result.settled, false);
    assert.equal(result.afterCommandId, id);
    assert.equal(result.commandStatus, "pending");
    assert.equal(await readFile(file, "utf8"), original);
    assert.deepEqual(await readdir(config.mcpCommandsPath), [`${id}.json`]);
  });
});

test("both command completion and a newer compiler result satisfy the explicit boundary", async () => {
  await fixture(async (config, write) => {
    const boundary = Date.now(), id = randomUUID();
    await idle(write, boundary - 1000);
    await mkdir(path.join(config.mcpStatePath, "command-status"));
    await write(`command-status/${id}.json`, { commandId: id, status: "completed", success: true,
      timestamp: boundary, projectPath: config.unityProjectPath });
    await idle(write, boundary + 1);
    const result = await waitForUnityCompile(2000, config, { afterCommandId: id, sinceTimestamp: boundary });
    assert.equal(result.success, true);
    assert.equal(result.settled, true);
    assert.equal(result.commandStatus, "completed");
    assert.equal(result.compilationSinceVerified, true);
  });
});

test("completed command still requires a subsequent Editor heartbeat", async () => {
  await fixture(async (config, write) => {
    const now = Date.now(), id = randomUUID();
    await idle(write, now + 1);
    await write("editor-state.json", { timestamp: now - 100, isCompiling: false, isUpdating: false });
    await mkdir(path.join(config.mcpStatePath, "command-status"));
    await write(`command-status/${id}.json`, { commandId: id, status: "completed", success: true,
      timestamp: now, projectPath: config.unityProjectPath });
    const result = await waitForUnityCompile(1000, config, { afterCommandId: id });
    assert.equal(result.settled, false);
  });
});

test("a malformed heartbeat timestamp cannot satisfy a command-correlated wait", async () => {
  await fixture(async (config, write) => {
    const now = Date.now(), id = randomUUID();
    await idle(write, now);
    await write("editor-state.json", { timestamp: "invalid", isCompiling: false, isUpdating: false });
    await mkdir(path.join(config.mcpStatePath, "command-status"));
    await write(`command-status/${id}.json`, { commandId: id, status: "completed", success: true,
      timestamp: now, projectPath: config.unityProjectPath });
    const result = await waitForUnityCompile(1000, config, { afterCommandId: id });
    assert.equal(result.settled, false);
  });
});

test("a newer failed compilation retains its errors and tool-call boundary forwarding", async () => {
  await fixture(async (config, write) => {
    const boundary = Date.now();
    await idle(write, boundary);
    await write("compilation-status.json", { timestamp: boundary, completed: true, hasErrors: true,
      errors: [{ message: "CS1002 ; expected", file: "Assets/Broken.cs" }], warnings: [] });
    const result = JSON.parse((await handleToolCall("wait_for_unity_compile", {
      timeoutMs: 1000, sinceTimestamp: boundary,
    }, config)).content[0].text);
    assert.equal(result.settled, true);
    assert.equal(result.success, false);
    assert.equal(result.compilationSinceVerified, true);
    assert.equal(result.sinceTimestamp, boundary);
    assert.equal(result.compilerErrors[0].file, "Assets/Broken.cs");
    assert.deepEqual(await readdir(config.mcpCommandsPath), []);
  });
});

test("a pending refresh returns its original command and time boundary without resubmitting", async () => {
  await fixture(async (config) => {
    const startedAt = Date.now();
    const result = JSON.parse((await handleToolCall("refresh_unity_assets", {}, config)).content[0].text);
    assert.equal(result.pending, true);
    assert.equal(result.success, false);
    assert.ok(result.refreshRequestedAt >= startedAt && result.refreshRequestedAt <= Date.now());
    assert.deepEqual(result.nextAction, { tool: "wait_for_unity_compile", arguments: { afterCommandId: result.commandId } });
    assert.match(result.compilationNote, /sinceTimestamp=refreshRequestedAt/);
    assert.deepEqual(await readdir(config.mcpCommandsPath), [`${result.commandId}.json`]);
  });
});

test("invalid, failed, foreign or uncorrelated command evidence never proves compile readiness", async () => {
  await fixture(async (config, write) => {
    await idle(write);
    await mkdir(path.join(config.mcpStatePath, "command-status"));
    for (const changes of [{ success: false, error: "refresh failed" }, { projectPath: "C:/foreign" },
      { commandId: randomUUID() }, { timestamp: undefined }]) {
      const id = randomUUID();
      await write(`command-status/${id}.json`, { commandId: id, status: "completed", success: true,
        timestamp: Date.now(), projectPath: config.unityProjectPath, ...changes });
      const result = await waitForUnityCompile(1000, config, { afterCommandId: id });
      assert.equal(result.success, false);
      assert.equal(result.settled, false);
    }
    for (const afterCommandId of ["../outside", "not-an-id", 42]) {
      assert.equal((await waitForUnityCompile(1000, config, { afterCommandId })).settled, false);
    }
    for (const sinceTimestamp of [-1, 1.5, "123", null, Infinity, Date.now() + 60000]) {
      assert.equal((await waitForUnityCompile(1000, config, { sinceTimestamp })).settled, false);
    }
    assert.deepEqual(await readdir(config.mcpCommandsPath), []);
  });
});

test("object-reference owner and diagnostic bounds are explained and enforced before dispatch", async () => {
  await fixture(async (config) => {
    for (const owner of [{}, { objectPath: " " }, { objectId: 42 }]) {
      const result = JSON.parse((await handleToolCall("set_object_reference", {
        propertyName: "head", componentId: "component", targetPath: "Target", ...owner,
      }, config)).content[0].text);
      assert.equal(result.success, false);
      assert.match(result.error, /owning GameObject/);
      assert.deepEqual(await readdir(config.mcpCommandsPath), []);
    }
    const tools = new Map(registerTools().map(tool => [tool.name, tool]));
    assert.match(tools.get("set_object_reference").inputSchema.properties.componentId.description, /owner selector/);
    const budget = tools.get("get_console_logs").inputSchema.properties.maxResponseBytes;
    assert.match(budget.description, /16384-4194304, default 65536/);
    assert.equal(budget.minimum, 16384);
    assert.equal(budget.maximum, 4194304);
    assert.ok(tools.get("wait_for_unity_compile").inputSchema.properties.afterCommandId);
    assert.ok(tools.get("wait_for_unity_compile").inputSchema.properties.sinceTimestamp);
  });
});
