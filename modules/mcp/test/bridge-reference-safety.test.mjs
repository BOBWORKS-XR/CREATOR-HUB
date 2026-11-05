import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const bridge = fs.readFileSync('unity-extension/Editor/BanterMCPBridge.cs', 'utf8');
function method(name, next) {
  const start = bridge.indexOf(name);
  const end = bridge.indexOf(next, start + name.length);
  assert.ok(start >= 0 && end > start);
  return bridge.slice(start, end);
}

test('reference commands refuse Play Mode before resolving or writing a component', () => {
  for (const [name, next] of [
    ['private static void SetObjectReference(', 'private static string SetAssetReference('],
    ['private static string SetAssetReference(', 'private static void SetSerializedAssetReference('],
  ]) {
    const body = method(name, next);
    assert.ok(body.indexOf('EditorApplication.isPlayingOrWillChangePlaymode') < body.indexOf('ResolveGameObject('));
    assert.match(body, /Reference assignment requires Edit Mode/);
  }
});

test('object references reuse staging, retained-value checks and verified restoration', () => {
  const body = method('private static void SetObjectReference(', 'private static string SetAssetReference(');
  assert.match(body, /SetSerializedAssetReference\(component, so, prop, cmd\.propertyName, targetObject, cmd\.componentType\)/);
  assert.ok(body.indexOf('SetSerializedAssetReference(') < body.indexOf('MarkSceneDirty('));
  assert.match(body, /explicitly use targetPath: 'null'/);
  const helper = method('private static void SetSerializedAssetReference(', 'private static void SetReflectedAssetReference(');
  assert.ok(helper.indexOf('property.objectReferenceValue != targetAsset') < helper.indexOf('Undo.RecordObject'));
  assert.match(helper, /Unity did not retain the requested reference/);
  assert.match(helper, /rollbackProperty\.objectReferenceValue = previousAsset/);
  assert.match(helper, /previous reference was not retained/);
});

test('graph import exports source fingerprints and actual element identities', () => {
  const body = method('private static void ValidateVisualScriptingGraphAsset(', 'private static string VisualScriptingSourceHash(');
  assert.ok(body.indexOf('cmd.expectedContentHash') < body.indexOf('AssetDatabase.ImportAsset('));
  assert.ok(body.indexOf('EditorUtility.IsDirty(beforeImport)') < body.indexOf('AssetDatabase.ImportAsset('));
  assert.match(body, /elementIdentities\.Add\(elementGuid\.ToString\("D"\)/);
  assert.match(body, /Graph source changed during import/);
});
