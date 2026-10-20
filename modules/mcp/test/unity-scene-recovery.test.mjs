import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { projectIdForPath } from "../dist/lib/project-router.js";
import { getUnityCommandStatus } from "../dist/tools/get-unity-command-status.js";
import { handleToolCall } from "../dist/tools/index.js";

function fixture(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "creator-scene-recovery-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const root = path.join(project, ".bantworks-mcp");
  const config = {
    unityProjectPath: project,
    projectId: projectIdForPath(project),
    assetsPath: path.join(project, "Assets"),
    mcpStatePath: path.join(root, "state"),
    mcpCommandsPath: path.join(root, "commands"),
    hasUnityExtension: true,
  };
  for (const folder of [config.assetsPath, config.mcpCommandsPath,
    path.join(config.mcpStatePath, "command-status"), path.join(config.mcpStatePath, "scene-results")]) {
    fs.mkdirSync(folder, { recursive: true });
  }
  return config;
}

function sceneReceipt(commandId) {
  return { commandId, success: true, activeSceneName: "Fixture", activeScenePath: "Assets/Fixture.unity",
    openScenes: [{ name: "Fixture", isDirty: false }], buildScenes: [], timestamp: 12345 };
}

function completed(config, commandId) {
  const file = path.join(config.mcpStatePath, "command-status", `${commandId}.json`);
  fs.writeFileSync(file, JSON.stringify({ commandId, success: true, status: "completed",
    projectPath: config.unityProjectPath, editorInstanceId: "fixture-editor" }));
  return file;
}

test("queued scene reads expose the original project/command and never claim completed data", async t => {
  const config = fixture(t);
  // Advance polling deadlines only in this test; production timeouts stay unchanged.
  let now = Date.now();
  t.mock.method(Date, "now", () => now += 31000);
  const response = await handleToolCall("get_unity_scenes", {}, config);
  const result = JSON.parse(response.content[0].text);
  assert.equal(result.success, false);
  assert.equal(result.accepted, true);
  assert.equal(result.pending, true);
  assert.equal(result.status, "queued");
  assert.equal(result.projectId, config.projectId);
  assert.equal(result.projectPath, config.unityProjectPath);
  assert.deepEqual(result.nextAction, { tool: "get_unity_command_status",
    arguments: { commandId: result.commandId, projectId: config.projectId } });
  assert.match(result.message, /Do not resubmit/);
  const commands = fs.readdirSync(config.mcpCommandsPath);
  assert.deepEqual(commands, [`${result.commandId}.json`]);
  const command = JSON.parse(fs.readFileSync(path.join(config.mcpCommandsPath, commands[0]), "utf8"));
  assert.equal(command.type, "get_scenes");

  completed(config, result.commandId);
  const receipt = sceneReceipt(result.commandId);
  const file = path.join(config.mcpStatePath, "scene-results", `${result.commandId}.json`);
  const bytes = JSON.stringify(receipt);
  fs.writeFileSync(file, bytes);
  for (let i = 0; i < 2; i++) {
    const response = await handleToolCall(result.nextAction.tool, result.nextAction.arguments, config);
    const polled = JSON.parse(response.content[0].text);
    assert.equal(polled.success, true);
    assert.equal(polled.pending, false);
    assert.equal(polled.status, "completed");
    assert.deepEqual(polled.sceneResult, receipt);
    assert.equal(fs.readFileSync(file, "utf8"), bytes);
    assert.deepEqual(fs.readdirSync(config.mcpCommandsPath), commands);
  }
});

test("scene recovery refuses malformed or differently correlated results without consuming receipts", t => {
  const config = fixture(t), id = randomUUID();
  const acknowledgement = completed(config, id);
  const before = fs.readFileSync(acknowledgement);
  const file = path.join(config.mcpStatePath, "scene-results", `${id}.json`);
  for (const invalid of [null, [], { ...sceneReceipt(id), commandId: randomUUID() },
    { ...sceneReceipt(id), success: "true" }, { ...sceneReceipt(id), openScenes: null },
    { ...sceneReceipt(id), buildScenes: {} }]) {
    const bytes = JSON.stringify(invalid);
    fs.writeFileSync(file, bytes);
    const result = getUnityCommandStatus(id, config.projectId, config);
    assert.equal(result.success, false);
    assert.equal(result.status, "unknown");
    assert.match(result.error, /scene result/i);
    assert.equal(fs.readFileSync(file, "utf8"), bytes);
    assert.deepEqual(fs.readFileSync(acknowledgement), before);
  }
});

test("scene recovery retains project and Editor correlation checks and ordinary status responses", t => {
  const config = fixture(t), id = randomUUID();
  completed(config, id);
  const file = path.join(config.mcpStatePath, "scene-results", `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(sceneReceipt(id)));
  assert.equal(getUnityCommandStatus(id, "unity-other", config).success, false);
  fs.writeFileSync(path.join(config.mcpStatePath, "project-instance.json"), JSON.stringify({ editorInstanceId: "other-editor" }));
  const wrong = getUnityCommandStatus(id, config.projectId, config);
  assert.equal(wrong.success, false);
  assert.match(wrong.error, /Editor/);
  assert.equal(wrong.sceneResult, undefined);
  fs.rmSync(path.join(config.mcpStatePath, "project-instance.json"));
  fs.rmSync(file);
  const ordinary = getUnityCommandStatus(id, config.projectId, config);
  assert.equal(ordinary.success, true);
  assert.equal(ordinary.sceneResult, undefined);
});

test("immediate scene results remain available for correlated status recovery without another command", async t => {
  const config = fixture(t);
  const bridge = (async () => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const commands = fs.readdirSync(config.mcpCommandsPath);
      if (commands.length) {
        const command = JSON.parse(fs.readFileSync(path.join(config.mcpCommandsPath, commands[0]), "utf8"));
        const id = command.id;
        const result = sceneReceipt(id);
        fs.writeFileSync(path.join(config.mcpStatePath, "scene-results", `${id}.json`), JSON.stringify(result));
        completed(config, id);
        fs.mkdirSync(path.join(config.mcpStatePath, "command-results"), { recursive: true });
        fs.copyFileSync(path.join(config.mcpStatePath, "command-status", `${id}.json`),
          path.join(config.mcpStatePath, "command-results", `${id}.json`));
        fs.rmSync(path.join(config.mcpCommandsPath, commands[0]));
        return result;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Fixture command was not dispatched.");
  })();
  const [response, receipt] = await Promise.all([handleToolCall("get_unity_scenes", {}, config), bridge]);
  const result = JSON.parse(response.content[0].text);
  assert.equal(result.success, true);
  assert.equal(result.pending, false);
  assert.equal(result.status, "completed");
  assert.equal(result.projectId, config.projectId);
  assert.deepEqual(result.openScenes, receipt.openScenes);
  const polled = getUnityCommandStatus(receipt.commandId, config.projectId, config);
  assert.deepEqual(polled.sceneResult, receipt);
  assert.deepEqual(fs.readdirSync(config.mcpCommandsPath), []);
});

test("a correlated scene failure cannot be promoted by a successful generic acknowledgement", t => {
  const config = fixture(t), id = randomUUID();
  completed(config, id);
  const receipt = { commandId: id, success: false, error: "Scene read failed." };
  fs.writeFileSync(path.join(config.mcpStatePath, "scene-results", `${id}.json`), JSON.stringify(receipt));
  const result = getUnityCommandStatus(id, config.projectId, config);
  assert.equal(result.success, false);
  assert.equal(result.pending, false);
  assert.equal(result.status, "completed");
  assert.equal(result.error, receipt.error);
  assert.deepEqual(result.sceneResult, receipt);
});
