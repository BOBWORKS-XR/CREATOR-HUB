// Lab transport only. This is not public discovery or native update acceptance.
// CONFIG: {schemaVersion:1,targetVersion,directory,pins:{descriptor,
// descriptorSignature,installer,manifest,executable}}. Paths are absolute;
// pins must come from external review of already-signed, immutable inputs.
// The VM caller owns temporary Windows trust/proxy setup and its recovery.
// Native callers separately bind public12 or accepted B05 with the matching
// baseline assertion. Neither contract factory accepts a baseline override.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const tls = require('node:tls');
const semver = require('semver');
const { selectBaseline } = require('./self-update-baselines.cjs');
const { readBounded } = require('./read-bounded-input.cjs');

const DESCRIPTOR = 'creator-hub-windows-x86_64.json';
const FEED_PATH = '/repos/BOBWORKS-XR/CREATOR-HUB/releases?per_page=10';
const LIMITS = Object.freeze({ feed: 256 * 1024, metadata: 32 * 1024, signature: 4096,
  installer: 512 * 1024 * 1024, headers: 8192, connections: 16, requests: 128,
  idleMs: 30000, durationMs: 600000, servedBytes: 1025 * 1024 * 1024 });
const UNIFIED_OUTGOING_BASELINE = Object.freeze({ version: '0.1.14',
  installer: '284820f92de487e8a0f1bb5b3b99cafe5e073f0402a9350a2ea6e76fa9543157',
  exe: 'cd5e3fd2829727d06444c0f3266b178798d1b55c63df651be12eb38ac4523a86' });
const UNIFIED_OUTGOING_SCOPE = Object.freeze({ kind: 'unified-outgoing-14-15',
  baseline: 'accepted-unmodified-unified-0.1.14-B05', target: 'outer-only-0.1.15-acceptance-fixture',
  labDiscovery: true, publicDiscovery: false, liveAiAcceptance: false, productAcceptance: false, releaseReady: false });
const contracts = new WeakMap();
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function assertRunner(env = process.env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.RUNNER_OS !== 'Windows') {
    throw Error('Lab TLS/proxy requires a disposable GitHub-hosted Windows runner.');
  }
}

function keys(value, names, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `Invalid ${label}`);
  assert.deepEqual(Object.keys(value).sort(), [...names].sort(), `Unexpected ${label} fields`);
}

function version(value) {
  const parsed = typeof value === 'string' && semver.parse(value);
  assert.ok(parsed && parsed.version === value && !parsed.build.length, 'Use canonical SemVer without build metadata');
  return parsed;
}

function baselineFor(target) {
  version(target);
  // This historical transport remains pinned even as public baselines advance.
  const baseline = selectBaseline('0.1.13');
  assert.ok(semver.gt(target, baseline.version), 'Lab targets must be newer than pinned public 0.1.12');
  return Object.freeze(baseline);
}

function bounded(bytes, max, label) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= max, `${label} size is outside bounds`);
  return bytes;
}

function json(bytes, label) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw Error(`Invalid ${label} JSON`); }
}

function plainMinisig(value) {
  assert.ok(typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= LIMITS.signature &&
    value.startsWith('untrusted comment:'), 'Invalid plain minisig text');
  // Envelope/encoding only. Native Signature::decode and production-key verification own authenticity.
}

function minisigText(bytes) {
  // Keep BOM/whitespace visible rather than accepting bytes the producer does not emit.
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

function tauriSignature(value) {
  assert.equal(typeof value, 'string', 'Missing existing Tauri base64 signature');
  const decoded = Buffer.from(value, 'base64');
  assert.ok(value.length > 0 && value.length <= LIMITS.signature && decoded.toString('base64') === value,
    'Invalid Tauri base64 signature');
  plainMinisig(minisigText(decoded));
}

function validatedContract({ targetVersion, descriptor, descriptorSignature, installer, manifest, pins }, baseline, policy = {}) {
  keys(pins, ['descriptor', 'descriptorSignature', 'installer', 'manifest', 'executable'], 'SHA-256 pins');
  for (const pin of Object.values(pins)) assert.match(pin, /^[a-f0-9]{64}$/, 'Invalid SHA-256 pin');
  const supplied = { descriptor: bounded(descriptor, LIMITS.metadata, 'Descriptor'),
    descriptorSignature: bounded(descriptorSignature, LIMITS.signature, 'Descriptor signature'),
    installer: bounded(installer, LIMITS.installer, 'Installer'), manifest: bounded(manifest, LIMITS.metadata, 'Manifest') };
  for (const [name, bytes] of Object.entries(supplied)) assert.equal(hash(bytes), pins[name], `${name} SHA-256 mismatch`);
  const release = json(descriptor, 'descriptor');
  keys(release, ['schemaVersion', 'appId', 'version', 'platform', 'architecture', 'packageType', 'assetName',
    'byteLength', 'sha256', 'executableSha256', 'identityProtocol', 'lifecycleProtocol', 'installerProtocol', 'minHubVersion'], 'descriptor');
  for (const [field, expected] of Object.entries({ schemaVersion: 1, appId: 'creator-hub', version: targetVersion,
    platform: 'windows', architecture: 'x86_64', packageType: 'nsis', installerProtocol: 1,
    byteLength: installer.length, sha256: pins.installer, executableSha256: pins.executable })) {
    assert.equal(release[field], expected, `Descriptor ${field} mismatch`);
  }
  for (const field of ['identityProtocol', 'lifecycleProtocol']) {
    assert.ok([0, 1].includes(release[field]), `Unsupported ${field}`);
  }
  version(release.minHubVersion);
  assert.ok(semver.lte(release.minHubVersion, baseline.version), 'Target requires an intermediate Hub');
  for (const [field, expected] of Object.entries(policy.descriptor || {})) {
    assert.equal(release[field], expected, `Outgoing descriptor ${field} mismatch`);
  }
  assert.ok(typeof release.assetName === 'string' && release.assetName.length <= 160 &&
    /^[A-Za-z0-9._-]+\.exe$/.test(release.assetName) && !release.assetName.includes('..'), 'Invalid exact installer asset name');
  plainMinisig(minisigText(descriptorSignature));
  const prefix = `/BOBWORKS-XR/CREATOR-HUB/releases/download/v${targetVersion}/`;
  const update = json(manifest, 'manifest');
  assert.equal(update.version, targetVersion, 'Manifest version mismatch');
  assert.ok(Object.keys(update).every(key => ['version', 'notes', 'pub_date', 'platforms'].includes(key)), 'Unexpected manifest fields');
  keys(update.platforms, ['windows-x86_64'], 'manifest platforms');
  keys(update.platforms['windows-x86_64'], ['url', 'signature'], 'manifest Windows target');
  assert.equal(update.platforms['windows-x86_64'].url, `https://github.com${prefix}${release.assetName}`, 'Manifest URL mismatch');
  tauriSignature(update.platforms['windows-x86_64'].signature);
  const names = [DESCRIPTOR, `${DESCRIPTOR}.minisig`, release.assetName, 'latest.json'];
  const feed = Buffer.from(JSON.stringify([{ tag_name: `v${targetVersion}`, draft: false,
    prerelease: Boolean(semver.prerelease(targetVersion)), assets: names.map(name => ({ name })) }]));
  bounded(feed, LIMITS.feed, 'Release feed');
  const routes = [
    { host: 'api.github.com', path: FEED_PATH, bytes: feed, type: 'application/json' },
    ...names.map((name, index) => ({ host: 'github.com', path: `${prefix}${name}`,
      bytes: [descriptor, descriptorSignature, installer, manifest][index],
      type: index === 2 ? 'application/octet-stream' : index === 1 ? 'text/plain; charset=utf-8' : 'application/json' })),
  ].map(route => ({ ...route, bytes: Buffer.from(route.bytes), sha256: hash(route.bytes) }));
  const contract = Object.freeze({ targetVersion, baseline, pins: Object.freeze({ ...pins }),
    ...(policy.actualScope ? { actualScope: policy.actualScope } : {}),
    routes: Object.freeze(routes.map(({ host, path: routePath, sha256 }) => Object.freeze({ host, path: routePath, sha256 }))) });
  contracts.set(contract, routes);
  return contract;
}

function createContract(input) {
  return validatedContract(input, baselineFor(input.targetVersion));
}

function createUnifiedOutgoingContract(input) {
  keys(input, ['targetVersion', 'descriptor', 'descriptorSignature', 'installer', 'manifest', 'pins'], 'outgoing input');
  assert.equal(input.targetVersion, '0.1.15', 'Only the reviewed outer-only 0.1.15 fixture is admitted');
  return validatedContract(input, UNIFIED_OUTGOING_BASELINE, { actualScope: UNIFIED_OUTGOING_SCOPE,
    descriptor: { assetName: 'Creator_Hub_0.1.15_x64-acceptance-only-setup.exe', minHubVersion: '0.1.14' } });
}

function createIncoming016Contract(input) {
  const incoming = require('./windows-incoming-016.cjs');
  incoming.validateInput(input);
  return validatedContract(input, incoming.BASELINE, { descriptor: { assetName: incoming.TARGET.asset },
    actualScope: { kind: incoming.KIND, labDiscovery: true, publicDiscovery: false, migrationAccepted: false, releaseReady: false } });
}

function loadContract(config) {
  keys(config, ['schemaVersion', 'targetVersion', 'directory', 'pins'], 'lab config');
  assert.equal(config.schemaVersion, 1);
  baselineFor(config.targetVersion);
  assert.ok(path.isAbsolute(config.directory), 'Candidate directory must be absolute');
  const descriptor = readBounded(path.join(config.directory, DESCRIPTOR), LIMITS.metadata);
  const asset = json(descriptor, 'descriptor').assetName;
  assert.ok(typeof asset === 'string' && /^[A-Za-z0-9._-]+\.exe$/.test(asset) && !asset.includes('..') && asset.length <= 160, 'Invalid exact installer asset name');
  return createContract({ targetVersion: config.targetVersion, descriptor, pins: config.pins,
    descriptorSignature: readBounded(path.join(config.directory, `${DESCRIPTOR}.minisig`), LIMITS.signature),
    installer: readBounded(path.join(config.directory, asset), LIMITS.installer),
    manifest: readBounded(path.join(config.directory, 'latest.json'), LIMITS.metadata) });
}

function assertBaselineBytes(targetVersion, installer, executable) {
  const baseline = baselineFor(targetVersion);
  assert.equal(hash(bounded(installer, LIMITS.installer, 'Baseline installer')), baseline.installer, 'Unmodified public baseline installer required');
  assert.equal(hash(bounded(executable, LIMITS.installer, 'Baseline executable')), baseline.exe, 'Unmodified public baseline executable required');
  return baseline;
}

function assertUnifiedOutgoingBaselineBytes(installer, executable) {
  assert.equal(hash(bounded(installer, LIMITS.installer, 'Baseline installer')), UNIFIED_OUTGOING_BASELINE.installer,
    'Exact accepted B05 0.1.14 baseline installer required');
  assert.equal(hash(bounded(executable, LIMITS.installer, 'Baseline executable')), UNIFIED_OUTGOING_BASELINE.exe,
    'Exact installed B05 0.1.14 baseline executable required; no version masquerade');
  return UNIFIED_OUTGOING_BASELINE;
}

function connectHost(authority) {
  return ['api.github.com:443', 'github.com:443'].includes(authority) ? authority.slice(0, -4) : null;
}

function singleHost(request) {
  return Array.isArray(request.rawHeaders) && request.rawHeaders.filter((value, index) =>
    index % 2 === 0 && value.toLowerCase() === 'host').length === 1;
}

function newState() { return { requests: 0, bytes: 0, rejected: 0, served: new Map(), rejections: new Map(), rejectionOverflow: 0,
  connectionResetEvents: 0, connectionResets: new Map() }; }

function recordTransportError(state, kind, error) {
  if (error?.code !== 'ECONNRESET') { recordRejection(state, kind, error?.code); return; }
  // A peer disconnect is not a rejected request. These are events, not unique sockets.
  assert.ok(['tls-error', 'inner-client-error', 'outer-client-error'].includes(kind));
  state.connectionResetEvents++;
  if (state.connectionResets.has(kind)) state.connectionResets.get(kind).count++;
  else state.connectionResets.set(kind, { kind, code: 'ECONNRESET', count: 1 });
}

function recordRejection(state, kind, errorCode) {
  assert.match(kind, /^[a-z0-9-]{1,48}$/);
  // Public diagnostic identifiers only; never record URLs, headers or TLS control.
  const code = typeof errorCode === 'string' && /^[A-Z0-9_]{1,64}$/.test(errorCode) ? errorCode : null;
  const key = JSON.stringify([kind, code]);
  state.rejected++;
  if (state.rejections.has(key)) state.rejections.get(key).count++;
  else if (state.rejections.size < 16) state.rejections.set(key, { kind, code, count: 1 });
  else state.rejectionOverflow++;
}

function resolveRequest(contract, tunnelHost, request, state) {
  const routes = contracts.get(contract);
  assert.ok(routes, 'Use a validated lab contract');
  const headers = request.headers || {};
  state.requests++;
  const host = headers.host;
  if (state.requests > LIMITS.requests) return { status: 429 };
  if (request.method !== 'GET') return { status: 405 };
  if (!singleHost(request)) return { status: 400 };
  if (!['api.github.com', 'github.com'].includes(tunnelHost) ||
    ![tunnelHost, `${tunnelHost}:443`].includes(host)) return { status: 421 };
  if (['authorization', 'proxy-authorization', 'cookie', 'transfer-encoding', 'upgrade'].some(key => Object.hasOwn(headers, key)) ||
    (Object.hasOwn(headers, 'content-length') && headers['content-length'] !== '0')) return { status: 400 };
  // Compare raw origin-form paths; never normalize traversal, queries or aliases.
  const route = routes.find(item => item.host === tunnelHost && item.path === request.url);
  if (!route) return { status: 404 };
  if (state.bytes + route.bytes.length > LIMITS.servedBytes) return { status: 429 };
  return { status: 200, route };
}

function requestHandler(contract, state) {
  return (req, res) => {
    const result = resolveRequest(contract, req.socket.labHost, req, state);
    if (result.status !== 200) {
      recordRejection(state, `http-${result.status}`); res.writeHead(result.status, { Connection: 'close', 'Content-Length': '0' }); res.end(); return;
    }
    const route = result.route;
    res.writeHead(200, { 'Content-Type': route.type, 'Content-Length': String(route.bytes.length),
      'Cache-Control': 'no-store', Connection: 'close' });
    res.once('finish', () => {
      state.served.set(`${route.host}${route.path}`, { host: route.host, path: route.path, sha256: route.sha256 });
    });
    state.bytes += route.bytes.length;
    res.end(route.bytes);
  };
}

function labReport(contract, state) {
  return { kind: 'prepublication-lab-feed-contract-only', labDiscovery: true, publicDiscovery: false,
    releaseReady: false, nativeAcceptanceTested: false, signaturesVerifiedByHarness: false, baselineActuallyTested: false,
    actualScope: contract.actualScope || { kind: 'public-stable', baseline: 'unmodified-public-0.1.12',
      labDiscovery: true, publicDiscovery: false, liveAiAcceptance: false, productAcceptance: false, releaseReady: false },
    baseline: contract.baseline, targetVersion: contract.targetVersion,
    requests: [...state.served.values()], rejectedRequestCount: state.rejected,
    rejectionSummary: [...state.rejections.values()], rejectionOverflow: state.rejectionOverflow,
    connectionResetEventCount: state.connectionResetEvents, connectionResetSummary: [...state.connectionResets.values()] };
}

async function startLabProxy(contract, tlsOptions, env = process.env, transport = { http, tls }) {
  assertRunner(env);
  assert.ok(contracts.has(contract), 'Use a validated lab contract');
  keys(tlsOptions, ['pfx', 'passphrase'], 'ephemeral TLS options');
  bounded(tlsOptions.pfx, 64 * 1024, 'TLS PFX');
  const context = transport.tls.createSecureContext({ ...tlsOptions, minVersion: 'TLSv1.2' });
  const state = newState(), sockets = new Set();
  const options = { maxHeaderSize: LIMITS.headers, headersTimeout: 10000, requestTimeout: 30000 };
  const inner = transport.http.createServer(options, requestHandler(contract, state));
  const outer = transport.http.createServer(options, (_req, res) => {
    recordRejection(state, 'outer-http-405'); res.writeHead(405, { Connection: 'close', 'Content-Length': '0' }); res.end();
  });
  function reject(socket, status = 400, kind = 'connection', code) {
    recordRejection(state, kind, code); socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  for (const server of [inner, outer]) {
    server.on('clientError', (error, socket) => {
      const kind = server === inner ? 'inner-client-error' : 'outer-client-error';
      if (error.code === 'ECONNRESET') { recordTransportError(state, kind, error); socket.destroy(); }
      else reject(socket, 400, kind, error.code);
    });
    server.on('upgrade', (_req, socket) => reject(socket, 400, 'http-upgrade'));
    server.on('checkContinue', (_req, res) => { recordRejection(state, 'expect-continue'); res.writeHead(400, { Connection: 'close' }); res.end(); });
    server.on('checkExpectation', (_req, res) => { recordRejection(state, 'expectation'); res.writeHead(400, { Connection: 'close' }); res.end(); });
  }
  inner.on('connect', (_req, socket) => reject(socket, 400, 'inner-connect'));
  outer.on('connection', socket => {
    if (socket.remoteAddress !== '127.0.0.1' || sockets.size >= LIMITS.connections) { socket.destroy(); return; }
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {}); socket.setTimeout(LIMITS.idleMs, () => socket.destroy());
  });
  outer.on('connect', (req, socket, head) => {
    const host = connectHost(req.url);
    if (!host || head.length || !singleHost(req) || ![req.url, host].includes(req.headers.host) ||
      ['authorization', 'proxy-authorization', 'cookie', 'content-length', 'transfer-encoding'].some(key => Object.hasOwn(req.headers, key))) {
      reject(socket, 400, 'connect-policy'); return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    // Terminate locally on this socket. No DNS lookup, upstream connection or relay.
    const secure = new transport.tls.TLSSocket(socket, { isServer: true, secureContext: context, minVersion: 'TLSv1.2',
      ALPNProtocols: ['http/1.1'], SNICallback: (name, callback) => {
        if (name !== host) callback(Error('Rejected SNI')); else callback(null, context);
      } });
    sockets.add(secure); secure.once('close', () => sockets.delete(secure));
    secure.on('error', error => { recordTransportError(state, 'tls-error', error); secure.destroy(); });
    secure.setTimeout(LIMITS.idleMs, () => secure.destroy());
    const deadline = setTimeout(() => secure.destroy(), 10000);
    secure.once('close', () => clearTimeout(deadline));
    secure.once('secure', () => {
      clearTimeout(deadline);
      if (secure.servername !== host) { secure.destroy(); recordRejection(state, 'tls-sni'); return; }
      secure.disableRenegotiation(); secure.labHost = host;
      inner.emit('connection', secure);
    });
  });
  await new Promise((resolve, rejectListen) => {
    outer.once('error', rejectListen); outer.listen(0, '127.0.0.1', resolve);
  });
  let closing;
  const close = () => closing ||= new Promise(resolve => {
    clearTimeout(expiry); for (const socket of sockets) socket.destroy(); outer.close(resolve);
  });
  const expiry = setTimeout(close, LIMITS.durationMs);
  return { proxyUrl: `http://127.0.0.1:${outer.address().port}`, report: () => labReport(contract, state), close };
}

async function main() {
  assertRunner();
  assert.equal(process.argv.length, 4, 'Usage: node scripts/self-update-lab-feed.cjs CONFIG REPORT');
  const config = json(readBounded(path.resolve(process.argv[2]), LIMITS.metadata), 'config');
  const contract = loadContract(config);
  // VM helper sends its ephemeral PFX/password over stdin, never argv, logs or artifacts.
  let input = Buffer.alloc(0);
  const inputDeadline = setTimeout(() => process.stdin.destroy(Error('TLS control timeout')), 10000);
  try {
    for await (const chunk of process.stdin) {
      assert.ok(input.length + chunk.length <= 96 * 1024, 'TLS control input exceeds bounds');
      input = Buffer.concat([input, chunk]);
    }
  } finally { clearTimeout(inputDeadline); }
  const control = json(input, 'TLS control');
  keys(control, ['pfx', 'passphrase'], 'TLS control');
  const proxy = await startLabProxy(contract, { pfx: Buffer.from(control.pfx, 'base64'), passphrase: control.passphrase });
  input.fill(0);
  try {
    console.log(JSON.stringify({ kind: 'lab-feed-ready', proxyUrl: proxy.proxyUrl, labDiscovery: true, publicDiscovery: false }));
    await new Promise(resolve => {
      const timer = setTimeout(finish, LIMITS.durationMs);
      function finish() {
        clearTimeout(timer); process.removeListener('SIGINT', finish); process.removeListener('SIGTERM', finish); resolve();
      }
      process.once('SIGINT', finish); process.once('SIGTERM', finish);
    });
  } finally { await proxy.close(); }
  fs.writeFileSync(path.resolve(process.argv[3]), `${JSON.stringify(proxy.report(), null, 2)}\n`, { flag: 'wx' });
}

module.exports = { DESCRIPTOR, FEED_PATH, LIMITS, UNIFIED_OUTGOING_BASELINE, assertRunner, baselineFor, createContract,
  createUnifiedOutgoingContract, createIncoming016Contract, loadContract, readBounded, assertBaselineBytes, assertUnifiedOutgoingBaselineBytes,
  connectHost, newState, recordRejection, requestHandler, labReport, startLabProxy };
if (require.main === module) main().catch(() => {
  // Do not serialize TLS control input, parser errors, headers or candidate contents.
  console.error('Lab feed refused or failed; no native/public acceptance established.'); process.exitCode = 1;
});
