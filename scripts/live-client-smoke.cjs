// Read-only live-client smoke, not installer/updater or Unity Editor acceptance.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

function run(command, args, cwd) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGTERM');
    }, 120_000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', error => { clearTimeout(timer); resolve({ code: null, error: error.message, stdout, stderr }); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, timedOut, stdout, stderr }); });
  });
}

function values(value, visit) {
  visit(value);
  if (Array.isArray(value)) value.forEach(item => values(item, visit));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => values(item, visit));
}

function summarizeClient(stdout, project) {
  let toolCalled = false, completed = false, fixtureReturned = false, connected = false;
  let failure = null;
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    values(event, value => {
      if (!value || typeof value !== 'object') return;
      if (value.name === 'acceptance' && value.status === 'connected') connected = true;
      if ((value.type === 'mcp_tool_call' && value.tool === 'get_bridge_status' && value.server === 'acceptance') || (value.type === 'tool_use' && value.name === 'mcp__acceptance__get_bridge_status')) toolCalled = true;
      if ((value.type === 'mcp_tool_call' && value.status === 'completed') || (value.type === 'result' && value.is_error === false)) completed = true;
      if (value.error === 'authentication_failed') failure = 'client-authentication-failed';
      if (typeof value.text === 'string') {
        try { const payload = JSON.parse(value.text); if (payload.ready === false && payload.project?.path === project) fixtureReturned = true; } catch { /* Other client text is not a tool payload. */ }
      }
    });
  }
  return { connected, toolCalled, completed, fixtureReturned, failure };
}

async function main() {
  const [stage, codex, claude, label, ...flags] = process.argv.slice(2);
  if (!stage || !codex || !claude || !/^[a-z0-9-]+$/.test(label || '') || flags.some(flag => !['--only=codex', '--only=claude-code'].includes(flag) && !flag.startsWith('--bundle='))) throw Error('Usage: live-client-smoke.cjs STAGE CODEX-EXE CLAUDE-EXE UNIQUE-LABEL [--only=codex|--only=claude-code] [--bundle=REBUILT-SERVER]');
  const only = flags.find(flag => flag.startsWith('--only='));
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, 'artifacts', label);
  if (fs.existsSync(output)) throw Error('Evidence directory already exists. Use a new label.');
  const override = flags.find(flag => flag.startsWith('--bundle='));
  const server = override ? path.resolve(override.slice('--bundle='.length)) : path.resolve(stage, 'modules/mcp/server/creator-works-mcp.mjs');
  const node = path.resolve(stage, `modules/mcp/server/runtime/node${process.platform === 'win32' ? '.exe' : ''}`);
  for (const file of [server, node, codex, claude]) if (!fs.statSync(file).isFile()) throw Error('A required executable or bundle is missing.');
  const project = path.join(output, 'fixture-project');
  fs.mkdirSync(path.join(project, 'Assets'), { recursive: true });
  const env = { UNITY_PROJECT_PATH: project, CREATOR_WORKS_TOOL_GROUPS: 'none' };
  const prompt = 'Call ONLY the acceptance MCP server get_bridge_status tool ONCE with empty arguments. This is an intentionally unopened disposable project. Do not run shell commands, modify files, change settings, install anything, or call any other tool. Then report the returned project path and ready flag in one sentence. A ready=false result is expected; do not try to repair it.';
  const clientConfig = path.join(output, 'claude-mcp.json');
  fs.writeFileSync(clientConfig, JSON.stringify({ mcpServers: { acceptance: { command: node, args: [server], env } } }, null, 2), { flag: 'wx' });
  const toml = JSON.stringify;
  const serverConfig = `mcp_servers={acceptance={command=${toml(node)},args=[${toml(server)}],env={UNITY_PROJECT_PATH=${toml(project)},CREATOR_WORKS_TOOL_GROUPS="none"},enabled_tools=["get_bridge_status"]}}`;
  const cases = [
    ['codex', codex, ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '-c', serverConfig, '-c', 'model_reasoning_effort="low"', prompt]],
    ['claude-code', claude, ['-p', '--strict-mcp-config', '--mcp-config', clientConfig, '--no-session-persistence', '--setting-sources', '', '--tools', '', '--allowedTools', 'mcp__acceptance__get_bridge_status', '--max-budget-usd', '0.25', '--output-format', 'stream-json', '--verbose', prompt]],
  ];
  const report = { scope: 'Actual installed AI CLI clients; direct Node/server. NOT stable-router, install, signed-update, Desktop or Editor acceptance.', created: new Date().toISOString(), stage: path.resolve(stage), sourceBundleOverride: Boolean(override), serverSha256: crypto.createHash('sha256').update(fs.readFileSync(server)).digest('hex'), clients: {} };
  for (const [name, command, args] of cases) {
    if (only && only !== `--only=${name}`) continue;
    const result = await run(command, args, output);
    fs.writeFileSync(path.join(output, `${name}.jsonl`), result.stdout, { flag: 'wx' });
    fs.writeFileSync(path.join(output, `${name}.stderr.log`), result.stderr, { flag: 'wx' });
    const summary = summarizeClient(result.stdout, project);
    report.clients[name] = { exitCode: result.code, timedOut: result.timedOut || false, ...summary,
      passed: result.code === 0 && !summary.failure && summary.toolCalled && summary.completed && summary.fixtureReturned };
    console.log(`${name}: ${JSON.stringify(report.clients[name])}`);
  }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  if (Object.values(report.clients).some(client => !client.passed)) process.exitCode = 1;
}

module.exports = { summarizeClient };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
