const assert=require('node:assert/strict'),path=require('node:path');
const target=require('./public-update-023.cjs'),direct=require('./native-outgoing-direct-019.cjs');
const hash=target.hash,binding=target.binding;
function checkMigrationReceipt(report) {
  const { profile, clients, clientReview } = report;
  assert.deepEqual(Object.keys(profile || {}).sort(), ['home', 'local', 'roaming'], 'Explicit captured profile required');
  for (const folder of Object.values(profile)) {
    assert.ok(path.win32.isAbsolute(folder || ''), 'Absolute Windows profile roots required');
    assert.ok(!folder.split(/[\\/]/).includes('..'), 'Ambiguous profile root refused');
  }
  const oldRoute = target.managedLocations(profile.local, '0.1.22', profile.home);
  const newRoute = target.managedLocations(profile.local, '0.1.23', profile.home);
  const selectedPath = path.join(profile.home, '.claude.json');
  const oldClientPath = path.join(profile.home, '.gemini/config/mcp_config.json');
  const currentSettingsPath = path.join(profile.roaming, 'creator-works-mcp/launcher-config.json');
  const oldSettingsPath = path.join(profile.roaming, 'banter-mcp/launcher-config.json');
  const captures = path.dirname(clients?.selectedBefore?.capture || '');
  assert.equal(path.dirname(captures), path.resolve(__dirname, '../artifacts'), 'Owned driver capture directory required');
  assert.match(path.basename(captures), /^native-suite-[0-9]+$/);
  const readCapture = (receipt, file, name) => {
    assert.deepEqual(Object.keys(receipt || {}).sort(), ['bytes', 'capture', 'file', 'sha256']);
    assert.equal(receipt.file, file); assert.equal(receipt.capture, path.join(captures, name));
    const bytes = direct.readEvidence(receipt.capture);
    assert.equal(receipt.bytes, bytes.length); assert.equal(receipt.sha256, hash(bytes));
    return bytes;
  };
  const selectedBefore = readCapture(clients.selectedBefore, selectedPath, 'claude-before.json');
  const oldBefore = readCapture(clients.oldBefore, oldClientPath, 'old-client-before.json');
  for (const [key, selectedName, oldName] of [
    ['afterUpdateCancel', 'claude-update-cancel.json', 'old-client-update-cancel.json'],
    ['afterReviewCancel', 'claude-review-cancel.json', 'old-client-review-cancel.json'],
  ]) {
    assert.ok(readCapture(clients[key]?.selected, selectedPath, selectedName).equals(selectedBefore), `${key}: selected client changed`);
    assert.ok(readCapture(clients[key]?.old, oldClientPath, oldName).equals(oldBefore), `${key}: unselected client changed`);
  }
  const selectedAfter = readCapture(clients.selectedAfter, selectedPath, 'claude-after.json');
  const oldAfter = readCapture(clients.oldAfter, oldClientPath, 'old-client-after.json');
  direct.assertClientBytes({ selectedPath, oldClientPath, selectedBefore: selectedAfter, oldClientBefore: oldBefore });
  const currentBefore = readCapture(clients.currentSettingsBefore, currentSettingsPath, 'settings-before.json');
  const currentAfter = readCapture(clients.currentSettingsAfter, currentSettingsPath, 'settings-after.json');
  const legacyBefore = readCapture(clients.oldSettingsBefore, oldSettingsPath, 'old-settings-before.json');
  const legacyAfter = readCapture(clients.oldSettingsAfter, oldSettingsPath, 'old-settings-after.json');
  for (const [file, before, after] of [[currentSettingsPath, currentBefore, currentAfter], [oldSettingsPath, legacyBefore, legacyAfter]]) {
    assert.ok(before.equals(after), 'Original settings changed');
    assert.ok(direct.readEvidence(file).equals(before), 'Original settings changed after capture');
  }
  assert.deepEqual(report.manualCapabilityRetention,
    require('./sdk-retention-023.cjs').verify(report.lastTool, report.restore, currentAfter, legacyAfter));
  const review = direct.reviewedSettings(currentSettingsPath, newRoute.base);
  assert.deepEqual(report.settingsReview, { source: review.source, path: review.path });
  assert.deepEqual(report.settingsView, direct.assertSettingsView(review));
  assert.equal(typeof report.settingsViewExistedBeforeReview, 'boolean');
  if (report.settingsViewExistedBeforeReview) {
    assert.ok(readCapture(report.settingsViewBefore, review.path, 'settings-view-before.json').equals(direct.readEvidence(review.path)),
      'Existing settings view changed');
  } else assert.equal(report.settingsViewBefore, undefined);
  assert.deepEqual(Object.keys(clientReview || {}).sort(), ['approved', 'cancelled', 'evidence']);
  assert.deepEqual(clientReview.cancelled, { status: 'cancelled', count: 0 });
  direct.assertReviewedClientMigration({ before: JSON.parse(selectedBefore), after: JSON.parse(selectedAfter),
    oldClientBefore: oldBefore, oldClientAfter: oldAfter, oldCommand: oldRoute.command, newCommand: newRoute.command,
    settingsPath: review.path, approved: clientReview.approved?.status === 'migrated' && clientReview.approved?.count === 1 });
  const oldEntry = JSON.parse(oldBefore).mcpServers['creator-works'];
  assert.equal(oldEntry.command, oldRoute.command); assert.deepEqual(oldEntry.args, []);
  assert.equal(oldEntry.env.CREATOR_WORKS_CONFIG_OWNER, 'creator-hub-v1');
  assert.equal(oldEntry.env.CREATOR_WORKS_LAUNCHER_CONFIG, oldSettingsPath);
  assert.deepEqual(clientReview.evidence, direct.assertMigrationEvidence({ result: clientReview.approved,
    local: profile.local, selectedPath, before: selectedBefore, after: selectedAfter }));
  target.assertActiveResources(profile.local, '0.1.22', report.beforeRoute, true, profile.home);
  target.assertActiveResources(profile.local, '0.1.23', report.afterRoute, true, profile.home);
  target.assertInstalledResources(path.join(profile.local, 'Creator Hub'), '0.1.23');
  target.assertFreshConnection(report.heldProcessesBefore, report.reconnectedProcesses, profile);
  target.assertFreshConnection(report.freshOldProcesses, report.reconnectedProcesses, profile);
  assert.equal(new Set([...report.heldProcessesBefore, ...report.freshOldProcesses, ...report.reconnectedProcesses]
    .map(row => row.pid)).size, 6, 'Fresh old-client connection must be distinct');
  assert.equal(report.freshOldServerVersion.version, binding.baseline.manifest.modules.mcp.version);
}

module.exports={checkMigrationReceipt};
