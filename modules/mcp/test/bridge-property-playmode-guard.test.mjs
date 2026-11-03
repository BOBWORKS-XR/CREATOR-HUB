import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridge = fs.readFileSync(
  path.join(root, "unity-extension", "Editor", "BanterMCPBridge.cs"),
  "utf8"
);

test("component property writes reject Play Mode before resolution or mutation", () => {
  const start = bridge.indexOf("private static void SetComponentProperty(");
  assert.notEqual(start, -1, "SetComponentProperty must exist");
  const end = bridge.indexOf("private static void SetObjectReference(", start);
  assert.ok(end > start, "SetComponentProperty must have a bounded source region");
  const handler = bridge.slice(start, end);
  const body = handler.slice(handler.indexOf("{") + 1);
  const guard = /^\s*if\s*\(EditorApplication\.isPlayingOrWillChangePlaymode\)\s*throw new InvalidOperationException\(\s*"Stop Play Mode before setting component properties\."\s*\);/.exec(body);
  assert.ok(guard, "The handler must begin with the Play Mode rejection guard");

  for (const marker of [
    "ResolveGameObject(",
    "ResolveComponent(",
    "new SerializedObject(",
    "Undo.RecordObject(",
    "SetSerializedPropertyValue(",
    "so.ApplyModifiedProperties();",
    "EditorSceneManager.MarkSceneDirty(",
  ]) {
    const offset = body.indexOf(marker);
    assert.notEqual(offset, -1, `Existing operation must remain: ${marker}`);
    assert.ok(offset >= guard[0].length, `Play Mode must reject before ${marker}`);
  }
});
