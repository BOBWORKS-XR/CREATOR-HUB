'use strict';
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const KEY = 'HKCU\\Software\\Unity Technologies\\Unity Editor 5.x';
const REG = 'C:/Windows/System32/reg.exe';
const TASKLIST = 'C:/Windows/System32/tasklist.exe';
const OLD_MARKER = 'Banter_GeneratedVSNodesVersion_h4024949815';
const NAMES = Object.freeze([
  'VisualScripting.Core.dimInactiveNodes_h955041597',
  'VisualScripting.Core.dimIncompatibleNodes_h4135596119',
  'VisualScripting.Core.showVariablesHelp_h3648579426',
  'VisualScripting.Core.createSceneVariables_h764933226',
  'VisualScripting.Core.showGrid_h136069214',
  'VisualScripting.Core.snapToGrid_h737844074',
  'VisualScripting.Core.panSpeed_h1838217405',
  'VisualScripting.Core.dragPanSpeed_h221254189',
  'VisualScripting.Core.zoomSpeed_h2912577653',
  'VisualScripting.Core.overviewSmoothing_h2538208068',
  'VisualScripting.Core.carryChildren_h1145191565',
  'VisualScripting.Core.disablePlaymodeTint_h351116593',
  'VisualScripting.Core.debug_h3974091188',
  'VisualScripting.Core.controlScheme_h1079602647',
  'VisualScripting.Core.clearGraphSelection_h1739901552',
  'VisualScripting.Core.humanNaming_h3214476536',
  'VisualScripting.Core.maxSearchResults_h1216023653',
  'VisualScripting.Core.groupInheritedMembers_h2073615133',
  'VisualScripting.Core.limitFuzzyFinderHeight_h2164200919',
  'VisualScripting.Core.developerMode_h2942489904',
  'VisualScripting.Core.trackMetadataState_h324091184',
  'VisualScripting.Core.debugInspectorGUI_h392219620',
  'VisualScripting.Core.editorSetupCompleted_h4225087630',
  'VisualScripting.Flow.updateNodesAutomatically_h320929579',
  'VisualScripting.Flow.predictPotentialNullReferences_h2432315234',
  'VisualScripting.Flow.predictPotentialMissingComponents_h55821081',
  'VisualScripting.Flow.showConnectionValues_h347184961',
  'VisualScripting.Flow.predictConnectionValues_h1339655071',
  'VisualScripting.Flow.hidePortLabels_h1284545792',
  'VisualScripting.Flow.animateControlConnections_h3998904789',
  'VisualScripting.Flow.animateValueConnections_h2469177689',
  'VisualScripting.Flow.skipContextMenu_h379524481',
  'VisualScripting.Flow.editorSetupCompleted_h570183847',
  'VisualScripting.State.statesReveal_h2011139588',
  'VisualScripting.State.transitionsReveal_h2835807676',
  'VisualScripting.State.transitionsEndArrow_h3692974115',
  'VisualScripting.State.animateTransitions_h2594983630',
  'VisualScripting.State.editorSetupCompleted_h1609089154',
]);
const MAX_VALUE = 65536;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function requireThat(ok, message) { if (!ok) { const error = new Error(message); error.predicate = message; throw error; } }
function exactKeys(value, names) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\n') === [...names].sort().join('\n'), 'Exact preference fields required.');
}
function row(hex) {
  const bytes = Buffer.from(hex, 'hex');
  return { present: true, type: 'REG_BINARY', hex, size: bytes.length, sha256: sha(bytes) };
}
function validateRow(value, max = MAX_VALUE) {
  exactKeys(value, ['present', 'type', 'hex', 'size', 'sha256']);
  requireThat(typeof value.hex === 'string' && /^(?:[0-9a-f]{2})*$/.test(value.hex)
    && value.hex.length <= max * 2 && value.present === true && value.type === 'REG_BINARY', 'Existing bounded REG_BINARY required.');
  const expected = row(value.hex);
  requireThat(value.size === expected.size && value.sha256 === expected.sha256, 'Preference bytes and hash differ.');
}
function validate(snapshot) {
  exactKeys(snapshot, ['schemaVersion', 'entries', 'oldMarker']);
  requireThat(snapshot.schemaVersion === 1, 'Preference snapshot version refused.');
  exactKeys(snapshot.entries, NAMES);
  for (const name of NAMES) validateRow(snapshot.entries[name]);
  validateRow(snapshot.oldMarker, 128);
  return snapshot;
}
function same(a, b) {
  validate(a); validate(b);
  return NAMES.every(name => a.entries[name].hex === b.entries[name].hex)
    && a.oldMarker.hex === b.oldMarker.hex;
}
function parseQuery(output, name) {
  requireThat(NAMES.includes(name) || name === OLD_MARKER, 'Unknown registry value refused.');
  requireThat(typeof output === 'string' && Buffer.byteLength(output) <= MAX_VALUE * 3, 'Preference query output bound.');
  const rows = output.split(/\r?\n/).filter(line => line.trim().startsWith(name));
  requireThat(rows.length === 1, 'Exactly one approved existing preference required.');
  const match = /^\s*(\S+)\s+(REG_\S+)\s*([0-9a-fA-F]*)\s*$/.exec(rows[0]);
  requireThat(match && match[1] === name && match[2] === 'REG_BINARY'
    && match[3].length % 2 === 0 && match[3].length <= (name === OLD_MARKER ? 128 : MAX_VALUE) * 2,
  'Preference identity, presence, type or byte bound refused.');
  return row(match[3].toLowerCase());
}
function createGuard({ approved = false, exec = spawnSync } = {}) {
  function authorize() { requireThat(approved === true, 'Explicit VS preference approval required before value access.'); }
  function unityProcesses() {
    const result = exec(TASKLIST, ['/FI', 'IMAGENAME eq Unity.exe', '/FO', 'CSV', '/NH'],
      { windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 65536 });
    requireThat(!result.error && result.status === 0 && typeof result.stdout === 'string'
      && Buffer.byteLength(result.stdout) <= 65536, 'Unity process inventory failed.');
    const lines = result.stdout.split(/\r?\n/).filter(line => line.trim());
    if (lines.length === 1 && /^INFO: No tasks are running which match the specified criteria\.?\s*$/.test(lines[0])) return [];
    requireThat(lines.length > 0, 'Empty Unity inventory refused.');
    return lines.map(line => {
      const match = /^"Unity\.exe","([1-9][0-9]*)",/.exec(line);
      requireThat(match && Number.isSafeInteger(Number(match[1])), 'Unknown Unity inventory row.');
      return Number(match[1]);
    });
  }
  function requireNoUnity() { requireThat(unityProcesses().length === 0, 'Unity remains running; no preference mutation permitted.'); }
  function readOne(name) {
    authorize();
    requireThat(NAMES.includes(name) || name === OLD_MARKER, 'Unknown registry value refused.');
    const result = exec(REG, ['query', KEY, '/v', name, '/reg:64'],
      { windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: MAX_VALUE * 3 });
    requireThat(!result.error && result.status === 0, 'Approved preference query failed; no absent value adoption.');
    return parseQuery(result.stdout, name);
  }
  function capture() {
    authorize(); requireNoUnity();
    const snapshot = { schemaVersion: 1, entries: Object.fromEntries(NAMES.map(name => [name, readOne(name)])),
      oldMarker: readOne(OLD_MARKER) };
    requireNoUnity();
    return validate(snapshot);
  }
  function restore(before, after) {
    authorize(); validate(before); validate(after);
    const progress = { attemptedWrites: 0, restoredKeys: [], restoredExactly: false };
    try {
      requireThat(before.oldMarker.hex === after.oldMarker.hex, 'Read-only SDK marker drift; no restoration authorized.');
      const expected = JSON.parse(JSON.stringify(after));
      for (const name of NAMES) {
        if (before.entries[name].hex === after.entries[name].hex) continue;
        requireThat(same(expected, capture()), 'Preference drift before restoration; remaining entries preserved.');
        requireNoUnity();
        progress.attemptedWrites++;
        const result = exec(REG, ['add', KEY, '/v', name, '/t', 'REG_BINARY', '/d', before.entries[name].hex, '/f', '/reg:64'],
          { windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
        requireThat(!result.error && result.status === 0, 'Preference restoration outcome uncertain; no retry.');
        requireThat(readOne(name).hex === before.entries[name].hex, 'Preference restoration readback differs; no retry.');
        expected.entries[name] = before.entries[name];
        progress.restoredKeys.push(name);
      }
      requireThat(same(before, capture()), 'Final exact preference or SDK marker verification failed.');
      progress.restoredExactly = true;
      return progress;
    } catch (error) {
      const failure = new Error(error.message);
      if (error.predicate) failure.predicate = error.predicate;
      failure.restoration = progress;
      throw failure;
    }
  }
  return { capture, requireNoUnity, unityProcesses, restore };
}
module.exports = { KEY, REG, TASKLIST, OLD_MARKER, NAMES, MAX_VALUE, sha, row, validate, same, parseQuery, createGuard };
