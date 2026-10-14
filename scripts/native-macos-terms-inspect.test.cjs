const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const probe = require('./native-macos-app-probe.cjs');
const native = fs.readFileSync(path.join(__dirname, 'native-macos-terms-inspect.swift'), 'utf8').replace(/\r\n/g, '\n');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'creator-mac-terms-tests-')));
let compilerUncertain = false;
after(() => {
  if (compilerUncertain) return;
  const real = fs.realpathSync(scratch);
  assert.equal(path.dirname(real), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(real).startsWith('creator-mac-terms-tests-'));
  fs.rmSync(real, { recursive: true });
});
const owner = { process: { pid: 42, infoPlist: { sha256: 'fixture' } }, window: { id: 17, pid: 42 } };
function receipt() {
  const control = { path: 'root-window/0', pid: 42, windowID: 17, enabled: true, hidden: false,
    parentCFMatches: true, windowCFMatches: true, nativeReferencesStable: true, contained: true,
    hitPeerAXError: 0, hitPeerPIDAXError: 0, hitPeerPID: 42, hitPeerCFMatches: true,
    actionsAXError: 0, actions: ['AXPress'] };
  return { ...probe.acceptance, command: 'terms-inspect', complete: true, readOnly: true,
    actionAttempted: false, permissionRequestsPerformed: false, actionAuthorityEstablished: false, termsAccepted: false,
    process: structuredClone(owner.process), window: structuredClone(owner.window), active: true,
    rootNativeCFReferencePreserved: true, rootReferenceScope: 'native-invocation',
    candidateCount: 2, visitedNodeCount: 34, reads: [],
    package: { bundleIdentifier: 'com.creatorworks.hub', bundleExecutable: 'creator-hub', bundleShortVersion: '0.1.14', infoPlist: structuredClone(owner.process.infoPlist) },
    controls: [{ ...control, role: 'AXCheckBox', title: 'I have read and agree to these terms, including the risk assumption and liability limitations above.', checked: 0 },
      { ...control, path: 'root-window/1', role: 'AXButton', title: 'Accept and continue', enabled: false }] };
}
test('terms CLI is only an explicit independently pinned ordinary14 control, not a press/remote option', () => {
  const args = ['--app', '/tmp/Root.app', '--hub-sha256', 'a'.repeat(64), '--output', '/tmp/new', '--expected-version', '0.1.14',
    '--assembly-receipt', '/tmp/signed-unix-assembly.json', '--assembly-receipt-sha256', 'b'.repeat(64), '--launch-context', 'direct-ordinary'];
  assert.equal(probe.options([...args, '--terms-inspect']).termsInspect, true);
  for (const bad of [args.slice(0, 6), args.map(v => v === 'direct-ordinary' ? 'launchservices-ordinary' : v),
    args.map(v => v === '0.1.14' ? '0.1.13' : v)]) assert.throws(() => probe.options([...bad, '--terms-inspect']));
  assert.throws(() => probe.options([...args, '--terms-inspect', '--press']));
});
test('typed read-only control snapshot permits disabled Continue as observed state, never consent or action authority', () => {
  const r = receipt(); probe.validateTermsInspection(r, owner);
  assert.equal(r.controls[1].enabled, false); assert.equal(r.controls[0].checked, 0);
  assert.equal(r.actionAuthorityEstablished, false); assert.equal(r.termsAccepted, false);
  for (const state of [0, 1]) { r.controls[0].checked = state; probe.validateTermsInspection(r, owner); }
});
test('missing/error/drifted per-control association, state, peer, identity and promoted flags refuse', () => {
  const mutations = [r => r.complete = false, r => r.actionAttempted = true, r => r.actionAuthorityEstablished = true,
    r => r.termsAccepted = true, r => r.nativeGuiAccepted = true, r => r.process.pid++, r => r.window.id++,
    r => r.active = false, r => r.candidateCount = 3, r => r.visitedNodeCount = 513, r => r.reads = Array(257).fill({}),
    r => r.rootNativeCFReferencePreserved = false, r => r.rootReferenceScope = 'serialized-authority',
    r => r.package.bundleShortVersion = '0.1.13', r => r.controls.push(structuredClone(r.controls[0])),
    r => r.controls[1] = structuredClone(r.controls[0])];
  for (const field of ['parentCFMatches', 'windowCFMatches', 'nativeReferencesStable', 'contained', 'hitPeerCFMatches']) {
    mutations.push(r => r.controls[0][field] = false, r => delete r.controls[0][field]);
  }
  mutations.push(r => r.controls[0].enabled = 'true', r => r.controls[0].hidden = null, r => r.controls[0].role = 'AXGroup',
    r => r.controls[0].title = 'Other', r => r.controls[0].pid++, r => r.controls[0].hitPeerPID++,
    r => r.controls[0].windowID++, r => r.controls[0].hitPeerAXError = -25204, r => r.controls[0].hitPeerPIDAXError = -25202,
    r => r.controls[0].actionsAXError = -25204, r => r.controls[0].actions = [], r => r.controls[0].actions = ['AXPress', {}],
    r => r.controls[0].checked = '0', r => r.controls[0].checked = 2);
  for (const change of mutations) { const r = receipt(); change(r); assert.throws(() => probe.validateTermsInspection(r, owner)); }
});
test('terms native source stays bounded/read-only and retains actual native parent/window/peer/reference fences', () => {
  assert.doesNotMatch(native + probe.surfaceSupportSource(), /AXUIElementPerformAction|AXUIElementSetAttributeValue|CGRequestScreenCaptureAccess|AXIsProcessTrustedWithOptions|\.activate\(|terminate\(|kill\(|osascript|evaluateJavaScript/);
  for (const guard of ['+ 4', 'depth <= 16', 'seen.count < 512', 'termsReads.count < 256', '0.2', 'terms-remote-process-drift',
    'termsLinkMatches(linkedParent, parentElement)', 'termsLinkMatches(linkedWindow, window)', 'CFEqual($0, candidate.item)',
    'CFEqual(current[0], window)', 'try fence(p, parent)', 'AXUIElementCopyElementAtPosition', 'CFBooleanGetTypeID()',
    'CFNumberIsFloatType', 'value == 0 || value == 1', 'names.count <= 32', 'parentChildren.filter']) assert.ok(native.includes(guard), guard);
  assert.ok(native.indexOf('try admitted()') < native.indexOf('let root = AXUIElementCreateApplication(pid)'));
  assert.match(native, /termsResult\["actionAuthorityEstablished"\] = false/);
  assert.match(native, /termsResult\["termsAccepted"\] = false/);
  const js = fs.readFileSync(path.join(__dirname, 'native-macos-app-probe.cjs'), 'utf8');
  assert.match(js, /process.arch === 'x64' && env.CREATOR_MACOS_TERMS_INSPECT === '1'/);
  assert.match(js, /write\('terms-control-inspection.json', receipt\)/);
  assert.match(native, /for attempt in 0\.\.<32/);
  assert.match(native, /termsReadinessStarted \+ 20/);
  assert.match(native, /termsDeadline = min\(termsReadinessDeadline, started \+ 4\)/);
  assert.match(native, /termsAttempts.append/);
  assert.match(native, /termsPinnedOwner/); assert.match(native, /termsPinnedWindow/);
  assert.match(native, /if !metadataFailures.contains\(failure.reason\) \{ throw failure \}/);
});
async function run(file, args, env) {
  const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', data => { assert.ok(out.length + data.length <= 1048576); out += data; });
  child.stderr.on('data', data => { assert.ok(err.length + data.length <= 1048576); err += data; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { compilerUncertain = true; child.stdout.unref?.(); child.stderr.unref?.(); child.unref(); reject(Error('native test tool lifetime unknown; evidence retained')); }, 120000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, err }); });
  });
}
async function compile(name, main) {
  const dir = path.join(scratch, name); fs.mkdirSync(dir);
  const support = path.join(dir, 'support.swift'), file = path.join(dir, 'main.swift'), binary = path.join(dir, 'native');
  fs.writeFileSync(support, probe.surfaceSupportSource(), { flag: 'wx' }); fs.writeFileSync(file, main, { flag: 'wx' });
  const result = await run('/usr/bin/swiftc', [support, file, '-o', binary], process.env);
  assert.equal(result.code, 0, result.err); assert.equal(result.signal, null); return binary;
}
test('SDK compiles actual readonly terms inspector and local/poisoned admission refuses without Root launch', { skip: process.platform !== 'darwin' }, async () => {
  const binary = await compile('guard', native);
  for (const args of [[], ['/not-read.json', '1']]) {
    const result = await run(binary, args, { GITHUB_ACTIONS: 'false' });
    assert.equal(result.code, 2, result.err); assert.equal(result.signal, null);
    const r = JSON.parse(result.out); assert.equal(r.error, 'hosted-ci-explicit-opt-in-required');
    assert.equal(r.actionAttempted, false); assert.equal(r.termsAccepted, false);
  }
});
test('SDK pure native negatives cover all association facts, typed state and wrong/nil/error AX reads with no live target', { skip: process.platform !== 'darwin' }, async () => {
  const declarations = native.split('\nvar termsAttempts =')[0]
    .replace('AXUIElementSetMessagingTimeout(item, 0.2)', 'fixtureTimeout(item, 0.2)')
    .replace('AXUIElementCopyAttributeValue(item, key as CFString, &raw)', 'fixtureRead(item, key as CFString, &raw)');
  const fixture = declarations + String.raw`
var fixtureStatus = AXError.success, fixtureValue: CFTypeRef?
func fixtureTimeout(_ item: AXUIElement, _ seconds: Float) -> AXError { return .success }
func fixtureRead(_ item: AXUIElement, _ key: CFString, _ raw: inout CFTypeRef?) -> AXError { raw = fixtureValue; return fixtureStatus }
do {
    let good = Dictionary(uniqueKeysWithValues: termsFactNames.map { ($0, true) })
    try requireTermsFacts(good)
    for key in termsFactNames {
        for absent in [true, false] {
            var bad = good; if absent { bad.removeValue(forKey: key) } else { bad[key] = false }
            var refused = false; do { try requireTermsFacts(bad) } catch { refused = true }
            try check(refused, "fixture-missing-fact-accepted")
        }
    }
    for raw in ["true" as CFString, NSNumber(value: 1), NSNull()] as [CFTypeRef] {
        var refused = false; do { _ = try termsBoolean(raw) } catch { refused = true }
        try check(refused, "fixture-boolean-coerced")
    }
    try check(try termsBoolean(kCFBooleanTrue) && !termsBoolean(kCFBooleanFalse), "fixture-boolean-drift")
    for raw in ["0" as CFString, NSNumber(value: 2), NSNumber(value: -1), NSNumber(value: 0.5), NSNull()] as [CFTypeRef] {
        var refused = false; do { _ = try termsChecked(raw) } catch { refused = true }
        try check(refused, "fixture-value-coerced")
    }
    try check(try termsChecked(NSNumber(value: 0)) == 0 && termsChecked(NSNumber(value: 1)) == 1, "fixture-checked-drift")
    let one = AXUIElementCreateApplication(42), other = AXUIElementCreateApplication(43)
    try check(termsLinkMatches(one, one) && !termsLinkMatches(other, one) && !termsLinkMatches("wrong" as CFString, one), "fixture-link-coercion")
    for reason in ["terms-native-association-unverified", "terms-root-cf-drift", "terms-owner-bytes-drift", "terms-boolean-type-unverified", "owned-process-start-drift"] {
        try check(!termsReadinessPending(reason, nil, [:]), "fixture-unsafe-readiness-retry")
    }
    try check(termsReadinessPending("ax-children-unbounded-or-unreadable", ["phase": "terms-root-discovery", "axError": -25204], [:]), "fixture-native-readiness-error-lost")
    try check(!termsReadinessPending("ax-children-unbounded-or-unreadable", ["phase": "terms-control-reference-recheck", "axError": -25204], [:]), "fixture-control-read-refusal-retried")
    try check(!termsReadinessPending("terms-controls-not-unique", nil, ["candidateCount": 3]), "fixture-ambiguity-retried")
    termsDeadline = ProcessInfo.processInfo.systemUptime + 4
    for (status, raw) in [(AXError.cannotComplete, nil as CFTypeRef?), (.noValue, nil), (.attributeUnsupported, nil), (.success, nil)] {
        fixtureStatus = status; fixtureValue = raw
        var refused = false; do { _ = try termsRead(one, kAXParentAttribute, "fixture", "fixture-node") } catch { refused = true }
        try check(refused, "fixture-error-or-missing-link-accepted")
    }
    emit(["fixtureVerified": true, "actionAttempted": false]); exit(0)
} catch { emit(["error": String(describing: error)]); exit(2) }
`;
  const binary = await compile('pure', fixture), result = await run(binary, [], process.env);
  assert.equal(result.code, 0, result.err || result.out); assert.equal(result.signal, null);
  assert.equal(JSON.parse(result.out).fixtureVerified, true);
});
