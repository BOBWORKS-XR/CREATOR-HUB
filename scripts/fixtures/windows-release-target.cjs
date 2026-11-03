'use strict';
// Synthetic unit-test metadata only. Never loaded by a release CLI or used as evidence.
const profile = require('../windows-release-target.cjs');
const fixture = Object.freeze({ ...profile.getTarget(),
  source: Object.freeze({ commit: '7'.repeat(40), tree: '8'.repeat(40) }), parent: '9'.repeat(40),
  rootBuild: null, rawProducer: 'local-r7-build',
  successorEvidence: null, localRestart: null,
  splitNativeRoles: false, productionLanes: null,
  sourceCi: Object.freeze({ runId: 41705099186, runAttempt: 2, jobId: 126159652422,
    harnessCommit: 'b95de7a80bb1e5deed1658188b362a3c69cd48aa', harnessTree: '96f91b81f6abd594045922569305bc7d32c74457',
    workflow: '.github/workflows/windows-final-mcp-tests.yml', workflowBlobSha: 'd7f215a0ce9f0608f100e9c5b3bc3b181f0f9cde',
    workflowSha256: 'f56d21765c262b43e113fe443c3d98d70d2fb3aed2adfc3fa3de38f7ac7df512', expectedTests: 316,
    artifactId: 13264443782, artifactName: 'windows-r6-mcp-npm-41705099186-2', artifactSize: 10387,
    artifactSha256: '8736eed2e2fd48ffa929fc880ff7916ab3db9b8f33ba50d0b15b8ef3b4a57b2f' }),
  runtime: Object.freeze({ baselineGeneration: 'a'.repeat(64), targetGeneration: 'b'.repeat(64),
    baselineModuleVersion: '2.7.7', targetModuleVersion: '2.7.8-fixture.19', recoveryReceiptSha256: 'c'.repeat(64) }),
});
function install() { require('node:test').mock.method(profile, 'getTarget', () => fixture); }
module.exports = { fixture, install };
