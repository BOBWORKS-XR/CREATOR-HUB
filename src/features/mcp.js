import { controller, node, lines, text, confirm } from './common.js';

const clients = [
  ['codex', 'Codex', 'codex'], ['claude', 'Claude Code', 'claude'],
  ['claudeDesktop', 'Claude Desktop', 'claude_desktop'], ['antigravity', 'Antigravity', 'antigravity'], ['opencode', 'OpenCode', 'opencode'],
];
const cliPolicy = 'unity-cli-experimental-v1';
const noticeKey = 'creator-works-mcp.ai-usage-notice-hidden.v1';

export function mount(root, api) {
  root.innerHTML = `
    <div class="feature-heading"><h2>Creator Works MCP</h2><span data-field="status" role="status">Checking availability</span></div>
    <p data-field="error" class="feature-error" role="alert" hidden></p><button data-field="retry" class="text-button" type="button" hidden>Check connection again</button>
    <section data-field="product-panel" class="feature-section" aria-label="Saved MCP settings review" hidden>
      <h3>Saved MCP settings</h3><p data-field="product-status" role="status">Checking retained settings</p>
      <div data-field="product-evidence" class="feature-note"></div>
      <button data-field="product-review" data-native-action class="text-button" type="button" disabled>Review saved MCP settings</button>
      <button data-field="product-check" data-native-action class="text-button" type="button" disabled>Check saved settings</button>
    </section>
    <div data-field="notice" class="feature-banner"><p>AI results and token charges are unpredictable. Your AI provider controls billing. Back up projects and review generated actions.</p><label class="feature-check"><input data-field="notice-remember" type="checkbox">Don't show again</label><button data-field="notice-close" class="icon-button" type="button" title="Dismiss AI usage notice" aria-label="Dismiss AI usage notice">&#215;</button></div>
    <fieldset data-field="controls" disabled aria-label="MCP controls">
      <div class="feature-actions feature-section"><button data-field="guide" class="text-button" type="button">Connection guide</button><button data-field="check" class="icon-button" type="button" title="Check Unity connection" aria-label="Check Unity connection"><span class="icon icon-refresh" aria-hidden="true"></span></button></div>
      <div class="feature-grid">
        <section aria-label="Unity connection">
          <div class="feature-input-row"><label>Unity project<input data-field="project" type="text" autocomplete="off" spellcheck="false"></label><button data-field="browse" class="text-button" type="button"><span class="icon icon-folder" aria-hidden="true"></span> Browse</button></div>
          <label>Recent Unity projects<select data-field="discovered"><option value="">Choose a project</option></select></label>
          <div data-field="clients"></div>
          <details><summary>Optional Unity CLI</summary><p data-field="cli-status" class="feature-note"></p><label class="feature-check"><input data-field="cli" type="checkbox" disabled><span>Also connect Unity CLI to the selected AI clients</span></label><p class="feature-note">Off by default. Experimental in Creator Hub and Unity. Requires Unity 6 and the Unity Pipeline package; this option does not install that package.</p><button data-field="cli-docs" class="text-button" type="button">Unity CLI requirements <span class="icon icon-external" aria-hidden="true"></span></button></details>
          <button data-field="setup" class="primary-button" type="button" disabled>Set up Creator Works MCP</button>
          <div data-field="setup-result" class="feature-output" role="status"></div>
        </section>
        <section class="feature-section" aria-label="Connection status"><h3>Connection status</h3><div data-field="checks"></div><p class="feature-note">Saved settings are not proof of a live AI connection. Fully quit and reopen changed AI clients, then ask your AI to call get_bridge_status.</p></section>
      </div>
      <section class="feature-section" aria-label="Saved Unity projects"><div class="feature-heading"><h3>Unity projects</h3><div class="feature-actions"><button data-field="add" class="text-button" type="button"><span class="icon icon-folder" aria-hidden="true"></span> Add project</button><button data-field="bridges" class="text-button" type="button">Update bridges</button></div></div><div data-field="projects"></div></section>
      <details class="feature-section"><summary>Existing client connections and recovery</summary><p class="feature-note">Review only the clients selected above. Native review keeps backups and asks before changing existing entries.</p><button data-field="review" class="text-button" type="button">Review selected connections</button><button data-field="recovery-check" class="text-button" type="button">Check interrupted changes</button><div data-field="recovery"></div><button data-field="recover" class="text-button" type="button" disabled>Review and resume eligible changes</button></details>
      <details class="feature-section"><summary>Advanced settings</summary>
        <button data-field="product-review-advanced" class="text-button" type="button">Review saved MCP settings</button>
        <label>MCP server path<input data-field="server" type="text" autocomplete="off" spellcheck="false"></label>
        <label>Capabilities<select data-field="groups"><option value="core">Token Saver (recommended)</option><option value="all">Full Unity + Banter (high context)</option><option value="read">Inspection</option><option value="core,banter">Banter workflow</option><option value="core,shadergraph">Shader Graph preview</option><option value="core,author">Unity authoring</option><option value="core,test">Testing</option><option value="none">Minimal routing</option></select></label>
        <label class="feature-check"><input data-field="follow" type="checkbox"><span>Follow active project</span></label>
        <label class="feature-check"><input data-field="scripts" type="checkbox"><span>Allow custom script components</span></label>
        <label class="feature-check"><input data-field="tests" type="checkbox"><span>Allow running all project tests</span></label>
        <button data-field="save" class="text-button" type="button">Save options</button>
        <button data-field="bridge" class="text-button" type="button">Install or update bridge for selected project</button>
      </details>
    </fieldset>
    <dialog data-field="guide-dialog" class="feature-dialog" aria-labelledby="feature-mcp-guide-title"><h3 id="feature-mcp-guide-title">Connect your AI to Unity</h3><p>Project Setup creates a Unity project. MCP connects an AI client to it; it is not the AI model.</p><ol data-field="guide-steps"></ol><p data-field="guide-error" class="feature-error" role="alert" hidden></p><div class="feature-actions"><button data-field="guide-help" class="text-button" type="button">Help &amp; troubleshooting</button><button data-field="guide-skip" class="text-button" type="button">Use existing controls</button><button data-field="guide-start" class="primary-button" type="button">Set up a connection</button></div></dialog>`;
  const page = controller(root, api, 'mcp'); const $ = page.field;
  let config = null;
  let onboarding = null;
  let chosen = false;
  let cliTouched = false;
  let cliConsent = null;
  let recovery = [];
  let productReport = null;
  let productIssue = false;
  let productReviewed = false;
  const clientUi = new Map();
  const active = () => config?.channels?.find(channel => channel.id === config.active_channel_id);
  const selectedClients = () => clients.filter(([id]) => clientUi.get(id).checkbox.checked);
  const run = async (action, label) => { const result = await page.run(action, label); controls(); return result; };
  function productVisibility() {
    const required = productReport && (['legacy-only', 'conflict'].includes(productReport.status)
      || productReport.recovery.some(item => !item.historical_completed));
    $('product-panel').hidden = !required && !productIssue;
  }
  function productError(reason) {
    productReviewed = false; page.lock(true);
    productIssue = true;
    $('product-status').textContent = `Saved settings could not be loaded or reviewed. Review saved settings and recovery evidence before retrying. ${text(reason)}`;
    productVisibility();
  }
  function renderProductSettings(report) {
    if (!report || !['none', 'current', 'identical', 'legacy-only', 'conflict'].includes(report.status)
      || !Array.isArray(report.backups) || !Array.isArray(report.recovery)) throw new Error('Saved settings status is incomplete. Originals were not changed.');
    productReport = report;
    const interrupted = report.recovery.some(item => !item.historical_completed);
    if (interrupted) productReviewed = false;
    const reviewMessage = productReviewed ? 'Reviewed settings remain in use from their existing store.' : 'Review before loading this form.';
    const messages = { none: 'No existing MCP settings found.', current: 'Current MCP settings retained.', identical: 'Current and older MCP settings match; both are retained.',
      'legacy-only': `Older MCP settings remain at their existing location. ${reviewMessage}`,
      conflict: `Current and older MCP settings differ. Both originals are kept. ${reviewMessage}` };
    $('product-status').textContent = interrupted ? 'A saved-settings operation needs recovery review. No automatic rollback or reset is attempted.' : messages[report.status];
    lines($('product-evidence'), [report.currentPath ? `Current: ${report.currentPath}` : null, report.legacyPath ? `Older settings: ${report.legacyPath}` : null,
      report.evidencePath ? `Evidence: ${report.evidencePath}` : null,
      ...report.backups.map(path => `Retained backup: ${path}`),
      ...report.recovery.flatMap(item => [`Recovery journal: ${item.journal}${item.historical_completed ? ' (completed history)' : ' (requires review)'}`,
        ...(item.files || []).map(file => `${file.client}: ${file.status} · ${file.path}`)])]);
    const blocked = interrupted || (!productReviewed && ['legacy-only', 'conflict'].includes(report.status));
    productVisibility();
    if (blocked) page.lock(true);
    return blocked;
  }
  async function inspectProductSettings() {
    try { return renderProductSettings(await page.call('product_settings_status')); }
    catch (reason) { productError(reason); throw reason; }
  }
  function controls() {
    const ready = onboarding?.runtime?.ready && onboarding?.project?.valid;
    $('setup').disabled = !ready || !selectedClients().length;
    $('add').disabled = !$('project').value.trim();
    $('bridge').disabled = !onboarding?.project?.valid;
    for (const [id, ui] of clientUi) {
      const state = onboarding?.clients?.find(client => client.id === id);
      ui.checkbox.disabled = state?.supported === false;
      ui.apply.disabled = !active() || state?.supported === false || active().unity_project_path !== $('project').value;
      ui.disconnect.disabled = !state?.configured || state?.supported === false;
    }
    $('cli').disabled = !onboarding?.unityCli?.canEnable && !onboarding?.unityCli?.enabled;
    $('recover').disabled = !recovery.some(item => item.canResume);
  }
  function renderStatus(value) {
    if (!value?.runtime || !Array.isArray(value.clients)) throw new Error('Connection status is incomplete. Check again.');
    onboarding = value;
    const p = value.project;
    const rows = [['Private runtime', value.runtime.ready ? 'Ready' : 'Unavailable', value.runtime.ready],
      ['Unity project', p?.valid ? 'Valid' : $('project').value ? 'Invalid' : 'Not selected', p?.valid],
      ['SDK profile', p?.sdkProfile?.label || 'Not selected', p?.sdkProfile?.profile && !['none', 'unknown'].includes(p.sdkProfile.profile)],
      ['Unity bridge', p?.bridgeCurrent ? p.stateStatus === 'fresh' ? 'Connected' : 'Installed; open Unity and check again' : p?.bridgeInstalled ? 'Update available' : 'Not installed', p?.bridgeCurrent && p.stateStatus === 'fresh']];
    $('checks').replaceChildren(...rows.map(([name, value, ready]) => { const row = node('div', null, 'feature-row'); row.append(node('span', name), node('span', value, ready ? 'feature-good' : 'feature-warn')); return row; }));
    for (const [id, ui] of clientUi) {
      const state = value.clients.find(client => client.id === id);
      ui.status.textContent = state?.supported === false ? 'Not available on this OS' : `${state?.detected ? 'Detected' : 'Not detected'} · ${state?.configured ? 'Configured' : 'Not configured'}${state?.issue ? ` · ${state.issue}` : ''}`;
      if (!chosen) ui.checkbox.checked = state?.supported !== false && Boolean(state?.detected || state?.configured);
      if (state?.supported === false) ui.checkbox.checked = false;
    }
    chosen = true;
    $('cli-status').textContent = value.unityCli?.message || 'Optional Unity CLI is unavailable.';
    if (!cliTouched) {
      $('cli').checked = value.unityCli?.enabled === true;
      cliConsent = config?.unity_cli_consent_version === cliPolicy ? cliPolicy : null;
    }
    const steps = [
      !value.runtime.ready ? 'The private runtime is unavailable. Do not close unrelated Node processes.' : 'Private runtime is ready.',
      !p?.valid ? 'Select the Unity project folder containing Assets, Packages and ProjectSettings. Use Project Setup if you need a new project.' : !p.bridgeCurrent ? 'Review setup to install or update the Unity bridge.' : p.stateStatus !== 'fresh' ? 'Open the project in Unity, let it compile, fix Console errors and check again.' : 'Unity bridge is responding.',
      'Select your AI clients, review setup, then fully quit and reopen any changed clients. Claude Code and Claude Desktop are different apps; the Claude website is not Desktop.',
      'Ask your AI to call get_bridge_status for this project. Saved settings alone do not prove the AI client loaded MCP.',
    ];
    $('guide-steps').replaceChildren(...steps.map(step => node('li', step))); controls();
  }
  async function check() { renderStatus(await page.call('get_onboarding_status', { unityProjectPath: $('project').value || null })); }
  async function followActive(channel) {
    if (!config.auto_start || !channel) return;
    for (const [id, , commandId] of clients) {
      const client = onboarding?.clients.find(item => item.id === id);
      if (client?.configured && client.supported !== false) await page.call(`update_${commandId}_mcp_config`, {
        channel, mcpServerPath: config.mcp_server_path, toolGroups: config.tool_groups || 'core',
      });
    }
  }
  function renderProjects() {
    $('projects').replaceChildren(...config.channels.map(channel => {
      const row = node('div', null, 'feature-row');
      const info = node('span'); info.append(node('strong', channel.name), node('p', channel.unity_project_path, 'feature-note'));
      const actions = node('div', null, 'feature-actions');
      const select = node('button', channel.id === config.active_channel_id ? 'Active project' : 'Use project', 'text-button'); select.type = 'button';
      page.on(select, 'click', () => run(async () => {
        const next = { ...config, active_channel_id: channel.id };
        await page.call('save_config', { config: next }); config = next; $('project').value = channel.unity_project_path; await check(); await followActive(channel); renderProjects();
      }, 'Selecting project'));
      const remove = node('button', null, 'icon-button'); remove.type = 'button'; remove.title = 'Remove from saved projects'; remove.setAttribute('aria-label', `Remove ${channel.name} from saved projects`); remove.textContent = '×';
      page.on(remove, 'click', () => run(async () => {
        if (!await confirm(page, { title: 'Remove saved project?', detail: `Remove ${channel.name} from this list? Project files and AI client settings are not deleted.`, accept: 'Remove from list' })) return;
        const remaining = config.channels.filter(item => item.id !== channel.id);
        const next = { ...config, channels: remaining, active_channel_id: config.active_channel_id === channel.id ? remaining[0]?.id || null : config.active_channel_id };
        await page.call('save_config', { config: next }); config = next; $('project').value = active()?.unity_project_path || ''; await check(); renderProjects();
      }, 'Updating saved projects'));
      actions.append(select, remove); row.append(info, actions); return row;
    }));
    if (!config.channels.length) $('projects').append(node('p', 'No saved Unity projects.', 'feature-note'));
  }
  async function reload() {
    page.lock(true);
    try {
      config = await page.call('load_config');
      if (!Array.isArray(config?.channels)) throw new Error('Saved MCP configuration is incomplete. Nothing was changed.');
    } catch (reason) { productError(reason); throw reason; }
    const discovered = await page.call('discover_unity_projects');
    if (!Array.isArray(discovered)) throw new Error('Project discovery returned an invalid list.');
    if (!$('project').value) $('project').value = active()?.unity_project_path || discovered[0]?.path || '';
    const placeholder = node('option', 'Choose a project'); placeholder.value = '';
    $('discovered').replaceChildren(placeholder, ...discovered.map(item => { const option = node('option', item.name); option.value = item.path; return option; }));
    $('server').value = config.mcp_server_path || '';
    const groups = config.tool_groups || 'core';
    if (![...$('groups').options].some(option => option.value === groups)) { const option = node('option', `Current: ${groups}`); option.value = groups; $('groups').append(option); }
    $('groups').value = groups; $('follow').checked = config.auto_start === true;
    $('scripts').checked = config.enable_custom_scripts === true; $('tests').checked = config.allow_all_tests !== false;
    renderProjects(); await check(); productIssue = false; productVisibility(); page.lock(false);
  }
  for (const [id, label, commandId] of clients) {
    const row = node('div', null, 'feature-client');
    const name = node('label', null, 'feature-check');
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.client = id;
    name.append(checkbox, node('span', label));
    const status = node('span', 'Not checked', 'feature-note');
    const actions = node('div', null, 'feature-actions');
    const apply = node('button', 'Apply', 'text-button'); apply.type = 'button'; apply.setAttribute('aria-label', `Apply to ${label}`);
    const disconnect = node('button', 'Disconnect', 'text-button'); disconnect.type = 'button'; disconnect.setAttribute('aria-label', `Disconnect ${label}`);
    actions.append(apply, disconnect); row.append(name, status, actions); $('clients').append(row);
    clientUi.set(id, { checkbox, status, apply, disconnect });
    page.on(checkbox, 'change', controls);
    page.on(apply, 'click', () => run(async () => {
      const channel = active();
      if (!channel || channel.unity_project_path !== $('project').value) throw new Error('Use this saved project or run reviewed setup first.');
      await page.call(`update_${commandId}_mcp_config`, { channel, mcpServerPath: config.mcp_server_path, toolGroups: config.tool_groups || 'core' });
      await check(); $('setup-result').textContent = `${label} settings saved. Fully quit and reopen ${label}, then check the connection.`;
    }, `Configuring ${label}`));
    page.on(disconnect, 'click', () => run(async () => {
      if (!await confirm(page, { title: `Disconnect ${label}?`, detail: 'Remove the Creator Works MCP entry only. Optional Unity CLI and unrelated servers are separate.', accept: 'Disconnect' })) return;
      await page.call(`remove_${commandId}_mcp_config`); await check();
    }, `Disconnecting ${label}`));
  }
  page.on($('project'), 'input', () => { onboarding = null; controls(); });
  page.on($('check'), 'click', () => run(check, 'Checking connection'));
  page.on($('retry'), 'click', () => { if (!page.busy()) void api.retry('mcp'); });
  page.on($('product-check'), 'click', () => run(inspectProductSettings, 'Inspecting saved settings'));
  async function reviewProductSettings() {
    if (page.busy()) return;
    productReviewed = false;
    page.lock(true);
    productIssue = true; productVisibility();
    const reviewed = await run(async () => {
      const report = await page.call('review_product_settings');
      renderProductSettings(report);
      // Report.status/backups alone cannot distinguish a native cancellation.
      if (report.approved !== true) {
        $('product-status').textContent = 'Review returned without explicit approval. Originals are retained and the form stays locked.';
        return;
      }
      if (report.recovery.some(item => !item.historical_completed)) throw new Error('Settings recovery still needs review. Nothing was reset.');
      await reload();
    }, 'Reviewing saved settings');
    if (reviewed && productReport?.approved === true && !$('controls').disabled) {
      productReviewed = true;
      $('product-status').textContent = 'Reviewed settings loaded from their existing store. Originals and backups were retained.';
      $('retry').hidden = true;
      page.initialized = true; api.changed();
    }
    if (!reviewed) productError($('error').textContent);
  }
  page.on($('product-review'), 'click', reviewProductSettings);
  page.on($('product-review-advanced'), 'click', reviewProductSettings);
  page.on($('discovered'), 'change', () => { if ($('discovered').value) { $('project').value = $('discovered').value; void run(check, 'Checking project'); } });
  page.on($('browse'), 'click', () => run(async () => { const path = await page.call('pick_project_folder'); if (path) { $('project').value = path; await check(); } }, 'Choosing project'));
  page.on($('add'), 'click', () => run(async () => {
    const channel = await page.call('add_project', { projectPath: $('project').value });
    const existing = config.channels.find(item => item.unity_project_path === channel.unity_project_path);
    const next = { ...config, channels: existing ? config.channels : [...config.channels, channel], active_channel_id: existing?.id || channel.id };
    await page.call('save_config', { config: next }); config = next; renderProjects(); await check();
  }, 'Adding project'));
  page.on($('cli'), 'change', async () => {
    cliTouched = true;
    if (!$('cli').checked) { cliConsent = null; return; }
    $('cli').checked = false;
    await run(async () => {
      const allowed = await confirm(page, { title: 'Experimental Unity CLI', detail: 'Unity CLI integration is experimental in both Creator Hub and Unity. It can change Editor and project state. Keep backups. Unity 6 and the Unity Pipeline package are required.', accept: 'Agree and enable', acknowledgement: 'I understand and agree to use the experimental Unity CLI integration.' });
      cliConsent = allowed ? cliPolicy : null; $('cli').checked = allowed;
    }, 'Reviewing Unity CLI');
  });
  page.on($('cli-docs'), 'click', () => run(() => api.invoke('open_resource', { resource: 'unity-cli-docs' }), 'Opening documentation'));
  page.on($('setup'), 'click', () => run(async () => {
    if (!onboarding?.project?.valid || !onboarding.runtime.ready || !selectedClients().length) throw new Error('Select a valid Unity project and an AI client, then check the connection.');
    if ($('cli').checked && cliConsent !== cliPolicy) throw new Error('Accept experimental Unity CLI consent before enabling it.');
    if (!await confirm(page, { title: 'Review connection setup', detail: `Project: ${$('project').value}\nClients: ${selectedClients().map(([, name]) => name).join(', ')}\nCapabilities: ${config.tool_groups || 'core'}\nCustom scripts: ${config.enable_custom_scripts === true ? 'on' : 'off'}\nAll project tests: ${config.allow_all_tests !== false ? 'allowed' : 'restricted'}\nUnity CLI: ${$('cli').checked ? 'experimental' : 'off for selected clients'}`, accept: 'Apply setup' })) return;
    await page.call('one_click_setup', {
      unityProjectPath: $('project').value,
      configureCodex: clientUi.get('codex').checkbox.checked, configureClaude: clientUi.get('claude').checkbox.checked,
      configureClaudeDesktop: clientUi.get('claudeDesktop').checkbox.checked, configureAntigravity: clientUi.get('antigravity').checkbox.checked,
      configureOpencode: clientUi.get('opencode').checkbox.checked, toolGroups: config.tool_groups || 'core', enableCustomScripts: config.enable_custom_scripts === true,
      configureUnityCli: cliTouched || config.unity_cli_enabled === true ? $('cli').checked : null,
      unityCliConsent: $('cli').checked ? cliConsent : null,
    });
    cliTouched = false; await reload();
    const next = { ...config, connection_guide_version: 1 }; await page.call('save_config', { config: next }); config = next;
    $('setup-result').textContent = 'Settings saved. Open Unity and resolve Console errors. Fully quit and reopen changed AI clients, then check again. Earlier completed steps may remain if a later check fails.';
  }, 'Setting up MCP'));
  page.on($('bridges'), 'click', () => run(async () => { const value = await page.call('update_configured_unity_extensions'); $('setup-result').textContent = `Bridges updated: ${value.updated}. Failed: ${value.failed?.length || 0}.`; await check(); }, 'Updating bridges'));
  page.on($('bridge'), 'click', () => run(async () => { await page.call('install_unity_extension', { unityProjectPath: $('project').value }); await check(); }, 'Installing Unity bridge'));
  page.on($('save'), 'click', () => run(async () => {
    const next = { ...config, mcp_server_path: $('server').value.trim(), tool_groups: $('groups').value, auto_start: $('follow').checked, enable_custom_scripts: $('scripts').checked, allow_all_tests: $('tests').checked };
    await page.call('save_config', { config: next }); config = next;
    const channel = active();
    if (channel) {
      await page.call('set_unity_custom_scripts', { unityProjectPath: channel.unity_project_path, enabled: next.enable_custom_scripts });
      await page.call('set_unity_allow_all_tests', { unityProjectPath: channel.unity_project_path, enabled: next.allow_all_tests });
      await check(); await followActive(channel);
    }
    $('setup-result').textContent = next.auto_start ? 'Options saved; configured clients follow the active project. Restart changed clients, then check the connection.' : 'Options saved. Apply to selected clients or use reviewed setup to update their capabilities.';
  }, 'Saving options'));
  page.on($('review'), 'click', () => run(async () => {
    const ids = selectedClients().map(([id]) => id); if (!ids.length) throw new Error('Select at least one AI client.');
    if (onboarding?.managedRouting) {
      const result = await page.call('review_existing_client_connections', { clients: ids });
      if (!['migrated', 'cancelled', 'unchanged'].includes(result?.status)) throw new Error('Connection review outcome is unknown. Check retained recovery records before retrying.');
      $('setup-result').textContent = result.status === 'migrated' ? `${result.count} connections moved with backups. Restart changed clients.` : result.status === 'cancelled' ? 'Review cancelled. No further change was requested.' : 'No eligible connections were changed.';
    } else for (const client of ids) {
      const result = await page.call('review_existing_client_connection', { client });
      if (!['migrated', 'cancelled', 'unchanged'].includes(result?.status)) throw new Error('Connection review outcome is unknown. Earlier approved changes may remain.');
      if (result.status === 'cancelled') { $('setup-result').textContent = 'Review cancelled. Earlier approved changes may remain.'; break; }
    }
    await reload();
  }, 'Reviewing connections'));
  async function readRecovery() {
    recovery = await page.call('pending_client_recovery');
    if (!Array.isArray(recovery) || recovery.length > 768) throw new Error('Recovery response is invalid. No recovery was requested.');
    lines($('recovery'), recovery.map(item => `${item.clientName}: ${item.message}`)); controls();
  }
  page.on($('recovery-check'), 'click', () => run(readRecovery, 'Checking interrupted changes'));
  page.on($('recover'), 'click', () => run(async () => {
    for (const record of recovery.filter(item => item.canResume)) {
      const result = await page.call('recover_client_connection', { clients: record.clients, operation: record.operation, central: record.central });
      if (!result?.completed) throw new Error('Recovery was declined or needs manual inspection. Current files were kept.');
    }
    await readRecovery(); await reload();
  }, 'Reviewing recovery'));
  page.on($('guide'), 'click', () => { if (!page.busy()) $('guide-dialog').showModal(); });
  page.on($('guide-start'), 'click', () => { $('guide-dialog').close(); $('project').focus(); });
  page.on($('guide-help'), 'click', () => { $('guide-dialog').close(); document.querySelector('#context-help-dialog').showModal(); });
  page.on($('guide-skip'), 'click', async () => {
    $('guide-error').hidden = true;
    const saved = await run(async () => { const next = { ...config, connection_guide_version: 1 }; await page.call('save_config', { config: next }); config = next; }, 'Saving guide preference');
    if (saved) $('guide-dialog').close();
    else { $('guide-error').textContent = $('error').textContent || 'The preference was not saved. No connection was changed.'; $('guide-error').hidden = false; }
  });
  page.on($('notice-close'), 'click', async () => {
    if (page.busy()) return;
    if ($('notice-remember').checked) {
      if (!await confirm(page, { title: 'Confirm hiding this notice', detail: 'AI results, token use and provider charges vary and are outside Creator Works MCP control. The app cannot estimate or cap them.', accept: 'Confirm and hide', acknowledgement: 'I understand and accept this AI usage risk.' })) return;
      try { localStorage.setItem(noticeKey, 'true'); if (localStorage.getItem(noticeKey) !== 'true') throw new Error('Preference was not saved.'); }
      catch (reason) { page.showError(`The preference could not be saved. The warning remains visible. ${text(reason)}`); return; }
    }
    $('notice').hidden = true;
  });
  try { $('notice').hidden = localStorage.getItem(noticeKey) === 'true'; } catch { /* Keep warning visible. */ }
  return Object.assign(page, {
    async initialize() {
      page.lock(true);
      let loaded = false;
      const complete = await run(async () => {
        if (await inspectProductSettings()) return;
        await reload(); loaded = true;
      }, 'Checking Unity connection');
      if (complete && !loaded) $('status').textContent = 'Review saved settings';
      if (complete && loaded && config.connection_guide_version !== 1 && !root.hidden) $('guide-dialog').showModal();
      return complete && loaded;
    },
    event(name, value) {
      if (name === 'creator-mcp-lifecycle' && value?.state === 'disconnected') {
        page.enable(false, 'MCP disconnected. The last operation may be unknown. Check again before retrying.');
      }
    },
    help: [
      ['Which tool is this?', 'MCP connects compatible AI clients to Unity. It is not an AI model. Project Setup creates and validates projects; Hub brings both tools together.'],
      ['My AI cannot see MCP', 'Select the correct Unity project, run reviewed setup, open it in Unity and resolve compile errors. Fully quit and reopen changed AI clients, then ask the AI to call get_bridge_status. Claude Desktop and Claude Code need separate configuration.'],
      ['AI costs are high', 'Your provider controls billing. Check usage limits, avoid unnecessary context and fast/high-cost modes, and consider a cheaper model for routine work. The app cannot cap token charges.'],
      ['Unity CLI', 'Optional and off by default. Integration is experimental in Creator Hub and Unity, requires explicit agreement and needs Unity 6 plus Unity Pipeline. MCP works without it.'],
      ['Setup failed or another app is running', 'Read the exact error. Keep backups, check the connection and review interrupted changes before retrying. Never close unrelated Node processes. Earlier completed steps may remain; no mutation is retried automatically.'],
    ],
  });
}
