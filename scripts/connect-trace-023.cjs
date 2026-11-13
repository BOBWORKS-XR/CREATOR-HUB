'use strict';
const path = require('node:path');
const { execFile } = require('node:child_process');
const MAX = 8;
const BRANCH = 'refs/heads/codex/windows-warning-023-20261113-r4-ci2';
function target(value) {
  if (typeof value !== 'string' || value.length > 272) return { kind: 'redacted' };
  const match = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):([1-9][0-9]{0,4})$/.exec(value);
  if (!match || Number(match[2]) > 65535) return { kind: 'redacted' };
  const host = match[1].toLowerCase(), port = Number(match[2]);
  if (['localhost', '127.0.0.1', '[::1]'].includes(host)) return { kind: 'loopback', host, port };
  if (/^[0-9.]+$/.test(host) || host.startsWith('[')) return { kind: 'ip-redacted', port };
  const labels = host.split('.');
  if (host.length > 253 || labels.length < 2 || !/^[a-z]{2,24}$/.test(labels.at(-1))
    || labels.some(s => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s) || s.startsWith('xn--')))
    return { kind: 'redacted' };
  return { kind: 'dns', host, port };
}
function enabled(env, platform) {
  return platform === 'win32' && env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted'
    && env.RUNNER_OS === 'Windows' && env.GITHUB_REPOSITORY === 'BOBWORKS-XR/CREATOR-HUB'
    && env.GITHUB_REF === BRANCH && env.GITHUB_JOB === 'acceptance';
}
async function owner(clientPort, proxyPort, env = process.env, platform = process.platform, execute = execFile) {
  if (!enabled(env, platform)) return { status: 'not-enabled' };
  if (![clientPort, proxyPort].every(n => Number.isInteger(n) && n >= 1 && n <= 65535)) return { status: 'invalid-port' };
  const exe = path.win32.join(env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  return new Promise(resolve => execute(exe, ['-NoProfile', '-NonInteractive', '-File',
    path.join(__dirname, 'connect-owner-023.ps1'), '-ClientPort', String(clientPort), '-ProxyPort', String(proxyPort)],
  { windowsHide: true, timeout: 4000, maxBuffer: 16384, encoding: 'utf8' }, (error, stdout) => {
    if (error) return resolve({ status: 'unavailable' });
    try {
      const result = JSON.parse(stdout);
      if (!Array.isArray(result) || result.length > 2 || !result.every(r => Number.isInteger(r.pid) && r.pid > 0
        && Number.isInteger(r.parentPid) && typeof r.image === 'string' && r.image.length <= 512)) throw Error();
      resolve({ status: result.length ? 'observed' : 'not-found', processes: result });
    } catch { resolve({ status: 'invalid-result' }); }
  }));
}
async function traceDeniedConnect(state, request, socket, env = process.env, platform = process.platform, inspect = owner) {
  if (!enabled(env, platform)) return;
  state.connectTrace ??= []; state.connectTraceOverflow ??= 0;
  if (state.connectTrace.length >= MAX) { state.connectTraceOverflow++; return; }
  const row = { target: target(request?.url), clientPort: socket.remotePort, proxyPort: socket.localPort,
    hostHeaderMatchesAuthority: request?.headers?.host === request?.url, owner: { status: 'pending' } };
  state.connectTrace.push(row);
  try { row.owner = await inspect(row.clientPort, row.proxyPort, env, platform); }
  catch { row.owner = { status: 'unavailable' }; }
}
function traceReport(state) {
  return { connectTrace: structuredClone(state.connectTrace || []), connectTraceOverflow: state.connectTraceOverflow || 0 };
}
function trackedDenial(state, request, socket, env, reject, inspect = owner) {
  state.pendingDenials ??= new Set();
  const pending = traceDeniedConnect(state, request, socket, env, process.platform, inspect)
    .then(() => reject(), () => reject());
  state.pendingDenials.add(pending);
  pending.then(() => state.pendingDenials.delete(pending), () => state.pendingDenials.delete(pending));
  return pending;
}
async function drainDenials(state) {
  while (state.pendingDenials?.size) await Promise.allSettled([...state.pendingDenials]);
}
module.exports = { target, enabled, owner, traceDeniedConnect, traceReport, trackedDenial, drainDenials };
