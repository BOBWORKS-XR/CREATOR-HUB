import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [binary, appId, version, trustedSha256] = process.argv.slice(2);
assert.ok(binary && path.isAbsolute(binary), 'Pass an absolute launcher path.');
assert.ok(['creator-project-setup', 'creator-works-mcp'].includes(appId), 'Unknown companion identity.');
assert.match(version ?? '', /^\d+\.\d+\.\d+$/);
assert.match(trustedSha256 ?? '', /^[a-f0-9]{64}$/i);
assert.equal(process.platform, 'win32', 'This identity probe is Windows-only.');

const contents = fs.readFileSync(binary);
const sha256 = crypto.createHash('sha256').update(contents).digest('hex');
assert.equal(sha256, trustedSha256.toLowerCase(), 'Launcher hash mismatch; executable was not run.');
assert.equal(contents.toString('ascii', 0, 2), 'MZ');
const pe = contents.readUInt32LE(0x3c);
assert.equal(contents.toString('ascii', pe, pe + 4), 'PE\0\0');
assert.equal(contents.readUInt16LE(pe + 4), 0x8664, 'Expected the Windows x64 launcher.');
assert.equal(contents.readUInt16LE(pe + 24 + 68), 2, 'Expected a GUI-subsystem launcher.');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'creator-companion-info-')));
try {
  const env = {
    ...process.env,
    APPDATA: path.join(root, 'roaming'),
    LOCALAPPDATA: path.join(root, 'local'),
    USERPROFILE: root,
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'),
    CODEX_HOME: path.join(root, 'codex'),
    CREATOR_WORKS_MCP_ROOT: path.join(root, 'not-a-server'),
    BANTWORKS_MCP_ROOT: path.join(root, 'not-a-server'),
  };
  const result = spawnSync(binary, ['--creator-hub-info'], { encoding: 'utf8', timeout: 15000, windowsHide: true, env });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `Identity query exited ${result.status}: ${result.stderr}`);
  const identity = JSON.parse(result.stdout);
  assert.equal(identity.appId, appId);
  assert.equal(identity.version, version);
  assert.equal(identity.platform, 'windows');
  assert.equal(identity.architecture, 'x86_64');
  assert.deepEqual(fs.readdirSync(root), [], 'Metadata query created user data or configuration.');
  process.stdout.write(`${JSON.stringify({ appId, version, sha256, identity, isolatedProbe: true })}\n`);
} finally {
  assert.equal(fs.realpathSync(root), root);
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
}
