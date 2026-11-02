const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const probe = require('./native-macos-app-probe.cjs');
const source = fs.readFileSync(path.join(__dirname, 'native-macos-terms-action.swift'), 'utf8');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'creator-semantic-tests-')));
let compilerUncertain = false;
after(() => {
  if (compilerUncertain) return;
  const real = fs.realpathSync(scratch);
  assert.equal(path.dirname(real), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(real).startsWith('creator-semantic-tests-'));
  fs.rmSync(real, { recursive: true });
});
const owner = { process: { pid: 42, infoPlist: { sha256: 'fixture' } }, window: { id: 17, pid: 42 } };
function receipt() {
  const rows = checked => ['AXCheckBox', 'AXButton'].map((role, i) => ({ role, path: `root-window/${i}`,
    title: i ? 'Accept and continue' : 'I have read and agree to these terms, including the risk assumption and liability limitations above.',
    pid: 42, windowID: 17, parentPID: 42, documentPID: 42, containerPID: 42,
    enabled: i ? !!checked : true, ...(i ? {} : { checked }), actionMethod: 'held-element-semantic-AXPress',
    parentCFMatches: true, windowCFMatches: true, nativeReferencesStable: true, contained: true,
    actionsAXError: 0, actions: ['AXPress'], fieldErrors: [] }));
  return { ...probe.acceptance, command: 'terms-semantic', contractRevision: 1, complete: true, diagnosticOnly: true,
    actionAttempted: true, permissionRequestsPerformed: false, pointerMethodAdmitted: false, termsAccepted: false,
    process: owner.process, window: owner.window,
    package: { bundleShortVersion: '0.1.14', bundleIdentifier: 'com.creatorworks.hub', bundleExecutable: 'creator-hub', infoPlist: owner.process.infoPlist },
    dialogAbsentVerified: true, rootNativeCFReferencePreserved: true, rootReferenceScope: 'native-invocation', elapsedMilliseconds: 4000,
    actions: ['AXCheckBox', 'AXButton'].map((role, i) => ({ role, path: `root-window/${i}`, action: 'AXPress', axResult: 0, startedUptime: 10 + i, returnedUptime: 10.5 + i })),
    before: rows(0), afterCheckbox: rows(1), attempts: [{}],
    lastCapture: { complete: true, documentCount: 1, candidateCount: 0, containerCount: 0, headingCount: 0,
      process: owner.process, window: owner.window, rootNativeCFReferencePreserved: true, rootReferenceScope: 'native-invocation' } };
}
test('semantic CLI remains exact Intel ordinary14 scope, independent of pointer inspection', () => {
  const args = ['--app', '/tmp/Root.app', '--hub-sha256', 'a'.repeat(64), '--output', '/tmp/new', '--expected-version', '0.1.14',
    '--assembly-receipt', '/tmp/signed-unix-assembly.json', '--assembly-receipt-sha256', 'b'.repeat(64), '--launch-context', 'direct-ordinary'];
  assert.equal(probe.options([...args, '--terms-semantic']).termsSemantic, true);
  assert.equal(probe.options([...args, '--terms-semantic']).termsInspect, undefined);
  for (const bad of [args.slice(0, 6), args.map(v => v === 'direct-ordinary' ? 'launchservices-ordinary' : v),
    args.map(v => v === '0.1.14' ? '0.1.13' : v), [...args, '--terms-inspect']]) {
    assert.throws(() => probe.options([...bad, '--terms-semantic']));
  }
});
test('semantic receipt needs both exact transitions and native disappearance, not a group hit or API return alone', () => {
  probe.validateSemanticTerms(receipt(), owner);
  const mutations = [r => r.complete = false, r => r.actionAttempted = false, r => r.pointerMethodAdmitted = true,
    r => r.nativeGuiAccepted = true, r => r.termsAccepted = true, r => r.process = { ...r.process, pid: 99 },
    r => r.window = { ...r.window, id: 99 }, r => r.actions.reverse(), r => r.actions.pop(),
    r => r.actions.push(r.actions[1]), r => r.actions[0].axResult = -25204, r => r.actions[1].axResult = -25202,
    r => r.actions[1].role = 'AXGroup', r => r.actions[1].startedUptime = 9,
    r => r.before[0].checked = 1, r => r.before[1].enabled = true, r => r.afterCheckbox[0].checked = 0,
    r => r.afterCheckbox[1].enabled = false, r => r.afterCheckbox[0].parentCFMatches = false,
    r => r.afterCheckbox[0].pid = 99, r => r.afterCheckbox[0].windowCFMatches = false,
    r => r.afterCheckbox[0].nativeReferencesStable = false, r => r.afterCheckbox[0].contained = false,
    r => r.afterCheckbox[0].actionsAXError = -25204, r => r.afterCheckbox[0].fieldErrors.push({}),
    r => r.dialogAbsentVerified = false, r => r.lastCapture.candidateCount = 2, r => r.lastCapture.documentCount = 0,
    r => r.lastCapture.complete = false, r => r.rootReferenceScope = 'serialized-authority', r => r.elapsedMilliseconds = 99999];
  for (const change of mutations) { const r = structuredClone(receipt()); change(r); assert.throws(() => probe.validateSemanticTerms(r, owner)); }
});
test('consent proof reads only exact app record and refuses old, future, malformed, oversized or linked records', () => {
  const home = path.join(scratch, 'home'); fs.mkdirSync(home);
  const file = probe.consentRecordPath(home); assert.equal(fs.existsSync(file), false);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const valid = { schemaVersion: 1, policyVersion: '2026-09-28-v1', acceptedAtMs: 101 };
  for (const value of [{ ...valid, acceptedAtMs: 1 }, { ...valid, acceptedAtMs: 201 }, { ...valid, policyVersion: 'old' },
    { ...valid, schemaVersion: 2 }, { ...valid, extra: true }, 'malformed', 'x'.repeat(2049)]) {
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    assert.throws(() => probe.readNativeConsent(home, 100, 200));
  }
  fs.writeFileSync(file, JSON.stringify(valid));
  const before = fs.readFileSync(file), saved = probe.readNativeConsent(home, 100, 200);
  assert.equal(saved.acceptedAtMs, 101); assert.equal(saved.readOnlyVerification, true); assert.deepEqual(fs.readFileSync(file), before);
  const manager = fs.readFileSync(path.join(__dirname, '../src-tauri/src/manager.rs'), 'utf8');
  const terms = fs.readFileSync(path.join(__dirname, '../src-tauri/src/usage_terms.rs'), 'utf8');
  assert.match(manager, /dirs::data_local_dir\(\)[\s\S]*?\.join\("CreatorHub"\)/);
  assert.match(terms, /manager::child_dir\("consent"\)\?\.join\("hub-usage-terms.json"\)/);
  const linked = path.join(scratch, 'hard-linked-consent'); fs.linkSync(file, linked);
  assert.throws(() => probe.readNativeConsent(home, 100, 200));
});
test('consent record symlink cannot supply native acceptance', { skip: process.platform === 'win32' }, () => {
  const home = path.join(scratch, 'linked-home'); fs.mkdirSync(home);
  const file = probe.consentRecordPath(home), original = path.join(scratch, 'consent-original.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(original, JSON.stringify({ schemaVersion: 1, policyVersion: '2026-09-28-v1', acceptedAtMs: 101 }));
  fs.symlinkSync(original, file);
  assert.throws(() => probe.readNativeConsent(home, 100, 200));
});
test('action source has one exact semantic call site, never coordinate targeting, remote presses, IPC or storage writes', () => {
  assert.equal((source.match(/AXUIElementPerformAction\(/g) || []).length, 1);
  assert.match(source, /AXUIElementPerformAction\(target.item, kAXPressAction as CFString\)/);
  assert.doesNotMatch(source, /AXUIElementCopyElementAtPosition|AXUIElementSetAttributeValue|\.activate\(|kill\(|terminate\(|evaluateJavaScript|localStorage|write\(/);
  for (const guard of ['try admitted()', 'CREATOR_MACOS_TERMS_SEMANTIC', 'try pidMatches(target.item', 'try held.verifyRoot()',
    'semanticActions.append', 'try sameHeldTerms(held, current)', 'terms-semantic-document-drift', 'semanticStarted + 20',
    'semanticAttempts.count < 32', 'terms-semantic-immediate-membership-drift', 'terms-semantic-immediate-bounds-drift',
    'terms-semantic-checkbox-state-drift', 'try requireSemanticPressSuccess(result)']) assert.ok(source.includes(guard), guard);
  assert.ok(source.indexOf('semanticActions.append') < source.indexOf('let result = AXUIElementPerformAction'));
  const support = probe.termsSupportSource();
  assert.match(support, /if contract == \.pointer \{[\s\S]*?AXUIElementCopyElementAtPosition/);
  assert.match(support, /if contract == \.pointer \{ try requireTermsFacts\(facts\) \} else \{ try requireSemanticFacts\(facts\) \}/);
  assert.doesNotMatch(support, /AXUIElementPerformAction|AXUIElementSetAttributeValue/);
});
function compile(name, main) {
  const dir = path.join(scratch, name); fs.mkdirSync(dir);
  for (const [file, text] of [['support.swift', probe.surfaceSupportSource()], ['terms.swift', probe.termsSupportSource()], ['main.swift', main]]) {
    fs.writeFileSync(path.join(dir, file), text, { flag: 'wx' });
  }
  const binary = path.join(dir, 'native');
  const result = spawnSync('/usr/bin/swiftc', ['support.swift', 'terms.swift', 'main.swift'].map(f => path.join(dir, f)).concat(['-o', binary]), { encoding: 'utf8', timeout: 120000 });
  if (result.error) compilerUncertain = true;
  assert.equal(result.status, 0, result.stderr); assert.equal(result.signal, null);
  return binary;
}
test('SDK compiles real semantic helper; unowned/local/poisoned execution cannot press', { skip: process.platform !== 'darwin' }, () => {
  const binary = compile('admission', source);
  const result = spawnSync(binary, ['/never-read-owner', '1'], { env: { GITHUB_ACTIONS: 'false' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 2, result.stderr); assert.equal(result.signal, null);
  const r = JSON.parse(result.stdout); assert.equal(r.actionAttempted, false); assert.deepEqual(r.actions, []);
  assert.equal(r.error, 'hosted-ci-explicit-opt-in-required');
});
test('SDK pure semantic policy preserves pointer refusal and rejects missing facts, ref drift, wrong states, repeat/error/other actions', { skip: process.platform !== 'darwin' }, () => {
  const declarations = source.split('\nvar semanticReceipt:')[0];
  const binary = compile('pure', declarations + String.raw`
func denied(_ body: () throws -> Void) throws { var refused = false; do { try body() } catch { refused = true }; try check(refused, "fixture-unsafe-acceptance") }
do {
    var facts = Dictionary(uniqueKeysWithValues: termsFactNames.map { ($0, true) })
    for key in ["activationPoint", "hitPeerCF", "hitPeerPID"] { facts[key] = false }
    try requireSemanticFacts(facts); try denied { try requireTermsFacts(facts) }
    for key in semanticFactNames { var bad = facts; bad[key] = false; try denied { try requireSemanticFacts(bad) }; bad.removeValue(forKey: key); try denied { try requireSemanticFacts(bad) } }
    let one = AXUIElementCreateApplication(42), other = AXUIElementCreateApplication(43)
    func candidate(_ item: AXUIElement, _ parent: AXUIElement, _ container: AXUIElement, _ doc: AXUIElement, _ role: String) -> TermsCandidate {
        return TermsCandidate(item: item, parent: parent, container: container, document: doc, path: role, role: role, title: role)
    }
    let roles = ["AXCheckBox", "AXButton"]
    let originals = roles.map { candidate(one, one, one, one, $0) }
    let good = HeldTerms(candidates: originals, documents: [one], verifyRoot: {})
    try sameHeldTerms(good, good)
    for index in 0..<4 {
        let refs = (0..<4).map { $0 == index ? other : one }
        let bad = HeldTerms(candidates: [candidate(refs[0], refs[1], refs[2], refs[3], roles[0]), originals[1]], documents: [one], verifyRoot: {})
        try denied { try sameHeldTerms(good, bad) }
    }
    try denied { try sameHeldTerms(good, HeldTerms(candidates: originals, documents: [other], verifyRoot: {})) }
    let before: [[String: Any]] = [["role": "AXCheckBox", "title": termsCheckbox, "checked": 0, "enabled": true], ["role": "AXButton", "title": termsContinue, "enabled": false]]
    var after = before; after[0]["checked"] = 1; after[1]["enabled"] = true
    try semanticState(before, 0, false); try semanticState(after, 1, true)
    try denied { try semanticState(before, 1, true) }; try denied { try semanticState(after, 0, false) }
    try check(semanticStatePending(before) && !semanticStatePending(after), "fixture-state-poll-drift")
    var impossible = before; impossible[1]["enabled"] = true
    try check(!semanticStatePending(impossible), "fixture-impossible-state-pending")
    try requireSemanticSequence("AXCheckBox", []); try requireSemanticSequence("AXButton", [["role": "AXCheckBox", "axResult": Int32(0)]])
    for role in ["AXGroup", "close-window", "AXButton"] { try denied { try requireSemanticSequence(role, []) } }
    try denied { try requireSemanticSequence("AXCheckBox", [["role": "AXCheckBox", "axResult": Int32(0)]]) }
    for status in [AXError.cannotComplete, .invalidUIElement, .actionUnsupported, .failure] {
        try denied { try requireSemanticPressSuccess(status) }
        try denied { try requireSemanticSequence("AXButton", [["role": "AXCheckBox", "axResult": status.rawValue]]) }
    }
    for reason in ["terms-native-association-unverified", "terms-root-cf-drift", "terms-owner-bytes-drift", "owned-process-start-drift"] {
        try check(!semanticReadinessPending(reason, nil, [:]), "fixture-drift-retried")
    }
    let pending: [String: Any] = ["phase": "remote-before", "attribute": "AXParent", "axError": Int32(-25204), "timeoutSetAXError": Int32(0), "valuePresent": false]
    try check(semanticReadinessPending("terms-attribute-unavailable", pending, [:]), "fixture-readiness-lost")
    for key in ["phase", "attribute", "axError", "timeoutSetAXError", "valuePresent"] {
        var bad = pending; bad.removeValue(forKey: key)
        try check(!semanticReadinessPending("terms-attribute-unavailable", bad, [:]), "fixture-missing-link-admitted")
    }
    termsRows = before; termsResult = ["process": ["pid": NSNumber(value: 42)]]; termsPinnedWindow = one
    for reason in ["owned-process-start-drift", "image-drift", "terms-root-cf-drift", "terms-owned-application-not-visible"] {
        let dead = HeldTerms(candidates: originals, documents: [one], verifyRoot: { throw Denied(reason) })
        try denied { try semanticPressOnce(dead, "AXCheckBox", 0, false) }
        try check(semanticActions.isEmpty, "fixture-preaction-failure-pressed")
    }
    emit(["fixtureVerified": true, "actionAttempted": false]); exit(0)
} catch { emit(["error": String(describing: error)]); exit(2) }
`);
  const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.stdout); assert.equal(result.signal, null);
  assert.equal(JSON.parse(result.stdout).fixtureVerified, true);
});
