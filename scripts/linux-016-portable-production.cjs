// Fixed production-input packaging lane. No profile selection, signing or app execution.
const assert = require('node:assert/strict');
const producer = require('./linux-016-portable-package.cjs').production016();

module.exports = producer;
if (require.main === module) (async () => {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'preflight') {
    assert.equal(args.length, 0); producer.preflight();
    console.log(JSON.stringify({ profile: producer.PROFILE, preflightPassed: true, releaseReady: false }));
  } else if (mode === 'fetch') {
    assert.equal(args.length, 1); producer.fetchInputs(...args);
  } else {
    assert.equal(mode, 'package'); assert.equal(args.length, 4); await producer.produce(...args);
  }
})().catch(error => {
  console.error(String(error.message).slice(0, 2000));
  if (error.inventoryEvidence) console.error(JSON.stringify(error.inventoryEvidence));
  process.exitCode = 1;
});
