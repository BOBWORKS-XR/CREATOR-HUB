'use strict';

const MAX_ROWS = 8;
const SENSITIVE_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'content-length', 'transfer-encoding',
]);

function safeAuthority(value) {
  if (typeof value !== 'string' || value.length > 253) return '[redacted]';
  const match = /^([A-Za-z0-9.-]+):([1-9][0-9]{0,4})$/.exec(value);
  if (!match || Number(match[2]) > 65535) return '[redacted]';
  const labels = match[1].toLowerCase().split('.');
  if (labels.length < 2 || !['com', 'org', 'net', 'io', 'dev', 'app'].includes(labels.at(-1)) ||
      labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) ||
        label.startsWith('xn--'))) return '[redacted]';
  return `${labels.join('.')}:${match[2]}`;
}

function initialize(state) {
  state.connectDiagnostics ??= [];
  state.connectDiagnosticsOverflow ??= 0;
}

// Test-only observer: the caller must already have denied CONNECT under its original policy.
function captureConnect(state, req, head) {
  initialize(state);
  const authority = safeAuthority(req?.url);
  const rawHeaders = Array.isArray(req?.rawHeaders) ? req.rawHeaders : [];
  let hostCount = 0, hostHeader, sensitiveHeadersPresent = false;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = typeof rawHeaders[index] === 'string' ? rawHeaders[index].toLowerCase() : '';
    if (name === 'host') { hostCount++; hostHeader = rawHeaders[index + 1]; }
    if (SENSITIVE_HEADERS.has(name)) sensitiveHeadersPresent = true;
  }
  for (const name of Object.keys(req?.headers ?? {})) {
    if (SENSITIVE_HEADERS.has(name.toLowerCase())) sensitiveHeadersPresent = true;
  }
  const row = {
    authority,
    headPresent: Boolean(head && head.length > 0),
    singleHost: hostCount === 1,
    duplicateHost: hostCount > 1,
    hostHeaderMatchesAuthority: hostCount === 1 && authority !== '[redacted]' && hostHeader === req.url,
    sensitiveHeadersPresent,
  };
  const existing = state.connectDiagnostics.find(candidate =>
    Object.keys(row).every(key => candidate[key] === row[key]));
  if (existing) existing.count++;
  else if (state.connectDiagnostics.length < MAX_ROWS) state.connectDiagnostics.push({ ...row, count: 1 });
  else state.connectDiagnosticsOverflow++;
}

function reportConnect(state) {
  initialize(state);
  const rows = state.connectDiagnostics.map(row => ({ ...row }));
  // At most eight sanitized signatures plus one count-only overflow row.
  if (state.connectDiagnosticsOverflow) rows.push({ overflow: true, count: state.connectDiagnosticsOverflow });
  return rows;
}

module.exports = { captureConnect, reportConnect };
