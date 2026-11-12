'use strict';
const assert = require('node:assert/strict');
const profiles = Object.freeze({
  creator: { dependencies: { 'com.sidequest.creator-sdk': '4.0.25' }, groups: 'core,creator' },
  banter: { dependencies: { 'com.sidequest.banter': '3.2.1' }, groups: 'core,banter' },
  hybrid: { dependencies: { 'com.sidequest.creator-sdk': '4.0.25', 'com.sidequest.banter': '3.2.1' }, groups: 'core,banter,creator' },
  none: { dependencies: {}, groups: 'core' },
});
function fixture(profile) {
  assert.ok(Object.hasOwn(profiles, profile));
  const { dependencies, groups } = profiles[profile];
  return { manifest: JSON.stringify({ dependencies }) + '\n', groups,
    checkedProject: { valid: true, sdkProfile: { profile, recommendedToolGroups: groups } } };
}
module.exports = { fixture };
