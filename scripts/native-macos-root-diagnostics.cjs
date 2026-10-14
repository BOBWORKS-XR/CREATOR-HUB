const { isDeepStrictEqual } = require('node:util');
const { spawn } = require('node:child_process');
const scopes = Object.freeze(['direct-private', 'direct-ordinary', 'launchservices-ordinary']);
const flags = Object.freeze({ diagnosticOnly: true, readOnly: true, actionAttempted: false,
  permissionRequestsPerformed: false, nativeGuiAccepted: false, mcpAccepted: false,
  migrationAccepted: false, updateAccepted: false, releaseReady: false });
const MAX_BYTES = 512 * 1024;
function check(value, reason) { if (!value) throw Error(reason); }
function launchControl(context, env, version) {
  check(scopes.includes(context) && env.CREATOR_MACOS_LAUNCH_CONTROL === '1' && version === '0.1.14', 'explicit-fresh14-launch-control-required');
}
function ordinaryProfile(env) {
  check(typeof env.HOME === 'string' && env.HOME.startsWith('/Users/runner') && !/[\x00-\x1f]/.test(env.HOME), 'disposable-runner-home-required');
  check(typeof env.TMPDIR === 'string' && env.TMPDIR.startsWith('/') && !/[\x00-\x1f]/.test(env.TMPDIR), 'ordinary-runner-tmp-required');
  const result = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: env.HOME, TMPDIR: env.TMPDIR };
  for (const name of ['USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', '__CF_USER_TEXT_ENCODING']) {
    if (env[name] !== undefined) {
      check(typeof env[name] === 'string' && env[name].length <= 512 && !/[\x00-\x1f]/.test(env[name]), 'ordinary-environment-value-refused');
      result[name] = env[name];
    }
  }
  return result; // No caller secrets, DYLD injection, CFFIXED_USER_HOME or XDG overrides.
}
function fence(receipt, owner) {
  check(receipt?.command === 'bitmap-fence' && receipt.cgWindowFenceVerified === true &&
    receipt.actionAttempted === false && receipt.permissionRequestsPerformed === false &&
    isDeepStrictEqual(receipt.process, owner.process) && isDeepStrictEqual(receipt.window, owner.window), 'diagnostic-owned-root-fence-unverified');
}
function logPlan(owner, now) {
  const p = owner?.process;
  check(Number.isSafeInteger(p?.pid) && p.pid > 0 && p.pid <= 0x7fffffff && Number.isSafeInteger(p.startSeconds) &&
    p.startSeconds > 0 && Number.isSafeInteger(p.startMicroseconds) && p.startMicroseconds >= 0 && p.startMicroseconds < 1000000,
  'diagnostic-kernel-identity-required');
  const started = p.startSeconds * 1000 + p.startMicroseconds / 1000;
  check(Number.isFinite(now) && now >= started && now - started <= 120000, 'diagnostic-time-window-refused');
  // Fixed 120s read ceiling; parsed records are additionally clipped to this exact kernel lifetime.
  return { file: '/usr/bin/log', argv: ['show', '--style', 'ndjson', '--last', '120s', '--predicate',
    `processIdentifier == ${p.pid}`, '--info', '--debug', '--no-pager'], pid: p.pid, started, ended: now,
    maxBytes: MAX_BYTES, timeoutMilliseconds: 5000 };
}
function parseLog(bytes, plan) {
  check(Buffer.isBuffer(bytes) && bytes.length <= MAX_BYTES, 'diagnostic-log-byte-limit');
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split(/\r?\n/).filter(Boolean);
  check(lines.length <= 256, 'diagnostic-log-record-limit');
  const entries = [];
  for (const line of lines) {
    const value = JSON.parse(line);
    if (Object.hasOwn(value, 'finished')) continue;
    check(value.processID === plan.pid, 'diagnostic-foreign-log-pid-refused');
    const time = Date.parse(value.timestamp);
    check(Number.isFinite(time), 'diagnostic-log-timestamp-unverified');
    if (time < plan.started || time > plan.ended) continue; // Prior use of the same PID is not this Root.
    entries.push(Object.fromEntries(['timestamp', 'processID', 'processImagePath', 'senderImagePath', 'subsystem', 'category',
      'messageType', 'eventMessage'].filter(key => Object.hasOwn(value, key)).map(key => {
        const item = value[key];
        check(typeof item === 'number' || typeof item === 'string' && item.length <= 8192, 'diagnostic-log-field-unbounded');
        return [key, item];
      })));
  }
  return entries;
}
function runLog(plan, env, create = spawn) {
  return new Promise(resolve => {
    const task = create(plan.file, plan.argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let total = 0, settled = false;
    const finish = result => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ ...result, bytes: Buffer.concat(chunks), toolPid: task.pid ?? null });
    };
    const abandon = result => {
      task.stdout.destroy(); task.stderr.destroy(); task.unref();
      finish({ exitCode: null, signal: null, toolLifetimeUncertain: true, ...result });
    };
    const timer = setTimeout(() => abandon({ timedOut: true }), plan.timeoutMilliseconds);
    task.stdout.on('data', data => {
      if (settled) return;
      total += data.length;
      if (total > plan.maxBytes) abandon({ overflow: true });
      else chunks.push(Buffer.from(data));
    });
    task.stderr.resume(); // No broad/error/credential text copied into receipts.
    task.once('error', error => finish({ exitCode: null, signal: null, error: error.code }));
    task.once('close', (code, signal) => finish({ exitCode: code, signal, toolLifetimeUncertain: false }));
  });
}
async function diagnostic(owner, io) {
  const result = { ...flags, scope: 'exact-held-root-kernel-lifetime-only', completed: false,
    webContentScope: 'unresolved-native-association; no WebContent process logs read' };
  try {
    result.before = await io.fence('before'); fence(result.before, owner);
    const plan = logPlan(owner, io.now());
    let output, toolError;
    try { output = await io.run(plan); } catch (error) { toolError = error; }
    result.toolLifetimeUncertain = !!toolError || output?.toolLifetimeUncertain === true;
    result.after = await io.fence('after'); fence(result.after, owner);
    if (toolError) throw toolError;
    check(output.exitCode === 0 && output.signal === null && !output.error && !output.timedOut && !output.overflow,
      'diagnostic-log-tool-refused-or-bounded-out');
    result.plan = plan; result.entries = parseLog(output.bytes, plan); result.completed = true;
  } catch (error) { result.reason = error.message; }
  return result;
}
module.exports = { scopes, flags, launchControl, ordinaryProfile, fence, logPlan, parseLog, runLog, diagnostic };
