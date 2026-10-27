'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const source = name => fs.readFileSync(path.join(root, 'src-tauri/src', name), 'utf8').replace(/\r\n/g, '\n');

test('DEB handoff publication follows actual installer outcome and precedes restart', () => {
  const text = source('self_update.rs').split('pub async fn install_hub_update(')[1].split('\n#[cfg(test)]')[0];
  const prepare = text.indexOf('prepare_mcp_handoff(&handle, &release)');
  const install = text.indexOf('let installed_outcome = crate::linux_update::install(');
  const completion = text.indexOf('complete_deb_install(&installed_outcome,');
  const verify = text.indexOf('VerifiedRestartImage::native_deb(');
  const publish = text.indexOf('handoff.publish(&installed_outcome,');
  const finish = text.indexOf('completion.finish(');
  const restart = text.indexOf('handle.request_restart()');
  assert.ok(prepare >= 0 && prepare < install && install < completion && completion < verify && verify < publish && publish < finish && finish < restart);
  assert.match(text.slice(install, completion), /target_os = "linux", feature = "integrated-features"/);
  assert.equal((text.match(/handoff\.publish\(/g) || []).length, 1);
});

test('startup uses the exact installed image and production-signed release, never a page read', () => {
  const text = source('self_update.rs');
  assert.match(text, /fn resume_mcp_handoff\(/);
  assert.match(text, /catalog::verify_signed_target\(APP_ID, bytes, signature, true, Target::native\(\)\?\)/);
  assert.match(text, /let executable_sha256 = manager::file_hash\(&installed\)\?/);
  assert.match(text, /crate::mcp_update_handoff::resume\(/);
  assert.match(text, /Target::native\(\)\?\.package != "deb"/);
  const feature = source('features.rs');
  const restore = source('hosted_restore.rs');
  assert.doesNotMatch(feature + restore, /mcp_update_handoff/);
});

test('Root-only route adapter requires the durable activation permit and exact old CAS', () => {
  const text = source('builtin.rs');
  assert.match(text, /fn prepare_update_route\(/);
  assert.match(text, /fn activate_update\(/);
  assert.match(text, /authority\.authorize\(/);
  assert.match(text, /previous\.as_deref\(\) != Some\(expected\)/);
  const main = source('main.rs');
  assert.match(main, /#\[cfg\(all\(target_os = "linux", feature = "integrated-features"\)\)\]\nmod mcp_update_handoff;/);
});

test('route outcome is separate from network warning and never a startup popup or portable recovery action', () => {
  const text = source('self_update.rs');
  assert.match(text, /pub\(super\) mcp_route_update: Option<crate::mcp_update_handoff::Readback>/);
  assert.match(text, /fn mcp_route_update_status\(/);
  assert.doesNotMatch(text, /\.2\.lock\(\)|title\("Managed MCP update needs review"\)/);
  const init = text.split('pub fn initialize(')[1].split('fn mcp_handoff_path(')[0];
  assert.match(init, /spawn_blocking/);
  const read = text.split('fn mcp_route_update_status(')[1].split('\n#[derive(Serialize)]')[0];
  assert.doesNotMatch(read, /prepare_update_route|activate_update|::resume\(|blocking_show/);
  const portable = source('portable_update.rs');
  assert.match(portable, /mcp_route_update: None/);
});

test('no handoff with a different older active generation has explicit legacy recovery, not quiet Ready', () => {
  const text = source('self_update.rs').split('fn mcp_route_update_status(')[1].split('\n#[derive(Serialize)]')[0];
  assert.match(text, /legacy_readback\(/);
  assert.match(text, /inspect_update_route\(handle\)/);
  const inspect = source('builtin.rs').split('fn inspect_update_route(')[1].split('pub(crate) fn prepare_update_route(')[0];
  assert.match(inspect, /verify_descriptor/);
  assert.doesNotMatch(inspect, /prepare_generation_from|hosting_candidate|activate\(/);
});

test('Installed metadata errors cannot return before a classified verified restart decision', () => {
  const text = source('self_update.rs').split('pub async fn install_hub_update(')[1];
  const start = text.indexOf('let installed_outcome = crate::linux_update::install(');
  const end = text.indexOf('handle.request_restart()', start);
  assert.ok(start >= 0 && end > start);
  const afterInstall = text.slice(start, end);
  assert.doesNotMatch(afterInstall, /let path = mcp_handoff_path\(\)\?;/,
    'metadata path failure currently strands mapped RootA after Installed');
  assert.match(afterInstall, /complete_deb_install\(&installed_outcome,/);
  const integrated = text.slice(start, text.indexOf('#[cfg(not(feature = "integrated-features"))]', start));
  const tail = /\n\s*completion\.finish\(&release\.version, \|notice\| \{[\s\S]*?\}, \|\| handle\.request_restart\(\)\)\s*\n\s*\}\s*$/;
  assert.match(integrated, tail);
  assert.doesNotMatch(integrated.replace('completion.finish(', 'return completion.finish('), tail);
  assert.doesNotMatch(integrated.replace('handle.request_restart())', 'handle.request_restart());'), tail);
  assert.doesNotMatch(afterInstall, /map_err\([\s\S]*?review_message/,
    'metadata failure must be captured by typed completion, not escape the Root worker');
});

test('the installed restart image must be verified against the signed executable hash after installation', () => {
  const text = source('self_update.rs').split('pub async fn install_hub_update(')[1];
  const afterInstall = text.slice(text.indexOf('let installed_outcome = crate::linux_update::install('), text.indexOf('handle.request_restart()'));
  assert.match(afterInstall, /release\.executable_sha256/,
    'pre-install identity of mapped A cannot verify the replacement B');
  assert.match(afterInstall, /tauri::process::current_binary\(&handle\.env\(\)\)/);
  assert.doesNotMatch(afterInstall, /installed_location\(&handle\)/);
});

test('DEB cancellation is handled before image verification and metadata, with no new authority input', () => {
  const text = source('mcp_update_handoff.rs').split('pub(crate) fn complete_deb_install(')[1].split('fn blocked_restart_notice')[0];
  assert.ok(text.indexOf('Outcome::Cancelled') < text.indexOf('verify()'));
  assert.ok(text.indexOf('verify()') < text.indexOf('publish()'));
  const verifier = source('mcp_update_handoff.rs').split('pub fn native_deb(')[1].split('fn capture(')[0];
  assert.match(verifier, /\/usr\/bin\/creator-hub/);
  assert.match(verifier, /Self::capture\(installed, restart, sha256, 0\)/);
});

test('unresolved MCP preparation offers a Hub-only manual signed-DEB path independently of route repair', () => {
  const text = source('self_update.rs').split('pub async fn install_hub_update(')[1];
  assert.match(text, /prepare_mcp_handoff\(&handle, &release\)[\s\S]*?manual_install_message/);
  const helper = source('mcp_update_handoff.rs');
  assert.match(helper, /pub hub_only_manual_install: Option<String>/);
});

test('startup completion hint is emitted only after the operation guard lifetime ends', () => {
  const init = source('self_update.rs').split('pub fn initialize(')[1].split('fn mcp_handoff_path(')[0];
  assert.match(init, /after_operation\(operation,/);
  assert.match(init, /emit\("mcp-route-update-complete", \(\)\)/);
});

test('fresh supersession capture is reachable only after the actual Update Hub native confirmation', () => {
  const full = source('self_update.rs');
  const install = full.split('pub async fn install_hub_update(')[1].split('\n#[cfg(test)]')[0];
  const approved = install.indexOf('if !approved { return Ok("Hub update cancelled. Nothing was installed.".into()); }');
  const signature = install.indexOf('key.verify(&bytes, &signature, false)');
  const capture = install.indexOf('prepare_mcp_handoff(&handle, &release)');
  const system = install.indexOf('let installed_outcome = crate::linux_update::install(');
  assert.ok(approved >= 0 && approved < signature && signature < capture && capture < system);
  assert.equal((full.match(/prepare_mcp_handoff\(&handle, &release\)/g) || []).length, 1);
});

test('fresh capture does not authenticate or replay old bytes and publication owns opaque retention', () => {
  const helper = source('mcp_update_handoff.rs');
  const capture = helper.split('pub fn capture(')[1].split('pub fn publish(')[0];
  assert.doesNotMatch(capture, /decode\(|verify_current\(|known_commit\(|journal\.archive/);
  assert.match(capture, /require_higher_target\(&target\.version, &current\.version, &actual\.hub_version\)/);
  const init = source('self_update.rs').split('pub fn initialize(')[1].split('fn mcp_handoff_path(')[0];
  assert.doesNotMatch(init, /Prepared::capture|prepare_mcp_handoff/);
  const status = source('self_update.rs').split('fn mcp_route_update_status(')[1].split('\n#[derive(Serialize)]')[0];
  assert.doesNotMatch(status, /Prepared::capture|prepare_mcp_handoff|publish\(/);
});
