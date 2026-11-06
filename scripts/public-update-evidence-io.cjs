'use strict';
const assert=require('node:assert/strict');
const zlib=require('node:zlib');
function readZipMember(zip, wanted, limit = 256 * 1024) {
  assert.ok(Buffer.isBuffer(zip) && zip.length <= 64 * 1024 * 1024);
  assert.ok(Number.isSafeInteger(limit) && limit > 0 && limit <= 64 * 1024 * 1024);
  assert.match(wanted, /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/);
  assert.ok(wanted.split('/').every(part => part !== '.' && part !== '..'));
  const exactPath = wanted.includes('/'), eocd = zip.lastIndexOf(Buffer.from('504b0506', 'hex'));
  assert.ok(eocd >= 0 && eocd + 22 <= zip.length); assert.equal(eocd + 22 + zip.readUInt16LE(eocd + 20), zip.length);
  assert.equal(zip.readUInt16LE(eocd + 4), 0); assert.equal(zip.readUInt16LE(eocd + 6), 0);
  const count = zip.readUInt16LE(eocd + 10), start = zip.readUInt32LE(eocd + 16);
  assert.ok(count > 0 && count <= 1000); assert.equal(count, zip.readUInt16LE(eocd + 8)); assert.equal(start + zip.readUInt32LE(eocd + 12), eocd);
  let offset = start, found = null; const names = new Set();
  for (let i = 0; i < count; i++) {
    assert.ok(offset + 46 <= eocd && zip.readUInt32LE(offset) === 0x02014b50);
    const flags = zip.readUInt16LE(offset + 8), method = zip.readUInt16LE(offset + 10), compressed = zip.readUInt32LE(offset + 20), size = zip.readUInt32LE(offset + 24);
    const n = zip.readUInt16LE(offset + 28), extra = zip.readUInt16LE(offset + 30), comment = zip.readUInt16LE(offset + 32), local = zip.readUInt32LE(offset + 42);
    const end = offset + 46 + n + extra + comment; assert.ok(end <= eocd);
    const name = zip.subarray(offset + 46, offset + 46 + n).toString('utf8');
    assert.ok(name && !name.startsWith('/') && !/[\\:\x00-\x1f\x7f]/.test(name) && name.split('/').every(part => part && part !== '.' && part !== '..'));
    assert.ok(!names.has(name.toLowerCase()), 'Duplicate archive member'); names.add(name.toLowerCase());
    if (exactPath ? name === wanted : name.split('/').at(-1) === wanted) {
      assert.equal(found, null, 'Ambiguous archive member'); assert.ok(!(flags & 1) && (method === 0 || method === 8));
      assert.ok(size > 0 && size <= limit && compressed <= limit && local + 30 <= start && zip.readUInt32LE(local) === 0x04034b50);
      assert.equal(zip.readUInt16LE(local + 6), flags); assert.equal(zip.readUInt16LE(local + 8), method);
      const nameLen = zip.readUInt16LE(local + 26), extraLen = zip.readUInt16LE(local + 28);
      assert.equal(zip.subarray(local + 30, local + 30 + nameLen).toString('utf8'), name);
      const data = local + 30 + nameLen + extraLen; assert.ok(data + compressed <= start);
      found = method === 0 ? Buffer.from(zip.subarray(data, data + compressed)) : zlib.inflateRawSync(zip.subarray(data, data + compressed), { maxOutputLength: limit });
      assert.equal(found.length, size);
    }
    offset = end;
  }
  assert.equal(offset, eocd); assert.ok(found, `Missing archive member: ${wanted}`); return found;
}
function ghApiArgs(route, binary) {
  assert.match(route, /^(?:actions\/(?:runs|jobs|artifacts)\/|git\/(?:commits|blobs|trees)\/|compare\/[a-f0-9]{40}\.\.\.[a-f0-9]{40}$|releases\/)/);
  return ['api', ...(binary && route.startsWith('releases/assets/') ? ['-H', 'Accept:application/octet-stream'] : []), `repos/BOBWORKS-XR/CREATOR-HUB/${route}`];
}
const ghRawCapabilities = new WeakMap();
function createGhReader(execute = require('node:child_process').execFileSync) {
  return (route, maxBuffer, binary = false) => {
    const args = ghApiArgs(route, binary);
    assert.ok(Number.isSafeInteger(maxBuffer) && maxBuffer > 0, 'Bounded capture required');
    if (binary) {
      assert.match(route, /^(?:actions\/(?:jobs\/[0-9]+\/logs|artifacts\/[0-9]+\/zip)|releases\/assets\/[0-9]+)$/,
        'Unknown raw capture route');
      if (!ghRawCapabilities.has(execute)) {
        const help = execute('gh', ['api', '--help'], { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 128 * 1024, stdio: 'pipe' });
        ghRawCapabilities.set(execute, /^\s*--allow-escape-sequences(?:\s|$)/m.test(String(help)));
      }
      if (ghRawCapabilities.get(execute)) args.splice(1, 0, '--allow-escape-sequences');
    }
    // Raw data never inherits a terminal. Preserve bytes for the existing hash checks.
    const bytes = execute('gh', args, { windowsHide: true, timeout: 60000, maxBuffer, stdio: 'pipe' });
    assert.ok(Buffer.isBuffer(bytes), 'Raw API capture must return bytes');
    return bytes;
  };
}

module.exports={readZipMember,createGhReader};
