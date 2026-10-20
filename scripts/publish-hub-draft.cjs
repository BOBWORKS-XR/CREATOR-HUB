const { checkDraft, checkLive, RELEASE_NOT_VISIBLE } = require('./check-release-feed.cjs');
const { setTimeout: wait } = require('node:timers/promises');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { checkSources, assertReleaseReady } = require('./check-unified-sources.cjs');
const { verifyRemote } = require('./windows-release-qualification.cjs');
const { parseArgs } = require('node:util');
const { selectBaseline } = require('./self-update-baselines.cjs');

function checkReadiness(version, options) {
  const root = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'modules/suite.json'), 'utf8'));
  checkSources(root, manifest);
  return assertReleaseReady(manifest, { version, platform: options.platform, receiptPath: options.receipt,
    ...(options.platform === 'linux-x86_64' ? { sha256: options.sha256 } : {}) });
}

async function publishDraft(version, actions = {}, options = {}) {
  if (options.platform === 'linux-x86_64') {
    if (version !== '0.1.16') throw Error('Only Linux 0.1.16 has a finite publication route.');
    return require('./publish-linux-016-hub-draft.cjs').publish(options, actions);
  }
  const qualification = await (actions.checkReadiness || checkReadiness)(version, options);
  await (actions.verifyQualification || verifyRemote)(qualification);
  const inspectDraft = actions.checkDraft || checkDraft;
  const inspectLive = actions.checkLive || checkLive;
  const publish = actions.publish || (() => (actions.execute || execFileSync)('gh', ['api', '--method', 'PATCH',
    `repos/BOBWORKS-XR/CREATOR-HUB/releases/${qualification.draft.id}`, '-f', `tag_name=v${version}`, '-F', 'draft=false', '-f', 'make_latest=false'],
  { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true }));
  const preflight = await inspectDraft(version);
  if (preflight.previousStable !== selectBaseline('0.1.14').version) throw Error('Public previous stable differs from the qualified native incoming baseline.');
  await publish(`v${version}`);
  // Public feeds can expose this version immediately, even before marking it latest.
  // Do not claim readiness until real old-client update/restart acceptance passes.
  let live;
  for (let attempt = 1; attempt <= 30; attempt++) {
    try { live = await inspectLive(version); break; }
    catch (error) {
      if (error?.code !== RELEASE_NOT_VISIBLE || attempt === 30) throw error;
      await (actions.wait || wait)(2000);
    }
  }
  return { preflight, live, ready: false, next: 'Run Public Hub self-update acceptance for this exact release before promoting latest or announcing readiness.' };
}
module.exports = { publishDraft, checkReadiness };
if (require.main === module) {
  (async () => {
    const { values, positionals } = parseArgs({ options: { receipt: { type: 'string' }, platform: { type: 'string' },
      sha256: { type: 'string' }, intent: { type: 'string' } }, allowPositionals: true });
    if (values.platform !== 'linux-x86_64' && (values.sha256 !== undefined || values.intent !== undefined)) throw Error('Linux publication options require linux-x86_64.');
    if (positionals.length !== 1) throw Error('Usage: publish-hub-draft.cjs VERSION --platform windows-x86_64 --receipt REVIEWED-QUALIFICATION');
    return publishDraft(positionals[0], {}, values);
  })().then(result => console.log(JSON.stringify(result)), error => {
    console.error(error.message);
    console.error('Release readiness is blocked. Inspect the draft/public state before any retry.');
    process.exitCode = 1;
  });
}
