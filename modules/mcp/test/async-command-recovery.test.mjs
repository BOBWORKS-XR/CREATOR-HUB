import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { fixture } from "./helpers/async-command-source.cjs";

const menuMessage = "Executed Unity Editor menu item: CreatorFixture/Run";
const envelope = (id, extra = {}) => ({ commandId: id, success: true, status: "completed", ...extra });
const menu = (id, extra = {}) => ({ commandId: id, success: true, menuPath: "CreatorFixture/Run",
  executionSucceeded: true, executionReturnedTrue: true, diagnostics: [], ...extra });

for (const folder of ["command-results", "command-status"]) {
  test(`menu failure overrides a successful ${folder} envelope and retains diagnostics`, () => {
    const f = fixture(), id = randomUUID();
    f.put(f.receipt(folder, id), envelope(id, { message: menuMessage }));
    const failure = menu(id, { success: false, executionSucceeded: false, error: "Fixture menu failed",
      diagnostics: [{ message: "Fixture failure details" }] });
    const file = f.receipt("editor-menu-results", id);
    f.put(file, failure);
    const status = f.getUnityCommandStatus(id, f.config.projectId, f.config);
    assert.equal(status.status, "completed");
    assert.equal(status.success, false);
    assert.equal(status.error, failure.error);
    assert.deepEqual(JSON.parse(JSON.stringify(status.menuResult)), failure);
    assert.equal(status.executionSucceeded, false);
    assert.equal(f.get(file), JSON.stringify(failure));
  });

  test(`successful menu ${folder} only proves callback return, not asynchronous completion`, () => {
    const f = fixture(), id = randomUUID();
    f.put(f.receipt(folder, id), envelope(id, { message: menuMessage }));
    const receipt = menu(id);
    f.put(f.receipt("editor-menu-results", id), receipt);
    const result = f.getUnityCommandStatus(id, f.config.projectId, f.config);
    assert.equal(result.success, true);
    assert.equal(result.status, "completed");
    assert.equal(result.executionSucceeded, true);
    assert.equal(result.settleVerified, false);
    assert.match(result.message, /not verified/);
    assert.deepEqual(JSON.parse(JSON.stringify(result.menuResult)), receipt);
  });

  for (const typeHint of [{ message: menuMessage }, { commandType: "execute_editor_menu_item" }]) {
    test(`missing menu result is unknown, not successful, for ${folder} and ${Object.keys(typeHint)[0]}`, () => {
      const f = fixture(), id = randomUUID(), file = f.receipt(folder, id);
      const original = envelope(id, typeHint);
      f.put(file, original);
      for (let i = 0; i < 2; i++) {
        const result = f.getUnityCommandStatus(id, f.config.projectId, f.config);
        assert.equal(result.success, false);
        assert.equal(result.status, "unknown");
        assert.equal(result.completion, "unknown");
        assert.match(result.message, /Do not resubmit/);
        assert.equal(result.nextAction.arguments.commandId, id);
        assert.equal(f.get(file), JSON.stringify(original));
      }
      f.put(f.receipt("editor-menu-results", id), menu(id));
      assert.equal(f.getUnityCommandStatus(id, f.config.projectId, f.config).success, true);
    });
  }
}

for (const invalid of [null, [], {}, "bad json", { success: true }, { success: "true" },
  { success: true, executionSucceeded: false }, { success: true, executionReturnedTrue: false },
  { success: true, diagnostics: {} }, { success: true, commandId: randomUUID() }]) {
  test(`malformed menu receipt is retained: ${JSON.stringify(invalid)}`, () => {
    const f = fixture(), id = randomUUID(), outer = f.receipt("command-results", id);
    f.put(outer, envelope(id, { message: menuMessage }));
    const file = f.receipt("editor-menu-results", id);
    f.put(file, invalid && typeof invalid === "object" && !Array.isArray(invalid) ? { commandId: id, ...invalid } : invalid);
    const bytes = f.get(file), outerBytes = f.get(outer);
    const result = f.getUnityCommandStatus(id, f.config.projectId, f.config);
    assert.equal(result.success, false);
    assert.equal(result.status, "unknown");
    assert.match(result.error, /menu result/i);
    assert.equal(f.get(file), bytes);
    assert.equal(f.get(outer), outerBytes);
    assert.equal(f.deletions.length, 0);
  });
}

test("legacy generic, failed and dispatched receipts retain their semantics", () => {
  for (const extra of [{}, { success: false, error: "Rejected before dispatch" }, { status: "dispatched", success: false }]) {
    const f = fixture(), id = randomUUID();
    f.put(f.receipt("command-status", id), envelope(id, extra));
    const result = f.getUnityCommandStatus(id, f.config.projectId, f.config);
    assert.equal(result.success, !extra.status && extra.success !== false);
    assert.equal(result.status, extra.status === "dispatched" ? "dispatched" : "completed");
    assert.equal(result.menuResult, undefined);
  }
});

test("scene receipt success, failure and malformed evidence remain independent of menu results", () => {
  for (const scene of [{ success: true, openScenes: [], buildScenes: [] },
    { success: false, error: "Scene fixture failure" }, { success: true, openScenes: null, buildScenes: [] }]) {
    const f = fixture(), id = randomUUID(), file = f.receipt("command-results", id);
    f.put(file, envelope(id));
    f.put(f.receipt("scene-results", id), { commandId: id, ...scene });
    const result = f.getUnityCommandStatus(id, f.config.projectId, f.config);
    assert.equal(result.success, scene.success && Array.isArray(scene.openScenes));
    assert.equal(result.menuResult, undefined);
    assert.equal(result.status, scene.openScenes === null ? "unknown" : "completed");
    if (scene.openScenes === null) assert.ok(f.get(file));
  }
});

for (const invalid of [null, [], {}, { success: "true" }, { status: "unexpected" }, { projectPath: 42 },
  { projectId: "unity-other" }, { projectPath: path.resolve("different-project") }, { editorInstanceId: "other-editor" }]) {
  test(`invalid generic receipt cannot be consumed or claim success: ${JSON.stringify(invalid)}`, () => {
    const f = fixture(), id = randomUUID(), file = f.receipt("command-results", id);
    f.descriptor();
    const value = invalid === null || Array.isArray(invalid) ? invalid : { commandId: id, ...invalid };
    f.put(file, value);
    const before = f.get(file), result = f.getUnityCommandStatus(id, f.config.projectId, f.config);
    assert.equal(result.success, false);
    assert.equal(result.status, "unknown");
    assert.equal(f.get(file), before);
  });
}

test("status correlation failures and unsafe IDs do not read or delete a foreign result", () => {
  const f = fixture(), id = randomUUID();
  f.put(f.receipt("command-results", id), envelope(id));
  assert.equal(f.getUnityCommandStatus(id, "unity-other", f.config).success, false);
  assert.equal(f.getUnityCommandStatus("../not-a-command", f.config.projectId, f.config).success, false);
  assert.equal(f.deletions.length, 0);
});

for (const invalid of [null, [], "bad json", {}, { success: "true" },
  { projectPath: path.resolve("different-project") }, { projectId: "unity-other" }, { editorInstanceId: "wrong-editor" },
  { commandId: randomUUID() }]) {
  test(`post-send file rejection keeps recovery identity and invalid receipt: ${JSON.stringify(invalid)}`, async () => {
    let received, receiptPath;
    const f = fixture({ platform: "linux", onCommand(command, api) {
      received = command;
      receiptPath = api.receipt("command-results", command.id);
      api.put(receiptPath, invalid && typeof invalid === "object" && !Array.isArray(invalid)
        ? { ...envelope(command.id), ...invalid, ...(Object.keys(invalid).length ? {} : { success: undefined }) } : invalid);
    } });
    f.descriptor();
    await assert.rejects(f.dispatchUnityBridgeCommand({ type: "refresh" }, f.config, 500), error => {
      assert.equal(error instanceof f.BridgeTransportError, true);
      assert.equal(error.commandId, received.id);
      assert.equal(error.projectId, f.config.projectId);
      assert.equal(error.projectPath, f.config.unityProjectPath);
      assert.equal(error.editorInstanceId, "fixture-editor");
      assert.equal(error.deliveryPhase, "sent");
      assert.equal(error.completion, "unknown");
      assert.equal(error.receiptPath, receiptPath);
      assert.equal(error.transport, "file");
      return true;
    });
    assert.ok(f.files.has(receiptPath));
    assert.equal(f.deletions.includes(receiptPath), false);
    assert.equal(f.writes.filter(name => name.endsWith(".tmp")).length, 1);
  });
}

test("file cleanup failure does not lose a validated completion", async () => {
  const f = fixture({ platform: "linux", beforeUnlink() { throw new Error("fixture cleanup failure"); },
    onCommand(command, api) { api.put(api.receipt("command-results", command.id), envelope(command.id)); } });
  const result = await f.dispatchUnityBridgeCommand({ type: "refresh" }, f.config, 500);
  assert.equal(result.acknowledgement.success, true);
  assert.ok(f.get(f.receipt("command-results", result.commandId)));
});

test("valid legacy success and failure acknowledgements keep their original outcome", async () => {
  for (const success of [true, false]) {
    const f = fixture({ platform: "linux", onCommand(command, api) {
      api.put(api.receipt("command-results", command.id), {
        commandId: command.id, success, message: null, error: success ? null : "Fixture rejected operation",
      });
    } });
    const result = await f.dispatchUnityBridgeCommand({ type: "refresh" }, f.config, 100);
    assert.equal(result.queued, false);
    assert.equal(result.acknowledgement.success, success);
    assert.equal(f.get(f.receipt("command-results", result.commandId)), undefined);
  }
});

test("valid command status survives a receipt cleanup error", () => {
  const f = fixture({ beforeUnlink() { throw new Error("Fixture cleanup failure"); } }), id = randomUUID();
  f.put(f.receipt("command-results", id), envelope(id));
  const result = f.getUnityCommandStatus(id, f.config.projectId, f.config);
  assert.equal(result.success, true);
  assert.equal(result.status, "completed");
  assert.ok(f.get(f.receipt("command-results", id)));
});

test("shared validation can reject a late foreign receipt before a caller consumes it", () => {
  const f = fixture(), id = randomUUID(), file = f.receipt("command-results", id);
  f.put(file, envelope(id, { projectPath: path.resolve("foreign-late-project") }));
  const bytes = f.get(file);
  assert.throws(() => f.validateBridgeCommandResult(JSON.parse(bytes), id, f.config), /project mismatch/i);
  assert.equal(f.get(file), bytes);
  assert.equal(f.deletions.length, 0);
  f.validateBridgeCommandResult(envelope(id, { success: false }), id, f.config);
});

test("file timeout keeps the original queued command rather than resending", async () => {
  const f = fixture({ platform: "linux" });
  const result = await f.dispatchUnityBridgeCommand({ type: "refresh" }, f.config, 100);
  assert.equal(result.queued, true);
  assert.equal(result.transport, "file");
  assert.equal(JSON.parse(f.get(f.command(result.commandId))).id, result.commandId);
  assert.equal(f.writes.length, 1);
});

test("pre-send target rejection is distinguishable from unknown completion", async () => {
  const f = fixture();
  f.descriptor({ projectPath: path.resolve("other-project") });
  await assert.rejects(f.dispatchUnityBridgeCommand({ type: "refresh" }, f.config), error => {
    assert.equal(error.deliveryPhase, "not_sent");
    assert.equal(error.completion, "not_started");
    assert.equal(error.projectPath, f.config.unityProjectPath);
    assert.match(error.commandId, /^[0-9a-f-]{36}$/);
    return true;
  });
  assert.equal(f.writes.length, 0);
});

test("serialization failure is pre-send and file publication failure is conservatively unknown", async () => {
  const f = fixture({ platform: "linux" }), circular = {};
  circular.self = circular;
  await assert.rejects(f.dispatchUnityBridgeCommand(circular, f.config), error => error.completion === "not_started");
  assert.equal(f.writes.length, 0);
  const io = fixture({ platform: "linux", beforeRename() { throw new Error("fixture failed rename"); } });
  await assert.rejects(io.dispatchUnityBridgeCommand({ type: "refresh" }, io.config), error => {
    assert.equal(error.deliveryPhase, "possibly_sent");
    assert.equal(error.completion, "unknown");
    return true;
  });
});

for (const extra of [{ projectPath: path.resolve("other-project") }, { editorInstanceId: "wrong-editor" }, { success: "true" }]) {
  test(`post-send pipe rejection keeps command identity without file fallback: ${JSON.stringify(extra)}`, async () => {
    let received;
    const f = fixture({ platform: "win32", onPipeCommand(command, socket) {
      received = command;
      socket.emit("data", Buffer.from(JSON.stringify(envelope(command.id, extra)) + "\n"));
    } });
    f.descriptor();
    await assert.rejects(f.dispatchUnityBridgeCommand({ type: "refresh" }, f.config, 500), error => {
      assert.equal(error.commandId, received.id);
      assert.equal(error.deliveryPhase, "sent");
      assert.equal(error.completion, "unknown");
      assert.equal(error.transport, "named_pipe");
      return true;
    });
    assert.deepEqual(f.writes, ["pipe:" + received.id]);
  });
}

for (const response of [undefined, "not-json\n", "null\n", JSON.stringify(envelope(randomUUID())) + "\n"]) {
  test(`lost or uncorrelated pipe acknowledgement never duplicates a command: ${String(response)}`, async () => {
    const f = fixture({ platform: "win32", onPipeCommand(command, socket) {
      if (response !== undefined) socket.emit("data", Buffer.from(response));
    } });
    f.descriptor();
    const result = await f.dispatchUnityBridgeCommand({ type: "refresh" }, f.config, 500);
    assert.equal(result.queued, true);
    assert.equal(result.transport, "named_pipe");
    assert.deepEqual(f.writes, ["pipe:" + result.commandId]);
  });
}

test("unavailable pipe falls back before delivery; synchronous write errors never fall back", async () => {
  const f = fixture({ platform: "win32", pipeUnavailable: true });
  f.descriptor();
  const result = await f.dispatchUnityBridgeCommand({ type: "refresh" }, f.config, 100);
  assert.equal(result.transport, "file");
  assert.equal(f.writes.length, 1);
  const writeError = fixture({ platform: "win32", writeThrows: true });
  writeError.descriptor();
  const unknown = await writeError.dispatchUnityBridgeCommand({ type: "refresh" }, writeError.config, 100);
  assert.equal(unknown.transport, "named_pipe");
  assert.equal(unknown.queued, true);
  assert.equal(writeError.writes.length, 0);
});

test("recovery target is frozen across an awaited dispatch", async () => {
  let f, initial;
  f = fixture({ platform: "win32", onPipeCommand(command, socket) {
    f.config.unityProjectPath = path.resolve("new-selection");
    f.config.projectId = "new-selection";
    socket.emit("data", Buffer.from(JSON.stringify(envelope(command.id, { projectPath: path.resolve("wrong-project") })) + "\n"));
  } });
  initial = { ...f.config };
  f.descriptor();
  await assert.rejects(f.dispatchUnityBridgeCommand({ type: "refresh" }, f.config, 100), error => {
    assert.equal(error.projectId, initial.projectId);
    assert.equal(error.projectPath, initial.unityProjectPath);
    return true;
  });
});

test("a successful pipe acknowledgement with legacy null fields remains compatible", async () => {
  const f = fixture({ platform: "win32", onPipeCommand(command, socket) {
    socket.emit("data", Buffer.from(JSON.stringify({ commandId: command.id, success: true,
      status: null, message: null, error: null, projectPath: null, editorInstanceId: null }) + "\n"));
  } });
  f.descriptor();
  const result = await f.dispatchUnityBridgeCommand({ type: "refresh" }, f.config, 100);
  assert.equal(result.transport, "named_pipe");
  assert.equal(result.acknowledgement.success, true);
  assert.equal(result.queued, false);
});
