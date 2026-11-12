'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const q22 = require('./windows-022-release-qualification.cjs');
const e = require('./windows-022-evidence.json');
const q = require('../packaging/windows/0.1.22-qualification.json');
const clone = x => structuredClone(x);
test('022 local qualification retains separate public acceptance and readiness gates', () => {
  q22.validateEvidence(e); q22.validateQualification(q);
  assert.equal(q.publicAcceptance, false); assert.equal(q.releaseReady, false);
});
for (const [name, change] of [
  ['wrong product', x => x.candidate.sourceCommit = '9bfce62e91088789c2a9d0872c012732f4036060'],
  ['wrong tree', x => x.candidate.sourceTree = '6862f0b310aa3fc13bcd8c42c60ebf46bebf8642'],
  ['Linux', x => x.platform = 'linux-x86_64'], ['wrong draft', x => x.draft.id++],
  ['missing asset', x => delete x.draft.assets['latest.json']],
  ['altered asset', x => x.draft.assets['latest.json'].sha256 = '0'.repeat(64)],
  ['premature public acceptance', x => x.publicAcceptance = true], ['premature ready', x => x.releaseReady = true],
]) test('022 qualification refuses ' + name, () => { const value = clone(q); change(value); assert.throws(() => q22.validateQualification(value)); });
function changeDocument(value, name, change) {
  const item = value.documents[name], data = JSON.parse(Buffer.from(item.base64, 'base64'));
  change(data); const bytes = Buffer.from(JSON.stringify(data));
  Object.assign(item, { base64: bytes.toString('base64'), size: bytes.length, sha256: q22.hash(bytes) });
}
for (const [name, document, change] of [
  ['failed build', 'build', x => x.status = 1],
  ['R3 source', 'build', x => x.sourceCommit = '9bfce62e91088789c2a9d0872c012732f4036060'],
  ['unsigned payload', 'signing', x => x.verification.installerSignatureVerified = false],
  ['omitted negative proof', 'signing', x => delete x.verification.negativeProofs.wrongPublicKeyRejected],
  ['failed native cancel', 'mcp-restore/report', x => x.cancelPreserved = false],
  ['failed native restart', 'setup-restore/report', x => x.automaticRestart = false],
  ['no restore proof', 'setup-no-restore/report', x => x.restorationVerified = false],
  ['no target MCP proof', 'mcp-restore/report', x => x.targetMcpRuntimeVerified = false],
  ['R3 binding', 'mcp-restore/binding', x => x.targetSource.commit = '9bfce62e91088789c2a9d0872c012732f4036060'],
]) test('022 evidence refuses ' + name, () => { const value = clone(e); changeDocument(value, document, change); assert.throws(() => q22.validateEvidence(value)); });
test('022 remote reader stays GET-only', () => {
  assert.deepEqual(q22.ghApiArgs('git/ref/tags/v0.1.22').slice(0, 3), ['api', '--method', 'GET']);
  for (const r of ['releases', 'git/ref/tags/v0.1.21', 'actions/runs/1/rerun', '../tokens']) assert.throws(() => q22.ghApiArgs(r));
});
test('022 six actual assets retain signatures, notes-only metadata and exact bytes', () => {
  assert.ok(process.env.QUALIFICATION_022_ASSETS, 'Actual 022 assets required; this gate cannot silently skip');
  const files = Object.fromEntries(q22.ASSETS.map(n => [n, fs.readFileSync(path.join(process.env.QUALIFICATION_022_ASSETS, n))]));
  const root = path.resolve(__dirname, '..'); assert.equal(q22.checkPayload(q, files, root), true);
  for (const name of q22.ASSETS) {
    const bad = { ...files, [name]: Buffer.from(files[name]) }; bad[name][0] ^= 1;
    assert.throws(() => q22.checkPayload(q, bad, root));
  }
});
