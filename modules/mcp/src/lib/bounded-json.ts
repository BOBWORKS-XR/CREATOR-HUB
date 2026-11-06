import * as fs from "fs";
import * as path from "path";

// Check fixed ancestors as well as the file so a linked state directory cannot redirect a read.
export function assertOrdinaryPath(file: string, root: string): void {
  const relative = path.relative(root, file);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("File is outside the approved directory.");
  }
  let current = root;
  for (const part of ["", ...relative.split(path.sep).filter(Boolean)]) {
    current = part ? path.join(current, part) : current;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("Linked paths are not supported for state reads.");
  }
}

export function readBoundedJson(file: string, maxBytes: number): unknown {
  return JSON.parse(readBoundedBytes(file, maxBytes).toString("utf8"));
}

export function readBoundedBytes(file: string, maxBytes: number): Buffer {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) {
    throw new Error(`Expected an ordinary JSON file of at most ${maxBytes} bytes.`);
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes || before.dev !== stat.dev || before.ino !== stat.ino) {
      throw new Error("JSON file changed while opening it.");
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fs.fstatSync(fd);
    if (length > maxBytes || stat.size !== length || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
      throw new Error("JSON file is oversized or changed while reading it.");
    }
    return buffer.subarray(0, length);
  } finally {
    fs.closeSync(fd);
  }
}
