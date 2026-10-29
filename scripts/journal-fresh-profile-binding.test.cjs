'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const b = require('./journal-fresh-profile-binding.cjs');
test('exact draft asset metadata requires a unique matching release asset', () => {
  const release = {id: 411494394, tag_name: 'v0.1.13-validation', draft: true};
  const asset = {...b.ASSET}; b.assetBinding(release, [asset], asset);
  assert.throws(() => b.assetBinding({...release, draft: false}, [asset], asset));
  assert.throws(() => b.assetBinding(release, [asset, {...asset, id: 7}], asset));
  assert.throws(() => b.assetBinding(release, [asset], {...asset, digest: 'sha256:' + '0'.repeat(64)}));
  assert.throws(() => b.assetBinding(release, Array(100).fill(asset), asset));
});
test('profile bytes cannot be substituted or partially supplied', () => {
  assert.throws(() => b.profile(Buffer.alloc(0)));
  assert.throws(() => b.profile(Buffer.alloc(b.PROFILE.size)));
  assert.throws(() => b.profile('{}'));
});
