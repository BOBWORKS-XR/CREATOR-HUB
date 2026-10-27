'use strict';
// Linux DEB 14 -> acceptance-only 15 and closed 016 bootstrap transport, NOT native acceptance.
// CONFIG: {schemaVersion:1,targetVersion:'0.1.15',directory,pins:{descriptor,
// descriptorSignature,installer,manifest,executable}}. External review supplies
// hashes of immutable already-signed inputs; this harness never authenticates them.
// The native caller owns its isolated ephemeral TLS trust/session and recovery.
// CLI CONFIG REPORT paths live below $RUNNER_TEMP/creator-linux-update-lab.
// Separate update-016-017[-inspect] MODE ROOT paths are fixed to the production update controller.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const tls = require('node:tls');

const FROM = '0.1.14', TO = '0.1.15';
const BRANCH = 'refs/heads/validation/linux-installed-candidate-014';
const DESCRIPTOR = 'creator-hub-linux-x86_64-deb.json';
const PLATFORM = 'linux-x86_64-deb';
const ASSET = 'Creator_Hub_0.1.15_amd64-acceptance-only.deb';
// Parent-reviewed native build 39105404389. This is an input restriction, not
// independent provenance, signature, installation or restart verification.
const REVIEWED_TARGET = Object.freeze({ bytes: 62212268,
  installer: '98aa9750cecf387a960f994d24726e5ca09100a5ce3723607939eeaa08d80796',
  executable: '7629379fbd3d0b7db0a996d727aa166750e08165478d622fe0d7c5047f2d50fe' });
const INTEGRATED_BRANCH = 'refs/heads/validation/linux-integrated-update';
const INTEGRATED_TARGET = Object.freeze({ bytes: 63874030,
  descriptor: 'bbc44a1443f861bda3e927727834f14fb5af487f5290a03616335228335f8290',
  descriptorSignature: '3199977b6ccd8911ded3691145f9c3a939105c8b4f0aa805679b10e04c64ed9b',
  installer: '4cbd1488e0568e79ad8a9bc47d445cbbb344abc2c72045cde2dd3cd5e72fb36d',
  manifest: 'f260bcd30e8ce5d3f20189ddbb1b2ba2c33186be71b83e3937af68f1dcc1ca5c',
  executable: 'fc18fd79ab9fd1f9456b1f124acaba2390ea3501e1617e3f91dea082d9ce7a56' });
const FEED_PATH = '/repos/BOBWORKS-XR/CREATOR-HUB/releases?per_page=10';
const PREFIX = `/BOBWORKS-XR/CREATOR-HUB/releases/download/v${TO}/`;
const LIMITS = Object.freeze({ metadata: 32768, signature: 4096, installer: 512 * 1024 * 1024,
  feed: 256 * 1024, headers: 8192, headerCount: 16, connections: 32, activeConnections: 8,
  requests: 64, receivedBytes: 256 * 1024, receivedPerConnection: 32768,
  servedBytes: 1028 * 1024 * 1024, handshakeMs: 10000, connectionMs: 60000,
  idleMs: 15000, durationMs: 600000, tls: 65536 });
const PIN_NAMES = ['descriptor', 'descriptorSignature', 'installer', 'manifest', 'executable'];
const HOSTS = ['api.github.com', 'github.com'];
const BOOTSTRAP_PROFILE = '016-bootstrap';
const BOOTSTRAP_BRANCH = 'refs/heads/validation/native-linux-production-016-flatpak';
const BOOTSTRAP_WORKFLOW = '.github/workflows/native-linux-production-016-flatpak.yml';
const BOOTSTRAP_REQUEST = 'execute-production-bootstrap-activation-016';
const BOOTSTRAP_PREFIX = '/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.16/';
// Reviewed Root4d9 producer39435741602; metadata carrier39445160315/artifact12276935344.
// These are transport restrictions, not signature or native-install acceptance.
const BOOTSTRAP_FILES = Object.freeze(Object.fromEntries(Object.entries({
  'creator-hub-linux-x86_64-portable.json': { size: 702, sha256: 'fa93c3e380716685e31ff5f90b2ed46ddf153864227e861465a96dddb318bde2' },
  'creator-hub-linux-x86_64-portable.json.minisig': { size: 305, sha256: 'fffe83751416fb23be49a57336d25112f2940457398b9da695e3e60ac61fec25' },
  'creator-hub-linux-x86_64-0.1.16.portable-manifest.json': { size: 68007, sha256: 'e999031faf52382dc93145e8195df50d9d86f6b4d3d138f3546881d74882e013' },
  'creator-hub-linux-x86_64-0.1.16.portable-manifest.json.minisig': { size: 305, sha256: 'edfc1d1befcbcdd3074e878bacbb5122289ff0f0827dc6b9e098340195344e32' },
  'creator-hub-linux-x86_64-0.1.16.appdir.tar.gz': { size: 164473696, sha256: 'a1df9859259bab9038bad737cadc0480c10a3a03ac388d16e589afbf364ebbf1' },
}).map(([name, value]) => [name, Object.freeze(value)])));
const BOOTSTRAP_ZIP = Object.freeze({ size: 451816231, sha256: '25ba6649c3886fd685c1dc7bab7f49e405569fe015674528529e9e3b901ccab5' });
const UPDATE_BRANCH = 'refs/heads/validation/native-linux-production-016-update';
const UPDATE_WORKFLOW = '.github/workflows/native-linux-production-016-update.yml';
const UPDATE_SCENARIOS = Object.freeze({ deb: Object.freeze(['deb-native-cancel', 'deb-auth-cancel', 'deb-approve']),
  portable: Object.freeze(['portable-native-cancel', 'portable-approve']) });
const UPDATE_DEB = Object.freeze({ size: 64296202, sha256: 'efc71fb740ab87e2d8a3d8519cbe8fff38edaa6ee95f358e50b2eccc0f5f80fe',
  executableSha256: '147d7847a1437adbd33d161029307eb32bc1e406482d8f93247822eb805c47cd' });
const UPDATE_ASSET = 'Creator_Hub_0.1.17_amd64-acceptance-only.deb';
const UPDATE_SOURCE17 = Object.freeze({ commit: '75a99ff4a267064aaa3ac9e30039bc91dc791d89', tree: '5f62bf4bc1ba85eb293ca9a5a30330b06b6b4351' });
const contracts = new WeakMap();
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function keys(value, names, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `Invalid ${label}`);
  assert.deepEqual(Object.keys(value).sort(), [...names].sort(), `Unexpected ${label} fields`);
}
function bounded(bytes, max, label) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= max, `${label} size outside bounds`);
  return bytes;
}
function decode(bytes) { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
function json(bytes) { return JSON.parse(decode(bytes)); }
function plainMinisig(bytes) {
  const text = decode(bounded(bytes, LIMITS.signature, 'Minisig'));
  assert.ok(text.startsWith('untrusted comment:') && !text.includes('\0'), 'Invalid plain minisig envelope');
  // Encoding/envelope only. The native production-key verifier owns authenticity.
}
function canonicalBase64(text, max) {
  assert.ok(typeof text === 'string' && text.length > 0 && text.length <= Math.ceil(max / 3) * 4, 'Base64 size outside bounds');
  const bytes = Buffer.from(text, 'base64');
  assert.equal(bytes.toString('base64'), text, 'Noncanonical base64');
  return bounded(bytes, max, 'Decoded base64');
}

function createContract(input) {
  keys(input, ['targetVersion', 'descriptor', 'descriptorSignature', 'installer', 'manifest', 'pins'], 'Linux lab input');
  assert.equal(input.targetVersion, TO, 'Only acceptance-only Linux15 is admitted');
  keys(input.pins, PIN_NAMES, 'external SHA-256 pins');
  for (const value of Object.values(input.pins)) assert.match(value, /^(?!0{64}$)[a-f0-9]{64}$/, 'Invalid external pin');
  const bytes = {};
  for (const [name, max] of Object.entries({ descriptor: LIMITS.metadata, descriptorSignature: LIMITS.signature,
    installer: LIMITS.installer, manifest: LIMITS.metadata })) {
    bytes[name] = Buffer.from(bounded(input[name], max, name));
    assert.equal(hash(bytes[name]), input.pins[name], `${name} SHA-256 mismatch`);
  }
  const release = json(bytes.descriptor);
  keys(release, ['schemaVersion', 'appId', 'version', 'platform', 'architecture', 'packageType', 'assetName',
    'byteLength', 'sha256', 'executableSha256', 'identityProtocol', 'lifecycleProtocol', 'installerProtocol', 'minHubVersion'], 'Linux descriptor');
  for (const [key, expected] of Object.entries({ schemaVersion: 1, appId: 'creator-hub', version: TO, platform: 'linux',
    architecture: 'x86_64', packageType: 'deb', assetName: ASSET, byteLength: bytes.installer.length,
    sha256: input.pins.installer, executableSha256: input.pins.executable, installerProtocol: 1, minHubVersion: FROM })) {
    assert.equal(release[key], expected, `Linux descriptor ${key} mismatch`);
  }
  for (const key of ['identityProtocol', 'lifecycleProtocol']) assert.ok([0, 1].includes(release[key]), `Unsupported ${key}`);
  plainMinisig(bytes.descriptorSignature);
  const update = json(bytes.manifest);
  assert.ok(Object.keys(update).every(key => ['version', 'notes', 'pub_date', 'platforms'].includes(key)), 'Unexpected manifest fields');
  assert.equal(update.version, TO, 'Manifest version mismatch');
  for (const key of ['notes', 'pub_date']) if (Object.hasOwn(update, key)) assert.equal(typeof update[key], 'string');
  keys(update.platforms, [PLATFORM], 'Linux manifest platforms');
  keys(update.platforms[PLATFORM], ['url', 'signature'], 'Linux manifest entry');
  assert.equal(update.platforms[PLATFORM].url, `https://github.com${PREFIX}${ASSET}`, 'Exact Linux asset URL required');
  plainMinisig(canonicalBase64(update.platforms[PLATFORM].signature, LIMITS.signature));
  const names = [DESCRIPTOR, `${DESCRIPTOR}.minisig`, ASSET, 'latest.json'];
  const feed = Buffer.from(JSON.stringify([{ tag_name: `v${TO}`, draft: false, prerelease: false,
    assets: names.map(name => ({ name })) }]));
  bounded(feed, LIMITS.feed, 'Release feed');
  const routes = [{ host: HOSTS[0], path: FEED_PATH, bytes: feed, type: 'application/json' },
    ...names.map((name, i) => ({ host: HOSTS[1], path: `${PREFIX}${name}`,
      bytes: [bytes.descriptor, bytes.descriptorSignature, bytes.installer, bytes.manifest][i],
      type: i === 2 ? 'application/octet-stream' : i === 1 ? 'text/plain; charset=utf-8' : 'application/json' }))]
    .map(route => ({ ...route, sha256: hash(route.bytes) }));
  const contract = Object.freeze({ fromVersion: FROM, targetVersion: TO, pins: Object.freeze({ ...input.pins }),
    routes: Object.freeze(routes.map(({ host, path: routePath, sha256 }) => Object.freeze({ host, path: routePath, sha256 }))) });
  contracts.set(contract, routes);
  return contract;
}

function readBounded(file, max) {
  assert.ok(path.isAbsolute(file) && path.resolve(file) === file, 'Canonical absolute input required');
  for (let name = file; ; name = path.dirname(name)) {
    assert.equal(fs.lstatSync(name).isSymbolicLink(), false, 'Linked input refused');
    if (name === path.dirname(name)) break;
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const before = fs.fstatSync(fd);
    assert.ok(before.isFile() && before.size > 0 && before.size <= max && before.nlink === 1, 'Bounded single-link regular input required');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      assert.ok(count > 0, 'Short input read'); offset += count;
    }
    const after = fs.fstatSync(fd);
    for (const key of ['size', 'mtimeMs', 'ctimeMs', 'dev', 'ino']) assert.equal(after[key], before[key], 'Input changed during read');
    return bytes;
  } finally { fs.closeSync(fd); }
}
function loadContract(config) {
  keys(config, ['schemaVersion', 'targetVersion', 'directory', 'pins'], 'Linux lab config');
  assert.equal(config.schemaVersion, 1); assert.equal(config.targetVersion, TO);
  assert.ok(path.isAbsolute(config.directory) && path.resolve(config.directory) === config.directory, 'Canonical absolute candidate directory required');
  return createContract({ targetVersion: TO, pins: config.pins,
    descriptor: readBounded(path.join(config.directory, DESCRIPTOR), LIMITS.metadata),
    descriptorSignature: readBounded(path.join(config.directory, `${DESCRIPTOR}.minisig`), LIMITS.signature),
    installer: readBounded(path.join(config.directory, ASSET), LIMITS.installer),
    manifest: readBounded(path.join(config.directory, 'latest.json'), LIMITS.metadata) });
}
function reviewedTargetPins(pins, byteLength, profile = 'legacy') {
  assert.ok(['legacy', 'integrated-39134454264'].includes(profile), 'Unknown reviewed Linux target profile');
  const expected = profile === 'legacy' ? REVIEWED_TARGET : INTEGRATED_TARGET;
  assert.equal(byteLength, expected.bytes, 'Exact reviewed Linux15 DEB size required');
  for (const key of profile === 'legacy' ? ['installer', 'executable'] : PIN_NAMES) assert.equal(pins[key], expected[key], `Exact reviewed Linux15 ${key} pin required`);
}

function assertBootstrapRunner(env = process.env, platform = process.platform, arch = process.arch,
  uid = process.getuid?.(), euid = process.geteuid?.()) {
  assert.equal(platform, 'linux'); assert.equal(arch, 'x64');
  assert.ok(Number.isInteger(uid) && uid > 0 && uid === euid, 'Unprivileged disposable native user required');
  for (const [name, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: BOOTSTRAP_BRANCH,
    GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/${BOOTSTRAP_WORKFLOW}@${BOOTSTRAP_BRANCH}`,
    EXECUTION_REQUEST: BOOTSTRAP_REQUEST })) assert.equal(env[name], value, name);
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/);
  for (const name of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) assert.match(env[name] || '', /^[1-9][0-9]*$/);
  assert.ok(path.isAbsolute(env.RUNNER_TEMP || '') && path.resolve(env.RUNNER_TEMP) === env.RUNNER_TEMP);
  assert.ok(!env.FLATPAK_ID);
  for (const name of Object.keys(env)) assert.ok(!/^(LD_|DYLD_|TAURI_|WEBKIT_|APPIMAGE$|APPDIR$|PYTHON|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|SSL_CERT_|CURL_CA_BUNDLE$|BASH_ENV$|ENV$|CREATOR_HUB_SIGNING_)/.test(name)
    && !name.toLowerCase().endsWith('proxy'), 'Inherited runtime, trust, proxy or signing override refused');
}

function bootstrapFile(file, expected, retain = true) {
  assert.ok(path.isAbsolute(file) && path.resolve(file) === file);
  for (let name = file;; name = path.dirname(name)) {
    assert.equal(fs.lstatSync(name).isSymbolicLink(), false, 'Redirected bootstrap input');
    if (path.dirname(name) === name) break;
  }
  const before = fs.lstatSync(file, { bigint: true });
  assert.ok(before.isFile() && before.nlink === 1n && before.size === BigInt(expected.size));
  if (process.getuid) assert.equal(before.uid, BigInt(process.getuid()));
  const identity = value => [value.dev, value.ino, value.mode, value.nlink, value.size, value.mtimeNs, value.birthtimeNs];
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true }); assert.deepEqual(identity(opened), identity(before));
    const digest = crypto.createHash('sha256'), block = Buffer.alloc(65536), chunks = []; let size = 0;
    for (let count; (count = fs.readSync(fd, block)) > 0;) {
      size += count; assert.ok(size <= expected.size); digest.update(block.subarray(0, count));
      if (retain) chunks.push(Buffer.from(block.subarray(0, count)));
    }
    assert.deepEqual({ size, sha256: digest.digest('hex') }, expected, 'Exact reviewed bootstrap bytes required');
    assert.deepEqual(identity(fs.fstatSync(fd, { bigint: true })), identity(opened));
    const after = fs.lstatSync(file, { bigint: true });
    assert.deepEqual(identity(after), identity(before)); assert.equal(after.ctimeNs, before.ctimeNs);
    return retain ? Buffer.concat(chunks) : undefined;
  } finally { fs.closeSync(fd); }
}

function loadBootstrap016(root) {
  assert.ok(path.isAbsolute(root) && path.resolve(root) === root);
  const folder = fs.lstatSync(root); assert.ok(folder.isDirectory() && !folder.isSymbolicLink());
  bootstrapFile(path.join(root, 'portable.zip'), BOOTSTRAP_ZIP, false);
  const routes = Object.entries(BOOTSTRAP_FILES).map(([name, expected]) => {
    const directory = name.endsWith('.tar.gz') ? 'portable' : 'signed';
    const bytes = bootstrapFile(path.join(root, 'stage', directory, name), expected);
    return { host: 'github.com', path: BOOTSTRAP_PREFIX + name, bytes, sha256: expected.sha256,
      type: name.endsWith('.tar.gz') ? 'application/octet-stream' : name.endsWith('.minisig') ? 'text/plain; charset=utf-8' : 'application/json' };
  });
  const contract = Object.freeze({ profile: BOOTSTRAP_PROFILE, fromVersion: '0.1.16', targetVersion: '0.1.16',
    pins: Object.freeze({ originalZip: BOOTSTRAP_ZIP, files: BOOTSTRAP_FILES }),
    routes: Object.freeze(routes.map(({ host, path: routePath, sha256 }) => Object.freeze({ host, path: routePath, sha256 }))) });
  contracts.set(contract, routes); return contract;
}

function assertRunner(env = process.env, platform = process.platform, arch = process.arch,
  uid = process.getuid?.(), euid = process.geteuid?.()) {
  assert.equal(platform, 'linux', 'Native Linux runner required'); assert.equal(arch, 'x64');
  assert.ok(Number.isInteger(uid) && uid > 0 && euid === uid, 'Non-root native user required');
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB',
    GITHUB_REPOSITORY_ID: '1364807512', CREATOR_LINUX_UPDATE_LAB_FEED: '1' })) assert.equal(env[key], value, key);
  assert.ok([BRANCH, INTEGRATED_BRANCH].includes(env.GITHUB_REF), 'Exact reviewed lab branch required');
  if (env.GITHUB_REF === INTEGRATED_BRANCH) {
    assert.equal(env.CREATOR_LINUX_INTEGRATED_UPDATE, '1');
    assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'Integrated native lab is manual capture only');
  }
  assert.ok(['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME), 'Unsupported test event');
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/); assert.match(env.GITHUB_RUN_ID || '', /^[1-9][0-9]*$/);
  assert.equal(env.FLATPAK_ID, undefined, 'Native, not Flatpak context required');
  assert.ok(path.isAbsolute(env.RUNNER_TEMP || '') && path.resolve(env.RUNNER_TEMP) === env.RUNNER_TEMP, 'Canonical runner temp required');
  for (const key of Object.keys(env)) assert.ok(!/^(LD_|DYLD_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|SSL_CERT_|TAURI_SIGNING_|CREATOR_HUB_SIGNING_)/.test(key), 'Runtime/signing injection refused');
  // Environment admission is a disposable-execution guard, never caller authentication.
}

function connectHost(authority) {
  return typeof authority === 'string' && HOSTS.some(host => authority === `${host}:443`) ? authority.slice(0, -4) : null;
}
function headersAllowed(req, connect = false) {
  const raw = req.rawHeaders, headers = req.headers;
  if (req.httpVersion !== '1.1' || !Array.isArray(raw) || raw.length < 2 || raw.length > LIMITS.headerCount * 2 || raw.length % 2
    || !headers || typeof headers !== 'object') return false;
  const allowed = connect ? ['host', 'user-agent', 'connection', 'proxy-connection']
    : ['host', 'user-agent', 'accept', 'accept-encoding', 'connection', 'content-length'];
  const seen = new Set(); let bytes = 0;
  for (let i = 0; i < raw.length; i += 2) {
    if (typeof raw[i] !== 'string' || typeof raw[i + 1] !== 'string') return false;
    const name = raw[i].toLowerCase(), value = raw[i + 1];
    bytes += Buffer.byteLength(raw[i]) + Buffer.byteLength(value) + 4;
    if (!allowed.includes(name) || seen.has(name) || headers[name] !== value || !/^[\x20-\x7e]*$/.test(value)) return false;
    seen.add(name);
    if ((name === 'connection' || name === 'proxy-connection') && !/^(keep-alive|close)$/i.test(value)) return false;
    if (name === 'content-length' && value !== '0') return false;
  }
  return seen.has('host') && seen.size === Object.keys(headers).length && bytes <= LIMITS.headers;
}
function newState() {
  return { requests: 0, connections: 0, receivedBytes: 0, servedBytes: 0, rejected: 0, served: new Map(), closeReason: null };
}
function chargeRequest(state) {
  if (state.requests >= LIMITS.requests || state.closeReason) return false;
  state.requests++; return true;
}
function resolveRequest(contract, host, req, state) {
  const routes = contracts.get(contract); assert.ok(routes, 'Validated Linux contract required');
  if (!chargeRequest(state)) return { status: 429 };
  if (req.method !== 'GET') return { status: 405 };
  if (!headersAllowed(req)) return { status: 400 };
  if (!HOSTS.includes(host) || ![host, `${host}:443`].includes(req.headers.host)) return { status: 421 };
  // Deliberately raw origin-form comparison, never URL normalization or redirects.
  const route = routes.find(route => route.host === host && route.path === req.url);
  if (!route) return { status: 404 };
  if (state.servedBytes + route.bytes.length > LIMITS.servedBytes || state.receivedBytes > LIMITS.receivedBytes) return { status: 429 };
  state.servedBytes += route.bytes.length;
  return { status: 200, route };
}
function labReport(contract, state) {
  assert.ok(contracts.has(contract));
  const bootstrap = contract.profile === BOOTSTRAP_PROFILE;
  return { schemaVersion: 1, scope: bootstrap ? 'linux-portable-016-bootstrap-lab-transport' : 'linux-deb-outgoing-14-to-acceptance-only-15-lab-transport',
    fromVersion: contract.fromVersion, targetVersion: contract.targetVersion,
    labDiscovery: true, publicDiscovery: false, nativeAcceptanceTested: false, baselineActuallyTested: false,
    signaturesVerifiedByHarness: false, signedUpdateAccepted: false, migrationAccepted: false,
    restartAccepted: false, restoredViewsAccepted: false, liveAiAcceptance: false, releaseReady: false,
    pins: { ...contract.pins }, connectionCount: state.connections, requestCount: state.requests,
    receivedHttpBytes: state.receivedBytes, reservedResponseBytes: state.servedBytes,
    rejectedRequestCount: state.rejected, closeReason: state.closeReason,
    requests: [...state.served.values()].map(route => ({ ...route })) };
}

function tlsContext(options) {
  keys(options, ['key', 'cert'], 'caller-owned ephemeral TLS');
  const key = bounded(options.key, LIMITS.tls, 'Ephemeral TLS key'), cert = bounded(options.cert, LIMITS.tls, 'Ephemeral TLS certificate');
  const certificate = new crypto.X509Certificate(cert);
  assert.deepEqual((certificate.subjectAltName || '').split(', ').sort(), HOSTS.map(host => `DNS:${host}`).sort(), 'Exact GitHub TLS SANs required');
  assert.ok(certificate.checkPrivateKey(crypto.createPrivateKey(key)), 'Ephemeral TLS key mismatch');
  const now = Date.now(), start = Date.parse(certificate.validFrom), end = Date.parse(certificate.validTo);
  assert.ok(start <= now && end > now && end - start <= 48 * 60 * 60 * 1000, 'Short-lived ephemeral certificate required');
  return tls.createSecureContext({ key, cert, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3' });
}

// Mechanism-only entry for approved local synthetic TLS tests. No runner/native
// acceptance claim. Native orchestration/CLI must use guarded startLabProxy.
async function startLoopbackTransport(contract, options) {
  assert.ok(contracts.has(contract), 'Validated Linux contract required');
  const context = tlsContext(options), state = newState(), rawSockets = new Set(), secureSockets = new Set();
  const bound = new WeakMap(), used = new WeakSet(), timers = new Set();
  const opts = { maxHeaderSize: LIMITS.headers, headersTimeout: LIMITS.handshakeMs, requestTimeout: LIMITS.idleMs,
    connectionsCheckingInterval: 1000, joinDuplicateHeaders: false, insecureHTTPParser: false };
  const reject = (socket, status = 400) => {
    state.rejected++;
    if (!socket.destroyed && socket.writable) socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    else socket.destroy();
  };
  const refuse = (res, status) => {
    state.rejected++; res.writeHead(status, { Connection: 'close', 'Content-Length': '0' }); res.end();
  };
  const inner = http.createServer(opts, (req, res) => {
    const host = bound.get(req.socket);
    if (!host || used.has(req.socket) || req.socket.destroyed) { refuse(res, 400); return; }
    used.add(req.socket);
    const result = resolveRequest(contract, host, req, state);
    if (result.status !== 200) { refuse(res, result.status); return; }
    const route = result.route;
    res.writeHead(200, { 'Content-Type': route.type, 'Content-Length': String(route.bytes.length), 'Cache-Control': 'no-store', Connection: 'close' });
    res.once('finish', () => state.served.set(`${route.host}${route.path}`, { host: route.host, path: route.path, sha256: route.sha256 }));
    res.end(route.bytes);
  });
  const outer = http.createServer(opts, (_req, res) => {
    if (!chargeRequest(state)) { res.once('finish', () => { void close('request-budget'); }); refuse(res, 429); return; }
    refuse(res, 405);
  });
  for (const server of [inner, outer]) {
    server.maxHeadersCount = LIMITS.headerCount;
    server.on('clientError', (_error, socket) => reject(socket));
    server.on('upgrade', (_req, socket) => reject(socket));
    for (const event of ['checkContinue', 'checkExpectation']) server.on(event, (_req, res) => {
      if (!chargeRequest(state)) { res.once('finish', () => { void close('request-budget'); }); refuse(res, 429); return; }
      refuse(res, 400);
    });
  }
  inner.on('connect', (_req, socket) => reject(socket));
  let closePromise, expiry;
  const closed = {};
  closed.promise = new Promise(resolve => { closed.resolve = resolve; });
  const close = (reason = 'caller') => {
    if (closePromise) return closePromise;
    state.closeReason = reason;
    closePromise = new Promise(resolve => {
      clearTimeout(expiry); for (const timer of timers) clearTimeout(timer); timers.clear();
      for (const socket of secureSockets) socket.destroy(); for (const socket of rawSockets) socket.destroy();
      outer.close(() => { closed.resolve(); resolve(); });
    });
    return closePromise;
  };
  const deadline = (socket, ms) => {
    const timer = setTimeout(() => { state.rejected++; socket.destroy(); }, ms); timers.add(timer);
    socket.once('close', () => { clearTimeout(timer); timers.delete(timer); });
    return timer;
  };
  const count = socket => {
    let received = 0;
    return chunk => {
      received += chunk.length; state.receivedBytes += chunk.length;
      if (received > LIMITS.receivedPerConnection || state.receivedBytes > LIMITS.receivedBytes) {
        state.rejected++; socket.destroy();
        if (state.receivedBytes > LIMITS.receivedBytes) void close('received-byte-budget');
      }
    };
  };
  const counters = new WeakMap();
  outer.on('connection', socket => {
    if (++state.connections > LIMITS.connections) { socket.destroy(); void close('connection-budget'); return; }
    if (socket.remoteAddress !== '127.0.0.1' || rawSockets.size >= LIMITS.activeConnections || closePromise) { socket.destroy(); state.rejected++; return; }
    rawSockets.add(socket); socket.on('error', () => {});
    socket.once('close', () => rawSockets.delete(socket));
    socket.setTimeout(LIMITS.idleMs, () => socket.destroy()); deadline(socket, LIMITS.connectionMs);
    const counter = count(socket); counters.set(socket, counter); socket.on('data', counter);
  });
  outer.on('connect', (req, socket, head) => {
    const host = connectHost(req.url);
    if (!chargeRequest(state) || closePromise) { reject(socket, 429); void close('request-budget'); return; }
    if (!rawSockets.has(socket) || !host || head.length || !headersAllowed(req, true)
      || ![host, `${host}:443`].includes(req.headers.host)) { reject(socket); return; }
    socket.removeListener('data', counters.get(socket));
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    // No forwarding, DNS, remote socket, upstream request or external listener.
    const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: context, minVersion: 'TLSv1.2',
      ALPNProtocols: ['http/1.1'], SNICallback: (name, callback) => name === host ? callback(null, context) : callback(Error('Rejected SNI')) });
    secureSockets.add(secure); secure.once('close', () => { secureSockets.delete(secure); socket.destroy(); });
    secure.on('error', () => { state.rejected++; secure.destroy(); });
    secure.setTimeout(LIMITS.idleMs, () => secure.destroy());
    const handshake = deadline(secure, LIMITS.handshakeMs);
    secure.once('secure', () => {
      clearTimeout(handshake); timers.delete(handshake);
      if (secure.servername !== host || (secure.alpnProtocol && secure.alpnProtocol !== 'http/1.1')) { state.rejected++; secure.destroy(); return; }
      secure.disableRenegotiation(); bound.set(secure, host);
      secure.on('data', count(secure)); inner.emit('connection', secure);
    });
  });
  await new Promise((resolve, rejectListen) => {
    outer.once('error', rejectListen);
    outer.listen(0, '127.0.0.1', () => { outer.removeListener('error', rejectListen); resolve(); });
  });
  outer.on('error', () => { void close('transport-error'); });
  expiry = setTimeout(() => { void close('duration-budget'); }, LIMITS.durationMs);
  return { proxyUrl: `http://127.0.0.1:${outer.address().port}`, report: () => labReport(contract, state),
    close: () => close('caller'), closed: closed.promise };
}

async function startLabProxy(contract, options, env = process.env) {
  assertRunner(env);
  assert.ok(!fs.existsSync('/.flatpak-info'), 'Native context required');
  assert.ok(contracts.has(contract), 'Validated Linux contract required');
  reviewedTargetPins(contract.pins, contracts.get(contract)[3].bytes.length,
    env.GITHUB_REF === INTEGRATED_BRANCH ? 'integrated-39134454264' : 'legacy');
  return startLoopbackTransport(contract, options);
}
async function startBootstrap016Proxy(contract, options, env = process.env) {
  assertBootstrapRunner(env);
  assert.ok(!fs.existsSync('/.flatpak-info') && contracts.has(contract) && contract.profile === BOOTSTRAP_PROFILE);
  return startLoopbackTransport(contract, options);
}
function saveLabReport(reportFile, value) {
  fs.writeFileSync(reportFile, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

async function bootstrapMain() {
  assertBootstrapRunner();
  assert.equal(process.argv.length, 4);
  const inspect = process.argv[2] === 'bootstrap-016-inspect';
  assert.ok(inspect || process.argv[2] === 'bootstrap-016');
  const root = path.join(process.env.RUNNER_TEMP, 'native-linux-production-016-flatpak');
  assert.equal(process.argv[3], root);
  const folder = fs.lstatSync(root);
  assert.ok(folder.isDirectory() && folder.uid === process.getuid() && (folder.mode & 0o7777) === 0o700);
  const contract = loadBootstrap016(root);
  if (inspect) { console.log(JSON.stringify(labReport(contract, newState()))); return; }
  assert.ok(fs.fstatSync(0).isFIFO(), 'Inherited private pipe required');
  const iterator = process.stdin[Symbol.asyncIterator](); let pending = Buffer.alloc(0);
  async function line(maximum, timeout) {
    let timer;
    try {
      return await Promise.race([(async () => {
        while (!pending.includes(10)) {
          const next = await iterator.next(); if (next.done) return null;
          pending = Buffer.concat([pending, next.value]); assert.ok(pending.length <= maximum);
        }
        const at = pending.indexOf(10), result = pending.subarray(0, at); pending = pending.subarray(at + 1); return result;
      })(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Private control deadline')), timeout); })]);
    } finally { clearTimeout(timer); }
  }
  const control = json(bounded(await line(2 * LIMITS.tls, LIMITS.handshakeMs), 2 * LIMITS.tls, 'TLS control'));
  keys(control, ['key', 'cert'], 'ephemeral TLS control');
  const key = canonicalBase64(control.key, LIMITS.tls), cert = canonicalBase64(control.cert, LIMITS.tls);
  const proxy = await startBootstrap016Proxy(contract, { key, cert }); key.fill(0);
  console.log(JSON.stringify({ kind: 'bootstrap-016-ready', pid: process.pid, proxyUrl: proxy.proxyUrl, publicDiscovery: false, releaseReady: false }));
  try {
    const closed = await Promise.race([line(32, LIMITS.durationMs), proxy.closed.then(() => null)]);
    assert.ok(closed === null || closed.equals(Buffer.from('close')));
  } finally {
    await proxy.close(); process.stdin.destroy();
    saveLabReport(path.join(root, 'lab-transport.json'), proxy.report());
  }
}
function inside(root, file) {
  const relative = path.relative(root, file);
  assert.ok(path.isAbsolute(file) && path.resolve(file) === file && relative && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'Owned isolated lab path required');
}

function updateFiles(mode) {
  assert.ok(Object.hasOwn(UPDATE_SCENARIOS, mode), 'Explicit deb or portable mode required');
  return mode === 'deb' ? [DESCRIPTOR, `${DESCRIPTOR}.minisig`, UPDATE_ASSET, 'latest.json'].map(name => `deb17/${name}`)
    : ['16', '17'].flatMap(version => ['creator-hub-linux-x86_64-portable.json', 'creator-hub-linux-x86_64-portable.json.minisig',
      `creator-hub-linux-x86_64-0.1.${version}.portable-manifest.json`, `creator-hub-linux-x86_64-0.1.${version}.portable-manifest.json.minisig`,
      `creator-hub-linux-x86_64-0.1.${version}.appdir.tar.gz`].map(name => `portable${version}/${name}`));
}
function updateJson(bytes, maximum = LIMITS.metadata) {
  const value = json(bounded(bytes, maximum, 'Production update JSON'));
  assert.ok(bytes.equals(Buffer.from(`${JSON.stringify(value, null, 2)}\n`)), 'Canonical unambiguous update JSON required');
  return value;
}
function updateMaximum(name) {
  return name.endsWith('.deb') || name.endsWith('.tar.gz') ? 256 * 1024 * 1024
    : name.endsWith('.portable-manifest.json') ? 128 * 1024 : name.endsWith('.minisig') ? LIMITS.signature : LIMITS.metadata;
}
function createUpdate016017(config, input) {
  keys(config, ['schemaVersion', 'mode', 'fromVersion', 'targetVersion', 'files'], 'Production update config');
  assert.equal(config.schemaVersion, 1); assert.equal(config.fromVersion, '0.1.16'); assert.equal(config.targetVersion, '0.1.17');
  const names = updateFiles(config.mode); keys(config.files, names, 'Independently bound update pins'); keys(input, names, 'Exact update bytes');
  const bytes = {}, pins = {};
  for (const name of names) {
    const expected = config.files[name]; keys(expected, ['size', 'sha256'], 'External update pin');
    assert.ok(Number.isSafeInteger(expected.size) && expected.size > 0 && expected.size <= updateMaximum(name));
    assert.match(expected.sha256, /^(?!0{64}$)[a-f0-9]{64}$/);
    bytes[name] = Buffer.from(bounded(input[name], updateMaximum(name), name));
    assert.deepEqual({ size: bytes[name].length, sha256: hash(bytes[name]) }, expected, 'Exact independently pinned update input required');
    pins[name] = Object.freeze({ ...expected });
  }
  let executableSha256;
  if (config.mode === 'deb') {
    const release = updateJson(bytes[`deb17/${DESCRIPTOR}`]);
    keys(release, ['schemaVersion', 'appId', 'version', 'platform', 'architecture', 'packageType', 'assetName',
      'byteLength', 'sha256', 'executableSha256', 'identityProtocol', 'lifecycleProtocol', 'installerProtocol', 'minHubVersion'], 'Private017 DEB descriptor');
    for (const [name, expected] of Object.entries({ schemaVersion: 1, appId: 'creator-hub', version: '0.1.17', platform: 'linux',
      architecture: 'x86_64', packageType: 'deb', assetName: UPDATE_ASSET, byteLength: bytes[`deb17/${UPDATE_ASSET}`].length,
      sha256: pins[`deb17/${UPDATE_ASSET}`].sha256, identityProtocol: 0, lifecycleProtocol: 0, installerProtocol: 1, minHubVersion: '0.1.16' })) {
      assert.equal(release[name], expected, `Private017 DEB ${name} differs`);
    }
    assert.match(release.executableSha256, /^(?!0{64}$)[a-f0-9]{64}$/); executableSha256 = release.executableSha256;
    plainMinisig(bytes[`deb17/${DESCRIPTOR}.minisig`]);
    const latest = updateJson(bytes['deb17/latest.json']); keys(latest, ['version', 'notes', 'platforms'], 'Private017 latest');
    assert.equal(latest.version, '0.1.17'); assert.equal(typeof latest.notes, 'string'); keys(latest.platforms, [PLATFORM], 'Private017 platforms');
    keys(latest.platforms[PLATFORM], ['url', 'signature'], 'Private017 package');
    assert.equal(latest.platforms[PLATFORM].url, `https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.17/${UPDATE_ASSET}`);
    plainMinisig(canonicalBase64(latest.platforms[PLATFORM].signature, LIMITS.signature));
  } else {
    for (const version of ['16', '17']) {
      const directory = `portable${version}/`, descriptor = 'creator-hub-linux-x86_64-portable.json';
      const manifestName = `creator-hub-linux-x86_64-0.1.${version}.portable-manifest.json`, archiveName = `creator-hub-linux-x86_64-0.1.${version}.appdir.tar.gz`;
      const release = updateJson(bytes[directory + descriptor]), manifest = updateJson(bytes[directory + manifestName], 128 * 1024);
      keys(release, ['schemaVersion', 'appId', 'version', 'platform', 'architecture', 'packageType', 'manifest', 'archive', 'executableSha256', 'restartProtocol', 'minHubVersion'], 'Portable update descriptor');
      for (const [name, expected] of Object.entries({ schemaVersion: 1, appId: 'creator-hub', version: `0.1.${version}`, platform: 'linux',
        architecture: 'x86_64', packageType: 'portable-appdir', restartProtocol: 1, minHubVersion: '0.1.16' })) assert.equal(release[name], expected);
      for (const [role, name] of [['manifest', manifestName], ['archive', archiveName]]) {
        assert.deepEqual(release[role], { assetName: name, byteLength: pins[directory + name].size, sha256: pins[directory + name].sha256 });
      }
      keys(manifest, ['schemaVersion', 'appId', 'platform', 'architecture', 'version', 'sourceCommit', 'sourceTree', 'format', 'entrypoint', 'archive', 'entries'], 'Signed portable manifest');
      for (const name of ['schemaVersion', 'appId', 'platform', 'architecture', 'version']) assert.equal(manifest[name], release[name]);
      assert.equal(manifest.format, 'appdir-tar-gzip-v1'); assert.equal(manifest.entrypoint, 'usr/bin/creator-hub');
      for (const name of ['sourceCommit', 'sourceTree']) assert.match(manifest[name], /^[a-f0-9]{40}$/);
      if (version === '17') { assert.equal(manifest.sourceCommit, UPDATE_SOURCE17.commit); assert.equal(manifest.sourceTree, UPDATE_SOURCE17.tree); }
      keys(manifest.archive, ['size', 'sha256', 'unpackedSize'], 'Signed archive binding');
      assert.equal(manifest.archive.size, release.archive.byteLength); assert.equal(manifest.archive.sha256, release.archive.sha256);
      assert.ok(Number.isSafeInteger(manifest.archive.unpackedSize) && manifest.archive.unpackedSize > 0 && manifest.archive.unpackedSize <= 512 * 1024 * 1024);
      assert.ok(manifest.entries && typeof manifest.entries === 'object' && !Array.isArray(manifest.entries)
        && Object.keys(manifest.entries).length > 0 && Object.keys(manifest.entries).length <= 8192);
      const root = manifest.entries['usr/bin/creator-hub']; keys(root, ['kind', 'mode', 'size', 'sha256'], 'Signed Root entry');
      assert.equal(root.kind, 'file'); assert.equal(root.mode, 0o755); assert.ok(Number.isSafeInteger(root.size) && root.size > 0 && root.size <= 256 * 1024 * 1024);
      assert.match(root.sha256, /^(?!0{64}$)[a-f0-9]{64}$/); assert.equal(release.executableSha256, root.sha256);
      plainMinisig(bytes[directory + descriptor + '.minisig']); plainMinisig(bytes[directory + manifestName + '.minisig']);
    }
  }
  const feedNames = config.mode === 'deb' ? [DESCRIPTOR, `${DESCRIPTOR}.minisig`, UPDATE_ASSET, 'latest.json']
    : names.filter(name => name.startsWith('portable17/')).map(name => name.slice('portable17/'.length));
  const feed = Buffer.from(JSON.stringify([{ tag_name: 'v0.1.17', draft: false, prerelease: false, assets: feedNames.map(name => ({ name })) }]));
  const routes = [{ host: 'api.github.com', path: FEED_PATH, bytes: bounded(feed, LIMITS.feed, 'Private017 feed'), type: 'application/json' },
    ...names.map(name => ({ host: 'github.com', path: `/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.${name.startsWith('portable16/') ? '16' : '17'}/${name.slice(name.indexOf('/') + 1)}`,
      bytes: bytes[name], type: name.endsWith('.minisig') ? 'text/plain; charset=utf-8' : name.endsWith('.json') ? 'application/json' : 'application/octet-stream' }))]
    .map(route => ({ ...route, sha256: hash(route.bytes) }));
  const contract = Object.freeze({ profile: `016-${config.mode}-to-private017`, mode: config.mode, fromVersion: '0.1.16', targetVersion: '0.1.17',
    pins: Object.freeze(pins), ...(config.mode === 'deb' ? { executableSha256 } : {}),
    routes: Object.freeze(routes.map(({ host, path: routePath, sha256 }) => Object.freeze({ host, path: routePath, sha256 }))) });
  contracts.set(contract, routes); return contract;
}
function reviewedUpdateTarget(contract) {
  assert.ok(contracts.has(contract) && ['deb', 'portable'].includes(contract.mode)
    && contract.profile === `016-${contract.mode}-to-private017`, 'Distinct production update contract required');
  if (contract.mode === 'deb') {
    assert.deepEqual(contract.pins[`deb17/${UPDATE_ASSET}`], { size: UPDATE_DEB.size, sha256: UPDATE_DEB.sha256 }, 'Exact actual39352480021 DEB required');
    assert.equal(contract.executableSha256, UPDATE_DEB.executableSha256, 'Exact installed private017 Root required');
  }
}
function loadUpdate016017(root, mode) {
  assert.ok(path.isAbsolute(root) && path.resolve(root) === root);
  assert.deepEqual(fs.readdirSync(root).sort(), ['inputs', 'transport-pins.json']);
  const config = updateJson(readBounded(path.join(root, 'transport-pins.json'), LIMITS.metadata)); assert.equal(config.mode, mode);
  const names = updateFiles(mode), directories = mode === 'deb' ? ['deb17'] : ['portable16', 'portable17'];
  assert.deepEqual(fs.readdirSync(path.join(root, 'inputs')).sort(), directories);
  for (const directory of directories) assert.deepEqual(fs.readdirSync(path.join(root, 'inputs', directory)).sort(),
    names.filter(name => name.startsWith(directory + '/')).map(name => name.slice(directory.length + 1)).sort());
  keys(config.files, names, 'Exact external update inventory');
  const input = {};
  for (const name of names) {
    const expected = config.files[name]; keys(expected, ['size', 'sha256'], 'External update pin');
    assert.ok(Number.isSafeInteger(expected.size) && expected.size > 0 && expected.size <= updateMaximum(name));
    assert.match(expected.sha256, /^(?!0{64}$)[a-f0-9]{64}$/);
    input[name] = bootstrapFile(path.join(root, 'inputs', ...name.split('/')), expected);
  }
  const contract = createUpdate016017(config, input); reviewedUpdateTarget(contract); return contract;
}
function assertUpdateRunner(mode, env = process.env, platform = process.platform, arch = process.arch, uid = process.getuid?.(), euid = process.geteuid?.(), migrated = false) {
  assert.equal(typeof migrated, 'boolean');
  const branch = migrated ? 'refs/heads/validation/native-linux-production-016' : UPDATE_BRANCH;
  const workflow = migrated ? '.github/workflows/native-linux-production-016-migration.yml' : UPDATE_WORKFLOW;
  if (migrated) {
    assert.equal(mode, 'deb'); assert.equal(env.UPDATE_SCENARIO, 'deb-approve');
    assert.equal(env.CREATOR_MIGRATED_UPDATE_EXECUTE, 'true');
    assert.equal(env.CREATOR_NATIVE_LINUX_PRODUCTION_016, '1');
    assert.equal(env.CREATOR_MIGRATION_016_EXECUTE, 'true'); assert.equal(env.CREATOR_MIGRATION_016_SCENARIO, 'migration-approve');
    assert.equal(env.UPDATE_PROFILE_SHA256, '808f83a6cdc14a2d49000a2c9cd340397a748e166dfdb29720fe4af07ff91e66');
  }
  updateFiles(mode); assert.equal(platform, 'linux'); assert.equal(arch, 'x64');
  assert.ok(Number.isInteger(uid) && uid > 0 && uid === euid);
  for (const [name, expected] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: branch, GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/${workflow}@${branch}`, UPDATE_EXECUTE: 'true' })) assert.equal(env[name], expected, name);
  assert.ok(UPDATE_SCENARIOS[mode].includes(env.UPDATE_SCENARIO), 'Exact mode/scenario pairing required');
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/);
  for (const name of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) assert.match(env[name] || '', /^[1-9][0-9]*$/);
  assert.ok(path.isAbsolute(env.RUNNER_TEMP || '') && path.resolve(env.RUNNER_TEMP) === env.RUNNER_TEMP && !env.FLATPAK_ID);
  for (const name of Object.keys(env)) assert.ok(!/^(LD_|DYLD_|TAURI_|WEBKIT_|APPIMAGE$|APPDIR$|PYTHON|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|SSL_CERT_|CURL_CA_BUNDLE$|BASH_ENV$|ENV$|CREATOR_HUB_SIGNING_)/.test(name)
    && !name.toLowerCase().endsWith('proxy'), 'Inherited update injection/trust/proxy refused');
}
function updateReport(contract, report) {
  reviewedUpdateTarget(contract);
  return { ...report, scope: `linux-${contract.mode}-production016-to-private017-lab-transport`, mode: contract.mode,
    fromVersion: '0.1.16', targetVersion: '0.1.17', publicDiscovery: false, releaseReady: false };
}
async function startUpdate016017Proxy(contract, options, env = process.env, migrated = false) {
  assertUpdateRunner(contract?.mode, env, process.platform, process.arch, process.getuid?.(), process.geteuid?.(), migrated); reviewedUpdateTarget(contract); assert.ok(!fs.existsSync('/.flatpak-info'));
  const proxy = await startLoopbackTransport(contract, options);
  return { ...proxy, report: () => updateReport(contract, proxy.report()) };
}
async function updateMain() {
  const migrated = ['update-migrated-016-017', 'update-migrated-016-017-inspect'].includes(process.argv[2]);
  const mode = process.argv[3]; assertUpdateRunner(mode, process.env, process.platform, process.arch, process.getuid?.(), process.geteuid?.(), migrated); assert.equal(process.argv.length, 5);
  const inspect = process.argv[2] === (migrated ? 'update-migrated-016-017-inspect' : 'update-016-017-inspect');
  assert.ok(inspect || process.argv[2] === (migrated ? 'update-migrated-016-017' : 'update-016-017'));
  const root = path.join(process.env.RUNNER_TEMP, 'native-linux-production-016-update', 'transport'); assert.equal(process.argv[4], root);
  const folder = fs.lstatSync(root); assert.ok(folder.isDirectory() && !folder.isSymbolicLink() && folder.uid === process.getuid() && (folder.mode & 0o7777) === 0o700);
  const contract = loadUpdate016017(root, mode);
  if (inspect) { console.log(JSON.stringify(updateReport(contract, labReport(contract, newState())))); return; }
  assert.ok(fs.fstatSync(0).isFIFO(), 'Inherited private update pipe required');
  const iterator = process.stdin[Symbol.asyncIterator](); let pending = Buffer.alloc(0);
  async function line(maximum, timeout) {
    let timer;
    try {
      return await Promise.race([(async () => {
        while (!pending.includes(10)) {
          const next = await iterator.next(); if (next.done) return null;
          pending = Buffer.concat([pending, next.value]); assert.ok(pending.length <= maximum);
        }
        const at = pending.indexOf(10), result = pending.subarray(0, at); pending = pending.subarray(at + 1); return result;
      })(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Private update control deadline')), timeout); })]);
    } finally { clearTimeout(timer); }
  }
  const control = json(bounded(await line(2 * LIMITS.tls, LIMITS.handshakeMs), 2 * LIMITS.tls, 'Update TLS control'));
  keys(control, ['key', 'cert'], 'Ephemeral update TLS');
  const key = canonicalBase64(control.key, LIMITS.tls), cert = canonicalBase64(control.cert, LIMITS.tls);
  const proxy = await startUpdate016017Proxy(contract, { key, cert }, process.env, migrated); key.fill(0);
  console.log(JSON.stringify({ kind: 'update-016-017-ready', pid: process.pid, mode, proxyUrl: proxy.proxyUrl,
    publicDiscovery: false, nativeAcceptanceTested: false, signaturesVerifiedByHarness: false, releaseReady: false }));
  try {
    const closed = await Promise.race([line(32, LIMITS.durationMs), proxy.closed.then(() => null)]);
    assert.ok((closed === null || closed.equals(Buffer.from('close'))) && pending.length === 0);
  } finally {
    await proxy.close(); process.stdin.destroy(); saveLabReport(path.join(root, 'lab-transport.json'), proxy.report());
  }
}
async function main() {
  assertRunner();
  assert.equal(process.argv.length, 4, 'Use CONFIG REPORT');
  const root = path.join(process.env.RUNNER_TEMP, 'creator-linux-update-lab');
  const stat = fs.lstatSync(root);
  assert.ok(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o7777) === 0o700, 'Caller-owned private lab directory required');
  const [configFile, reportFile] = process.argv.slice(2);
  inside(root, configFile); inside(root, reportFile); assert.equal(path.dirname(reportFile), root);
  assert.equal(fs.existsSync(reportFile), false, 'Never replace a report');
  const config = json(readBounded(configFile, LIMITS.metadata)); inside(root, config.directory);
  const contract = loadContract(config);
  let input = Buffer.alloc(0);
  const timer = setTimeout(() => process.stdin.destroy(Error('Control timeout')), LIMITS.handshakeMs);
  try {
    for await (const chunk of process.stdin) {
      assert.ok(input.length + chunk.length <= 2 * LIMITS.tls, 'Bounded ephemeral TLS control required');
      input = Buffer.concat([input, chunk]);
    }
  } finally { clearTimeout(timer); }
  const control = json(input); keys(control, ['key', 'cert'], 'ephemeral TLS control');
  const key = canonicalBase64(control.key, LIMITS.tls), cert = canonicalBase64(control.cert, LIMITS.tls);
  const proxy = await startLabProxy(contract, { key, cert }); input.fill(0); key.fill(0);
  let stop;
  const stopped = new Promise(resolve => { stop = resolve; process.once('SIGINT', stop); process.once('SIGTERM', stop); });
  console.log(JSON.stringify({ kind: 'linux-lab-feed-ready', proxyUrl: proxy.proxyUrl, labDiscovery: true, publicDiscovery: false, releaseReady: false }));
  try { await Promise.race([proxy.closed, stopped]); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await proxy.close(); }
  saveLabReport(reportFile, proxy.report());
}

module.exports = { FROM, TO, BRANCH, INTEGRATED_BRANCH, INTEGRATED_TARGET, DESCRIPTOR, PLATFORM, ASSET, REVIEWED_TARGET, FEED_PATH, LIMITS, createContract, loadContract, reviewedTargetPins,
  readBounded, assertRunner, connectHost, headersAllowed, newState, resolveRequest, labReport, startLabProxy,
  BOOTSTRAP_PROFILE, BOOTSTRAP_BRANCH, BOOTSTRAP_WORKFLOW, BOOTSTRAP_REQUEST, BOOTSTRAP_PREFIX, BOOTSTRAP_FILES, BOOTSTRAP_ZIP,
  assertBootstrapRunner, loadBootstrap016, startBootstrap016Proxy,
  UPDATE_BRANCH, UPDATE_WORKFLOW, UPDATE_SCENARIOS, UPDATE_DEB, UPDATE_ASSET, UPDATE_SOURCE17,
  updateFiles, createUpdate016017, loadUpdate016017, reviewedUpdateTarget, assertUpdateRunner, startUpdate016017Proxy, updateReport,
  testing: Object.freeze({ startLoopbackTransport }) };
if (require.main === module) (['update-016-017', 'update-016-017-inspect', 'update-migrated-016-017', 'update-migrated-016-017-inspect'].includes(process.argv[2]) ? updateMain()
  : ['bootstrap-016', 'bootstrap-016-inspect'].includes(process.argv[2]) ? bootstrapMain() : main()).catch(() => {
  // Never log TLS material, HTTP headers, file contents, or parser exceptions.
  console.error('Linux lab transport refused or failed; no native/public acceptance established.'); process.exitCode = 1;
});
