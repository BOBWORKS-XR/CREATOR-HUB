const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { baselines, registrationArray } = require('./native-installed-baseline.cjs');

test('installed candidate helper refuses local and self-hosted runners before filesystem access', () => {
  for (const env of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted', RUNNER_OS: 'Windows' }]) {
    const result = spawnSync(process.execPath, ['-e', "require('./scripts/native-installed-baseline.cjs').install('upgrade','missing','missing')"], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restricted to a disposable GitHub-hosted Windows runner/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
  }
});
test('installed acceptance pins all three public installers and separates direct install from signed update', () => {
  assert.deepEqual(baselines.map(b => b.version), ['0.1.12', '2.7.7', '0.3.7']);
  for (const baseline of baselines) assert.match(baseline.sha256, /^[a-f0-9]{64}$/);
  const source = fs.readFileSync(path.join(__dirname, 'native-installed-baseline.cjs'), 'utf8');
  assert.match(source, /not signed in-app updater acceptance/);
  assert.ok(source.indexOf('seedBeforeInstall();') < source.indexOf('execFileSync(installer, installerArguments', source.indexOf('seedBeforeInstall();')));
});

test('PowerShell registration arrays preserve empty, one and three item counts', { skip: process.platform !== 'win32' }, () => {
  for (const names of [[], ['Creator Hub'], baselines.map(b => b.product)]) {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', `$items=${registrationArray(names)}; $items.Count`], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(Number(result.stdout.trim()), names.length);
  }
  assert.throws(() => registrationArray(['unknown']), /Unknown registration/);
});

test('native migration dialog buttons are allowlisted without relaxing process or title checks', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-window.ps1'), 'utf8');
  assert.match(source, /'Move connection' = @\('Review existing MCP connection'\)/);
  assert.ok(source.includes("'Keep existing' = @('Review existing MCP connection', 'Review existing MCP connections', 'Keep MCP settings working in Hub', 'Move to unified Creator Hub', 'Retire standalone Creator apps')"));
  for (const [button, title] of [['Back up and continue', 'Move to unified Creator Hub'],
    ['Move selected connections', 'Review existing MCP connections'],
    ['Move server path', 'Keep MCP settings working in Hub'], ['Finish migration', 'Retire standalone Creator apps']]) {
    assert.ok(source.includes(`'${button}' = @('${title}')`));
  }
  assert.match(source, /window.Current.Name -cnotin \$titles\[\$Value\]/);
  assert.match(source, /ProcessId\(\$dialog\) -ne \$TargetPid/);
});

test('migration acceptance parses TOML and compares real paths rather than encoded source strings', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-builtin-smoke.cjs'), 'utf8');
  assert.match(source, /tomllib.load/);
  assert.match(source, /verifyMigratedTarget\(entry, descriptor, report.runtimeGeneration, process.env.LOCALAPPDATA\)/);
  const targets = fs.readFileSync(path.join(__dirname, 'native-managed-target.cjs'), 'utf8');
  assert.match(targets, /fs.realpathSync\(entry.command\)/);
  assert.match(targets, /assert.deepEqual\(entry.args, \[\]/);
  assert.doesNotMatch(source, /content.includes\(report.runtimeGeneration/);
});

test('upgrade acceptance executes the actual guarded NSIS update arguments', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-installed-baseline.cjs'), 'utf8');
  assert.match(source, /mode === 'upgrade' \? \['\/UPDATE', '\/S', '\/NS'\] : \['\/S'\]/);
  assert.match(source, /execFileSync\(installer, installerArguments/);
  assert.match(source, /report.installerScope = mode === 'upgrade' \? 'guarded-nsis-update-default-location-no-msi'/);
});

test('installed migration coverage keeps Setup/legacy settings and includes the Desktop adapter', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-builtin-smoke.cjs'), 'utf8');
  assert.match(source, /'banter-mcp', 'launcher-config.json'/);
  assert.match(source, /'CreatorProjectSetup', 'editor-roots.json'/);
  assert.match(source, /id: 'claudeDesktop'.*'Claude', 'claude_desktop_config.json'/);
  assert.match(source, /verifyRetainedStores\('Real installer'\)/);
  assert.match(source, /verifyRetainedStores\(`\$\{app\} consent declined`\)/);
  assert.match(source, /verifyRetainedStores\(`\$\{app\} embedded operation`\)/);
  assert.match(source, /verifyRetainedStores\('Closing module views'\)/);
  assert.match(source, /verifyRetainedStores\('Failed payload and recovered retry'\)/);
  assert.match(source, /fresh profiles remain absent/);
});

test('built-in installation refusal retries only the exact startup busy response with a deadline', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-builtin-smoke.cjs'), 'utf8');
  const probe = source.slice(source.indexOf('  let denied;'), source.indexOf("  report.checks.push('Separate module installation"));
  assert.match(probe, /if \(denied !== 'Another Hub operation is already running\.'\) break;/);
  assert.match(probe, /Date.now\(\) < installationProbeDeadline/);
  assert.match(probe, /assert.match\(denied, \/built into this Hub\//);
  assert.doesNotMatch(probe, /catch|continue-on-error|\.includes\('operation'\)/);
});
