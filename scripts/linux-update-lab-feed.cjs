'use strict';
// Linux DEB 14 -> acceptance-only 15 transport, NOT signing/native acceptance.
// CONFIG: {schemaVersion:1,targetVersion:'0.1.15',directory,pins:{descriptor,
// descriptorSignature,installer,manifest,executable}}. External review supplies
// hashes of immutable already-signed inputs; this harness never authenticates them.
// The native caller owns its isolated ephemeral TLS trust/session and recovery.
// CLI CONFIG REPORT paths live below $RUNNER_TEMP/creator-linux-update-lab.
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
  return { schemaVersion: 1, scope: 'linux-deb-outgoing-14-to-acceptance-only-15-lab-transport', fromVersion: FROM, targetVersion: TO,
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
function inside(root, file) {
  const relative = path.relative(root, file);
  assert.ok(path.isAbsolute(file) && path.resolve(file) === file && relative && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'Owned isolated lab path required');
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
  fs.writeFileSync(reportFile, `${JSON.stringify(proxy.report(), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

module.exports = { FROM, TO, BRANCH, INTEGRATED_BRANCH, INTEGRATED_TARGET, DESCRIPTOR, PLATFORM, ASSET, REVIEWED_TARGET, FEED_PATH, LIMITS, createContract, loadContract, reviewedTargetPins,
  readBounded, assertRunner, connectHost, headersAllowed, newState, resolveRequest, labReport, startLabProxy,
  testing: Object.freeze({ startLoopbackTransport }) };
if (require.main === module) main().catch(() => {
  // Never log TLS material, HTTP headers, file contents, or parser exceptions.
  console.error('Linux lab transport refused or failed; no native/public acceptance established.'); process.exitCode = 1;
});
