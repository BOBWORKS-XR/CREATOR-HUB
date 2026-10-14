const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { BASELINE, VERSIONS, bumpRootVersion, sourceEntries, compileEnvironment, buildFixture } = require('./build-outer-update-fixture.cjs');

test('fixture admits only the native Windows x64 explicit acceptance context before filesystem access', () => {
  const rejectInspection = new Proxy({}, { get() { throw Error('Must not inspect baseline'); } });
  const base = { platform: 'win32', arch: 'x64', env: { CREATOR_OUTER_UPDATE_FIXTURE: '1' }, baseline: rejectInspection };
  for (const override of [{ platform: 'linux' }, { platform: 'darwin' }, { arch: 'arm64' }, { env: {} }]) {
    assert.throws(() => buildFixture('case', { ...base, ...override }), error => !error.message.includes('Must not inspect'));
  }
  assert.throws(() => buildFixture('../foreign', base), error => !error.message.includes('Must not inspect'));
});

test('JSON version-only fixture preserves all other values and refuses missing/duplicate fields', () => {
  const source = Buffer.from('{"version":"0.1.14","future":{"version":"keep"},"number":14}');
  assert.deepEqual(JSON.parse(bumpRootVersion('package.json', source)), { version: '0.1.15', future: { version: 'keep' }, number: 14 });
  for (const body of ['{}', '{"version":"0.1.13"}', '{"version":"0.1.14","version":"0.1.14"}']) {
    assert.throws(() => bumpRootVersion('package.json', Buffer.from(body)));
  }
});

test('Rust version fixture changes exactly the root package, with LF or CRLF and no module/dependency bumps', () => {
  for (const newline of ['\n', '\r\n']) {
    const root = `[package]${newline}name = "creator-hub"${newline}version = "0.1.14"${newline}`;
    const dependency = `[[package]]${newline}name = "other"${newline}version = "0.1.14"${newline}`;
    assert.equal(bumpRootVersion('src-tauri/Cargo.toml', Buffer.from(root)).toString(), root.replace('0.1.14', '0.1.15'));
    const lock = root.replace('[package]', '[[package]]') + dependency;
    assert.equal(bumpRootVersion('src-tauri/Cargo.lock', Buffer.from(lock)).toString(), lock.replace('0.1.14', '0.1.15'));
  }
  assert.throws(() => bumpRootVersion('native/other/Cargo.toml', Buffer.from('version = "0.1.14"')));
});

test('source export rejects links, submodules, duplicate paths and traversal before extraction', () => {
  const sha = 'a'.repeat(40);
  const valid = VERSIONS.map(name => `100644 blob ${sha}\t${name}\0`).join('');
  assert.equal(Object.keys(sourceEntries(valid)).length, 4);
  assert.equal(Object.keys(sourceEntries(valid + `100644 blob ${sha}\tsrc-tauri/icons/128x128@2x.png\0`)).length, 5);
  for (const bad of [`120000 blob ${sha}\tlink\0`, `160000 commit ${sha}\tmodule\0`,
    `100644 blob ${sha}\t../outside\0`, `100644 blob ${sha}\t/absolute\0`, `100644 blob ${sha}\tpackage.json\0`]) {
    assert.throws(() => sourceEntries(valid + bad));
  }
});

test('compile child strips signing material and injection flags without changing caller environment', () => {
  const env = { PATH: 'keep', CREATOR_HUB_SIGNING_KEY_PATH: 'private', GH_TOKEN: 'private', NODE_OPTIONS: 'inject',
    RUSTFLAGS: 'inject', CARGO_ENCODED_RUSTFLAGS: 'inject', TAURI_SIGNING_PRIVATE_KEY: 'private', CARGO_TARGET_DIR: 'foreign' };
  const before = structuredClone(env);
  assert.deepEqual(compileEnvironment(env, 'reviewed-manifest', 'owned-target'), { PATH: 'keep',
    CREATOR_BUILTIN_MANIFEST: 'reviewed-manifest', CARGO_TARGET_DIR: 'owned-target',
    CREATOR_MCP_HOST_WRITABLE: '1', CREATOR_MCP_HOST_READONLY_EVENTS: '1' });
  assert.deepEqual(env, before);
});

test('fixture pins current reviewed input, checks signed payloads and retains explicit unaccepted scope', () => {
  assert.equal(BASELINE.commit, '42a35d17c8f0c2f5e61ecaa6ce21aafb2725312f');
  assert.equal(BASELINE.hashes['installer.exe'], 'b3a42b8d67ef94edefa9cefa9e3791a196febb9d88a2163d38dcfed49c09c13d');
  const source = fs.readFileSync(path.join(__dirname, 'build-outer-update-fixture.cjs'), 'utf8');
  assert.ok(source.includes("['verify-package-input', 'verify-managed-runtime', 'verify-release']"));
  assert.ok(source.includes('privateModulesRecompiled: false, privateModulesResigned: false, privateKeyIncluded: false'));
  assert.ok(source.includes('outgoingNativeUpdateTested: false, viewsRestored: false, releaseReady: false'));
  assert.ok(source.includes('capture(path.join(root, name), VERSION_SOURCE_LIMIT)'));
  assert.ok(source.includes('bumpRootVersion(name, bytes(file, VERSION_SOURCE_LIMIT))'));
  assert.ok(source.includes("const producerSidecars = ['routing/router.json.sig', 'routing/runtime.json.sig']"));
  assert.ok(source.includes("'Producer signature differs from verified package signature'"));
  assert.ok(source.includes("['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive'"));
  assert.doesNotMatch(source, /readFileSync\(key|readFileSync\([^)]*auth\.json|release (?:create|edit|upload)/);
});
