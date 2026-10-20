const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readBounded(file, max) {
  assert.ok(path.isAbsolute(file), 'Input paths must be absolute');
  for (let entry = path.resolve(file); ; entry = path.dirname(entry)) {
    assert.equal(fs.lstatSync(entry).isSymbolicLink(), false, 'Linked inputs are not accepted');
    if (path.dirname(entry) === entry) break;
  }
  const fd = fs.openSync(file, 'r');
  try {
    const before = fs.fstatSync(fd);
    assert.ok(before.isFile() && before.size > 0 && before.size <= max, 'Input size is outside bounds');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      assert.ok(count > 0, 'Input changed while reading'); offset += count;
    }
    const after = fs.fstatSync(fd);
    assert.equal(after.size, before.size, 'Input changed while reading');
    assert.equal(after.mtimeMs, before.mtimeMs, 'Input changed while reading');
    return bytes;
  } finally { fs.closeSync(fd); }
}

module.exports = { readBounded };
