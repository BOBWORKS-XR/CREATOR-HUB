const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const lab = require('./self-update-lab-feed.cjs');
test('refusal diagnostics stay bounded and retain counts without request or secret content', () => {
  const state = lab.newState();
  lab.recordRejection(state, 'tls-error', 'ERR_SSL_WRONG_VERSION_NUMBER');
  lab.recordRejection(state, 'tls-error', 'ERR_SSL_WRONG_VERSION_NUMBER');
  lab.recordRejection(state, 'tls-error', 'not a safe code /private?token=secret');
  for (let index = 0; index < 20; index++) lab.recordRejection(state, `http-${400 + index}`);
  const report = lab.labReport(lab.createContract(input()), state);
  assert.equal(report.rejectedRequestCount, 23);
  assert.equal(report.rejectionSummary.length, 16);
  assert.equal(report.rejectionSummary.reduce((sum, value) => sum + value.count, 0) + report.rejectionOverflow, 23);
  assert.deepEqual(report.rejectionSummary[0], { kind: 'tls-error', code: 'ERR_SSL_WRONG_VERSION_NUMBER', count: 2 });
  assert.equal(report.rejectionSummary[1].code, null);
  assert.doesNotMatch(JSON.stringify(report), /private|token=secret|not a safe code/);
});
const { applications, updaterManifest } = require('./release-descriptor.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const runner = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows' };

// Deliberately unsigned contract fixtures, not installer/signature acceptance evidence.
function fixture(targetVersion = '0.1.13') {
  const installer = Buffer.from('not an executable: unit contract fixture');
  const plainDescriptorSignature = 'untrusted comment: NONCRYPTOGRAPHIC DESCRIPTOR FIXTURE\n';
  const plainInstallerSignature = 'untrusted comment: NONCRYPTOGRAPHIC INSTALLER FIXTURE\n';
  const encodedSignature = Buffer.from(plainInstallerSignature).toString('base64');
  const release = { schemaVersion: 1, appId: 'creator-hub', version: targetVersion, platform: 'windows',
    architecture: 'x86_64', packageType: 'nsis', assetName: 'Creator.Hub_0.1.13_x64-setup.exe',
    byteLength: installer.length, sha256: hash(installer), executableSha256: 'a'.repeat(64),
    identityProtocol: 0, lifecycleProtocol: 0, installerProtocol: 1, minHubVersion: '0.1.0-alpha.1' };
  // Pure producer helper only: no main(), signer, receipt, key or production asset access.
  const update = updaterManifest(applications.hub, targetVersion, release.assetName, encodedSignature);
  return { targetVersion, installer, release, update, plainDescriptorSignature, plainInstallerSignature, encodedSignature };
}

function input(f = fixture()) {
  const bytes = { descriptor: Buffer.from(JSON.stringify(f.release)), descriptorSignature: Buffer.from(f.plainDescriptorSignature),
    installer: f.installer, manifest: Buffer.from(JSON.stringify(f.update)) };
  return { targetVersion: f.targetVersion, ...bytes,
    pins: { ...Object.fromEntries(Object.entries(bytes).map(([name, value]) => [name, hash(value)])), executable: 'a'.repeat(64) } };
}

function outgoingInput() {
  const f = fixture('0.1.15');
  f.release.assetName = 'Creator_Hub_0.1.15_x64-acceptance-only-setup.exe';
  f.release.minHubVersion = '0.1.14';
  f.update = updaterManifest(applications.hub, f.targetVersion, f.release.assetName, f.encodedSignature);
  return input(f);
}

function request(contract, route, overrides = {}, state = lab.newState()) {
  const res = new EventEmitter();
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.end = bytes => { res.bytes = bytes; res.emit('finish'); };
  const req = { method: 'GET', url: route.path, headers: { host: route.host }, socket: { labHost: route.host }, ...overrides };
  req.rawHeaders ??= Object.entries(req.headers).flat();
  lab.requestHandler(contract, state)(req, res);
  return { res, state };
}

test('exact five paths, original hostnames and pinned public baseline; no public acceptance', () => {
  const contract = lab.createContract(input());
  assert.equal(contract.routes.length, 5);
  assert.deepEqual(contract.routes.map(route => route.host), ['api.github.com', 'github.com', 'github.com', 'github.com', 'github.com']);
  assert.equal(contract.routes[0].path, lab.FEED_PATH);
  assert.equal(contract.baseline.version, '0.1.12');
  assert.equal(contract.baseline.installer, '0cd8a4493dd9a5b77fbc5fe160582a2b2698fea43aedd9118b2d5b3bd3c51a18');
  assert.equal(contract.baseline.exe, '34c6f05548f469ac23b4faee7aa8355d5cca083c444c4f7b0942426a9c76a7ac');
  assert.ok(Object.isFrozen(contract) && Object.isFrozen(contract.pins));
  const report = lab.labReport(contract, lab.newState());
  assert.equal(report.labDiscovery, true);
  for (const field of ['publicDiscovery', 'releaseReady', 'nativeAcceptanceTested', 'signaturesVerifiedByHarness', 'baselineActuallyTested']) assert.equal(report[field], false);
  assert.deepEqual(report.requests, []);
});

test('newer stable and preview targets accepted; old, same, noncanonical, build variants refused', () => {
  for (const value of ['0.1.13', '0.1.13-rc.1', '1.0.0']) assert.equal(lab.baselineFor(value).version, '0.1.12');
  for (const value of ['0.1.12', '0.1.12-rc.1', '0.1.11', 'v0.1.13', '0.1.13+lab', '', null]) {
    assert.throws(() => lab.baselineFor(value));
  }
});

test('all supplied hashes, sizes and descriptor identity/protocol fields are checked', () => {
  for (const name of ['descriptor', 'descriptorSignature', 'installer', 'manifest']) {
    const data = input(); data[name] = Buffer.concat([data[name], Buffer.from('changed')]);
    assert.throws(() => lab.createContract(data), /SHA-256 mismatch/);
  }
  const changes = { schemaVersion: 2, appId: 'creator-works-mcp', version: '0.1.14', platform: 'linux', architecture: 'aarch64',
    packageType: 'msi', installerProtocol: 0, byteLength: 999, sha256: 'b'.repeat(64), executableSha256: 'b'.repeat(64),
    identityProtocol: 2, lifecycleProtocol: -1, minHubVersion: '0.1.13' };
  for (const [field, value] of Object.entries(changes)) {
    const f = fixture(); f.release[field] = value;
    assert.throws(() => lab.createContract(input(f)), undefined, field);
  }
  const f = fixture(); f.release.testOnly = true;
  assert.throws(() => lab.createContract(input(f)), /Unexpected descriptor fields/);
});

test('installer path traversal, aliases and unknown pin fields fail closed', () => {
  for (const asset of ['../installer.exe', 'file..exe', 'setup.exe?token=secret', 'setup.exe#fragment', 'dir/setup.exe', 'setup%2eexe', 'setup.EXE', 'a'.repeat(161)]) {
    const f = fixture(); f.release.assetName = asset;
    assert.throws(() => lab.createContract(input(f)));
  }
  const data = input(); data.pins.publicKey = 'test key';
  assert.throws(() => lab.createContract(data), /Unexpected SHA-256 pins/);
});

test('strict input bounds and Tauri signature encoding; no authenticity claim', () => {
  for (const [name, max] of [['descriptor', lab.LIMITS.metadata], ['descriptorSignature', lab.LIMITS.signature], ['manifest', lab.LIMITS.metadata]]) {
    const data = input(); data[name] = Buffer.alloc(max + 1);
    assert.throws(() => lab.createContract(data), /outside bounds/);
  }
  const data = input(); data.installer = Buffer.alloc(0);
  assert.throws(() => lab.createContract(data), /outside bounds/);
  for (const sig of ['', 'not base64', Buffer.from('wrong envelope').toString('base64')]) {
    const f = fixture(); f.update.platforms['windows-x86_64'].signature = sig;
    assert.throws(() => lab.createContract(input(f)));
  }
  assert.equal(lab.labReport(lab.createContract(input()), lab.newState()).signaturesVerifiedByHarness, false);
});

test('producer-format plain metadata signature accepted verbatim; manifest signature stays base64', () => {
  const f = fixture(), data = input(f), contract = lab.createContract(data);
  const metadataResponse = request(contract, contract.routes[2]).res;
  assert.equal(metadataResponse.status, 200);
  assert.equal(metadataResponse.headers['Content-Type'], 'text/plain; charset=utf-8');
  assert.deepEqual(metadataResponse.bytes, Buffer.from(f.plainDescriptorSignature));
  const manifestResponse = JSON.parse(request(contract, contract.routes[4]).res.bytes);
  assert.deepEqual(manifestResponse, f.update);
  assert.equal(manifestResponse.platforms['windows-x86_64'].signature, f.encodedSignature);
  assert.equal(Buffer.from(f.encodedSignature, 'base64').toString('utf8'), f.plainInstallerSignature);
  assert.notEqual(f.plainDescriptorSignature, f.plainInstallerSignature);
  assert.equal(lab.labReport(contract, lab.newState()).signaturesVerifiedByHarness, false);
});

test('base64 metadata signature file refused despite matching file hash and valid manifest', () => {
  const f = fixture(); f.plainDescriptorSignature = Buffer.from(f.plainDescriptorSignature).toString('base64');
  assert.throws(() => lab.createContract(input(f)), /Invalid plain minisig/);
});

test('plain-text manifest signature refused while descriptor signature remains valid plain text', () => {
  const f = fixture(); f.update.platforms['windows-x86_64'].signature = f.plainInstallerSignature;
  assert.throws(() => lab.createContract(input(f)), /Invalid Tauri base64 signature/);
});

test('plain minisig bytes are strict UTF-8 and are never trimmed or transcoded in responses', () => {
  for (const newline of ['\n', '\r\n']) {
    const f = fixture(); f.plainDescriptorSignature = `untrusted comment: NONCRYPTOGRAPHIC caf\u00e9 FIXTURE${newline}`;
    const data = input(f), contract = lab.createContract(data);
    assert.deepEqual(request(contract, contract.routes[2]).res.bytes, data.descriptorSignature);
  }
  for (const prefix of [' ', '\n', '\uFEFF']) {
    const f = fixture(); f.plainDescriptorSignature = `${prefix}${f.plainDescriptorSignature}`;
    assert.throws(() => lab.createContract(input(f)), /Invalid plain minisig/);
  }
  const f = fixture(); f.plainDescriptorSignature = Buffer.concat([Buffer.from(f.plainDescriptorSignature), Buffer.from([0xff])]);
  assert.throws(() => lab.createContract(input(f)), /encoded data/);
});

test('Tauri base64 is canonical and decoded minisig is strict UTF-8 plain text', () => {
  for (const transform of [value => ` ${value}`, value => `${value}\n`]) {
    const f = fixture(); f.update.platforms['windows-x86_64'].signature = transform(f.encodedSignature);
    assert.throws(() => lab.createContract(input(f)), /Invalid Tauri base64 signature/);
  }
  const unpadded = fixture(), paddedSignature = Buffer.from(`${unpadded.plainInstallerSignature}X`).toString('base64');
  assert.match(paddedSignature, /=+$/);
  unpadded.update.platforms['windows-x86_64'].signature = paddedSignature.replace(/=+$/, '');
  assert.throws(() => lab.createContract(input(unpadded)), /Invalid Tauri base64 signature/);
  const invalid = fixture();
  invalid.update.platforms['windows-x86_64'].signature = Buffer.concat([Buffer.from(invalid.plainInstallerSignature), Buffer.from([0xff])]).toString('base64');
  assert.throws(() => lab.createContract(input(invalid)), /encoded data/);
});

test('manifest version, exact URL, platforms and existing installer signature are bound', () => {
  for (const url of ['http://github.com/x', 'https://127.0.0.1/setup.exe', 'https://github.com:443/x',
    'https://github.com@evil.test/x', 'https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.13/other.exe']) {
    const f = fixture(); f.update.platforms['windows-x86_64'].url = url;
    assert.throws(() => lab.createContract(input(f)), /Manifest URL mismatch/);
  }
  const old = fixture(); old.update.version = '0.1.12';
  assert.throws(() => lab.createContract(input(old)), /Manifest version mismatch/);
  const extra = fixture(); extra.update.platforms['linux-x86_64'] = extra.update.platforms['windows-x86_64'];
  assert.throws(() => lab.createContract(input(extra)), /manifest platforms/);
  const missing = fixture(); delete missing.update.platforms['windows-x86_64'].signature;
  assert.throws(() => lab.createContract(input(missing)), /manifest Windows target/);
});

test('all five GET responses are exact snapshots, length/hash bound, with no redirects', () => {
  const data = input(); const original = Buffer.from(data.installer);
  const contract = lab.createContract(data); data.installer.fill(0); data.descriptor.fill(0);
  const state = lab.newState();
  for (const route of contract.routes) {
    const { res } = request(contract, route, {}, state);
    assert.equal(res.status, 200); assert.equal(hash(res.bytes), route.sha256);
    assert.equal(res.headers['Content-Length'], String(res.bytes.length));
    assert.equal(res.headers.Location, undefined);
  }
  assert.deepEqual(request(contract, contract.routes[3]).res.bytes, original);
  const feed = JSON.parse(request(contract, contract.routes[0]).res.bytes);
  assert.equal(feed[0].tag_name, 'v0.1.13'); assert.equal(feed[0].draft, false);
  assert.equal(feed[0].assets.length, 4); assert.ok(request(contract, contract.routes[0]).res.bytes.length < lab.LIMITS.feed);
  assert.equal(lab.labReport(contract, state).requests.length, 5);
});

test('only exact CONNECT authorities: no alternate ports, userinfo, IPs or DNS aliases', () => {
  assert.equal(lab.connectHost('api.github.com:443'), 'api.github.com');
  assert.equal(lab.connectHost('github.com:443'), 'github.com');
  for (const value of ['github.com', 'github.com:80', 'github.com:0443', 'GITHUB.COM:443', 'github.com.:443',
    'evil.test:443', 'github.com@evil.test:443', '127.0.0.1:443', '[::1]:443', 'https://github.com:443', null]) {
    assert.equal(lab.connectHost(value), null);
  }
});

test('request methods, cross-host confusion, absolute URLs and path/query aliases are denied', () => {
  const contract = lab.createContract(input()), route = contract.routes[0];
  for (const method of ['POST', 'PUT', 'HEAD', 'CONNECT', 'OPTIONS']) assert.equal(request(contract, route, { method }).res.status, 405);
  assert.equal(request(contract, route, { headers: { host: 'github.com' } }).res.status, 421);
  assert.equal(request(contract, route, { socket: { labHost: 'evil.test' } }).res.status, 421);
  assert.equal(request(contract, route, { headers: { host: 'api.github.com:443' } }).res.status, 200);
  for (const url of [route.path.replace('10', '100'), `${route.path}&token=secret`, `https://${route.host}${route.path}`,
    '/repos/BOBWORKS-XR/CREATOR-HUB/../CREATOR-HUB/releases?per_page=10', '/repos/BOBWORKS-XR/CREATOR-HUB/releases?per_page=%31%30']) {
    assert.equal(request(contract, route, { url }).res.status, 404);
  }
  for (const route of contract.routes.slice(1)) assert.equal(request(contract, route, { url: `${route.path}?download=1` }).res.status, 404);
});

test('credentials and request bodies refused; reports retain only allowlisted host/path/hash', () => {
  const contract = lab.createContract(input()), route = contract.routes[0], state = lab.newState();
  for (const field of ['authorization', 'proxy-authorization', 'cookie', 'transfer-encoding', 'upgrade', 'content-length']) {
    assert.equal(request(contract, route, { headers: { host: route.host, [field]: 'NEVER-LOG-THIS' } }, state).res.status, 400);
  }
  request(contract, route, {}, state); request(contract, route, {}, state);
  const report = lab.labReport(contract, state);
  assert.equal(report.requests.length, 1);
  assert.deepEqual(Object.keys(report.requests[0]).sort(), ['host', 'path', 'sha256']);
  assert.ok(!JSON.stringify(report).includes('NEVER-LOG-THIS'));
  assert.equal(report.rejectedRequestCount, 6);
});

test('request and byte budgets refuse further data', () => {
  const contract = lab.createContract(input()), route = contract.routes[0];
  const state = lab.newState(); state.requests = lab.LIMITS.requests;
  assert.equal(request(contract, route, {}, state).res.status, 429);
  const full = lab.newState(); full.bytes = lab.LIMITS.servedBytes;
  assert.equal(request(contract, route, {}, full).res.status, 429);
});

test('baseline assertion cannot accept fixture installer/executable bytes or change public pins', () => {
  const before = lab.baselineFor('0.1.13');
  assert.throws(() => lab.assertBaselineBytes('0.1.13', Buffer.from('fixture'), Buffer.from('fixture')), /Unmodified public baseline installer required/);
  assert.deepEqual(lab.baselineFor('0.1.13'), before);
});

test('fixed outgoing factory uses actual accepted B05 14 while the public factory remains pinned to 12', () => {
  const contract = lab.createUnifiedOutgoingContract(outgoingInput());
  assert.equal(contract.targetVersion, '0.1.15');
  assert.deepEqual(contract.baseline, { version: '0.1.14',
    installer: '284820f92de487e8a0f1bb5b3b99cafe5e073f0402a9350a2ea6e76fa9543157',
    exe: 'cd5e3fd2829727d06444c0f3266b178798d1b55c63df651be12eb38ac4523a86' });
  assert.ok(Object.isFrozen(contract.baseline) && Object.isFrozen(contract.actualScope));
  assert.equal(lab.createContract(input(fixture('0.1.15'))).baseline.version, '0.1.12');
  assert.equal(lab.baselineFor('0.1.15').version, '0.1.12');
  assert.throws(() => lab.createContract(outgoingInput()), /intermediate Hub/);
  assert.throws(() => lab.assertUnifiedOutgoingBaselineBytes(Buffer.from('B02'), Buffer.from('version-masquerade')),
    /Exact accepted B05/);
  const report = lab.labReport(contract, lab.newState());
  assert.equal(report.actualScope.kind, 'unified-outgoing-14-15');
  assert.equal(report.actualScope.baseline, 'accepted-unmodified-unified-0.1.14-B05');
  for (const field of ['publicDiscovery', 'liveAiAcceptance', 'productAcceptance', 'releaseReady']) {
    assert.equal(report.actualScope[field], false);
  }
  for (const field of ['publicDiscovery', 'releaseReady', 'nativeAcceptanceTested', 'signaturesVerifiedByHarness', 'baselineActuallyTested']) {
    assert.equal(report[field], false);
  }
});

test('outgoing factory refuses baseline overrides, alternate versions/assets and intermediary targets', () => {
  for (const targetVersion of ['0.1.14', '0.1.15-fixture', '0.1.15+lab', '0.1.16']) {
    assert.throws(() => lab.createUnifiedOutgoingContract({ ...outgoingInput(), targetVersion }));
  }
  for (const field of ['baseline', 'baselineVersion', 'actualScope', 'driver', 'signingKey']) {
    assert.throws(() => lab.createUnifiedOutgoingContract({ ...outgoingInput(), [field]: 'unreviewed' }), /Unexpected outgoing input/);
  }
  for (const [field, value] of [['minHubVersion', '0.1.12'], ['minHubVersion', '0.1.15'],
    ['assetName', 'Creator.Hub_0.1.15_x64-setup.exe']]) {
    const data = outgoingInput();
    const descriptor = JSON.parse(data.descriptor); descriptor[field] = value;
    data.descriptor = Buffer.from(JSON.stringify(descriptor)); data.pins.descriptor = hash(data.descriptor);
    assert.throws(() => lab.createUnifiedOutgoingContract(data));
  }
});

test('outgoing contracts reuse every shared hash, bound, signature encoding and exact five-route check', () => {
  for (const name of ['descriptor', 'descriptorSignature', 'installer', 'manifest']) {
    const data = outgoingInput(); data[name] = Buffer.concat([data[name], Buffer.from('changed')]);
    assert.throws(() => lab.createUnifiedOutgoingContract(data), /SHA-256 mismatch/);
  }
  for (const name of ['descriptor', 'manifest', 'descriptorSignature']) {
    const data = outgoingInput(); data[name] = Buffer.alloc(name === 'descriptorSignature' ? lab.LIMITS.signature + 1 : lab.LIMITS.metadata + 1);
    assert.throws(() => lab.createUnifiedOutgoingContract(data), /outside bounds/);
  }
  const encodedMetadata = outgoingInput();
  encodedMetadata.descriptorSignature = Buffer.from(encodedMetadata.descriptorSignature.toString('base64'));
  encodedMetadata.pins.descriptorSignature = hash(encodedMetadata.descriptorSignature);
  assert.throws(() => lab.createUnifiedOutgoingContract(encodedMetadata), /Invalid plain minisig/);
  const plainManifest = outgoingInput(); const manifest = JSON.parse(plainManifest.manifest);
  manifest.platforms['windows-x86_64'].signature = 'untrusted comment: not base64';
  plainManifest.manifest = Buffer.from(JSON.stringify(manifest)); plainManifest.pins.manifest = hash(plainManifest.manifest);
  assert.throws(() => lab.createUnifiedOutgoingContract(plainManifest), /Invalid Tauri base64 signature/);

  const data = outgoingInput(); const contract = lab.createUnifiedOutgoingContract(data);
  assert.equal(contract.routes.length, 5);
  const prefix = '/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.15/';
  assert.deepEqual(contract.routes.map(route => route.path), [lab.FEED_PATH, `${prefix}${lab.DESCRIPTOR}`,
    `${prefix}${lab.DESCRIPTOR}.minisig`, `${prefix}Creator_Hub_0.1.15_x64-acceptance-only-setup.exe`, `${prefix}latest.json`]);
  data.installer.fill(0);
  for (const route of contract.routes) {
    const response = request(contract, route).res;
    assert.equal(response.status, 200); assert.equal(hash(response.bytes), route.sha256);
    assert.equal(request(contract, route, { url: `${route.path}&alias=1` }).res.status, 404);
    assert.equal(request(contract, route, { headers: { host: route.host, authorization: 'DO-NOT-LOG' } }).res.status, 400);
  }
});

test('each runner guard is mandatory; proxy refuses before TLS initialization', async () => {
  lab.assertRunner(runner);
  for (const field of Object.keys(runner)) {
    const env = { ...runner, [field]: 'wrong' };
    assert.throws(() => lab.assertRunner(env), /disposable/);
    await assert.rejects(lab.startLabProxy(null, null, env), /disposable/);
  }
});

test('CLI cannot run on the user PC and never dumps TLS input/errors', () => {
  const result = spawnSync(process.execPath, [require.resolve('./self-update-lab-feed.cjs'), 'missing-config', 'missing-report'], {
    encoding: 'utf8', input: 'NEVER-LOG-THIS', env: { ...process.env, GITHUB_ACTIONS: 'false' } });
  assert.notEqual(result.status, 0); assert.equal(result.stdout, '');
  assert.ok(!result.stderr.includes('NEVER-LOG-THIS')); assert.match(result.stderr, /no native\/public acceptance/);
});

test('file fixtures are bounded, read-only and loaded without editing signed inputs', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-lab-contract-'));
  t.after(() => { for (const file of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, file)); fs.rmdirSync(directory); });
  const data = input(), f = fixture();
  const files = { [lab.DESCRIPTOR]: data.descriptor, [`${lab.DESCRIPTOR}.minisig`]: data.descriptorSignature,
    [f.release.assetName]: data.installer, 'latest.json': data.manifest };
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), bytes, { flag: 'wx' });
  const config = { schemaVersion: 1, targetVersion: data.targetVersion, directory, pins: data.pins };
  const contract = lab.loadContract(config);
  assert.equal(contract.routes.length, 5);
  for (const [name, bytes] of Object.entries(files)) assert.deepEqual(fs.readFileSync(path.join(directory, name)), bytes);
  assert.throws(() => lab.readBounded(path.join(directory, lab.DESCRIPTOR), 1), /outside bounds/);
  assert.throws(() => lab.loadContract({ ...config, directory: '.' }), /absolute/);
  assert.throws(() => lab.loadContract({ ...config, signingKey: 'forbidden' }), /Unexpected lab config/);
  const signatureFile = path.join(directory, `${lab.DESCRIPTOR}.minisig`);
  const encodedMetadata = Buffer.from(data.descriptorSignature.toString('base64'));
  fs.writeFileSync(signatureFile, encodedMetadata);
  assert.throws(() => lab.loadContract({ ...config, pins: { ...data.pins, descriptorSignature: hash(encodedMetadata) } }), /Invalid plain minisig/);
  assert.deepEqual(fs.readFileSync(signatureFile), encodedMetadata, 'Refusal must not decode or rewrite the supplied file');
});

function mockTransport() {
  const servers = [], secured = [];
  class Socket extends EventEmitter {
    constructor() { super(); this.remoteAddress = '127.0.0.1'; this.writes = []; }
    setTimeout(ms, fn) { this.timeout = ms; this.onTimeout = fn; }
    write(value) { this.writes.push(value); }
    end(value) { this.write(value); this.destroy(); }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
    disableRenegotiation() { this.renegotiationDisabled = true; }
  }
  class Server extends EventEmitter {
    constructor(options, handler) { super(); this.options = options; this.on('request', handler); servers.push(this); }
    listen(port, host, done) { this.bind = { port, host }; done(); }
    address() { return { port: 12345, address: this.bind.host }; }
    close(done) { this.closed = true; done(); }
  }
  const transport = { http: { createServer: (options, handler) => new Server(options, handler) }, tls: {
    createSecureContext: options => { transport.contextOptions = options; return {}; },
    TLSSocket: class extends Socket {
      constructor(parent, options) { super(); this.parent = parent; this.options = options; secured.push(this); }
    },
  } };
  return { transport, servers, secured, Socket };
}

async function mockProxy(t) {
  const mock = mockTransport(), contract = lab.createContract(input());
  // All networking/TLS is mocked. No certificate, private key, trust or system proxy is created.
  const proxy = await lab.startLabProxy(contract, { pfx: Buffer.from('NO PRIVATE KEY: transport fixture'), passphrase: '' }, runner, mock.transport);
  t.after(() => proxy.close());
  return { ...mock, proxy, contract, inner: mock.servers[0], outer: mock.servers[1] };
}

test('proxy helper binds only IPv4 loopback and guards TLS/SNI/Host without any relay', async t => {
  const { proxy, inner, outer, secured, Socket, transport, contract } = await mockProxy(t);
  assert.deepEqual(outer.bind, { port: 0, host: '127.0.0.1' });
  assert.equal(proxy.proxyUrl, 'http://127.0.0.1:12345');
  assert.equal(transport.contextOptions.minVersion, 'TLSv1.2');
  assert.equal(inner.options.maxHeaderSize, lab.LIMITS.headers);
  const socket = new Socket(); outer.emit('connection', socket);
  outer.emit('connect', { url: 'api.github.com:443', headers: { host: 'api.github.com:443' },
    rawHeaders: ['Host', 'api.github.com:443'] }, socket, Buffer.alloc(0));
  assert.equal(secured.length, 1); assert.match(socket.writes[0], /200 Connection Established/);
  const secure = secured[0];
  assert.deepEqual(secure.options.ALPNProtocols, ['http/1.1']);
  let sniError;
  secure.options.SNICallback('github.com', error => { sniError = error; }); assert.ok(sniError);
  secure.options.SNICallback('api.github.com', error => { assert.equal(error, null); });
  let admitted;
  inner.once('connection', value => { admitted = value; });
  secure.servername = 'api.github.com'; secure.emit('secure');
  assert.equal(admitted, secure); assert.equal(secure.labHost, 'api.github.com');
  assert.equal(secure.renegotiationDisabled, true);
  const res = new EventEmitter(); res.writeHead = status => { res.status = status; };
  res.end = bytes => { res.bytes = bytes; res.emit('finish'); };
  inner.emit('request', { method: 'GET', headers: { host: 'api.github.com' }, rawHeaders: ['Host', 'api.github.com'],
    url: lab.FEED_PATH, socket: secure }, res);
  assert.equal(res.status, 200); assert.equal(hash(res.bytes), contract.routes[0].sha256);
  assert.deepEqual(proxy.report().requests, [contract.routes[0]]);
  await proxy.close(); await proxy.close();
  assert.ok(socket.destroyed && secure.destroyed && outer.closed);
});

test('proxy helper refuses unsupported CONNECT, credential headers, bodies and pipelined bytes', async t => {
  const { outer, secured, Socket, proxy } = await mockProxy(t);
  const base = { url: 'github.com:443', headers: { host: 'github.com:443' }, rawHeaders: ['Host', 'github.com:443'] };
  const bad = [{ ...base, url: 'evil.test:443' }, { ...base, headers: { host: 'api.github.com:443' } },
    ...['authorization', 'proxy-authorization', 'cookie', 'content-length', 'transfer-encoding'].map(key =>
      ({ ...base, headers: { ...base.headers, [key]: 'DO-NOT-LOG' } }))];
  for (const req of bad) {
    const socket = new Socket(); outer.emit('connection', socket); outer.emit('connect', req, socket, Buffer.alloc(0));
    assert.ok(socket.destroyed); assert.match(socket.writes[0], /400 Rejected/);
  }
  const pipelined = new Socket(); outer.emit('connection', pipelined);
  outer.emit('connect', base, pipelined, Buffer.from('anything after CONNECT'));
  assert.ok(pipelined.destroyed); assert.equal(secured.length, 0);
  assert.ok(!JSON.stringify(proxy.report()).includes('DO-NOT-LOG'));
});

test('missing/mismatched SNI is never admitted; idle sockets and connection budget are bounded', async t => {
  const { outer, inner, secured, Socket } = await mockProxy(t);
  let admitted = 0; inner.on('connection', () => admitted++);
  for (const name of [undefined, 'github.com', 'evil.test']) {
    const socket = new Socket(); outer.emit('connection', socket);
    outer.emit('connect', { url: 'api.github.com:443', headers: { host: 'api.github.com:443' },
      rawHeaders: ['Host', 'api.github.com:443'] }, socket, Buffer.alloc(0));
    const secure = secured.at(-1); secure.servername = name; secure.emit('secure');
    assert.ok(secure.destroyed); socket.destroy();
  }
  assert.equal(admitted, 0);
  const idle = new Socket(); outer.emit('connection', idle);
  assert.equal(idle.timeout, lab.LIMITS.idleMs); idle.onTimeout(); assert.ok(idle.destroyed);
  const outside = new Socket(); outside.remoteAddress = '192.0.2.1'; outer.emit('connection', outside); assert.ok(outside.destroyed);
  const sockets = Array.from({ length: lab.LIMITS.connections + 1 }, () => new Socket());
  for (const socket of sockets) outer.emit('connection', socket);
  assert.ok(sockets.at(-1).destroyed); assert.ok(!sockets[0].destroyed);
});

test('malformed HTTP, upgrades, nested CONNECT and untunneled GET never become lab responses', async t => {
  const { outer, inner, Socket, proxy } = await mockProxy(t);
  for (const server of [outer, inner]) {
    for (const event of ['clientError', 'upgrade']) {
      const socket = new Socket(); server.emit(event, Error('SECRET-PARSER-CONTENT'), socket); assert.ok(socket.destroyed);
    }
    for (const event of ['checkContinue', 'checkExpectation']) {
      const res = { writeHead: status => { res.status = status; }, end() {} };
      server.emit(event, {}, res); assert.equal(res.status, 400);
    }
  }
  const nested = new Socket(); inner.emit('connect', {}, nested); assert.ok(nested.destroyed);
  const res = { writeHead: status => { res.status = status; }, end() {} };
  outer.emit('request', {}, res); assert.equal(res.status, 405);
  assert.ok(!JSON.stringify(proxy.report()).includes('SECRET-PARSER-CONTENT'));
  assert.equal(proxy.report().rejectedRequestCount, 10);
  assert.equal(proxy.report().connectionResetEventCount, 0);
});

test('peer resets are bounded transport event diagnostics, not rejected requests or HTTP responses', async t => {
  const { outer, inner, secured, Socket, proxy } = await mockProxy(t);
  const socket = new Socket(); outer.emit('connection', socket);
  outer.emit('connect', { url: 'api.github.com:443', headers: { host: 'api.github.com:443' },
    rawHeaders: ['Host', 'api.github.com:443'] }, socket, Buffer.alloc(0));
  const secure = secured[0]; secure.servername = 'api.github.com'; secure.emit('secure');
  secure.emit('error', Object.assign(Error('PRIVATE TRANSPORT DETAIL'), { code: 'ECONNRESET' }));
  inner.emit('clientError', Object.assign(Error('PRIVATE TRANSPORT DETAIL'), { code: 'ECONNRESET' }), secure);
  assert.ok(secure.destroyed); assert.deepEqual(secure.writes, []);
  for (let index = 0; index < 20; index++) {
    const reset = new Socket();
    outer.emit('clientError', Object.assign(Error('PRIVATE TRANSPORT DETAIL'), { code: 'ECONNRESET' }), reset);
    assert.ok(reset.destroyed); assert.deepEqual(reset.writes, []);
  }
  const report = proxy.report();
  assert.equal(report.rejectedRequestCount, 0);
  assert.deepEqual(report.rejectionSummary, []);
  assert.equal(report.connectionResetEventCount, 22);
  assert.deepEqual(report.connectionResetSummary, [
    { kind: 'tls-error', code: 'ECONNRESET', count: 1 },
    { kind: 'inner-client-error', code: 'ECONNRESET', count: 1 },
    { kind: 'outer-client-error', code: 'ECONNRESET', count: 20 },
  ]);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE TRANSPORT DETAIL/);
  assert.equal(report.requests.length, 0);
});

test('non-reset TLS and HTTP failures still fail request policy accounting', async t => {
  const { outer, inner, secured, Socket, proxy } = await mockProxy(t);
  const socket = new Socket(); outer.emit('connection', socket);
  outer.emit('connect', { url: 'api.github.com:443', headers: { host: 'api.github.com:443' },
    rawHeaders: ['Host', 'api.github.com:443'] }, socket, Buffer.alloc(0));
  secured[0].emit('error', Object.assign(Error('SECRET TLS DETAIL'), { code: 'ERR_SSL_WRONG_VERSION_NUMBER' }));
  for (const server of [inner, outer]) {
    for (const code of ['HPE_INVALID_METHOD', 'ECONNABORTED', undefined]) {
      const malformed = new Socket(); server.emit('clientError', { code }, malformed);
      assert.ok(malformed.destroyed); assert.match(malformed.writes[0], /400 Rejected/);
    }
  }
  const report = proxy.report();
  assert.equal(report.rejectedRequestCount, 7);
  assert.equal(report.connectionResetEventCount, 0);
  assert.doesNotMatch(JSON.stringify(report), /SECRET TLS DETAIL/);
});

test('duplicate or absent Host headers refused even when a parser keeps the first value', async t => {
  const contract = lab.createContract(input()), route = contract.routes[0];
  for (const rawHeaders of [[], ['Host', route.host, 'host', 'evil.test']]) {
    assert.equal(request(contract, route, { rawHeaders }).res.status, 400);
  }
  const { outer, secured, Socket } = await mockProxy(t);
  for (const rawHeaders of [[], ['Host', 'github.com:443', 'hOsT', 'api.github.com:443']]) {
    const socket = new Socket(); outer.emit('connection', socket);
    outer.emit('connect', { url: 'github.com:443', headers: { host: 'github.com:443' }, rawHeaders }, socket, Buffer.alloc(0));
    assert.ok(socket.destroyed);
  }
  assert.equal(secured.length, 0);
});
