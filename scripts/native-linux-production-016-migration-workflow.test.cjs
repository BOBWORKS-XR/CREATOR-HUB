'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { yaml } = require('../node_modules/playwright-core/lib/utilsBundle.js');
const file = path.join(__dirname, '../.github/workflows/native-linux-production-016-migration.yml');
const source = fs.readFileSync(file, 'utf8');
const parsed = yaml.parseDocument(source, { uniqueKeys: true });
assert.deepEqual(parsed.errors, []);
const workflow = parsed.toJSON();

test('exact validation-branch push registers the workflow but execution remains manual and opted in', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ['push', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.push, { branches: ['validation/native-linux-production-016'] });
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read' });
  assert.deepEqual(Object.keys(workflow.jobs), ['migration', 'changed_delivery', 'changed_mcp']);
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs), ['profile', 'scenario', 'execute_migration', 'continue_changed_mcp', 'source_receipt_sha256']);
  assert.equal(inputs.execute_migration.type, 'boolean');
  assert.equal(inputs.execute_migration.default, false);
  assert.equal(inputs.scenario.type, 'choice');
  assert.deepEqual(inputs.scenario.options, ['migration-guide-cancel', 'migration-first-system-cancel', 'migration-second-system-cancel', 'migration-approve']);
  const job = workflow.jobs.migration;
  for (const condition of ["github.repository == 'BOBWORKS-XR/CREATOR-HUB'", "github.repository_id == '1364807512'",
    "github.ref == 'refs/heads/validation/native-linux-production-016'", "github.event_name == 'workflow_dispatch'",
    "github.workflow_ref == 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/native-linux-production-016-migration.yml@refs/heads/validation/native-linux-production-016'",
    'inputs.execute_migration == true']) assert.ok(job.if.includes(condition), condition);
  assert.equal(job['runs-on'], 'ubuntu-22.04');
  assert.equal(job.strategy, undefined);
  assert.equal(job.env.CREATOR_MIGRATION_016_SCENARIO, '${{ inputs.scenario }}');
  assert.equal(job.env.CREATOR_MIGRATION_016_EXECUTE, '${{ inputs.execute_migration }}');
  assert.equal(job.steps.find(step => step.uses === 'actions/checkout@v6').with['persist-credentials'], false);
});

test('actual job guard skips registration pushes even with execution requested, and admits only the exact opted-in dispatch', () => {
  const job = workflow.jobs.migration;
  // Interpret only the guard's fixed conjunction/equality grammar, not JavaScript
  // or an approximation that could overlook an added OR/always() bypass.
  const clauses = job.if.trim().split(/\s+&&\s+/).map(clause => {
    const match = /^(github\.[a-z_]+|inputs\.(?:execute_migration|continue_changed_mcp)) (==|!=) (?:'([^']+)'|(true))$/.exec(clause.trim());
    assert.ok(match, `Unsupported execution guard clause: ${clause}`);
    return { field: match[1].split('.'), operator: match[2], expected: match[4] ? true : match[3] };
  });
  assert.equal(clauses.length, 7);
  const github = { repository: 'BOBWORKS-XR/CREATOR-HUB', repository_id: '1364807512',
    ref: 'refs/heads/validation/native-linux-production-016', event_name: 'workflow_dispatch',
    workflow_ref: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/native-linux-production-016-migration.yml@refs/heads/validation/native-linux-production-016' };
  const admitted = (context, inputs) => clauses.every(({ field: [root, key], operator, expected }) =>
    operator === '==' ? ({ github: context, inputs })[root]?.[key] === expected
      : ({ github: context, inputs })[root]?.[key] !== expected);
  assert.equal(admitted(github, { execute_migration: true }), true);
  assert.equal(admitted(github, { execute_migration: true, continue_changed_mcp: true }), false);
  for (const inputs of [{}, { execute_migration: false }, { execute_migration: true }, { execute_migration: 'true' }]) {
    assert.equal(admitted({ ...github, event_name: 'push' }, inputs), false, 'Registration push must skip the entire migration job');
  }
  for (const inputs of [{}, { execute_migration: false }, { execute_migration: 'true' }]) {
    assert.equal(admitted(github, inputs), false);
  }
  for (const key of Object.keys(github)) {
    assert.equal(admitted({ ...github, [key]: 'not-the-admitted-context' }, { execute_migration: true }), false, key);
  }
});

test('pinned preflight Python precedes pure tests while native brokers retain the system interpreter', () => {
  const steps = workflow.jobs.migration.steps;
  const setups = steps.filter(step => step.uses === 'actions/setup-python@v6');
  assert.equal(setups.length, 1);
  assert.equal(setups[0].id, 'preflight_python');
  assert.deepEqual(setups[0].with, { 'python-version': '3.11.17', 'update-environment': false });
  const setup = steps.indexOf(setups[0]);
  const pure = steps.findIndex(step => step.name?.startsWith('Pure execution'));
  const download = steps.findIndex(step => step.uses === 'actions/github-script@v8');
  const dependencies = steps.findIndex(step => step.run?.includes('sudo apt-get install'));
  const broker = steps.findIndex(step => step.name?.startsWith('Fixed root broker'));
  assert.ok(0 < setup && setup < pure && pure < download && download < dependencies && dependencies < broker);
  assert.deepEqual(steps[pure].env, { PREFLIGHT_PYTHON: '${{ steps.preflight_python.outputs.python-path }}' });
  assert.match(steps[pure].run, /^"\$PREFLIGHT_PYTHON" -I -c 'import sys, tomllib; assert sys.version_info\[:3\] == \(3, 11, 17\)'$/m);
  assert.match(steps[pure].run, /^"\$PREFLIGHT_PYTHON" -B scripts\/native-linux-production-016-stage\.test\.py$/m);
  assert.match(steps[pure].run, /^"\$PREFLIGHT_PYTHON" -B scripts\/native-linux-production-016-migration\.test\.py$/m);
  for (const env of [workflow.env, workflow.jobs.migration.env, ...steps.map(step => step.env)]) {
    for (const key of Object.keys(env || {})) assert.doesNotMatch(key, /^(?:LD_|DYLD_|PYTHONPATH$|PYTHONHOME$)/);
  }
  assert.equal(Object.hasOwn(workflow.jobs.migration.env, 'PREFLIGHT_PYTHON'), false);
  for (const step of steps.filter((_, index) => index !== pure)) {
    assert.equal(Object.hasOwn(step.env || {}, 'PREFLIGHT_PYTHON'), false);
    assert.doesNotMatch(step.run || '', /PREFLIGHT_PYTHON|preflight_python\.outputs/);
  }
  for (const step of steps) assert.doesNotMatch(step.run || '', /\bunset\b|GITHUB_ENV|GITHUB_PATH/);
  assert.match(steps[dependencies].run, /python3-gi python3-toml/);
  assert.match(steps[broker].run, /'PATH=\/usr\/bin:\/bin', 'LANG=C', 'LC_ALL=C',\s*'\/usr\/bin\/python3', '-B', str\(source\), 'broker'/);
  const controller = fs.readFileSync(path.join(__dirname, 'native-linux-production-016-migration.py'), 'utf8');
  assert.match(controller, /"\/usr\/bin\/python3", "-B", str\(BASE \/ "scripts" \/ Path\(__file__\)\.name\), "session"/);
  assert.match(controller, /import tomllib as toml\s+except ImportError:\s+import toml/);
});

test('actual reused polkit and transitive helper suites are mandatory before downloads or apt', () => {
  const steps = workflow.jobs.migration.steps;
  const pure = steps.findIndex(step => step.name?.startsWith('Pure execution'));
  const download = steps.findIndex(step => step.uses === 'actions/github-script@v8');
  const apt = steps.findIndex(step => step.run?.includes('sudo apt-get'));
  assert.ok(0 <= pure && pure < download && download < apt);
  assert.equal(steps[pure]['continue-on-error'], undefined);
  for (const name of ['native-linux-polkit-probe', 'native-linux-root-probe', 'native-unix-window']) {
    const command = `"$PREFLIGHT_PYTHON" -B scripts/${name}.test.py`;
    assert.equal(steps[pure].run.split('\n').filter(line => line === command).length, 1, command);
    assert.equal(steps.filter(step => (step.run || '').includes(command)).length, 1, command);
  }
  assert.doesNotMatch(steps[pure].run, /\|\||set \+e|continue-on-error/);
  const suite = fs.readFileSync(path.join(__dirname, 'native-linux-polkit-probe.test.py'), 'utf8');
  assert.match(suite, /^b = p\.base\(\)$/m);
});

test('real exact-target fixture is mandatory after GUI dependencies and gates SDK, tooling and broker', () => {
  const steps = workflow.jobs.migration.steps;
  const apt = steps.findIndex(step => step.run?.includes('sudo apt-get install'));
  const fixtures = steps.filter(step => step.run?.includes('--native-exact-target'));
  assert.equal(fixtures.length, 1);
  const fixture = fixtures[0], index = steps.indexOf(fixture);
  assert.ok(apt < index);
  for (const next of [steps.findIndex(step => step.run?.includes('npm ci --prefix modules/mcp')),
    steps.findIndex(step => step.uses?.startsWith('dtolnay/rust-toolchain@')),
    steps.findIndex(step => step.name?.startsWith('Build pinned WebDriver')),
    steps.findIndex(step => step.name?.startsWith('Fixed root broker'))]) assert.ok(index < next);
  assert.equal(fixture.if, undefined);
  assert.equal(fixture['continue-on-error'], undefined);
  assert.equal(fixture['timeout-minutes'], 2);
  assert.deepEqual(fixture.env, { CREATOR_NATIVE_EXACT_TARGET_FIXTURE: '1' });
  assert.match(fixture.run, /^set -o noclobber$/m);
  assert.match(fixture.run, /^\/usr\/bin\/timeout --signal=TERM --kill-after=5s 40s \/usr\/bin\/python3 -B scripts\/native-linux-polkit-probe\.test\.py --native-exact-target > "\$RUNNER_TEMP\/native-exact-target-observer\.json"$/m);
  assert.match(fixture.run, /-le 16384/);
  assert.doesNotMatch(fixture.run, /\|\||set \+e|sudo|broker|pkexec|\.deb/);
  const upload = steps.find(step => step.uses === 'actions/upload-artifact@v4');
  assert.equal(upload.with.path.split('\n').filter(line => line === '${{ runner.temp }}/native-exact-target-observer.json').length, 1);
});

test('unchanged production API/offline gate precedes any candidate execution or privilege', () => {
  const steps = workflow.jobs.migration.steps;
  const index = needle => steps.findIndex(step => step.run?.includes(needle));
  const download = steps.findIndex(step => step.uses === 'actions/github-script@v8');
  assert.ok(index('npm ci --ignore-scripts') < index('migration.test.py'));
  assert.ok(index('migration.test.py') < download);
  assert.match(steps[download].with.script, /native-linux-production-016-input.cjs/);
  assert.equal(steps[download].env.PROFILE, '${{ inputs.profile }}');
  const stage = steps.findIndex(step => step.run === 'python3 -B scripts/native-linux-production-016-stage.py');
  const request = steps.findIndex(step => step.run === 'python3 -B scripts/native-linux-production-016-migration.py');
  assert.ok(download < stage && stage < request && request < index('sudo apt-get'));
  assert.ok(index('sudo apt-get') < index("str(source), 'broker'"));
  assert.match(source, /npm ci --prefix modules\/mcp --ignore-scripts/);
  assert.match(source, /cargo install tauri-driver --version 2\.1\.0 --locked/);
  assert.equal(workflow.jobs.migration.permissions, undefined);
  assert.doesNotMatch(JSON.stringify(workflow.jobs.migration), /build:unified|cargo (?:build|run)|gh release|actions: write|continue-on-error|flatpak install/);
});

test('inline Python and Bash parse and artifact exports have an explicit bounded safe list', () => {
  const commands = workflow.jobs.migration.steps.filter(step => step.run).map(step => step.run);
  for (const command of commands) assert.ok(!command.includes('${{'), 'No workflow input interpolation into shell/Python source');
  for (const command of commands) cp.execFileSync(process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
    ['-n'], { input: command, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  const scripts = commands.flatMap(command => [...command.matchAll(/<<'PY'\n([\s\S]*?)\nPY(?:\n|$)/g)].map(match => match[1]));
  assert.equal(scripts.length, 3);
  cp.execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c',
    'import ast,json,sys\nfor source in json.load(sys.stdin): ast.parse(source, feature_version=(3,10))'],
  { input: JSON.stringify(scripts), encoding: 'utf8' });
  const exporter = workflow.jobs.migration.steps.find(step => step.name?.startsWith('Export only'));
  assert.equal(exporter.if, 'always()');
  assert.match(exporter.run, /range\(1, 49\)/);
  assert.match(exporter.run, /info\.st_nlink == 1/);
  assert.match(exporter.run, /os\.O_NOFOLLOW \| os\.O_NONBLOCK/);
  assert.match(exporter.run, /stamp\(file\.lstat\(\)\) == stamp\(info\)/);
  assert.match(exporter.run, /home\.png/);
  assert.match(exporter.run, /262144/);
  assert.doesNotMatch(exporter.run, /read_text|rglob|glob\(|assembly\.zip|\.deb|auth\.json|secret|password/);
  const upload = workflow.jobs.migration.steps.find(step => step.uses === 'actions/upload-artifact@v4');
  assert.equal(upload.if, 'always()');
  assert.doesNotMatch(upload.with.path, /\.bin|\.deb|assembly\.zip|credential|auth\.json/);
});

test('historical migration job body is unchanged apart from mutually exclusive dispatch', () => {
  const { createHash } = require('node:crypto');
  const body = { ...workflow.jobs.migration }; delete body.if;
  assert.equal(createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    'd30190926bbdce3adece4576cb2743fd97a646820de24a09f8b4c778ca70cb8c');
});

test('changed-payload job has only the exact opted-in conjunction and excludes registration pushes', () => {
  const job = workflow.jobs.changed_mcp;
  const clauses = job.if.trim().split(/\s+&&\s+/).map(clause => {
    const match = /^(github\.[a-z_]+|inputs\.(?:execute_migration|continue_changed_mcp|scenario)) == (?:'([^']+)'|(true))$/.exec(clause.trim());
    assert.ok(match, 'Unsupported changed-payload guard: ' + clause);
    return { field: match[1].split('.'), expected: match[3] ? true : match[2] };
  });
  assert.equal(clauses.length, 8);
  const github = { repository: 'BOBWORKS-XR/CREATOR-HUB', repository_id: '1364807512',
    ref: 'refs/heads/validation/native-linux-production-016', event_name: 'workflow_dispatch',
    workflow_ref: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/native-linux-production-016-migration.yml@refs/heads/validation/native-linux-production-016' };
  const input = { execute_migration: true, continue_changed_mcp: true, scenario: 'migration-approve' };
  const accepts = (g, inputs) => clauses.every(({ field: [root, key], expected }) => ({ github: g, inputs })[root]?.[key] === expected);
  assert.equal(accepts(github, input), true);
  for (const key of Object.keys(github)) assert.equal(accepts({ ...github, [key]: 'foreign' }, input), false, key);
  for (const key of Object.keys(input)) {
    const missing = { ...input }; delete missing[key]; assert.equal(accepts(github, missing), false, key);
  }
  assert.equal(accepts(github, { ...input, execute_migration: 'true' }), false);
  assert.equal(accepts(github, { ...input, continue_changed_mcp: 'true' }), false);
  assert.equal(accepts({ ...github, event_name: 'push' }, input), false);
  assert.equal(job['runs-on'], 'ubuntu-22.04'); assert.equal(job.strategy, undefined);
  assert.equal(job.env.CREATOR_CHANGED_MCP_SOURCE_RECEIPT_SHA256, '${{ inputs.source_receipt_sha256 }}');
  assert.equal(job.needs, 'changed_delivery');
  assert.deepEqual(job.permissions, { contents: 'read', actions: 'read' });
  assert.equal(job.env.CREATOR_CHANGED_MCP_DELIVERY_ARTIFACT, '${{ needs.changed_delivery.outputs.artifact }}');
  assert.equal(job.env.UPDATE_PROFILE_SHA256, 'ef2b5a589d934bf48306ddfd53d133513f3ab4d22b9622672f76887cb7acb095');
});

test('changed-payload source, input, fixture, verifiers, migration and continuation are ordered', () => {
  const steps = workflow.jobs.changed_mcp.steps;
  const named = prefix => steps.findIndex(step => step.name?.startsWith(prefix));
  const order = ['Bind exact controller', 'Reject a changed', 'Complete affected', 'Download only this run', 'Acquire original migration',
    'Acquire only original successor', 'Inspect original migration', 'Install only disposable',
    'Native exact-target', 'Install only the locked SDK', 'Build locked WebDriver',
    'Prepare only the reviewed verifier', 'Qualify metadata', 'Check stock policy', 'Seal continuation intent', 'Run the original migration',
    'Signed changed-payload', 'Export bounded evidence', 'Preserve original failures'];
  let prior = -1;
  for (const name of order) { const next = named(name); assert.ok(next > prior, name); prior = next; }
  const pure = steps[named('Complete affected')];
  for (const suite of ['native-linux-production-016-update.test.py', 'native-linux-migrated-update.test.py',
    'native-linux-production-016-input.test.cjs', 'native-linux-production-016-stage.test.py',
    'native-linux-production-016-migration.test.py', 'native-linux-changed-mcp-input.test.cjs',
    'native-linux-production-016-migration-workflow.test.cjs', 'linux-update-lab-feed.test.cjs',
    'linux-update-lab-feed-changed-mcp.test.cjs']) assert.ok(pure.run.includes(suite), suite);
  const acquire = steps.filter(step => step.uses === 'actions/github-script@v8');
  assert.equal(acquire.length, 2); assert.ok(acquire.every(step => step.with.retries === 0));
  assert.match(acquire[0].with.script, /lane\.run\(\{github, context, profile:process\.env\.PROFILE\}\)/);
  assert.match(acquire[0].with.script, /assert\.equal\(incoming\.length, 1763\)/);
  assert.match(acquire[0].with.script, /08f2df3b8139f00f5bd5b84619218228c7878d62ae0e4ec180fdcaaec6b87fc3/);
  assert.ok(acquire[0].with.script.indexOf('assert.equal(incoming.length') < acquire[0].with.script.indexOf('await lane.run'));
  assert.match(acquire[1].with.script, /native-linux-changed-mcp-input\.cjs/);
  const downloaded = steps.find(step => step.uses === 'actions/download-artifact@v5');
  assert.deepEqual(downloaded.with, { 'artifact-ids': '${{ needs.changed_delivery.outputs.artifact }}',
    'merge-multiple': true, path: '${{ runner.temp }}/native-linux-changed-mcp-delivery' });
  assert.match(steps[named('Qualify metadata')].run, /m\.U\.build_offline_verifier\(os\.environ\)/);
  assert.match(steps[named('Qualify metadata')].run, /m\.changed_build_installer_verifier\(os\.environ\)/);
  const fixture = steps[named('Native exact-target')];
  assert.equal(fixture['timeout-minutes'], 2); assert.equal(fixture.if, undefined);
  assert.match(fixture.run, /--native-exact-target/);
  const cache = steps.find(step => step.uses === 'Swatinem/rust-cache@v2');
  assert.equal(cache.with.workspaces, 'src-tauri');
  assert.equal(cache.with['shared-key'], 'native-linux-test-tools');
  assert.equal(cache.with['cache-on-failure'], true);
  const prepared = steps[named('Prepare only the reviewed verifier')];
  assert.equal(prepared['timeout-minutes'], 15);
  assert.equal(prepared.run.trim(), 'cargo test --release --locked --no-default-features --jobs 2 --manifest-path src-tauri/Cargo.toml --target-dir src-tauri/target --example private-deb017-dea67 --example private-deb017-dea67-guards --no-run');
  assert.doesNotMatch(steps.map(step => step.run || '').join('\n'), /cargo (?:build|run)|build:unified|gh release|flatpak install|\|\||set \+e/);
});

test('changed-payload inline scripts parse without input interpolation or environment rebinding', () => {
  const { Script } = require('node:vm');
  const steps = workflow.jobs.changed_mcp.steps;
  const commands = steps.filter(step => step.run).map(step => step.run);
  for (const command of commands) {
    assert.ok(!command.includes('${{'));
    cp.execFileSync(process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash', ['-n'],
      { input: command, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  }
  const python = commands.flatMap(command => [...command.matchAll(/<<'PY'\n([\s\S]*?)\nPY(?:\n|$)/g)].map(match => match[1]));
  assert.equal(python.length, 6);
  cp.execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c',
    'import ast,json,sys\nfor source in json.load(sys.stdin): ast.parse(source, feature_version=(3,10))'],
    { input: JSON.stringify(python), encoding: 'utf8' });
  for (const step of steps.filter(step => step.uses === 'actions/github-script@v8')) new Script('(async () => {\n' + step.with.script + '\n})');
  for (const js of commands.flatMap(command => [...command.matchAll(/<<'JS'\n([\s\S]*?)\nJS(?:\n|$)/g)].map(match => match[1]))) new Script(js);
  const envWrites = steps.filter(step => /GITHUB_ENV|GITHUB_PATH/.test(step.run || ''));
  assert.equal(envWrites.length, 1);
  assert.equal(envWrites[0].run.trim(), 'printf \'CONTROLLER_NODE=%s\\n\' "$(realpath "$(command -v node)")" >> "$GITHUB_ENV"');
  for (const env of [workflow.env, workflow.jobs.changed_mcp.env, ...steps.map(step => step.env)]) {
    for (const key of Object.keys(env || {})) assert.doesNotMatch(key, /^(?:LD_|DYLD_|PYTHONPATH$|PYTHONHOME$|GITHUB_SHA$|GITHUB_REF$|GITHUB_WORKFLOW_REF$)/);
  }
});

test('changed-payload evidence retains failures without publishing or uploading package inputs', () => {
  const steps = workflow.jobs.changed_mcp.steps;
  const exported = steps.find(step => step.name?.startsWith('Export bounded evidence'));
  assert.equal(exported.if, 'always()'); assert.match(exported.run, /'export-changed-mcp'/);
  const upload = steps.find(step => step.uses === 'actions/upload-artifact@v4');
  assert.equal(upload.if, 'always()');
  assert.match(upload.with.path, /native-linux-migrated-update-evidence\//);
  assert.match(upload.with.path, /source-receipt\.json/);
  assert.match(upload.with.path, /acquisition\.json/);
  assert.doesNotMatch(upload.with.path, /assembly\d*\.zip|signedDeb17\.zip|\.deb|auth\.json|catalog\.key/);
  assert.doesNotMatch(JSON.stringify(workflow.jobs.changed_mcp), /actions: write|gh release|publish-hub|continue-on-error|secrets\./);
  assert.deepEqual(Object.entries(workflow.jobs).filter(([, job]) => job.permissions?.contents === 'write').map(([name]) => name), ['changed_delivery']);
});

test('draft access is confined to a separate data-only job with no package execution', () => {
  const job = workflow.jobs.changed_delivery;
  assert.equal(job.if.trim(), workflow.jobs.changed_mcp.if.trim());
  assert.deepEqual(job.permissions, { contents: 'write', actions: 'read' });
  assert.equal(job['runs-on'], 'ubuntu-22.04'); assert.equal(job['timeout-minutes'], 10);
  assert.equal(job.outputs.artifact, '${{ steps.upload.outputs.artifact-id }}');
  assert.equal(job.env.CREATOR_CHANGED_MCP_SOURCE_RECEIPT_SHA256, '${{ inputs.source_receipt_sha256 }}');
  assert.equal(job.env.CREATOR_CHANGED_MCP_DELIVERY_ARTIFACT, undefined);
  assert.equal(job.steps.length, 6);
  assert.equal(job.steps[0].uses, 'actions/checkout@v6');
  assert.equal(job.steps[0].with['persist-credentials'], false);
  assert.match(job.steps[2].run, /c\.sourceReceipt\(/);
  assert.match(job.steps[3].run, /^node --test scripts\/native-linux-changed-mcp-input\.test\.cjs$/);
  const api = job.steps[4];
  assert.equal(api.uses, 'actions/github-script@v8'); assert.equal(api.with.retries, 0);
  assert.match(api.with.script, /await lane\.collectDelivery\(\{github, context, raw\}\)/);
  assert.doesNotMatch(api.with.script, /lane\.run\(|post|createRelease|updateRelease|deleteRelease|uploadRelease/);
  const uploader = job.steps[5]; assert.equal(uploader.uses, 'actions/upload-artifact@v4');
  assert.equal(uploader.with.name, 'changed-mcp-delivery-${{ github.run_id }}-${{ github.run_attempt }}');
  assert.equal(uploader.with['compression-level'], 0); assert.equal(uploader.with['if-no-files-found'], 'error');
  assert.deepEqual(uploader.with.path.trim().split('\n'), [
    '${{ runner.temp }}/native-linux-changed-mcp-delivery/signedDeb17.zip',
    '${{ runner.temp }}/native-linux-changed-mcp-delivery/delivery-api.json',
  ]);
  for (const step of job.steps) {
    assert.doesNotMatch(step.run || '', /sudo|cargo|npm|python|\.deb|unzip|tar |chmod|chown|GITHUB_ENV|GITHUB_PATH/);
    assert.equal(step['continue-on-error'], undefined);
    if (step.run) {
      assert.ok(!step.run.includes('${{'));
      cp.execFileSync(process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash', ['-n'],
        { input: step.run, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
    }
  }
  const { Script } = require('node:vm'); new Script('(async () => {\n' + api.with.script + '\n})');
  assert.equal(workflow.permissions.contents, 'read');
});
