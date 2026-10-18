'use strict';
// Synthetic bytes and caller-local ephemeral TLS only. No Hub or installer runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const tls = require('node:tls');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const lab = require('./linux-update-lab-feed.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const source = fs.readFileSync(require.resolve('./linux-update-lab-feed.cjs'), 'utf8');
const runner = () => ({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux',
  RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512',
  GITHUB_REF: lab.BRANCH, GITHUB_EVENT_NAME: 'workflow_dispatch', CREATOR_LINUX_UPDATE_LAB_FEED: '1',
  GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '39105426143', RUNNER_TEMP: os.tmpdir() });

function input() {
  const installer = Buffer.from('SYNTHETIC NON-DEB BYTES: no installation/signature acceptance');
  const descriptorSignature = Buffer.from('untrusted comment: SYNTHETIC NONCRYPTOGRAPHIC DESCRIPTOR FIXTURE\n');
  const descriptor = Buffer.from(JSON.stringify({ schemaVersion: 1, appId: 'creator-hub', version: '0.1.15',
    platform: 'linux', architecture: 'x86_64', packageType: 'deb', assetName: lab.ASSET,
    byteLength: installer.length, sha256: hash(installer), executableSha256: 'b'.repeat(64),
    identityProtocol: 0, lifecycleProtocol: 0, installerProtocol: 1, minHubVersion: '0.1.14' }));
  const manifest = Buffer.from(JSON.stringify({ version: '0.1.15', notes: 'TEST ONLY. Never publish.', platforms: {
    'linux-x86_64-deb': { url: `https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.15/${lab.ASSET}`,
      signature: Buffer.from('untrusted comment: SYNTHETIC NONCRYPTOGRAPHIC INSTALLER FIXTURE\n').toString('base64') },
  } }));
  const data = { targetVersion: '0.1.15', descriptor, descriptorSignature, installer, manifest };
  data.pins = { ...Object.fromEntries(['descriptor', 'descriptorSignature', 'installer', 'manifest'].map(name => [name, hash(data[name])])), executable: 'b'.repeat(64) };
  return data;
}
function change(data, field, update) {
  const value = JSON.parse(data[field]); update(value);
  data[field] = Buffer.from(JSON.stringify(value)); data.pins[field] = hash(data[field]); return data;
}
function request(route, extra = {}) {
  const req = { method: 'GET', httpVersion: '1.1', url: route.path, headers: { host: route.host }, ...extra };
  req.rawHeaders ??= Object.entries(req.headers).flat(); return req;
}

test('fixed Linux14 -> acceptance-only15 descriptor, package key, asset and five actual GitHub paths', () => {
  const contract = lab.createContract(input());
  assert.equal(lab.FROM, '0.1.14'); assert.equal(lab.TO, '0.1.15');
  assert.equal(lab.DESCRIPTOR, 'creator-hub-linux-x86_64-deb.json'); assert.equal(lab.PLATFORM, 'linux-x86_64-deb');
  assert.equal(lab.ASSET, 'Creator_Hub_0.1.15_amd64-acceptance-only.deb');
  const prefix = '/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.15/';
  assert.deepEqual(contract.routes.map(route => [route.host, route.path]), [
    ['api.github.com', '/repos/BOBWORKS-XR/CREATOR-HUB/releases?per_page=10'],
    ...[lab.DESCRIPTOR, `${lab.DESCRIPTOR}.minisig`, lab.ASSET, 'latest.json'].map(name => ['github.com', prefix + name]),
  ]);
  assert.ok(Object.isFrozen(contract) && Object.isFrozen(contract.pins) && Object.isFrozen(contract.routes));
});

test('guarded native input pins are exactly the parent-reviewed 39105404389 DEB and installed ELF', () => {
  assert.ok(Object.isFrozen(lab.REVIEWED_TARGET));
  assert.deepEqual(lab.REVIEWED_TARGET, { bytes: 62212268,
    installer: '98aa9750cecf387a960f994d24726e5ca09100a5ce3723607939eeaa08d80796',
    executable: '7629379fbd3d0b7db0a996d727aa166750e08165478d622fe0d7c5047f2d50fe' });
  lab.reviewedTargetPins(lab.REVIEWED_TARGET, lab.REVIEWED_TARGET.bytes);
  assert.throws(() => lab.reviewedTargetPins(input().pins, lab.REVIEWED_TARGET.bytes));
  assert.throws(() => lab.reviewedTargetPins(lab.REVIEWED_TARGET, lab.REVIEWED_TARGET.bytes + 1));
  for (const name of ['installer', 'executable']) assert.throws(() => lab.reviewedTargetPins({ ...lab.REVIEWED_TARGET, [name]: 'c'.repeat(64) }, lab.REVIEWED_TARGET.bytes));
  assert.ok(source.indexOf('reviewedTargetPins(contract.pins,') < source.indexOf('return startLoopbackTransport(contract, options);'));
});

test('all lab/native/public/signature/migration/update/restart gates remain explicitly separate', () => {
  const report = lab.labReport(lab.createContract(input()), lab.newState());
  assert.equal(report.labDiscovery, true); assert.equal(report.targetVersion, '0.1.15');
  for (const field of ['publicDiscovery', 'nativeAcceptanceTested', 'baselineActuallyTested', 'signaturesVerifiedByHarness',
    'signedUpdateAccepted', 'migrationAccepted', 'restartAccepted', 'restoredViewsAccepted', 'liveAiAcceptance', 'releaseReady']) {
    assert.equal(report[field], false, field);
  }
  assert.deepEqual(report.requests, []);
});

test('integrated39134454264 profile binds all five exact pins without changing the old profile', () => {
  const profile = 'integrated-39134454264', target = lab.INTEGRATED_TARGET;
  assert.ok(Object.isFrozen(target));
  assert.equal(target.bytes, 63874030);
  assert.equal(target.installer, '4cbd1488e0568e79ad8a9bc47d445cbbb344abc2c72045cde2dd3cd5e72fb36d');
  assert.equal(target.executable, 'fc18fd79ab9fd1f9456b1f124acaba2390ea3501e1617e3f91dea082d9ce7a56');
  lab.reviewedTargetPins(target, target.bytes, profile);
  for (const name of ['descriptor', 'descriptorSignature', 'installer', 'manifest', 'executable'])
    assert.throws(() => lab.reviewedTargetPins({ ...target, [name]: 'c'.repeat(64) }, target.bytes, profile), undefined, name);
  assert.throws(() => lab.reviewedTargetPins(target, target.bytes + 1, profile));
  assert.throws(() => lab.reviewedTargetPins(lab.REVIEWED_TARGET, lab.REVIEWED_TARGET.bytes, profile));
  assert.throws(() => lab.reviewedTargetPins(target, target.bytes));
  assert.throws(() => lab.reviewedTargetPins(target, target.bytes, 'arbitrary-profile'));
});

test('new native branch requires explicit integrated opt-in and manual event; no synthetic entry bypass', () => {
  const env = { ...runner(), GITHUB_REF: lab.INTEGRATED_BRANCH, CREATOR_LINUX_INTEGRATED_UPDATE: '1' };
  assert.equal(lab.INTEGRATED_BRANCH, 'refs/heads/validation/linux-integrated-update');
  lab.assertRunner(env, 'linux', 'x64', 21314, 21314);
  for (const changed of [{ CREATOR_LINUX_INTEGRATED_UPDATE: undefined }, { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_REF: lab.INTEGRATED_BRANCH + '-other' }, { SSL_CERT_FILE: '/fake' }])
    assert.throws(() => lab.assertRunner({ ...env, ...changed }, 'linux', 'x64', 21314, 21314));
  assert.ok(source.includes("env.GITHUB_REF === INTEGRATED_BRANCH ? 'integrated-39134454264' : 'legacy'"));
});

test('external pins and immutable copied bytes are required for every served candidate input', () => {
  for (const field of ['descriptor', 'descriptorSignature', 'installer', 'manifest']) {
    const data = input(); data[field][0] ^= 1;
    assert.throws(() => lab.createContract(data), /SHA-256 mismatch/);
  }
  for (const pin of ['', '0'.repeat(64), 'A'.repeat(64), 'a'.repeat(63)]) {
    const data = input(); data.pins.executable = pin; assert.throws(() => lab.createContract(data));
  }
  const extra = input(); extra.pins.keyPath = 'forbidden'; assert.throws(() => lab.createContract(extra));
  const data = input(), original = Buffer.from(data.installer), contract = lab.createContract(data);
  data.installer.fill(0); data.descriptor.fill(0); data.manifest.fill(0);
  const result = lab.resolveRequest(contract, 'github.com', request(contract.routes[3]), lab.newState());
  assert.deepEqual(result.route.bytes, original);
});

test('only exact target15/min14 Linux DEB identity and guarded installer protocol admit', () => {
  for (const targetVersion of ['0.1.14', '0.1.16', '0.1.15-rc.1', '0.1.15+lab', 'v0.1.15']) {
    assert.throws(() => lab.createContract({ ...input(), targetVersion }));
  }
  const changes = { schemaVersion: 2, appId: 'creator-works-mcp', version: '0.1.16', platform: 'windows',
    architecture: 'aarch64', packageType: 'appimage', assetName: '../acceptance.deb', byteLength: 1,
    sha256: 'c'.repeat(64), executableSha256: 'c'.repeat(64), identityProtocol: 2, lifecycleProtocol: -1,
    installerProtocol: 0, minHubVersion: '0.1.12' };
  for (const [field, value] of Object.entries(changes)) assert.throws(() => lab.createContract(change(input(), 'descriptor', d => { d[field] = value; })), undefined, field);
  assert.throws(() => lab.createContract(change(input(), 'descriptor', d => { d.minHubVersion = '0.1.15'; })));
  assert.throws(() => lab.createContract(change(input(), 'descriptor', d => { d.foreign = true; })));
  assert.throws(() => lab.createContract({ ...input(), baseline: 'masquerade' }));
});

test('metadata size, fatal UTF-8, plain descriptor minisig and canonical updater signature refuse malformed inputs', () => {
  for (const [field, max] of [['descriptor', lab.LIMITS.metadata], ['descriptorSignature', lab.LIMITS.signature], ['manifest', lab.LIMITS.metadata]]) {
    const data = input(); data[field] = Buffer.alloc(max + 1); assert.throws(() => lab.createContract(data), /size outside bounds/);
  }
  const empty = input(); empty.installer = Buffer.alloc(0); assert.throws(() => lab.createContract(empty));
  for (const bytes of [Buffer.from([0xff]), Buffer.from('\ufeffuntrusted comment: BOM'), Buffer.from('encoded-no-envelope'), Buffer.from('untrusted comment: nul\0')]) {
    const data = input(); data.descriptorSignature = bytes; data.pins.descriptorSignature = hash(bytes);
    assert.throws(() => lab.createContract(data));
  }
  for (const signature of ['', 'not base64', 'dW50cnVzdGVkIGNvbW1lbnQ6\n', Buffer.from('wrong envelope').toString('base64')]) {
    assert.throws(() => lab.createContract(change(input(), 'manifest', d => { d.platforms[lab.PLATFORM].signature = signature; })));
  }
});

test('manifest cannot redirect, switch platform, add query/auth/fragment or nominate other assets', () => {
  for (const url of [`http://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.15/${lab.ASSET}`,
    'https://evil.test/installer.deb', `https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.15/${lab.ASSET}?download=1`,
    `https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.15/${lab.ASSET}#fragment`,
    `https://user@github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.15/${lab.ASSET}`]) {
    assert.throws(() => lab.createContract(change(input(), 'manifest', d => { d.platforms[lab.PLATFORM].url = url; })));
  }
  for (const mutate of [d => { d.version = '0.1.14'; }, d => { d.platforms['windows-x86_64'] = d.platforms[lab.PLATFORM]; },
    d => { d.platforms['linux-x86_64-rpm'] = d.platforms[lab.PLATFORM]; }, d => { d.platforms[lab.PLATFORM].headers = {}; },
    d => { delete d.platforms[lab.PLATFORM].signature; }, d => { d.extra = 'foreign'; }]) {
    assert.throws(() => lab.createContract(change(input(), 'manifest', mutate)));
  }
});

test('exact CONNECT authorities only, without aliases, userinfo, IPs, alternate ports or paths', () => {
  for (const host of ['api.github.com', 'github.com']) assert.equal(lab.connectHost(`${host}:443`), host);
  for (const authority of ['github.com', 'github.com:80', 'github.com:0443', 'GITHUB.COM:443', 'github.com.:443',
    'user@github.com:443', 'github.com:443/path', 'https://github.com:443', '127.0.0.1:443', '[::1]:443', null]) assert.equal(lab.connectHost(authority), null);
});

test('raw HTTP identity, unique safe headers, no credentials/cookies/framing or unknown headers', () => {
  const route = lab.createContract(input()).routes[0];
  assert.ok(lab.headersAllowed(request(route)));
  for (const key of ['authorization', 'proxy-authorization', 'cookie', 'cookie2', 'transfer-encoding', 'upgrade', 'forwarded', 'x-forwarded-host', 'x-foreign']) {
    assert.equal(lab.headersAllowed(request(route, { headers: { host: route.host, [key]: 'DO-NOT-LOG' } })), false, key);
  }
  for (const rawHeaders of [[], ['Host', route.host, 'host', route.host], ['Host', 'evil.test'], ['Host'], ['Host', route.host, 'Accept', 'one', 'accept', 'two']]) {
    assert.equal(lab.headersAllowed(request(route, { rawHeaders })), false);
  }
  for (const headers of [{ host: route.host, 'content-length': '1' }, { host: route.host, connection: 'upgrade' },
    { host: route.host, connection: 'authorization' }, { host: route.host, accept: '\r\nforeign' }]) assert.equal(lab.headersAllowed(request(route, { headers })), false);
  assert.equal(lab.headersAllowed(request(route, { httpVersion: '1.0' })), false);
  assert.ok(lab.headersAllowed(request(route, { headers: { host: route.host, 'content-length': '0' } })));
  assert.equal(lab.headersAllowed(request(route, { headers: { host: route.host, 'content-length': '0' } }), true), false);
});

test('raw origin path, tunnel/Host binding, method and finite response/request/received-byte budgets', () => {
  const contract = lab.createContract(input()), route = contract.routes[0];
  for (const method of ['HEAD', 'POST', 'PUT', 'CONNECT', 'OPTIONS']) assert.equal(lab.resolveRequest(contract, route.host, request(route, { method }), lab.newState()).status, 405);
  for (const url of [`https://${route.host}${route.path}`, route.path + '&token=NO-LOG', route.path.replace('10', '100'),
    '/repos/BOBWORKS-XR/CREATOR-HUB/../CREATOR-HUB/releases?per_page=10', route.path.replace('10', '%31%30')]) {
    assert.equal(lab.resolveRequest(contract, route.host, request(route, { url }), lab.newState()).status, 404);
  }
  assert.equal(lab.resolveRequest(contract, 'github.com', request(route), lab.newState()).status, 421);
  for (const change of [{ requests: lab.LIMITS.requests }, { servedBytes: lab.LIMITS.servedBytes },
    { receivedBytes: lab.LIMITS.receivedBytes + 1 }, { closeReason: 'closed' }]) {
    assert.equal(lab.resolveRequest(contract, route.host, request(route), { ...lab.newState(), ...change }).status, 429);
  }
  const exhausted = { ...lab.newState(), requests: lab.LIMITS.requests };
  for (let i = 0; i < 10; i++) assert.equal(lab.resolveRequest(contract, route.host, request(route), exhausted).status, 429);
  assert.equal(exhausted.requests, lab.LIMITS.requests, 'Rejected attempts cannot grow the admitted-request counter');
  const state = lab.newState(); assert.equal(lab.resolveRequest(contract, route.host, request(route), state).status, 200);
  assert.equal(state.servedBytes, lab.resolveRequest(contract, route.host, request(route), lab.newState()).route.bytes.length);
  assert.throws(() => lab.resolveRequest({ ...contract }, route.host, request(route), lab.newState()));
});

test('native runner admission binds exact repo, branch, event, non-root OS and rejects injection', async () => {
  for (const event of ['push', 'workflow_dispatch']) lab.assertRunner({ ...runner(), GITHUB_EVENT_NAME: event }, 'linux', 'x64', 1001, 1001);
  for (const name of Object.keys(runner())) {
    const env = runner(); delete env[name]; assert.throws(() => lab.assertRunner(env, 'linux', 'x64', 1001, 1001), name);
  }
  for (const [platform, arch, uid, euid] of [['win32', 'x64', 1001, 1001], ['linux', 'arm64', 1001, 1001],
    ['linux', 'x64', 0, 0], ['linux', 'x64', 1001, 0]]) assert.throws(() => lab.assertRunner(runner(), platform, arch, uid, euid));
  for (const key of ['FLATPAK_ID', 'LD_PRELOAD', 'NODE_OPTIONS', 'SSL_CERT_FILE', 'NODE_TLS_REJECT_UNAUTHORIZED', 'TAURI_SIGNING_PRIVATE_KEY', 'CREATOR_HUB_SIGNING_KEY_PATH']) {
    assert.throws(() => lab.assertRunner({ ...runner(), [key]: 'forbidden' }, 'linux', 'x64', 1001, 1001));
  }
  for (const ref of ['refs/heads/main', lab.BRANCH + '-foreign', 'refs/tags/v0.1.14']) assert.throws(() => lab.assertRunner({ ...runner(), GITHUB_REF: ref }, 'linux', 'x64', 1001, 1001));
  await assert.rejects(lab.startLabProxy(null, null, {}));
});

test('loading exact fixed input files is bounded and read-only, never follows a linked input', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-linux-feed-input-'));
  const data = input();
  const files = { [lab.DESCRIPTOR]: data.descriptor, [`${lab.DESCRIPTOR}.minisig`]: data.descriptorSignature,
    [lab.ASSET]: data.installer, 'latest.json': data.manifest };
  t.after(() => { for (const name of Object.keys(files)) fs.unlinkSync(path.join(directory, name)); fs.rmdirSync(directory); });
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), bytes, { flag: 'wx', mode: 0o600 });
  const config = { schemaVersion: 1, targetVersion: '0.1.15', directory, pins: data.pins };
  assert.equal(lab.loadContract(config).routes.length, 5);
  for (const [name, bytes] of Object.entries(files)) assert.deepEqual(fs.readFileSync(path.join(directory, name)), bytes);
  assert.throws(() => lab.readBounded(path.join(directory, lab.DESCRIPTOR), 1));
  assert.throws(() => lab.loadContract({ ...config, directory: '.' }));
  assert.throws(() => lab.loadContract({ ...config, keyPath: 'forbidden' }));
  const saved = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', file => file === path.join(directory, lab.DESCRIPTOR)
    ? { isSymbolicLink: () => true } : saved(file));
  assert.throws(() => lab.loadContract(config), /Linked input/);
});

let ephemeral;
test.before(() => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-linux-feed-tls-'));
  const config = path.join(directory, 'ephemeral.cnf'), keyFile = path.join(directory, 'ephemeral-key.pem'), certFile = path.join(directory, 'ephemeral-cert.pem');
  fs.writeFileSync(config, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=api.github.com\n[ext]\nsubjectAltName=DNS:api.github.com,DNS:github.com\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n', { flag: 'wx', mode: 0o600 });
  ephemeral = { directory, paths: [config, keyFile, certFile] };
  const openssl = process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : '/usr/bin/openssl';
  assert.ok(fs.existsSync(openssl), 'Local OpenSSL required; no download or system trust changes');
  const result = spawnSync(openssl, ['req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-config', config, '-keyout', keyFile, '-out', certFile], { encoding: 'utf8', timeout: 15000, maxBuffer: 32768,
    windowsHide: true, shell: false, env: { PATH: path.dirname(openssl), SYSTEMROOT: process.env.SYSTEMROOT } });
  assert.equal(result.status, 0, 'Ephemeral test certificate generation failed');
  ephemeral.key = fs.readFileSync(keyFile); ephemeral.cert = fs.readFileSync(certFile);
});
test.after(() => {
  ephemeral?.key?.fill(0);
  if (ephemeral) {
    const parent = path.resolve(os.tmpdir()), absolute = path.resolve(ephemeral.directory);
    assert.equal(path.dirname(absolute), parent); assert.ok(path.basename(absolute).startsWith('creator-linux-feed-tls-'));
    for (const file of ephemeral.paths) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(absolute);
  }
});

async function proxy(t) {
  const contract = lab.createContract(input());
  // Deliberately mechanism-only: the local test machine is not a native runner.
  const server = await lab.testing.startLoopbackTransport(contract, { key: ephemeral.key, cert: ephemeral.cert });
  t.after(() => server.close()); return { server, contract, port: Number(new URL(server.proxyUrl).port) };
}
function tunnel(port, authority, headers = { Host: authority }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: authority, method: 'CONNECT', headers, agent: false });
    req.setTimeout(3000, () => req.destroy(Error('Test CONNECT timeout')));
    req.on('error', reject); req.once('connect', (res, socket, head) => {
      socket.on('error', () => {}); socket.setTimeout(3000, () => socket.destroy()); resolve({ status: res.statusCode, socket, head });
    }); req.end();
  });
}
async function tlsRequest(port, authority, text, servername = authority.slice(0, -4), ca = ephemeral.cert) {
  const result = await tunnel(port, authority);
  assert.equal(result.status, 200); assert.equal(result.head.length, 0);
  return new Promise(resolve => {
    const secure = tls.connect({ socket: result.socket, servername, ca, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
    let bytes = Buffer.alloc(0), done = false;
    const finish = error => { if (done) return; done = true; secure.destroy(); result.socket.destroy(); resolve({ bytes, error, authorized: secure.authorized }); };
    secure.setTimeout(3000, () => finish('test-timeout'));
    secure.on('data', chunk => { bytes = Buffer.concat([bytes, chunk]); if (bytes.length > 128 * 1024) finish('test-output-limit'); });
    secure.on('error', error => finish(error.code || 'tls-error'));
    secure.on('end', () => finish(null)); secure.on('close', () => finish(null));
    secure.once('secureConnect', () => secure.end(text));
  });
}
function response(bytes) {
  const split = bytes.indexOf('\r\n\r\n'); assert.ok(split >= 0, 'Complete HTTP response required');
  const lines = bytes.subarray(0, split).toString('ascii').split('\r\n');
  const headers = Object.fromEntries(lines.slice(1).map(line => { const at = line.indexOf(':'); return [line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()]; }));
  return { status: Number(lines[0].split(' ')[1]), headers, body: bytes.subarray(split + 4) };
}

test('actual loopback CONNECT/TLS serves all five exact pinned snapshots with verified local trust and no redirects', { timeout: 15000 }, async t => {
  const { server, contract, port } = await proxy(t);
  assert.equal(new URL(server.proxyUrl).hostname, '127.0.0.1');
  for (const route of contract.routes) {
    const raw = await tlsRequest(port, `${route.host}:443`, `GET ${route.path} HTTP/1.1\r\nHost: ${route.host}\r\nUser-Agent: Creator-Hub/0.1\r\nConnection: close\r\n\r\n`);
    assert.equal(raw.error, null); assert.equal(raw.authorized, true);
    const res = response(raw.bytes); assert.equal(res.status, 200); assert.equal(hash(res.body), route.sha256);
    assert.equal(res.headers['content-length'], String(res.body.length)); assert.equal(res.headers.location, undefined);
    assert.equal(res.headers['cache-control'], 'no-store');
  }
  assert.deepEqual(server.report().requests, contract.routes);
  await server.close(); await server.close(); await server.closed;
  assert.equal(server.report().closeReason, 'caller');
});

test('actual CONNECT rejects unknown destinations, mismatched Host, credentials and bodies without a relay', { timeout: 15000 }, async t => {
  const { server, port } = await proxy(t);
  for (const [authority, headers] of [['evil.test:443', { Host: 'evil.test:443' }],
    ['api.github.com:443', { Host: 'github.com:443' }], ['github.com:80', { Host: 'github.com:80' }],
    ...['Authorization', 'Proxy-Authorization', 'Cookie', 'Content-Length', 'Transfer-Encoding', 'X-Foreign'].map(name =>
      ['github.com:443', { Host: 'github.com:443', [name]: name === 'Content-Length' ? '0' : 'DO-NOT-LOG' }])]) {
    const result = await tunnel(port, authority, headers); assert.equal(result.status, 400, authority); result.socket.destroy();
  }
  assert.deepEqual(server.report().requests, []); assert.ok(!JSON.stringify(server.report()).includes('DO-NOT-LOG'));
});

test('actual TLS refuses mismatched/missing SNI and absent trust without disabling certificate verification', { timeout: 15000 }, async t => {
  const { server, contract, port } = await proxy(t), route = contract.routes[0];
  for (const name of ['github.com', 'evil.test', '']) {
    const result = await tlsRequest(port, 'api.github.com:443', `GET ${route.path} HTTP/1.1\r\nHost: api.github.com\r\n\r\n`, name);
    assert.equal(result.bytes.length, 0);
  }
  const noTrust = await tlsRequest(port, 'api.github.com:443', '', 'api.github.com', []);
  assert.ok(noTrust.error); assert.equal(noTrust.bytes.length, 0); assert.deepEqual(server.report().requests, []);
});

test('actual tunneled HTTP refuses path aliases, methods, cross-host, credentials, upgrades and duplicate Host', { timeout: 20000 }, async t => {
  const { server, contract, port } = await proxy(t), route = contract.routes[0];
  const cases = [[`GET ${route.path}&secret=DO-NOT-LOG HTTP/1.1\r\nHost: api.github.com`, 404],
    [`POST ${route.path} HTTP/1.1\r\nHost: api.github.com`, 405],
    [`GET ${route.path} HTTP/1.1\r\nHost: github.com`, 421],
    [`GET ${route.path} HTTP/1.1\r\nHost: api.github.com\r\nCookie: DO-NOT-LOG`, 400],
    [`GET ${route.path} HTTP/1.1\r\nHost: api.github.com\r\nAuthorization: DO-NOT-LOG`, 400],
    [`GET ${route.path} HTTP/1.1\r\nHost: api.github.com\r\nHost: api.github.com`, 400],
    [`GET ${route.path} HTTP/1.1\r\nHost: api.github.com\r\nConnection: Upgrade\r\nUpgrade: websocket`, 400],
    ['CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443', 400]];
  for (const [text, status] of cases) {
    const result = await tlsRequest(port, 'api.github.com:443', text + '\r\n\r\n'); assert.equal(response(result.bytes).status, status);
  }
  assert.deepEqual(server.report().requests, []); assert.ok(!JSON.stringify(server.report()).includes('DO-NOT-LOG'));
});

test('actual raw HTTP cannot bypass CONNECT and pipelined CONNECT bytes are not accepted as TLS', { timeout: 10000 }, async t => {
  const { server, port } = await proxy(t);
  const raw = text => new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }); let bytes = Buffer.alloc(0);
    socket.setTimeout(3000, () => socket.destroy(Error('Raw test timeout'))); socket.on('error', reject);
    socket.on('data', chunk => { bytes = Buffer.concat([bytes, chunk]); }); socket.on('end', () => { socket.destroy(); resolve(bytes); });
    socket.once('connect', () => socket.end(text));
  });
  assert.equal(response(await raw(`GET ${lab.FEED_PATH} HTTP/1.1\r\nHost: api.github.com\r\n\r\n`)).status, 405);
  assert.equal(response(await raw('CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\nPIPELINED')).status, 400);
  assert.deepEqual(server.report().requests, []);
});

test('actual total-connection budget closes the listener and owned sockets rather than accepting indefinitely', { timeout: 10000 }, async t => {
  const { server, port } = await proxy(t); const sockets = [];
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  for (let i = 0; i <= lab.LIMITS.connections; i++) await new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port }); sockets.push(socket); socket.on('error', () => resolve()); socket.once('connect', resolve);
  });
  await server.closed; assert.equal(server.report().closeReason, 'connection-budget');
  assert.equal(server.report().connectionCount, lab.LIMITS.connections + 1); assert.deepEqual(server.report().requests, []);
});

test('duration/owned connection/handshake deadlines are finite and expiry closes the actual listener', { timeout: 10000 }, async t => {
  const original = global.setTimeout; let expiry;
  t.mock.method(global, 'setTimeout', (fn, ms, ...args) => {
    if (ms === lab.LIMITS.durationMs) expiry = fn;
    return original(fn, ms, ...args);
  });
  const { server } = await proxy(t); assert.equal(typeof expiry, 'function');
  for (const key of ['durationMs', 'connectionMs', 'handshakeMs', 'idleMs']) assert.ok(lab.LIMITS[key] > 0 && lab.LIMITS[key] <= 600000);
  expiry(); await server.closed; assert.equal(server.report().closeReason, 'duration-budget');
});

test('TLS options accept only caller-provided short-lived exact-SAN certificate/key bytes, never filesystem key paths', async () => {
  const contract = lab.createContract(input());
  for (const options of [{ keyPath: 'catalog.key', cert: ephemeral.cert }, { key: ephemeral.key, cert: ephemeral.cert, rejectUnauthorized: false },
    { key: Buffer.from('not a PEM key'), cert: ephemeral.cert }, { key: ephemeral.key, cert: Buffer.alloc(0) }]) {
    await assert.rejects(lab.testing.startLoopbackTransport(contract, options));
  }
});

test('CLI refuses non-native admission before reading paths/stdin and never prints secret/parser material', () => {
  const result = spawnSync(process.execPath, [require.resolve('./linux-update-lab-feed.cjs'), 'missing-config', 'missing-report'], {
    encoding: 'utf8', input: 'DO-NOT-LOG-TLS-CONTROL', timeout: 10000, windowsHide: true,
    env: { ...process.env, GITHUB_ACTIONS: 'false' } });
  assert.notEqual(result.status, 0); assert.equal(result.stdout, '');
  assert.match(result.stderr, /no native\/public acceptance/); assert.ok(!result.stderr.includes('DO-NOT-LOG'));
});

test('new sidecar has no outbound forwarding, signing, install, trust-store, UI or Windows helper invocation', () => {
  assert.doesNotMatch(source, /require\(['"](?:node:)?(?:https|net|child_process)['"]\)|http\.(?:request|get)\(|tls\.connect\(|\bfetch\(|spawnSync|execFile|signDetached/);
  assert.doesNotMatch(source, /self-update-lab-feed\.cjs|release-descriptor\.cjs|catalog\.key|auth\.json|pkexec|dpkg|sudo|workflow run|gh release|NODE_TLS_REJECT_UNAUTHORIZED\s*=/);
  assert.match(source, /listen\(0, '127\.0\.0\.1'/); assert.doesNotMatch(source, /inner\.listen\(/);
  assert.match(source, /secure\.servername !== host/); assert.match(source, /head\.length/);
  assert.match(source, /secure\.disableRenegotiation\(\)/);
  assert.match(source, /fs\.writeFileSync\(reportFile,[\s\S]*flag: 'wx', mode: 0o600/);
  assert.equal([...source.matchAll(/fs\.writeFileSync\(/g)].length, 1);
  assert.doesNotMatch(source, /[^\x00-\x7f]|[ \t]+\r?$/m);
});
