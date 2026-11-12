import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const launcherSource = fs.readFileSync("launcher/src-tauri/src/lib.rs", "utf8");
const launcherHtml = fs.readFileSync("launcher/src/index.html", "utf8");
const launcherApp = fs.readFileSync("launcher/src/app.js", "utf8");
const tauriConfig = fs.readFileSync("launcher/src-tauri/tauri.conf.json", "utf8");
const runtimeStage = fs.readFileSync("scripts/stage-node-runtime.mjs", "utf8");
const standaloneBuilder = fs.readFileSync("scripts/build-standalone.mjs", "utf8");
const setupEntry = fs.readFileSync("scripts/cli/setup.mjs", "utf8");
const bridgeSource = fs.readFileSync("unity-extension/Editor/BanterMCPBridge.cs", "utf8");

test("guided setup accepts a Unity project folder and configures selected clients", () => {
  assert.match(launcherSource, /fn add_project\(/);
  assert.match(launcherSource, /fn discover_unity_projects\(/);
  assert.match(launcherSource, /fn one_click_setup\(/);
  assert.match(launcherSource, /fn update_configured_unity_extensions\(/);
  assert.match(launcherApp, /invoke\('one_click_setup'/);
  assert.match(launcherApp, /invoke\('update_configured_unity_extensions'/);
  assert.match(launcherApp, /invoke\('get_project_sdk_profile'/);
  assert.match(launcherApp, /Run the SDK validator in Unity to prove Editor-domain availability/);
  assert.match(launcherHtml, /Select a Unity project folder/);
  assert.match(launcherHtml, /SDK profile/);
  assert.match(launcherHtml, /Update Bridges/);
  assert.doesNotMatch(launcherHtml, /Add Scene Channel/);
});

test("one-click Auto resolves before any settings, client or bridge mutation", () => {
  const start = launcherSource.indexOf('fn one_click_setup(');
  const setup = launcherSource.slice(start, launcherSource.indexOf('\n#[tauri::command]', start));
  const resolve = setup.indexOf('let tool_groups = resolve_project_tool_groups(');
  assert.ok(resolve > 0);
  for (const boundary of ['default_mcp_server_path(', 'managed_client::target(', 'unity_cli::mode()', 'load_operation(', 'save_operation(',
    'install_unity_extension(', 'set_unity_custom_scripts(', 'update_codex_mcp_config(',
    'update_claude_mcp_config(', 'update_claude_desktop_mcp_config(',
    'update_antigravity_mcp_config(', 'update_opencode_mcp_config(']) {
    assert.ok(setup.indexOf(boundary) > resolve, `${boundary} must follow Auto resolution`);
  }
  assert.match(setup, /config\.tool_groups = selection;/);
  assert.doesNotMatch(setup, /config\.tool_groups = tool_groups/);
});

test("launcher-managed clients use a pinned private Node runtime", () => {
  assert.match(launcherSource, /resolve_node_command/);
  assert.match(launcherSource, /"command": node_command/);
  assert.match(launcherSource, /command = \\\"\{\}\\\"/);
  assert.match(tauriConfig, /release\/runtime\/node\.exe/);
  assert.match(runtimeStage, /24\.17\.0/);
  assert.match(runtimeStage, /PINNED_CHECKSUMS/);
  assert.match(runtimeStage, /archiveSha256/);
  assert.match(runtimeStage, /binarySha256/);
});

test("launcher presents Creator Works as the AI-facing MCP identity", () => {
  assert.match(launcherHtml, /Creator Works MCP/);
  assert.match(launcherSource, /const MCP_CLIENT_ID: &str = "creator-works"/);
  assert.match(launcherSource, /const TOOL_GROUPS_ENV: &str = "CREATOR_WORKS_TOOL_GROUPS"/);
  assert.match(launcherSource, /LEGACY_MCP_CLIENT_ID/);
  assert.doesNotMatch(launcherHtml, /BANTWORKS MCP/);
  assert.match(launcherHtml, /value="auto">Auto \(project SDK\)/);
  assert.match(launcherHtml, /value="core">Token Saver/);
  assert.match(launcherHtml, /value="core,creator">Altspace \/ Creator SDK/);
  assert.match(launcherHtml, /value="core,banter">Banter/);
  assert.match(launcherHtml, /value="core,banter,creator">Altspace \+ Banter/);
  assert.doesNotMatch(launcherHtml, /Full Unity \+ Banter|Banter workflow/);
  assert.match(launcherHtml, /value="core,shadergraph">Shader Graph preview/);
  assert.match(launcherHtml, /value="core,author">Unity authoring/);
  assert.match(launcherHtml, /value="core,test">Testing/);
  assert.match(launcherApp, /tool_groups: 'core'/);
});

test("cross-platform standalone packaging uses Creator Works artifact names", () => {
  assert.match(standaloneBuilder, /Creator-Works-MCP/);
  assert.match(standaloneBuilder, /creator-works-mcp\.mjs/);
  assert.match(standaloneBuilder, /writeFileSync\(path\.join\(stagingRoot, "banter-mcp\.mjs"\)/);
  assert.doesNotMatch(standaloneBuilder, /BANTWORKS-MCP|bantworks-standalone/);

  assert.match(setupEntry, /path\.join\(mcpRoot, "creator-works-mcp\.mjs"\)/);
  assert.match(setupEntry, /major < 20/);
  assert.doesNotMatch(setupEntry, /major < 18/);
});

test("custom script mode exposes existing compiled components without claiming to write C#", () => {
  assert.match(launcherHtml, /Custom Script Components/);
  assert.match(launcherHtml, /existing components from compiled project C#/);
  assert.doesNotMatch(launcherHtml, /MCP-authored scripts/);
  assert.match(bridgeSource, /MCP can add existing components from compiled project C# assemblies/);
  assert.doesNotMatch(bridgeSource, /MCP can add custom C# scripts/);
});

test("all-tests mode allows full suite runs by default and can be restricted in bridge and launcher", () => {
  assert.match(launcherHtml, /Allow Running All Tests/);
  assert.match(launcherHtml, /Allow MCP to run the entire test suite without filters/);
  assert.match(bridgeSource, /AllowAllTestsKey = "BantworksMCP_AllowAllTests_" \+ ComputeSha256\(Encoding.UTF8.GetBytes\(ProjectRoot\)\)/);
  assert.match(bridgeSource, /Running all tests without a filter is disabled for this project/);
  assert.match(bridgeSource, /MCP requires specific testNames, groupNames, or assembly filters/);
});

