'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const driver = require('./native-windows-016-settings-only.cjs');
const candidate = require('./windows-incoming-016.cjs');
const migration = require('./native-windows-016-migration.cjs');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(__filename.replace('.test.cjs', '.cjs'), 'utf8');
const workflow = fs.readFileSync(path.join(root, driver.WORKFLOW), 'utf8');
const text = file => fs.readFileSync(path.join(root, file), 'utf8');
const revision = 'a'.repeat(40);
function environment() {
  return { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: `refs/heads/${driver.BRANCH}`, GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/${driver.WORKFLOW}@refs/heads/${driver.BRANCH}`,
    GITHUB_SHA: revision, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', INPUT_RUN: '40431905266', INPUT_ARTIFACT: '12702061918',
    INPUT_SHA256: '9ed19a0abf547992b73607fb42802c59a6a07b165a3b543c270eb244478886d4', CREATOR_SETTINGS_CASE: 'current-legacy',
    USERPROFILE: 'C:\\Users\\runneradmin', APPDATA: 'C:\\Users\\runneradmin\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\runneradmin\\AppData\\Local' };
}
const fixture = () => driver.fixture(environment(), 'D:\\a\\CREATOR-HUB\\artifacts\\native-suite-123', path.win32);
const encode = value => Buffer.from(JSON.stringify(value));
function inputMetadata() {
  const env = environment();
  const run = { id: Number(env.INPUT_RUN), head_sha: 'b'.repeat(40), repository: { id: 1364807512 }, head_repository: { id: 1364807512 },
    head_branch: driver.BRANCH, path: '.github/workflows/windows-016-input.yml', event: 'workflow_dispatch', status: 'completed', conclusion: 'success' };
  const artifact = { id: Number(env.INPUT_ARTIFACT), name: 'windows-016-acceptance-input', expired: false, size_in_bytes: 100,
    digest: `sha256:${env.INPUT_SHA256}`, workflow_run: { id: run.id, head_sha: run.head_sha } };
  return { env, run, artifact };
}
test('host admission refuses local/foreign/override contexts before any input or native operation', async () => {
  driver.admission(environment(), 'win32');
  for (const change of [{ GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { GITHUB_REPOSITORY_ID: '1' },
    { GITHUB_EVENT_NAME: 'push' }, { GITHUB_REF: 'refs/heads/main' }, { GITHUB_WORKFLOW_REF: 'other' },
    { CREATOR_SETTINGS_CASE: 'other' }, { CREATOR_FAKE_APPROVAL: '1' }, { WEBVIEW2_USER_DATA_FOLDER: 'elsewhere' }, { NODE_OPTIONS: '--inspect' }, { HTTPS_PROXY: 'proxy' }]) {
    assert.throws(() => driver.admission({ ...environment(), ...change }, 'win32'));
  }
  assert.throws(() => driver.admission(environment(), 'linux'));
  await assert.rejects(driver.main(['C:\\must-not-be-read.exe'], { ...environment(), GITHUB_ACTIONS: 'false' }));
  assert.ok(source.indexOf('admission(env); //') < source.indexOf("if (args[0] === 'bind')"));
  assert.match(source, /const out = path\.join\(ROOT, 'artifacts', `native-suite-\$\{Date\.now\(\)\}`\)/);
  assert.doesNotMatch(source, /kill\(|taskkill|Stop-Process|execSync|window\.CreatorHubNative\s*=/);
});
test('stager identity binds repository, manual workflow, branch, successful run, digest and current harness independently', () => {
  const { env, run, artifact } = inputMetadata(); const bound = driver.bindInput(run, artifact, env);
  assert.equal(bound.harnessSource, revision); assert.equal(bound.artifactSource, run.head_sha);
  for (const change of [{ id: 1 }, { event: 'push' }, { head_branch: 'main' }, { path: 'wrong.yml' }, { conclusion: 'failure' },
    { status: 'in_progress' }, { repository: { id: 1 } }, { head_repository: { id: 1 } }]) assert.throws(() => driver.bindInput({ ...run, ...change }, artifact, env));
  for (const change of [{ id: 1 }, { name: 'wrong' }, { expired: true }, { digest: `sha256:${'0'.repeat(64)}` },
    { workflow_run: { id: run.id, head_sha: revision } }, { size_in_bytes: 65 * 1024 * 1024 }]) assert.throws(() => driver.bindInput(run, { ...artifact, ...change }, env));
  assert.equal(migration.TARGET, candidate.TARGET);
  assert.doesNotMatch(source, /35c9b066|d6b851e9|7f007549|c7885a1e|f562192c|2a809353|944eebfd|b6bf6f71/, 'No duplicated candidate or outgoing pins');
  assert.match(source, /candidate\.installer\(args\[0\]\)/); assert.match(source, /migration\.inspectInstalledResources\(path\.dirname\(hub\)\)/);
});
test('fixtures retain nondefault preferences and unknown fields; bootstrap requires genuine matching native review', () => {
  const f = fixture(), prefs = f.untouched.find(row => row.file.endsWith('hub-preferences.json'));
  assert.deepEqual(JSON.parse(prefs.bytes), { schemaVersion: 1, preview: false, autoDownload: false, restoreHostedViews: true });
  assert.doesNotMatch(prefs.bytes.toString(), /previewChannel/);
  assert.equal(f.config.auto_start, false); assert.equal(f.config.allow_all_tests, false); assert.equal(f.config.tool_groups, 'read');
  assert.equal(driver.initialConfig(f, 'current-legacy', 'C:\\Hub', path.win32).mcp_server_path, '');
  assert.equal(driver.initialConfig(f, 'legacy-only', 'C:\\Hub', path.win32).mcp_server_path, 'C:\\Hub\\modules\\mcp\\server\\creator-works-mcp.mjs');
  const original = encode({ ...f.config, mcp_server_path: 'C:\\verified\\server.mjs' });
  const review = { policy: 1, stores_retained: true, connections_reviewed: true, standalone_removal_accepted: false, retained_legacy_sha256: candidate.hash(original) };
  const verifiedServer = 'C:\\verified\\server.mjs';
  const current = driver.missingProjectFixture(original, original, review, verifiedServer);
  const merged = driver.mergedDocument(current, original);
  assert.equal(merged.channels.length, 2); assert.equal(merged.active_channel_id, f.config.active_channel_id);
  assert.deepEqual(merged.futurePreference, { keep: ['current-wins', false, 9] }); assert.equal(merged.tool_groups, 'none');
  assert.deepEqual(merged, { ...JSON.parse(current), channels: f.config.channels });
  for (const change of [{ stores_retained: false }, { connections_reviewed: false }, { standalone_removal_accepted: true }, { retained_legacy_sha256: '0'.repeat(64) }, { storesRetained: true }]) {
    assert.throws(() => driver.missingProjectFixture(original, original, { ...review, ...change }, verifiedServer));
  }
  assert.throws(() => driver.missingProjectFixture(current, original, review, verifiedServer));
  assert.throws(() => driver.missingProjectFixture(original, original, review, 'C:\\different\\server.mjs'));
  assert.ok(source.indexOf("await decision('bootstrap', true)") < source.indexOf('const review = read(f.review)'));
  assert.ok(source.indexOf('await close();\n      const next = missingProjectFixture') < source.indexOf("fs.openSync(f.current, 'r+')"));
  assert.match(source, /assert\.deepEqual\(read\(f\.review\), review\)/);
  assert.doesNotMatch(source, /(?:writeFileSync|openSync)\(f\.review|review_key\s*:|stores_retained\s*:/);
});
test('legacy review must finish its UI lease before either inspecting state or retrying after Cancel', () => {
  const doc = (busy, message) => ({ querySelector: () => ({ getAttribute: () => busy,
    querySelector: () => ({ textContent: message }) }) });
  const cancelled = 'Review returned without explicit approval. Originals are retained and the form stays locked.';
  assert.equal(driver.reviewSettled(true, doc('true', cancelled)), false, 'Message alone precedes finish_ui_operation');
  assert.equal(driver.reviewSettled(true, doc('false', 'Checking retained settings')), false);
  assert.equal(driver.reviewSettled(true, doc('false', cancelled)), true);
  assert.equal(driver.reviewSettled(false, doc('true', 'Checking retained settings')), false);
  assert.equal(driver.reviewSettled(false, doc('false', 'Review saved settings')), true);
  assert.equal(driver.reviewSettled(true, { querySelector: () => null }), false);
  assert.match(source, /await page\.waitForFunction\(reviewSettled, false\)/);
  const cancelledBranch = source.split("await decision('preserve', false);")[1].split("await decision('preserve', true)")[0];
  assert.ok(cancelledBranch.indexOf('await page.waitForFunction(reviewSettled, true)') < cancelledBranch.indexOf('await assertMcpControls(page, false)'));
  assert.match(cancelledBranch, /button\.isEnabled\(\), true/);
});
test('native config verification owns one workflow and finishes the exact lease without retrying failures', async () => {
  const config = { channels: [{ id: 'retained' }], tool_groups: 'none' };
  const fixture = failure => {
    const calls = []; let active = false;
    const page = { evaluate: fn => vm.runInNewContext(`(${fn.toString()})()`, {
      window: { CreatorHubNative: { invoke: async (outer, payload) => {
        assert.equal(outer, 'feature_call'); assert.equal(payload.feature, 'mcp');
        const { command, args } = payload; calls.push([command, JSON.parse(JSON.stringify(args))]);
        if (command === 'begin_ui_operation') {
          assert.equal(active, false); if (failure === command) throw Error(command);
          active = true; return 41;
        }
        if (command === 'load_config') {
          if (!active) throw Error('Start an owned UI workflow before changing MCP settings or projects.');
          if (failure === command) throw Error(command); return config;
        }
        assert.equal(command, 'finish_ui_operation'); assert.equal(active, true); assert.equal(args.id, 41);
        if (failure === command) throw Error(command); active = false; return null;
      } } },
    }) };
    return { calls, page };
  };
  const success = fixture(); assert.equal(await driver.loadMcpConfig(success.page), config);
  assert.deepEqual(success.calls, [['begin_ui_operation', {}], ['load_config', {}], ['finish_ui_operation', { id: 41 }]]);
  for (const failure of ['begin_ui_operation', 'load_config', 'finish_ui_operation']) {
    const f = fixture(failure); await assert.rejects(driver.loadMcpConfig(f.page), new RegExp(failure));
    assert.deepEqual(f.calls, failure === 'begin_ui_operation' ? [['begin_ui_operation', {}]] : success.calls);
  }
  const commands = text('modules/mcp/launcher/src-tauri/src/hosted_commands.rs');
  const exempt = commands.split('pub fn needs_workflow(')[1].split('macro_rules! args')[0];
  assert.ok(commands.split('pub fn needs_workflow(')[0].includes('"load_config"'));
  assert.match(exempt, /COMMANDS\.contains\(&command\)/); assert.doesNotMatch(exempt, /"load_config"/);
  assert.match(text('modules/mcp/launcher/src-tauri/src/service.rs'), /if changes && !self\.lifecycle\.has_workflow\(\)/);
  const controller = text('src/features/common.js').split('async run(')[1].split('dispose()')[0];
  assert.ok(controller.indexOf("await call('begin_ui_operation')") < controller.indexOf('await action();'));
  assert.ok(controller.indexOf('await action();') < controller.indexOf("await call('finish_ui_operation', { id: lease })"));
  assert.match(source, /const loaded = await loadMcpConfig\(page\)/);
  assert.doesNotMatch(source, /await feature\('load_config'\)/);
});
test('fieldset lock checks its disabled property and inherited child-control state before review and after Cancel', async () => {
  // Playwright treats disabled native inputs/buttons, not the FIELDSET itself, as disabled.
  const fixture = (disabled, childEnabled = !disabled) => ({ locator: selector => ({
    evaluate: fn => { assert.equal(selector, '#feature-mcp [data-field="controls"]'); return fn({ disabled }); },
    isEnabled: async () => {
      if (selector === '#feature-mcp [data-field="controls"]') return true;
      assert.ok(['project', 'check'].some(field => selector === `#feature-mcp [data-field="${field}"]`));
      return childEnabled;
    },
  }) });
  for (const enabled of [false, true]) {
    await driver.assertMcpControls(fixture(!enabled), enabled);
    await assert.rejects(driver.assertMcpControls(fixture(enabled), enabled));
    await assert.rejects(driver.assertMcpControls(fixture(!enabled, !enabled), enabled));
  }
  await assert.rejects(driver.assertMcpControls(fixture(undefined), false));
  assert.match(text('src/features/mcp.js'), /<fieldset data-field="controls" disabled/);
  assert.match(text('src/features/common.js'), /controls\.disabled = working \|\| !available \|\| poisoned \|\| locked/);
  assert.match(text('tests/direct-mcp-regressions.spec.js'), /toHaveJSProperty\('disabled', locked\)/);
  const legacy = source.split('const reviewLegacy = async cancelFirst => {')[1].split('await reviewLegacy(true)')[0];
  assert.equal((legacy.match(/await assertMcpControls\(page, false\)/g) || []).length, 2);
  assert.match(source, /await assertMcpControls\(page, true\)/);
});
function snapshot(kind, approve = true) {
  const [title, yes, no] = driver.DIALOGS[kind];
  return [{ title, class: '#32770', handle: 456, controls: [
    { id: 'ContentText', name: driver.confirmation(kind, fixture()), processId: 123 },
    { id: `CommandButton_${approve ? 1000 : 1001}`, name: approve ? yes : no, processId: 123 },
  ] }];
}
test('only exact fixture-native titles, disclosure, button ID, owner and one dialog are actionable', () => {
  for (const kind of Object.keys(driver.DIALOGS)) for (const approve of [false, true]) {
    const selected = driver.selectDialog(snapshot(kind, approve), 123, kind, approve, fixture());
    const command = driver.dialogCommand(123, 'C:\\Creator Hub\\creator-hub.exe', selected, kind, approve, fixture());
    assert.ok(command.endsWith(migration.DIALOG_ACTION)); assert.match(command, /\$expectedContent=/);
    for (const mutate of [rows => { rows[0].title = 'Other'; }, rows => { rows[0].class = 'Other'; },
      rows => { rows.push(rows[0]); }, rows => { rows[0].controls[0].name += 'changed'; },
      rows => { rows[0].controls[1].processId = 999; }, rows => { rows[0].controls[1].id = 'CommandButton_1234'; },
      rows => { rows[0].controls.push(rows[0].controls[1]); }, rows => { rows[0].handle = 0; }]) {
      const rows = snapshot(kind, approve); mutate(rows); assert.throws(() => driver.selectDialog(rows, 123, kind, approve, fixture()));
    }
    assert.throws(() => driver.dialogCommand(123, 'relative.exe', selected, kind, approve, fixture()));
    assert.throws(() => driver.dialogCommand(123, 'C:\\Hub.exe', { ...selected, content: 'unchecked' }, kind, approve, fixture()));
  }
});
function rustString(file, prefix) {
  const strings = [...text(file).matchAll(/"(?:\\.|[^"\\])*"/g)].flatMap(match => { try { return [JSON.parse(match[0])]; } catch { return []; } });
  const found = strings.filter(value => value.startsWith(prefix)); assert.equal(found.length, 1, prefix); return found[0];
}
test('native confirmation text and current product/UI semantics match the finite cases', () => {
  const c = 'src-tauri/src/convergence.rs', p = 'modules/mcp/launcher/src-tauri/src/product_settings.rs';
  const summary = rustString(c, '{} missing project(s);').replace('{}', '0').replace('{}', '0');
  const bootstrap = rustString('modules/mcp/launcher/src-tauri/src/service.rs', 'Move your existing setup to this Creator Hub?').replace('{native_summary}', summary);
  assert.equal(driver.confirmation('bootstrap', fixture()), bootstrap);
  const proposal = rustString(c, '\n\nMissing projects to import:').replace('{}', '1').replace('{}', '1');
  assert.equal(driver.confirmation('import', fixture()), rustString(c, 'Import saved MCP projects into your current settings?').replace('{import_message}', proposal));
  assert.equal(driver.confirmation('preserve', fixture()), rustString(p, 'Keep exact local backups of these MCP settings?').replace('{}', fixture().current).replace('{}', fixture().legacy));
  const convergence = text(c), ui = text('src/convergence.js'), mcp = text('src/features/mcp.js');
  assert.match(text(p), /if !previous\.is_empty\(\) && !recognized\(Path::new\(previous\)\)\?/,
    'An empty bootstrap server must not require an additional custom-server decision');
  assert.match(convergence, /saved\.retained_legacy_sha256 == legacy_image_hash\(snapshots\)/);
  assert.match(convergence, /pending \|\| apps != 0 \|\| \(settings != 0 && !reviewed\)/);
  assert.match(convergence, /let settings_only = !plan\.report\.required && import\.is_some\(\)/);
  for (const label of ['Import saved MCP projects', 'Back up and import projects', 'Keep existing']) assert.ok(convergence.includes(`"${label}"`));
  for (const label of ['Preserve MCP product settings', 'Keep backups', 'Keep unchanged']) assert.ok(text(p).includes(`"${label}"`));
  assert.match(ui, /current\?\.required === false && current\.settingsImportAvailable/);
  for (const label of ['Saved MCP projects imported', 'Continue in Hub', 'Back up and import projects']) assert.ok(ui.includes(`'${label}'`));
  assert.match(ui, /void change\('prepare_convergence', 'review', 'backed-up'\)/);
  assert.match(ui, /connections\.hidden = retire\.hidden = true/);
  assert.match(mcp, /let productReviewed = false/); assert.match(mcp, /report\.approved !== true/);
  assert.match(mcp, /\['legacy-only', 'conflict'\]\.includes\(report\.status\)/);
  for (const field of ['controls', 'status', 'product-status', 'project', 'groups', 'server', 'follow', 'scripts', 'tests']) assert.ok(mcp.includes(`data-field="${field}"`));
  assert.ok(mcp.includes('aria-label="Saved MCP settings review"')); assert.ok(mcp.includes('Review returned without explicit approval'));
  const builtinLoad = text('modules/mcp/launcher/src-tauri/src/lib.rs').split('fn load_builtin_config(')[1].split('/// Save configuration')[0];
  assert.match(builtinLoad, /hosted::config_snapshot\(current, legacy\)/); assert.doesNotMatch(builtinLoad, /atomic_write|save_config/);
  const menu = text('scripts/windows-incoming-016.cjs').split('async function showPage(')[1].split('function assertOwnedDebugging')[0];
  assert.ok(menu.includes("name: 'Open menu'")); assert.ok(menu.includes("name: 'Creator tools'"));
  assert.match(menu, /mcp: \/\^MCP/); assert.match(menu, /hub: \/\^Home/);
  const close = text('scripts/native-window.ps1');
  const localReceipt = path.join(root, 'artifacts/menu-merge-20261027/settings-build-v4/build-receipt.json');
  if (fs.existsSync(localReceipt)) assert.ok(close.includes(JSON.parse(fs.readFileSync(localReceipt)).title));
  assert.match(source, /assert\.equal\(requiredFalse\.required, false\)/);
  assert.match(source, /assert\.equal\(initialStatus\.settingsImportAvailable, false\)/);
  assert.match(source, /await reviewLegacy\(false\)/); assert.match(source, /fs\.existsSync\(f\.current\), current !== null/);
  assert.match(source, /assert\.deepEqual\(backupState\(\), beforeCancel\)/);
  assert.match(source, /ProcessId: child\.pid, ParentProcessId: process\.pid, ExecutablePath: hub/);
});
test('review serde, unchanged review after import, and verified-runtime restart fallback are distinct source contracts', () => {
  const convergence = text('src-tauri/src/convergence.rs');
  const record = convergence.split('struct ReviewRecord {')[1].split('\n}')[0];
  assert.deepEqual([...record.matchAll(/^    ([a-z_][a-z0-9_]*):/gm)].map(match => match[1]),
    ['policy', 'stores_retained', 'connections_reviewed', 'standalone_removal_accepted', 'retained_legacy_sha256']);
  assert.match(convergence, /#\[serde\(deny_unknown_fields\)\]\s+struct ReviewRecord/);
  assert.match(convergence, /manager::child_dir\("convergence"\)\?\.join\("review-v1\.json"\)/);
  const prepare = convergence.split('pub async fn prepare_convergence(')[1].split('const CLIENTS:')[0];
  const imported = convergence.split('fn import_reviewed_projects(')[1].split('fn resume_project_import(')[0];
  assert.doesNotMatch(prepare + imported, /save_review_at|record_path|move_to_hub/);
  assert.match(imported, /plan\.stores = renewed;/); assert.match(imported, /plan\.report = original_report;/);
  assert.match(imported, /fresh\.bytes\(\) != Some\(import\.bytes\.as_slice\(\)\)/);
  const inspect = convergence.split('fn inspect()')[1].split('fn prompt_review_key(')[0];
  for (const fragment of ['legacy_apps.is_empty()', '!pending_retirement', 'snapshots[0].bytes().is_some()',
    'store.resolve()', 'settings_use_verified_runtime(&snapshots, &runtime.server)', 'already_reviewed || already_using_hub']) assert.ok(inspect.includes(fragment), fragment);
  const verified = convergence.split('fn settings_use_verified_runtime(')[1].split('fn migration_required(')[0];
  assert.match(verified, /if settings_need_review\(snapshots\) \{\s+return false;/);
  assert.match(verified, /configured\.is_absolute\(\) && configured == verified_server/);
  const recovery = convergence.split('fn restore_settings_import_recovery(')[1].split('#[derive(Default)]')[0];
  assert.ok(recovery.includes('if !report.completed && !report.historical_completed'));
  assert.ok(source.includes("path.join(route.payload, 'mcp/server/creator-works-mcp.mjs')"));
  assert.ok(source.includes("save('restart-status.json', again)"));
  const prefs = text('src-tauri/src/preferences.rs').split('struct Record {')[1].split('\n}')[0];
  assert.match(prefs, /preview: Option<bool>/); assert.doesNotMatch(prefs, /preview_channel/);
});
test('startup and bootstrap route consent precede feature work; legacy review neither activates a route nor copies settings', () => {
  const app = text('src/app.js'), convergence = text('src-tauri/src/convergence.rs');
  assert.ok(app.includes('window.CreatorUsageTerms.requireAcceptance().then(beginStartup)'));
  assert.ok(app.indexOf('await loadPreferences();') < app.indexOf('await window.CreatorConvergence?.run();'));
  assert.ok(app.includes("byId('check-updates').disabled = busy || featureBusy || startupRunning"));
  const metadata = text('src-tauri/src/features.rs').split('pub fn feature_status()')[1].split('#[tauri::command]')[0];
  assert.doesNotMatch(metadata, /initialize_mcp|usage_terms|Manager|managed_route/);
  const move = convergence.split('pub async fn move_to_hub(')[1].split('fn cleanup_failure(')[0];
  const ordering = ['review.approve(&handle, &summary)', 'route.activate_convergence(&consent)',
    'service::initialize(&handle, server_root)', 'service::bind_managed_route(&handle)',
    'service::apply_convergence(&handle, approved)', 'refresh_reviewed_server_paths(plan, &base, &server, transition)',
    'save_review_at(&record_path()?, &plan.stores)', 'retire_batch_apps(plan, &installations'];
  for (let i = 0; i < ordering.length; i++) {
    assert.ok(move.includes(ordering[i]), ordering[i]);
    if (i) assert.ok(move.indexOf(ordering[i - 1]) < move.indexOf(ordering[i]), ordering[i]);
  }
  const route = text('src-tauri/src/builtin.rs').split('pub(crate) fn activate_convergence(')[1].split('pub(crate) fn convergence_route_review(')[0];
  assert.ok(route.includes('consent.authorize_route(&self.key())?;')); assert.ok(route.includes('self.activate()'));
  assert.doesNotMatch(route, /\.dialog\(/, 'Batch consent covers its own signed route; no extra guessed prompt');
  const needs = text('modules/mcp/launcher/src-tauri/src/service.rs').split('pub fn needs_managed_route(')[1].split('fn require_managed_route(')[0];
  for (const command of ['review_product_settings', 'product_settings_status', 'load_config', 'begin_ui_operation', 'finish_ui_operation']) assert.ok(!needs.includes(`"${command}"`));
  const product = text('modules/mcp/launcher/src-tauri/src/product_settings.rs');
  const backup = product.split('fn review_with(')[1].split('fn preserve(')[0];
  assert.match(backup, /if approved \{\s+preserve\(paths, &saved\)\?;/);
  const preserve = product.split('fn preserve(')[1].split('#[cfg(test)]')[0];
  assert.ok(preserve.includes('storage::retain_image(path, before)?;'));
  assert.doesNotMatch(preserve, /atomic_write|save_config|fs::write/);
  const mcp = text('src/features/mcp.js').split('async function reviewProductSettings()')[1].split("page.on($('product-review')")[0];
  assert.ok(mcp.indexOf('if (report.approved !== true)') < mcp.indexOf('await reload();'));
  assert.match(mcp, /\['none', 'current', 'identical'\]\.includes\(report\.status\)/);
  const run = text('src/features/common.js').split('async run(')[1].split('dispose()')[0];
  assert.ok(run.indexOf('await action();') < run.indexOf("await call('finish_ui_operation'"));
  assert.ok(run.indexOf("await call('finish_ui_operation'") < run.indexOf('working = false; update();'));
});
function receipt(caseName) {
  const { run, artifact, env } = inputMetadata();
  return { scope: 'exact-candidate-two-settings-cases', case: caseName, harnessSource: revision, ...candidate.productProvenance(),
    installerSha256: candidate.TARGET.installer, executableSha256: candidate.TARGET.exe, inputBinding: driver.bindInput(run, artifact, env),
    passed: true, nativeCaseAccepted: true, cancelPreserved: true, backupsVerified: true, settingsVerified: true,
    manualNormalRestartAccepted: true, policyRestored: true, installedResourcesVerified: true,
    requiredFalseObserved: caseName === 'current-legacy', bootstrapAccepted: caseName === 'current-legacy', legacyOnlyNoCopy: caseName === 'legacy-only',
    releaseReady: false, signedUpdateAccepted: false, signedAutomaticRestartAccepted: false, migrationAccepted: false,
    liveAiAppAccepted: false, userMachineUsed: false, ambiguousJsonAccepted: false,
    nativeDecisions: (caseName === 'current-legacy' ? [['bootstrap', true], ['import', false], ['import', true]] : [['preserve', false], ['preserve', true], ['preserve', true]])
      .map(([kind, approve]) => ({ kind, approve })),
    normalCloses: Array.from({ length: caseName === 'current-legacy' ? 3 : 2 }, (_, i) => ({ pid: 100 + i, exitCode: 0 })) };
}
test('receipts require both case-specific native decisions, byte checks and distinct normal restarts without wider acceptance', () => {
  for (const caseName of driver.CASES) {
    const report = receipt(caseName); driver.checkReceipt(report, caseName, revision);
    for (const [key, value] of Object.entries(report).filter(([, value]) => typeof value === 'boolean')) assert.throws(() => driver.checkReceipt({ ...report, [key]: !value }, caseName, revision), key);
    for (const change of [{ installerSha256: '0'.repeat(64) }, { harnessSource: 'b'.repeat(40) }, { nativeDecisions: [] },
      { normalCloses: report.normalCloses.map(row => ({ ...row, pid: 123 })) }]) assert.throws(() => driver.checkReceipt({ ...report, ...change }, caseName, revision));
  }
});
test('workflow is manual, two-job, read-only and candidate-pinned, with serialized preflight before native execution', () => {
  assert.match(workflow, /workflow_dispatch:/); assert.match(workflow, /case: \[current-legacy, legacy-only\]/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/validation\/windows-menu-merge-20261027'/);
  assert.match(workflow, /contents: read\s+actions: read/); assert.doesNotMatch(workflow, /: write|gh release|cargo |npm run build|sign-reviewed/);
  assert.ok(workflow.includes('node --test --test-concurrency=1 scripts/native-windows-016-settings-only.test.cjs'));
  assert.ok(workflow.indexOf('node --test') < workflow.indexOf('actions/download-artifact'));
  assert.ok(workflow.indexOf('inspect-installer') < workflow.indexOf('Native isolated settings case'));
  const inputs = workflow.split('    inputs:')[1].split('permissions:')[0];
  assert.doesNotMatch(inputs, /default:|40431905266|12702061918|9ed19a0a/);
  assert.deepEqual([...inputs.matchAll(/^      ([a-z_][a-z0-9_]*):$/gm)].map(match => match[1]), ['artifact_run', 'artifact_id', 'archive_sha256']);
  assert.equal((inputs.match(/required: true/g) || []).length, 3);
  assert.match(workflow, /native-suite-\*\/\*\.json/); assert.match(workflow, /\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /receipt \$reports\[0\]\.FullName/);
});
test('all native dialog programs, shared helpers and workflow shell blocks parse without executing them', { skip: process.platform !== 'win32' }, () => {
  const programs = [migration.PROCESSES, migration.REGISTRATIONS];
  for (const kind of Object.keys(driver.DIALOGS)) for (const approve of [false, true]) {
    const selected = driver.selectDialog(snapshot(kind, approve), 123, kind, approve, fixture());
    programs.push(driver.dialogCommand(123, 'C:\\Creator Hub\\creator-hub.exe', selected, kind, approve, fixture()));
  }
  const runs = [...workflow.matchAll(/^        run: \|\r?\n((?:          .*\r?\n|\r?\n)+)/gm)].map(match => match[1].replace(/^          /gm, '').replace(/\$\{\{[^}]+\}\}/g, 'PARSE_ONLY'));
  assert.equal(runs.length, 3); programs.push(...runs);
  for (const name of ['native-window.ps1', 'native-webview-policy.ps1', 'native-startup-diagnostics.ps1']) programs.push(text(`scripts/${name}`));
  const payload = Buffer.from(JSON.stringify(programs)).toString('base64');
  const parser = `$ErrorActionPreference='Stop';$programs=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json;foreach($source in $programs){$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors);if($errors.Count){throw ($errors|Out-String)}};'PARSED_ONLY'`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'],
    { input: parser, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /PARSED_ONLY/);
});
