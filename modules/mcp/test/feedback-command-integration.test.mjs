import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createConfigForProject } from "../dist/lib/config.js";
import { projectIdForPath } from "../dist/lib/project-router.js";
import { handleToolCall } from "../dist/tools/index.js";

function project(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "creator-command-integration-"));
  fs.mkdirSync(path.join(folder, "Assets"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const config = createConfigForProject(folder);
  config.projectId = projectIdForPath(folder);
  fs.mkdirSync(config.mcpCommandsPath, { recursive: true });
  return config;
}

test("post-send identity errors keep a single recoverable command and its receipt", { timeout: 10000 }, async t => {
  const config = project(t);
  const resultFolder = path.join(config.mcpStatePath, "command-results");
  fs.mkdirSync(resultFolder, { recursive: true });
  let receiptPath;
  const timer = setInterval(() => {
    const file = fs.readdirSync(config.mcpCommandsPath).find(file => file.endsWith(".json"));
    if (!file || receiptPath) return;
    const command = JSON.parse(fs.readFileSync(path.join(config.mcpCommandsPath, file), "utf8"));
    receiptPath = path.join(resultFolder, `${command.id}.json`);
    fs.writeFileSync(receiptPath, JSON.stringify({ commandId: command.id, success: true, projectPath: path.join(config.unityProjectPath, "foreign") }));
  }, 10);
  try {
    const result = JSON.parse((await handleToolCall("refresh_unity_assets", {}, config)).content[0].text);
    assert.equal(result.success, false);
    assert.equal(result.pending, true);
    assert.equal(result.completion, "unknown");
    assert.equal(result.deliveryPhase, "sent");
    assert.match(result.commandId, /^[a-f0-9-]{36}$/);
    assert.equal(result.projectId, config.projectId);
    assert.equal(result.nextAction.arguments.commandId, result.commandId);
    assert.ok(fs.existsSync(receiptPath));
    assert.equal(fs.readdirSync(config.mcpCommandsPath).length, 1);
  } finally { clearInterval(timer); }
});

test("polled menu failure is a tool error with redacted diagnostics and retained evidence", async t => {
  const config = project(t);
  const id = "31faac5a-b2e5-44ca-98c1-aea3e9a145b6";
  const generic = path.join(config.mcpStatePath, "command-results");
  const typed = path.join(config.mcpStatePath, "editor-menu-results");
  fs.mkdirSync(generic, { recursive: true }); fs.mkdirSync(typed, { recursive: true });
  fs.writeFileSync(path.join(generic, `${id}.json`), JSON.stringify({ commandId: id, success: true, projectPath: config.unityProjectPath, commandType: "execute_editor_menu_item" }));
  const file = path.join(typed, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ commandId: id, success: false, menuPath: "Custom/Test", error: "Authorization: Bearer PRIVATE",
    diagnostics: [{ level: "Error", message: "https://example.invalid/file?sig=PRIVATE" }] }));
  const result = await handleToolCall("get_unity_command_status", { commandId: id, projectId: config.projectId }, config);
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).success, false);
  assert.ok(!result.content[0].text.includes("PRIVATE"));
  assert.ok(fs.existsSync(file));
});
