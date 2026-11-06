const { checkDraft, checkLive, RELEASE_NOT_VISIBLE } = require('./check-release-feed.cjs');
const { setTimeout: wait } = require('node:timers/promises');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { checkSources, assertReleaseReady } = require('./check-unified-sources.cjs');
const { verifyRemote } = require('./windows-release-qualification.cjs');
const { parseArgs } = require('node:util');
const { selectBaseline } = require('./self-update-baselines.cjs');
const WINDOWS_VERSION = require('./windows-release-target.cjs').getTarget().version;
const isFinalWindows = (version, platform) => platform === 'windows-x86_64' && [WINDOWS_VERSION, '0.1.20', '0.1.21'].includes(version);
const finalVerifier = version => version === '0.1.21' ? require('./windows-021-release-qualification.cjs')
  : version === '0.1.20' ? require('./windows-020-release-qualification.cjs') : require('./windows-016-release-qualification.cjs');

async function finishPublicRelease(version, actions = {}, options = {}) {
  if (!isFinalWindows(version, options.platform)) throw Error('Public acceptance applies only to a qualified Windows release.');
  const qualification = await (actions.checkReadiness || checkReadiness)(version, options);
  const verified = await (actions.verifyPublishedQualification || finalVerifier(version).verifyPublishedRemote)(qualification);
  if (!verified || verified.releaseIsPublic !== true || verified.sourceCiVerified !== true || verified.nativeEvidenceVerified !== true
    || verified.signaturesVerified !== true || verified.releaseAssociationVerified !== true || verified.associationBuilt !== false
    || verified.releaseAssociationCommit !== options.association || verified.qualificationSha256 !== options.sha256
    || verified.draftId !== qualification.draft.id || verified.version !== version || verified.platform !== options.platform) {
    throw Error('Exact published qualification is required before public acceptance or promotion.');
  }
  const publicReader = version === '0.1.21' ? './windows-021-public-acceptance.cjs'
    : version === '0.1.20' ? './windows-020-public-acceptance.cjs'
    : version === '0.1.19' ? './windows-019-public-acceptance.cjs' : './windows-018-public-acceptance.cjs';
  const accepted = await (actions.verifyPublicAcceptance || require(publicReader).verify)(qualification, options);
  if (!accepted || accepted.publicAcceptance !== true || accepted.version !== version || accepted.releaseId !== qualification.draft.id
    || accepted.association !== options.association || accepted.qualificationSha256 !== options.sha256) {
    throw Error('Exact successful public self-update evidence is required before promotion.');
  }
  const inspectLive = actions.checkLive || checkLive;
  const live = await inspectLive(version);
  if (live.previousStable !== selectBaseline(version).version) throw Error('Public baseline drifted before promotion.');
  if (!options.promoteLatest) return { publicAcceptance: accepted, live, ready: false, next: 'Review this public acceptance, then use the guarded promote-latest mode.' };
  const getLatest = actions.getLatest || (() => JSON.parse(execFileSync('gh', ['api', 'repos/BOBWORKS-XR/CREATOR-HUB/releases/latest'],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true })));
  const before = await getLatest();
  if (!before || before.draft !== false || before.prerelease !== false || !Number.isSafeInteger(before.id)) throw Error('Current latest release is invalid.');
  const latestVersion = require('semver').valid(String(before.tag_name).replace(/^v/, ''));
  if (!latestVersion || require('semver').gt(latestVersion, version)) throw Error('Do not replace a newer public latest release.');
  if (before.id !== qualification.draft.id) {
    const rechecked = await getLatest();
    if (rechecked.id !== before.id || rechecked.tag_name !== before.tag_name) throw Error('Latest changed during review; stop before writing.');
    await (actions.promote || (() => (actions.execute || execFileSync)('gh', ['api', '--method', 'PATCH',
      `repos/BOBWORKS-XR/CREATOR-HUB/releases/${qualification.draft.id}`, '-f', 'make_latest=true'],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true })))();
  }
  const after = await getLatest();
  if (after.id !== qualification.draft.id || after.tag_name !== `v${version}` || after.draft !== false || after.prerelease !== false) {
    throw Error('Latest promotion readback differs; inspect remotely before any retry.');
  }
  await inspectLive(version);
  return { version, releaseId: after.id, publicAcceptance: accepted, latestVerified: true, ready: true };
}

function checkReadiness(version, options) {
  const root = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'modules/suite.json'), 'utf8'));
  checkSources(root, manifest);
  return assertReleaseReady(manifest, { version, platform: options.platform, receiptPath: options.receipt,
    ...(options.platform === 'linux-x86_64' || isFinalWindows(version, options.platform) ? { sha256: options.sha256 } : {}),
    ...(isFinalWindows(version, options.platform) ? { association: options.association } : {}) });
}

async function publishDraft(version, actions = {}, options = {}) {
  if (options.platform === 'linux-x86_64') {
    if (version !== '0.1.16') throw Error('Only Linux 0.1.16 has a finite publication route.');
    return require('./publish-linux-016-hub-draft.cjs').publish(options, actions);
  }
  if (options.platform === 'windows-x86_64' && ['0.1.16', '0.1.17'].includes(version)) {
    throw Error(`Windows ${version} qualification blocked: superseded by monotonic ${WINDOWS_VERSION}.`);
  }
  const qualification = await (actions.checkReadiness || checkReadiness)(version, options);
  const finalCandidate = isFinalWindows(version, options.platform);
  const verifier = finalCandidate
    ? finalVerifier(version).verifyRemote : verifyRemote;
  const verified = await (actions.verifyQualification || verifier)(qualification);
  if (finalCandidate && (!verified || verified.productionApproval !== true || verified.sourceCiVerified !== true || verified.nativeEvidenceVerified !== true
    || verified.signaturesVerified !== true || verified.publicAcceptance !== false || verified.releaseReady !== false
    || verified.releaseAssociationVerified !== true || verified.associationBuilt !== false
    || verified.releaseAssociationCommit !== options.association
    || verified.version !== version || verified.platform !== options.platform || verified.qualificationSha256 !== options.sha256
    || !Number.isSafeInteger(verified.draftId) || verified.draftId <= 0 || verified.draftId !== qualification.draft.id)) {
    throw Error(`Exact ${version} qualification did not authorize this draft publication.`);
  }
  const draftId = finalCandidate ? verified.draftId : qualification?.draft?.id;
  const inspectDraft = actions.checkDraft || checkDraft;
  const inspectLive = actions.checkLive || checkLive;
  const publish = actions.publish || (() => (actions.execute || execFileSync)('gh', ['api', '--method', 'PATCH',
    `repos/BOBWORKS-XR/CREATOR-HUB/releases/${draftId}`, '-f', `tag_name=v${version}`, '-F', 'draft=false', '-f', 'make_latest=false'],
  { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true }));
  const preflight = await inspectDraft(version);
  const baselineVersion = finalCandidate ? version : '0.1.14';
  if (preflight.previousStable !== selectBaseline(baselineVersion).version) throw Error('Public previous stable differs from the qualified native incoming baseline.');
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
module.exports = { publishDraft, checkReadiness, finishPublicRelease };
if (require.main === module) {
  (async () => {
    const { values, positionals } = parseArgs({ options: { receipt: { type: 'string' }, platform: { type: 'string' },
      sha256: { type: 'string' }, association: { type: 'string' }, intent: { type: 'string' },
      'verify-public': { type: 'boolean' }, 'promote-latest': { type: 'boolean' },
      'public-run': { type: 'string' }, 'public-artifact-sha256': { type: 'string' },
      'public-review': { type: 'string' }, 'public-review-sha256': { type: 'string' } }, allowPositionals: true });
    const publicMode = values['verify-public'] || values['promote-latest'];
    if (values['verify-public'] && values['promote-latest']) throw Error('Choose one public acceptance mode.');
    if (publicMode) {
      if (positionals.length !== 1) throw Error('One exact release version is required.');
      return finishPublicRelease(positionals[0], {}, { ...values, promoteLatest: Boolean(values['promote-latest']),
        publicRun: values['public-run'], publicArtifactSha256: values['public-artifact-sha256'],
        publicReview: values['public-review'], publicReviewSha256: values['public-review-sha256'] });
    }
    if (['public-run', 'public-artifact-sha256', 'public-review', 'public-review-sha256'].some(k => values[k] !== undefined)) throw Error('Public evidence options require an explicit public acceptance mode.');
    if (values.platform !== 'linux-x86_64' && values.intent !== undefined) throw Error('Linux publication options require linux-x86_64.');
    if (values.platform !== 'linux-x86_64' && values.sha256 !== undefined && !isFinalWindows(positionals[0], values.platform)) throw Error('Linux publication options require linux-x86_64.');
    if (values.association !== undefined && !isFinalWindows(positionals[0], values.platform)) throw Error('Association applies only to qualified Windows releases.');
    if (positionals.length !== 1) throw Error('Usage: publish-hub-draft.cjs VERSION --platform windows-x86_64 --receipt REVIEWED-QUALIFICATION');
    return publishDraft(positionals[0], {}, values);
  })().then(result => console.log(JSON.stringify(result)), error => {
    console.error(error.message);
    console.error('Release readiness is blocked. Inspect the draft/public state before any retry.');
    process.exitCode = 1;
  });
}
