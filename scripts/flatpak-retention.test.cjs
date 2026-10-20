const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const pkg = require('./flatpak-package.cjs');
const runner = require('./flatpak-disposable.cjs');
const config = path.resolve(os.tmpdir(), 'owned-flatpak-retention-fixture', 'home', '.var', 'app', pkg.ID, 'config');
const sha = pkg.sha256('{"foreign":"preserve","unknown":{"value":17}}\n');
const output = () => `${config}\n${sha}  ${path.join(config, 'retention-fixture.json')}\n`;
const permissions = () => '[Context]\nshared=ipc;\nsockets=x11;wayland;fallback-x11;\ndevices=dri;\n';

test('normal app-private read is bracketed by installed-context checks and only overrides the command', () => {
  const events = [], context = { ref: pkg.REF, commit: 'a'.repeat(64), permissionsSha256: pkg.sha256(permissions()) };
  const result = runner.retentionProbe((label, program, args, options) => {
    events.push('read'); assert.equal(label, 'read'); assert.equal(program, runner.FLATPAK);
    assert.deepEqual(args, ['run', '--user', '--command=sh', pkg.REF, '-c', runner.RETENTION_SCRIPT]);
    assert.deepEqual(options, { timeout: 30000, maxBuffer: 8192 });
    return output();
  }, phase => { events.push(phase); runner.parsePermissions(permissions()); return context; }, config, sha);
  assert.deepEqual(events, ['before', 'read', 'after']);
  assert.equal(result.mode, 'normal-app-sandbox-read-only'); assert.equal(result.config, config); assert.equal(result.sha256, sha);
});

test('captured --sandbox probe cannot establish app-private persistence from host XDG config', () => {
  // Run 38619251453: successful linkage followed by this exact failed read.
  const captured = 'sha256sum: /home/runner/work/_temp/creator-flatpak-qqmjjs/config/retention-fixture.json: No such file or directory\n';
  assert.equal(Buffer.byteLength(captured), 115);
  assert.equal(pkg.sha256(captured), 'd226acb69098c83615bab17da1a1fe8cacf0f0bf7ba96b69673ceb6ec381b09a');
  assert.throws(() => runner.parseRetention('', config, sha), /Exact mapped config/);
  const hostConfig = path.resolve(os.tmpdir(), 'owned-flatpak-retention-fixture', 'config');
  assert.throws(() => runner.parseRetention(`${hostConfig}\n${sha}  ${path.join(hostConfig, 'retention-fixture.json')}`, config, sha), /independently derived app-private/);
  assert.equal(runner.parseRetention(output(), config, sha).sha256, sha);
});

test('retention refuses missing, changed, foreign, ambiguous and oversized read output', () => {
  for (const text of ['', `${config}\n`, output().replace(sha, 'f'.repeat(64)), `${output()}extra\n`,
    output().replace('retention-fixture.json', 'foreign.json'), output().replace(`${config}\n`, `${config}/../config\n`)]) {
    assert.throws(() => runner.parseRetention(text, config, sha));
  }
  assert.throws(() => runner.parseRetention('x'.repeat(8193), config, sha), /Bounded retention/);
});

test('failed before-check prevents the read; after-check failure or drift never becomes success', () => {
  let reads = 0;
  const command = () => { reads++; return output(); };
  assert.throws(() => runner.retentionProbe(command, () => { throw Error('foreign installed permissions'); }, config, sha));
  assert.equal(reads, 0);
  assert.throws(() => runner.retentionProbe(command, phase => {
    if (phase === 'after') throw Error('deployment changed');
    return { commit: 'a'.repeat(64) };
  }, config, sha), /deployment changed/);
  assert.throws(() => runner.retentionProbe(command, phase => ({ commit: (phase === 'before' ? 'a' : 'b').repeat(64) }), config, sha), /context changed/);
  assert.equal(reads, 2);
});

test('effective permissions reject overridden filesystems, network, buses and environment', () => {
  runner.parsePermissions(permissions());
  for (const text of [permissions().replace('ipc;', 'ipc;network;'), `${permissions()}filesystems=home;\n`,
    `${permissions()}[Session Bus Policy]\norg.freedesktop.Flatpak=talk\n`, `${permissions()}[Environment]\nENV=/foreign\n`,
    `${permissions()}[Context]\n`, `${permissions()}shared=ipc;\n`, permissions().replace('x11;wayland;fallback-x11;', 'x11;wayland;'),
    permissions().replace('dri;', 'all;'), `${permissions()}[Application]\nname=${pkg.ID}\n`]) {
    assert.throws(() => runner.parsePermissions(text));
  }
});

test('production recheck binds ref, commit, metadata, effective permissions, runtime, files and fixture', () => {
  const source = pkg.read(path.join(__dirname, 'flatpak-disposable.cjs'), 65536).toString();
  for (const option of ['--show-ref', '--show-commit', '--show-location', '--show-metadata', '--show-permissions']) assert.ok(source.includes(option));
  assert.ok(source.includes('parsePermissions(permissions)'));
  assert.ok(source.includes("verifyFiles(path.join(deployed, 'files'), receipt.files)"));
  assert.ok(source.includes("assert.deepEqual(pkg.read(fixture, 8192), fixtureBytes"));
  assert.ok(source.includes('report.runtimeCommit'));
  assert.ok(source.includes("['run', '--user', '--sandbox', '--command=sh', pkg.REF, '-c', ABI_SCRIPT]"));
  assert.ok(source.includes("['run', '--user', '--command=sh', pkg.REF, '-c', RETENTION_SCRIPT]"));
  assert.ok(!source.includes("['run', '--user', '--sandbox', '--command=sh', pkg.REF, '-c', RETENTION_SCRIPT]"));
  assert.ok(!/flatpak-spawn|--filesystem|--allow=devel|--socket=|shell:\s*true/.test(source));
});
