const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.resolve(__dirname, "../..");
const sources = new Map();

// Load only the owned source modules and their atomic-write helper. All runtime IO is virtual.
exports.fixture = function fixture(options = {}) {
  let now = 100000;
  const files = new Map(), modules = new Map(), writes = [], deletions = [];
  const config = {
    projectId: "unity-fixture", unityProjectPath: path.resolve("synthetic-project"),
    mcpStatePath: path.resolve("synthetic-project/.mcp/state"),
    mcpCommandsPath: path.resolve("synthetic-project/.mcp/commands"), hasUnityExtension: true,
  };
  const key = value => path.resolve(value);
  const put = (file, value) => files.set(key(file), typeof value === "string" ? value : JSON.stringify(value));
  const get = file => files.get(key(file));
  const vfs = {
    mkdirSync() {},
    existsSync: file => files.has(key(file)),
    readFileSync(file) {
      options.beforeRead?.(file);
      if (!files.has(key(file))) throw Object.assign(new Error("ENOENT fixture"), { code: "ENOENT" });
      return get(file);
    },
    writeFileSync(file, value) { options.beforeWrite?.(file); put(file, value); writes.push(key(file)); },
    renameSync(from, to) {
      options.beforeRename?.(from, to);
      assert(files.has(key(from)));
      put(to, get(from));
      files.delete(key(from));
      if (path.dirname(key(to)) === config.mcpCommandsPath) options.onCommand?.(JSON.parse(get(to)), api);
    },
    unlinkSync(file) {
      options.beforeUnlink?.(file);
      deletions.push(key(file));
      files.delete(key(file));
    },
  };
  const timers = new Set();
  function schedule(callback, delay = 0) {
    const token = {};
    timers.add(token);
    queueMicrotask(() => {
      if (!timers.delete(token)) return;
      now += delay;
      callback();
    });
    return token;
  }
  const sockets = [];
  const net = {
    createConnection() {
      if (options.connectThrows) throw new Error("fixture connect setup failed");
      const socket = new EventEmitter();
      socket.destroy = () => { socket.destroyed = true; };
      socket.write = text => {
        if (options.writeThrows) throw new Error("fixture socket write failed");
        const command = JSON.parse(text);
        writes.push("pipe:" + command.id);
        options.onPipeCommand?.(command, socket, api);
      };
      sockets.push(socket);
      queueMicrotask(() => {
        if (options.pipeUnavailable) socket.emit("error", new Error("fixture unavailable"));
        else socket.emit("connect");
      });
      return socket;
    },
  };
  class Clock extends Date { static now() { return now; } }
  const allow = new Set(["src/tools/get-unity-command-status.ts", "src/lib/unity-bridge-transport.ts", "src/lib/files.ts"]);
  function load(relative) {
    assert(allow.has(relative), `Unexpected source dependency: ${relative}`);
    if (modules.has(relative)) return modules.get(relative).exports;
    const filename = path.join(root, relative);
    if (!sources.has(relative)) {
      const result = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
        fileName: filename, reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
      });
      assert.equal((result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
      sources.set(relative, result.outputText);
    }
    const module = { exports: {} };
    modules.set(relative, module);
    function safeRequire(name) {
      if (name === "fs") return vfs;
      if (name === "net") return net;
      if (name === "path") return path;
      if (name === "crypto") return crypto;
      if (name.endsWith("/project-router.js")) return { projectIdForPath() { throw new Error("Fixture requires an explicit project ID"); } };
      if (name.startsWith(".")) return load(path.relative(root, path.resolve(path.dirname(filename), name)).replace(/\\/g, "/").replace(/\.js$/, ".ts"));
      throw new Error(`Unexpected dependency: ${name}`);
    }
    const execute = vm.runInNewContext(`(function(require,module,exports){${sources.get(relative)}\n})`, {
      Buffer, Date: Clock, process: { platform: options.platform || process.platform, pid: process.pid },
      setTimeout: schedule, clearTimeout: token => timers.delete(token),
    }, { filename });
    execute(safeRequire, module, module.exports);
    return module.exports;
  }
  const api = {
    config, files, writes, deletions, sockets, put, get,
    receipt: (folder, id) => path.join(config.mcpStatePath, folder, `${id}.json`),
    command: id => path.join(config.mcpCommandsPath, `${id}.json`),
    descriptor(extra = {}) {
      put(path.join(config.mcpStatePath, "project-instance.json"), {
        projectPath: config.unityProjectPath, editorInstanceId: "fixture-editor", updatedAt: now,
        protocolVersion: 1, capabilities: ["named_pipe_commands"], pipeName: "bantworks-unity-fixture", ...extra,
      });
    },
  };
  return Object.assign(api, load("src/tools/get-unity-command-status.ts"), load("src/lib/unity-bridge-transport.ts"));
};
