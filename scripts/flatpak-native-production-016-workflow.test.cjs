'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { yaml } = require('../node_modules/playwright-core/lib/utilsBundle.js');
const p = require('./flatpak-native-production-016.cjs');

test('production bundle workflow is manual, repository/ref guarded and has no publication authority', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', p.WORKFLOW), 'utf8');
  const parsed = yaml.parseDocument(source, { uniqueKeys: true }); assert.deepEqual(parsed.errors, []);
  const w = parsed.toJSON(), job = w.jobs.package;
  assert.deepEqual(w.permissions, { contents: 'read' }); assert.deepEqual(Object.keys(w.jobs), ['package']);
  assert.deepEqual(w.on.push.branches, ['validation/linux-flatpak-production-016']);
  assert.deepEqual(Object.keys(w.on.workflow_dispatch.inputs), ['source_pins']);
  assert.equal(w.on.workflow_dispatch.inputs.source_pins.required, true);
  for (const text of [`github.repository == '${p.REPO}'`, `github.repository_id == '${p.REPO_ID}'`,
    "github.event_name == 'workflow_dispatch'", `github.ref == '${p.BRANCH}'`]) assert.ok(job.if.includes(text));
  assert.equal(job['runs-on'], 'ubuntu-22.04'); assert.equal(job['timeout-minutes'], 25);
  assert.deepEqual(job.env, { SOURCE_PINS: '${{ inputs.source_pins }}' });
  assert.equal(job.steps.find(x => x.uses === 'actions/checkout@v6').with['persist-credentials'], false);
  assert.equal(job.steps.find(x => x.uses === 'actions/checkout@v6').with['fetch-depth'], 0);
  assert.ok(job.steps.some(x => x.uses === `dtolnay/rust-toolchain@${p.TOOLCHAIN}`));
  const commands = job.steps.filter(x => x.run).map(x => x.run).join('\n');
  assert.doesNotMatch(commands, /\$\{\{\s*inputs\./);
  for (const forbidden of ['flatpak run', 'flatpak install', 'flatpak update', 'remote-add', 'flathub', 'gpg', 'minisign',
    'cargo run', 'cargo install', 'build:unified', 'gh release', 'continue-on-error']) assert.ok(!source.includes(forbidden), forbidden);
  const index = text => job.steps.findIndex(x => x.run?.includes(text));
  assert.ok(index('preflight') < job.steps.findIndex(x => x.uses === 'actions/github-script@v8'));
  assert.ok(index('preflight') < index('sudo apt-get'));
  assert.ok(index('npm ci --ignore-scripts') < index('node --test'));
  assert.ok(index('node --test') < index('production-016.cjs package'));
  assert.ok(job.steps.find(x => x.uses === 'actions/github-script@v8').with.script.includes('lane.collect(github, context)'));
  const upload = job.steps.filter(x => x.uses === 'actions/upload-artifact@v4'); assert.equal(upload.length, 2);
  assert.equal(upload[0].with['if-no-files-found'], 'error'); assert.equal(upload[1].if, 'failure()');
  assert.ok(upload[0].with.path.includes(p.BUNDLE));
  for (const row of upload) assert.doesNotMatch(row.with.path, /\*|\/source\/|\/cargo-home\/|credential|auth\.json|key|\.pem/);
});

test('only the new launcher producer can compile; prototype keeps its original ref and receipt scope', () => {
  const source = fs.readFileSync(path.join(__dirname, 'flatpak-native-production-016.cjs'), 'utf8');
  assert.equal((source.match(/execute\(toolFiles\.cargo\.path, args/g) || []).length, 1);
  assert.ok(source.includes("'--bin', COMMAND")); assert.ok(source.includes("'--manifest-path'"));
  assert.ok(!source.includes('require(\'./flatpak-native-activation.cjs\')'));
  assert.ok(!source.includes('src-tauri/Cargo.toml') && !source.includes('modules/mcp/Cargo.toml'));
  assert.ok(source.includes('candidateExecuted') && source.includes('publisherSignatureAccepted'));
  assert.ok(source.includes('bundleInspectionPassed: true'));
  const old = require('./flatpak-native-activation.cjs'); assert.equal(old.recipe().branch, 'native-activation-test');
});
