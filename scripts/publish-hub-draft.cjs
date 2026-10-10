const { checkDraft, checkLive } = require('./check-release-feed.cjs');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { checkSources, assertReleaseReady } = require('./check-unified-sources.cjs');

function checkReadiness() {
  const root = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'modules/suite.json'), 'utf8'));
  checkSources(root, manifest);
  assertReleaseReady(manifest);
}

async function publishDraft(version, actions = {}) {
  await (actions.checkReadiness || checkReadiness)();
  const inspectDraft = actions.checkDraft || checkDraft;
  const inspectLive = actions.checkLive || checkLive;
  const publish = actions.publish || (tag => execFileSync('gh', ['release', 'edit', tag,
    '--repo', 'BOBWORKS-XR/CREATOR-HUB', '--draft=false', '--latest=false'],
  { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true }));
  const preflight = await inspectDraft(version);
  await publish(`v${version}`);
  // Public feeds can expose this version immediately, even before marking it latest.
  // Do not claim readiness until real old-client update/restart acceptance passes.
  const live = await inspectLive(version);
  return { preflight, live, ready: false, next: 'Run Public Hub self-update acceptance for this exact release before promoting latest or announcing readiness.' };
}
module.exports = { publishDraft };
if (require.main === module) publishDraft(process.argv[2]).then(result => console.log(JSON.stringify(result)), error => {
  console.error(error.message);
  console.error('Release readiness is blocked. Inspect the draft/public state before any retry.');
  process.exitCode = 1;
});
