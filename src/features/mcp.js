import { controller, node, lines, text, confirm } from './common.js';
import { capabilityView } from './capability-profiles.js';
import { recalledProductReview, rememberProductReview } from './product-review.js';
import { bundledServerPath, sameSettingsExceptServer } from './runtime-repair.js';
import { connectionStep, liveCheck } from './connection-assistance.js';

const clients = [
  ['codex', 'Codex', 'codex'], ['claude', 'Claude Code', 'claude'],
  ['claudeDesktop', 'Claude Desktop', 'claude_desktop'], ['antigravity', 'Antigravity', 'antigravity'], ['opencode', 'OpenCode', 'opencode'],
];
const cliPolicy = 'unity-cli-experimental-v1';
const noticeKey = 'creator-works-mcp.ai-usage-notice-hidden.v1';

export function mount(root, api) {
  root.innerHTML = `
    <div class="feature-heading"><h2>Creator Works MCP</h2><span data-field="status" role="status">Checking availability</span></div>
    <p class="feature-note">MCP is included with Creator Hub. Update Hub to get MCP updates. If your AI already connects to the right Unity project, you normally don't need to set it up again.</p>
    <section data-field="route-update" hidden></section>
    <p data-field="error" class="feature-error" role="alert" hidden></p><button data-field="retry" class="text-button" type="button" hidden>Check connection again</button>
    <section data-field="product-panel" class="feature-section" aria-label="Saved MCP settings review" hidden>
      <h3 data-field="product-title">Use your saved MCP setup</h3><p data-field="product-status" role="status">Checking your saved setup...</p>
      <ul data-field="product-summary" class="feature-note"><li>Back up your saved settings before continuing.</li><li>Keep your current preferences and saved projects.</li><li>Your Unity projects will not be changed.</li></ul>
      <div class="feature-actions product-settings-actions">
        <button data-field="product-review" data-native-action class="primary-button" type="button" disabled>Back up and continue</button>
        <button data-field="product-later" class="text-button" type="button">Back to Home</button>
      </div>
      <details data-field="product-details"><summary>Technical details</summary><p data-field="product-diagnostic" class="feature-note" hidden></p><div data-field="product-evidence" class="feature-note"></div>
        <button data-field="product-check" data-native-action class="text-button" type="button" disabled><span class="icon icon-refresh" aria-hidden="true"></span> Check again</button>
      </details>
    </section>
    <div data-field="notice" class="feature-banner"><p>AI results and token charges are unpredictable. Your AI provider controls billing. Back up projects and review generated actions.</p><label class="feature-check"><input data-field="notice-remember" type="checkbox">Don't show again</label><button data-field="notice-close" class="icon-button" type="button" title="Dismiss AI usage notice" aria-label="Dismiss AI usage notice">&#215;</button></div>
    <fieldset data-field="controls" disabled aria-label="MCP controls">
      <section data-field="runtime-repair" class="feature-section" hidden><h3>Your setup points to a different copy of MCP</h3><p>Keep it if you chose it yourself. To use the copy updated with Hub, switch below. This changes Hub's saved choice, not your Unity projects or AI app settings.</p><button data-field="repair-runtime" class="primary-button" type="button">Use MCP included with Hub</button></section>
      <div class="feature-actions feature-section"><button data-field="guide" class="text-button" type="button">Connection guide</button><button data-field="check" class="icon-button" type="button" title="Check Unity connection" aria-label="Check Unity connection"><span class="icon icon-refresh" aria-hidden="true"></span></button></div>
      <div class="feature-grid">
        <section aria-label="Unity connection">
          <div class="feature-input-row"><label>Unity project<input data-field="project" type="text" autocomplete="off" spellcheck="false"></label><button data-field="browse" class="text-button" type="button"><span class="icon icon-folder" aria-hidden="true"></span> Browse</button></div>
          <label>Recent Unity projects<select data-field="discovered"><option value="">Choose a project</option></select></label>
          <p data-field="selection" class="feature-note" role="status"></p>
          <p class="feature-note">Connecting for the first time? Tick the apps you use, then choose <strong>Set up Creator Works MCP</strong>. To update just one app for your saved project, choose <strong>Apply</strong> beside it.</p>
          <div data-field="clients"></div>
          <details><summary>Optional Unity CLI</summary><p data-field="cli-status" class="feature-note"></p><label class="feature-check"><input data-field="cli" type="checkbox" disabled><span>Also connect Unity CLI to the selected AI clients</span></label><p class="feature-note">Off by default. Experimental in Creator Hub and Unity. Requires Unity 6 and the Unity Pipeline package; this option does not install that package.</p><button data-field="cli-docs" class="text-button" type="button">Unity CLI requirements <span class="icon icon-external" aria-hidden="true"></span></button></details>
          <button data-field="setup" class="primary-button" type="button" disabled>Set up Creator Works MCP</button>
          <div data-field="setup-result" class="feature-output" role="status"></div>
        </section>
        <section class="feature-section" aria-label="Connection status"><h3 data-field="connection-heading" tabindex="-1">Connection status</h3><p data-field="checked-project" class="feature-note"></p>
          <label>AI app to check<select data-field="assist-client"><option value="">Choose an AI app</option></select></label>
          <p data-field="assist-message" role="status"></p>
          <div class="feature-actions"><button data-field="assist-action" class="primary-button" type="button">Check this project</button>
          <button data-field="assist-copy" class="text-button" type="button" hidden>Copy read-only check</button>
          <button data-field="assist-relink" class="text-button" type="button" hidden>My AI opens the wrong project</button></div>
          <details data-field="assist-details"><summary>Connection details and read-only check</summary><div data-field="checks"></div><p data-field="assist-prompt" class="feature-note" tabindex="-1"></p></details>
          <p data-field="assist-result" class="feature-note" role="status"></p>
        </section>
      </div>
      <section class="feature-section" aria-label="Saved Unity projects"><div class="feature-heading"><h3>Unity projects</h3><div class="feature-actions"><button data-field="add" class="text-button" type="button"><span class="icon icon-folder" aria-hidden="true"></span> Add project</button><button data-field="bridges" class="text-button" type="button">Update bridges</button></div></div><div class="feature-actions"><p data-field="sdk-latest" class="feature-note" role="status">Latest Creator SDK not checked.</p><button data-field="sdk-check" class="text-button" type="button"><span class="icon icon-refresh" aria-hidden="true"></span> Check latest SDK</button></div><div data-field="projects"></div></section>
      <section class="feature-section" aria-label="Local project feedback"><div class="feature-heading"><h3>Local project feedback</h3><button data-field="feedback-check" class="icon-button" type="button" title="Check project feedback preferences" aria-label="Check project feedback preferences" disabled><span class="icon icon-refresh" aria-hidden="true"></span></button></div>
        <label class="feature-check"><input data-field="feedback-enabled" type="checkbox" disabled><span>Enable local feedback for this Unity project</span></label>
        <label class="feature-check"><input data-field="feedback-usage" type="checkbox" disabled><span>Enable optional usage check-ins</span></label>
        <p data-field="feedback-status" class="feature-note" role="status">Select and check a Unity project. Local only; nothing is uploaded automatically.</p><div data-field="feedback-error" class="feature-error" role="alert" hidden></div>
        <button data-field="feedback-save" class="text-button" type="button" disabled>Save project feedback preferences</button>
      </section>
      <details class="feature-section"><summary>Existing client connections and recovery</summary><p class="feature-note">Review only the clients selected above. Native review keeps backups and asks before changing existing entries.</p><button data-field="review" class="text-button" type="button">Review selected connections</button><button data-field="recovery-check" class="text-button" type="button">Check interrupted changes</button><div data-field="recovery"></div><button data-field="recover" class="text-button" type="button" disabled>Review and resume eligible changes</button></details>
      <details class="feature-section"><summary>Advanced settings</summary>
        <button data-field="product-review-advanced" class="text-button" type="button">Review saved MCP settings</button>
        <label>MCP server path<input data-field="server" type="text" autocomplete="off" spellcheck="false"></label>
        <label>Capabilities<select data-field="groups"><option value="auto">Auto (project SDK)</option><option value="core">Token Saver</option><option value="all">All tools (high context)</option><option value="read">Inspection</option><option value="core,creator">Altspace / Creator SDK</option><option value="core,banter">Banter</option><option value="core,banter,creator">Altspace + Banter</option><option value="core,shadergraph">Shader Graph preview</option><option value="core,author">Unity authoring</option><option value="core,test">Testing</option><option value="none">Minimal routing</option></select></label>
        <p data-field="capability-status" class="feature-note" role="status"></p>
        <label class="feature-check"><input data-field="follow" type="checkbox"><span>Follow active project</span></label>
        <label class="feature-check"><input data-field="scripts" type="checkbox"><span>Allow custom script components</span></label>
        <label class="feature-check"><input data-field="tests" type="checkbox"><span>Allow running all project tests</span></label>
        <button data-field="save" class="text-button" type="button">Save options</button>
        <button data-field="bridge" class="text-button" type="button">Install or update bridge for selected project</button>
      </details>
    </fieldset>
    <dialog data-field="guide-dialog" class="feature-dialog" aria-labelledby="feature-mcp-guide-title"><h3 id="feature-mcp-guide-title">Connect your AI to Unity</h3><p>New here? Set up a connection. Already using MCP? Check your existing connection before changing it.</p><ol data-field="guide-steps"></ol><div data-field="guide-error" class="feature-error" role="alert" hidden></div><div class="feature-actions"><button data-field="guide-help" class="text-button" type="button">Help &amp; troubleshooting</button><button data-field="guide-skip" class="text-button" type="button">I already use MCP</button><button data-field="guide-start" class="primary-button" type="button">Set up a connection</button></div></dialog>`;
  const page = controller(root, api, 'mcp'); const $ = page.field;
  const disposeRouteNotice = window.CreatorMcpRouteUpdate.mount($('route-update'), api.mcpRouteUpdate?.(), { mcpPage: true });
  const disposePage = page.dispose;
  let config = null;
  let onboarding = null;
  const manualClientChoices = new Map();
  let cliTouched = false;
  let cliConsent = null;
  let recovery = [];
  let productReport = null;
  let productIssue = false;
  let productReviewed = false;
  let feedbackProject = null;
  let feedbackRequest = 0;
  let connectionRequest = 0;
  const optionBaseline = new Map();
  const appliedUnityOptions = new Map();
  const projectChecks = new Map();
  let latestSdkRequest = 0;
  let disposed = false;
  const clientUi = new Map();
  $('assist-prompt').textContent = liveCheck;
  for (const [id, label] of clients) { const option = node('option', label); option.value = id; $('assist-client').append(option); }
  function assistance() {
    const id = $('assist-client').value;
    return connectionStep({ status: onboarding, project: $('project').value, activePath: active()?.unity_project_path,
      client: onboarding?.clients?.find(item => item.id === id), label: clients.find(([key]) => key === id)?.[1],
      canApply: clientUi.get(id)?.apply.disabled === false, differentRuntime: !$('runtime-repair').hidden });
  }
  function canRelink(step) {
    const id = $('assist-client').value;
    if (id === 'claude' && ['present', 'unreadable'].includes(onboarding?.project?.claudeProjectEntry)) return false;
    return step === 'prompt' && $('runtime-repair').hidden && clientUi.get(id)?.apply.disabled === false
      && active()?.unity_project_path === $('project').value && onboarding?.clients?.some(c => c.id === id && c.configured === true && !c.issue && c.supported !== false);
  }
  const active = () => config?.channels?.find(channel => channel.id === config.active_channel_id);
  function syncProjectPicker() {
    const path = $('project').value;
    $('discovered').value = [...$('discovered').options].some(option => option.value === path) ? path : '';
  }
  const selectedClients = () => clients.filter(([id]) => clientUi.get(id).checkbox.checked);
  const checkedClient = state => !!state && !state.issue && state.supported === true && typeof state.configured === 'boolean';
  const run = async (action, label) => { const result = await page.run(action, label); controls(); return result; };
  function requireReload(reason) {
    invalidateConnection(); page.lock(true); $('retry').hidden = false;
    throw new Error(`${text(reason)} Earlier steps may remain. Check connection again to reload saved settings before another change.`);
  }
  async function saveConfig(next) {
    try { await page.call('save_config', { config: next }); }
    catch (reason) { requireReload(reason); }
    config = next;
  }
  function localError(name, message, reason) {
    const details = node('details');
    details.append(node('summary', 'Technical details'), node('p', text(reason)));
    $(name).replaceChildren(node('p', message), details);
    $(name).hidden = false;
  }
  function productVisibility() {
    const required = productReport && (['legacy-only', 'conflict'].includes(productReport.status)
      || productReport.recovery.some(item => !item.historical_completed));
    $('product-panel').hidden = !required && !productIssue;
  }
  function productError(reason) {
    productReviewed = false; page.lock(true);
    productIssue = true;
    $('product-title').textContent = 'Your saved setup needs a check';
    $('product-status').textContent = page.needsRestart()
      ? 'Hub could not confirm that the last step finished. Close and reopen Hub before trying again. Your saved files are kept.'
      : 'We could not finish checking your settings. Your existing files are kept. Try again, or return Home and continue later.';
    $('product-diagnostic').textContent = text(reason); $('product-diagnostic').hidden = false;
    $('product-details').open = false;
    $('error').textContent = page.needsRestart() ? 'Close and reopen Hub before continuing. Your saved files are kept.'
      : 'Your saved setup could not be checked. Try Check connection again, or return Home for now.';
    $('error').hidden = false;
    productVisibility();
  }
  function renderProductSettings(report, recall = true) {
    if (!report || !['none', 'current', 'identical', 'legacy-only', 'conflict'].includes(report.status)
      || !Array.isArray(report.backups) || !Array.isArray(report.recovery)) throw new Error('Saved settings status is incomplete. Originals were not changed.');
    productReport = report;
    const interrupted = report.recovery.some(item => !item.historical_completed);
    if (interrupted) productReviewed = false;
    else if (recall && ['legacy-only', 'conflict'].includes(report.status)) {
      productReviewed = recalledProductReview(report, localStorage);
    }
    const reviewMessage = productReviewed ? 'Your saved setup is ready. Your original files and backups are kept.' : '';
    const messages = { none: 'No previous MCP setup was found.', current: 'Your current MCP settings are ready.', identical: 'Your saved setups match. Both copies will be kept.',
      'legacy-only': 'Your previous MCP setup is available. Back it up to continue.',
      conflict: 'We found two saved setups. Continue with your current preferences and projects; the older copy will be kept.' };
    $('product-title').textContent = interrupted ? 'Finish checking your saved setup' : productReviewed ? 'Saved MCP setup' : 'Use your saved MCP setup';
    $('product-status').textContent = interrupted ? 'An earlier settings change did not finish. Review it to continue safely, or return Home for now.' : reviewMessage || messages[report.status];
    $('product-diagnostic').hidden = true;
    $('product-review').textContent = interrupted ? 'Review and continue' : productReviewed ? 'Review saved setup' : 'Back up and continue';
    $('product-summary').hidden = productReviewed && !interrupted;
    lines($('product-evidence'), [report.currentPath ? `Current: ${report.currentPath}` : null, report.legacyPath ? `Older settings: ${report.legacyPath}` : null,
      report.evidencePath ? `Evidence: ${report.evidencePath}` : null,
      ...report.backups.map(path => `Retained backup: ${path}`),
      ...report.recovery.flatMap(item => [`Recovery journal: ${item.journal}${item.history_only ? ' (completed history from another settings location; read-only)' : item.historical_completed ? ' (completed history)' : ' (requires review)'}`,
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
    $('product-later').disabled = page.busy();
    const ready = onboarding?.runtime?.ready && onboarding?.project?.valid;
    const selection = config?.tool_groups || 'core';
    const capabilities = capabilityView(selection, onboarding?.project);
    const draft = capabilityView($('groups').value, onboarding?.project);
    const profileDirty = $('groups').value !== selection;
    $('groups').querySelector('option[value="auto"]').textContent = draft.autoLabel;
    $('capability-status').textContent = profileDirty ? 'Capabilities changed. Save options before applying them.' : capabilities.status;
    const selected = active();
    const server = bundledServerPath(onboarding);
    $('runtime-repair').hidden = !server || !config || config.mcp_server_path?.replaceAll('\\', '/') === server;
    $('selection').textContent = selected ? `Selected for MCP: ${selected.name} (${selected.unity_project_path}).` : 'No saved project selected for MCP.';
    if ($('project').value && $('project').value !== selected?.unity_project_path) $('selection').textContent += ` Setup draft: ${$('project').value} (not selected for MCP).`;
    $('setup').disabled = !ready || !selectedClients().length || profileDirty || !capabilities.ready;
    $('add').disabled = !$('project').value.trim();
    $('bridge').disabled = !onboarding?.project?.valid;
    for (const [id, ui] of clientUi) {
      const state = onboarding?.clients?.find(client => client.id === id);
      ui.checkbox.disabled = !checkedClient(state);
      ui.apply.disabled = !ready || !active() || !checkedClient(state) || active().unity_project_path !== $('project').value || profileDirty || !capabilities.ready;
      ui.disconnect.disabled = !checkedClient(state) || !state.configured;
    }
    $('cli').disabled = !onboarding?.unityCli?.canEnable && !onboarding?.unityCli?.enabled;
    $('recover').disabled = !recovery.some(item => item.canResume);
    const feedbackReady = feedbackProject !== null && feedbackProject === $('project').value && onboarding?.project?.valid;
    $('feedback-enabled').disabled = !feedbackReady;
    $('feedback-usage').disabled = !feedbackReady || !$('feedback-enabled').checked;
    $('feedback-save').disabled = !feedbackReady;
    $('feedback-check').disabled = !onboarding?.project?.valid;
    const [step, message, action] = assistance();
    $('assist-message').textContent = message;
    $('assist-action').textContent = action;
    $('assist-copy').hidden = !['connect', 'runtime', 'client-status', 'setup'].includes(step);
    const checkFirst = step === 'connect' && $('assist-client').value === 'claude';
    for (const [button, primary] of [[$('assist-copy'), checkFirst], [$('assist-action'), !checkFirst]]) {
      button.classList.toggle('primary-button', primary);
      button.classList.toggle('text-button', !primary);
      if (primary && button.previousElementSibling) button.parentElement.prepend(button);
    }
    $('assist-relink').hidden = !canRelink(step);
  }
  function renderStatus(value) {
    const projectKnown = typeof value?.project?.valid === 'boolean' || (value?.project === null && !$('project').value.trim());
    if (typeof value?.runtime?.ready !== 'boolean' || !projectKnown || !Array.isArray(value.clients)) throw new Error('Connection status is incomplete. Check again.');
    onboarding = value;
    $('checked-project').textContent = `Checked project: ${$('project').value || 'None'}`;
    const p = value.project;
    const rows = [['Private runtime', value.runtime.ready ? 'Ready' : 'Unavailable', value.runtime.ready],
      ['Unity project', p?.valid ? 'Valid' : $('project').value ? 'Invalid' : 'Not selected', p?.valid],
      ['SDK profile', p?.sdkProfile?.label || 'Not selected', !p?.sdkProfile?.error && p?.sdkProfile?.profile && !['none', 'unknown'].includes(p.sdkProfile.profile)],
      ['Unity bridge', !p?.valid ? 'Not checked' : p.bridgeCurrent ? p.stateStatus === 'fresh' ? 'Recent Unity state found' : 'Installed; open Unity and check again' : p.bridgeInstalled ? 'Update available' : 'Not installed', p?.valid && p.bridgeCurrent && p.stateStatus === 'fresh']];
    $('checks').replaceChildren(...rows.map(([name, value, ready]) => { const row = node('div', null, 'feature-row'); row.append(node('span', name), node('span', value, ready ? 'feature-good' : 'feature-warn')); return row; }));
    for (const [id, ui] of clientUi) {
      const state = value.clients.find(client => client.id === id);
      const scopeStatus = id === 'claude'
        ? (state?.configured ? 'Configured for your user' : 'No user-level setup found')
        : (state?.configured ? 'Configured' : 'Not configured');
      const projectEntry = id === 'claude' ? p?.claudeProjectEntry : null;
      const projectNote = projectEntry === 'present' ? 'Project entry found' : projectEntry === 'unreadable' ? 'Project settings could not be checked' : '';
      const userStatus = !checkedClient(state) ? (state?.issue || 'Connection status not verified') : scopeStatus;
      ui.status.textContent = state?.supported === false ? 'Not available on this OS' : [state?.detected ? 'Detected' : state ? 'Not detected' : '', projectNote, userStatus].filter(Boolean).join(' · ');
      ui.checkbox.checked = checkedClient(state) && (manualClientChoices.get(id) ?? Boolean(state.configured || (state.detected && !projectNote)));
    }
    $('cli-status').textContent = value.unityCli?.message || 'Optional Unity CLI is unavailable.';
    if (!cliTouched) {
      $('cli').checked = value.unityCli?.enabled === true;
      cliConsent = config?.unity_cli_consent_version === cliPolicy ? cliPolicy : null;
    }
    const steps = [
      !value.runtime.ready ? 'Hub could not find its built-in MCP tools. Check for a Hub update before changing client settings.' : 'Hub found its built-in MCP tools.',
      !p?.valid ? 'Select the Unity project folder containing Assets, Packages and ProjectSettings. Use Project Setup if you need a new project.' : !p.bridgeCurrent ? 'Review setup to install or update the Unity bridge.' : p.stateStatus !== 'fresh' ? 'Open the project in Unity, let it compile, fix Console errors and check again.' : 'Recent Unity state files were found. A live connection has not been verified.',
      'For a new connection, tick the AI apps you use and review setup. Claude Code and Claude Desktop are separate choices. For an existing connection, check it in your AI app first.',
      'Ask your AI to call get_bridge_status for this project. Saved settings alone do not prove the AI client loaded MCP.',
    ];
    $('guide-steps').replaceChildren(...steps.map(step => node('li', step))); controls();
  }
  function clearFeedback(message) {
    ++feedbackRequest; feedbackProject = null;
    $('feedback-enabled').checked = false; $('feedback-usage').checked = false;
    $('feedback-error').hidden = true; $('feedback-status').textContent = message;
    controls();
  }
  async function readFeedback(project = $('project').value) {
    clearFeedback('Checking local preferences for this project. Nothing is uploaded automatically.');
    if (!project.trim() || project !== $('project').value || !onboarding?.project?.valid) {
      $('feedback-status').textContent = 'Select and check a valid Unity project before changing local feedback.';
      return false;
    }
    const request = feedbackRequest;
    try {
      const result = await page.call('get_project_feedback_settings', { unityProjectPath: project });
      if (request !== feedbackRequest || project !== $('project').value) return false;
      if (typeof result?.enabled !== 'boolean' || typeof result.usageCheckIns !== 'boolean'
        || typeof result.file !== 'string' || !result.file || (!result.enabled && result.usageCheckIns)) throw new Error('Project feedback response is incomplete. Preferences were not changed by this check.');
      feedbackProject = project;
      $('feedback-enabled').checked = result.enabled; $('feedback-usage').checked = result.usageCheckIns;
      $('feedback-status').textContent = result.enabled ? `Local feedback: ${result.file}` : 'Local feedback is off for this project. Nothing is uploaded automatically.';
      controls(); return true;
    } catch (reason) {
      if (request === feedbackRequest && project === $('project').value) {
        $('feedback-status').textContent = 'Preferences could not be verified. Check project feedback before saving.';
        localError('feedback-error', 'Feedback preferences could not be checked. Try Check project feedback again.', reason);
      }
      return false;
    }
  }
  function invalidateConnection() {
    ++connectionRequest; onboarding = null;
    $('assist-result').textContent = '';
    $('checked-project').textContent = `Not checked: ${$('project').value || 'No project selected'}`;
    $('checks').replaceChildren();
    for (const ui of clientUi.values()) ui.status.textContent = 'Not checked';
    $('cli-status').textContent = 'Check the project connection before changing Unity CLI.';
    $('guide-steps').replaceChildren(node('li', 'Check the selected project connection again. Previous connection status is no longer current.'));
    clearFeedback('Check the Unity connection before changing local feedback.');
  }
  async function check() {
    const project = $('project').value;
    syncProjectPicker();
    invalidateConnection();
    const request = connectionRequest;
    const result = await page.call('get_onboarding_status', { unityProjectPath: project || null });
    if (request !== connectionRequest || project !== $('project').value) return;
    renderStatus(result); await readFeedback(project);
  }
  async function followActive(channel) {
    if (!config.auto_start || !channel) return;
    const target = channel.unity_project_path === $('project').value ? onboarding
      : await page.call('get_onboarding_status', { unityProjectPath: channel.unity_project_path });
    if (!target?.project?.valid || !Array.isArray(target.clients)) throw new Error('Check the selected MCP project before updating its clients.');
    const capabilities = capabilityView(config.tool_groups || 'core', target.project);
    if (!capabilities.ready) throw new Error(capabilities.status);
    for (const [id, , commandId] of clients) {
      const client = target.clients.find(item => item.id === id);
      if (checkedClient(client) && client.configured) await page.call(`update_${commandId}_mcp_config`, {
        channel, mcpServerPath: config.mcp_server_path, toolGroups: config.tool_groups || 'core',
      });
    }
  }
  function renderProjects() {
    $('projects').replaceChildren(...config.channels.map(channel => {
      const selected = channel.id === config.active_channel_id;
      const row = node('div', null, 'feature-project');
      row.dataset.selected = String(selected);
      row.dataset.projectPath = channel.unity_project_path;
      const select = node('button', null, 'feature-project-select'); select.type = 'button';
      select.setAttribute('aria-pressed', String(selected));
      select.setAttribute('aria-label', `Select ${channel.name} for MCP`);
      select.title = channel.unity_project_path;
      const indicator = node('span', null, 'feature-project-indicator'); indicator.setAttribute('aria-hidden', 'true');
      const info = node('span', null, 'feature-project-info');
      info.append(node('strong', channel.name), node('span', channel.unity_project_path, 'feature-note'));
      select.append(indicator, info);
      const meta = node('div', null, 'feature-project-meta');
      if (selected) meta.append(node('span', 'Selected for MCP', 'feature-project-badge feature-good'));
      const checked = projectChecks.get(channel.unity_project_path);
      meta.append(node('span', checked?.sdk || 'Checking SDK', 'feature-project-badge feature-note'));
      if (checked?.sdkUntested) meta.append(node('span', 'Not yet tested with Hub', 'feature-project-badge feature-note'));
      if (checked?.sdkIssue) {
        const issue = node('span', 'Package versions need review', 'feature-project-badge feature-warn');
        issue.title = 'The SDK was found. Review package versions in Setup / Repair; project files have not been changed.';
        meta.append(issue);
      }
      const badge = node('span', checked?.bridge || 'Checking bridge', `feature-project-badge ${checked?.current ? 'feature-good' : 'feature-warn'}`);
      if (checked?.issue) badge.title = checked.issue;
      meta.append(badge);
      page.on(select, 'click', () => run(async () => {
        const next = { ...config, active_channel_id: channel.id };
        await saveConfig(next); $('project').value = channel.unity_project_path; renderProjects(); await check(); await followActive(channel);
      }, 'Selecting project'));
      const remove = node('button', null, 'icon-button'); remove.type = 'button'; remove.title = 'Remove from saved projects'; remove.setAttribute('aria-label', `Remove ${channel.name} from saved projects`); remove.textContent = '×';
      page.on(remove, 'click', () => run(async () => {
        if (!await confirm(page, { title: 'Remove saved project?', detail: `Remove ${channel.name} from this list? Project files and AI client settings are not deleted.`, accept: 'Remove from list' })) return;
        const remaining = config.channels.filter(item => item.id !== channel.id);
        const next = { ...config, channels: remaining, active_channel_id: config.active_channel_id === channel.id ? remaining[0]?.id || null : config.active_channel_id };
        await saveConfig(next); $('project').value = active()?.unity_project_path || ''; renderProjects(); await check();
      }, 'Updating saved projects'));
      row.append(select, meta, remove); return row;
    }));
    if (!config.channels.length) $('projects').append(node('p', 'No saved Unity projects.', 'feature-note'));
  }
  async function checkProjectBadges() {
    for (const channel of config.channels) {
      const result = { sdk: 'SDK unavailable', bridge: 'Bridge not checked', current: false };
      try {
        const status = await page.call('get_unity_extension_status', { unityProjectPath: channel.unity_project_path });
        if (typeof status?.installed !== 'boolean' || typeof status?.current !== 'boolean' || (status.current && !status.installed)) throw new Error('Bridge status is incomplete.');
        result.bridge = status.current ? 'Bridge current' : status.installed ? 'Bridge update available' : 'Bridge not installed';
        result.current = status.current;
      } catch (reason) { result.issue = text(reason); }
      try {
        const profile = await page.call('get_project_sdk_profile', { unityProjectPath: channel.unity_project_path });
        if (typeof profile?.label === 'string' && profile.label) result.sdk = profile.label;
        result.sdkIssue = Boolean(profile?.error && ['creator', 'banter', 'hybrid'].includes(profile.profile));
        result.sdkUntested = profile?.creatorSdkTested === false;
      } catch { /* Bridge and SDK checks are independent. */ }
      projectChecks.set(channel.unity_project_path, result);
      renderProjects();
    }
  }
  async function checkLatestSdk() {
    if (disposed || $('sdk-check').disabled) return;
    const request = ++latestSdkRequest;
    $('sdk-check').disabled = true;
    $('sdk-latest').textContent = 'Checking latest Creator SDK...';
    let timer;
    try {
      const value = await Promise.race([
        api.invoke('feature_call', { feature: 'setup', command: 'latest_sdk_requirements', args: {} }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SDK lookup timed out.')), 20000); }),
      ]);
      if (disposed || request !== latestSdkRequest) return;
      if (typeof value?.version !== 'string' || value.version.length > 128
        || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value.version)) throw new Error('Invalid SDK version.');
      $('sdk-latest').textContent = `Latest Creator SDK: ${value.version}`;
    } catch {
      if (!disposed && request === latestSdkRequest) $('sdk-latest').textContent = 'Latest SDK could not be checked. Installed versions are still shown below.';
    } finally {
      clearTimeout(timer);
      if (!disposed && request === latestSdkRequest) $('sdk-check').disabled = false;
    }
  }
  page.on($('sdk-check'), 'click', checkLatestSdk);
  async function reload() {
    try { await loadSettings(); $('retry').hidden = true; }
    catch (reason) { $('retry').hidden = false; throw reason; }
  }
  function loadOption(name, value, property = 'value') {
    const input = $(name);
    if (!optionBaseline.has(name) || input[property] === optionBaseline.get(name)) input[property] = value;
    optionBaseline.set(name, value);
  }
  async function loadSettings() {
    page.lock(true);
    try {
      config = await page.call('load_config');
      if (!Array.isArray(config?.channels)) throw new Error('Saved MCP configuration is incomplete. Nothing was changed.');
    } catch (reason) { productError(reason); throw reason; }
    const discovered = await page.call('discover_unity_projects');
    if (!Array.isArray(discovered)) throw new Error('Project discovery returned an invalid list.');
    if (!$('project').value) $('project').value = active()?.unity_project_path || discovered[0]?.path || '';
    const placeholder = node('option', 'Choose a project'); placeholder.value = '';
    const known = new Map();
    for (const item of [...config.channels.map(channel => ({ name: channel.name, path: channel.unity_project_path })), ...discovered]) {
      if (!known.has(item.path)) known.set(item.path, item);
    }
    $('discovered').replaceChildren(placeholder, ...[...known.values()].map(item => { const option = node('option', item.name); option.value = item.path; return option; }));
    loadOption('server', config.mcp_server_path || '');
    const groups = config.tool_groups || 'core';
    if (![...$('groups').options].some(option => option.value === groups)) { const option = node('option', `Current: ${groups}`); option.value = groups; $('groups').append(option); }
    loadOption('groups', groups); loadOption('follow', config.auto_start === true, 'checked');
    loadOption('scripts', config.enable_custom_scripts === true, 'checked'); loadOption('tests', config.allow_all_tests !== false, 'checked');
    renderProjects(); await check(); await checkProjectBadges(); productIssue = false; productVisibility(); page.lock(false);
  }
  for (const [id, label, commandId] of clients) {
    const row = node('div', null, 'feature-client');
    const name = node('label', null, 'feature-check');
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.client = id;
    name.append(checkbox, node('span', label));
    const status = node('span', 'Not checked', 'feature-note'); status.tabIndex = -1;
    const actions = node('div', null, 'feature-actions');
    const apply = node('button', 'Apply', 'text-button'); apply.type = 'button'; apply.setAttribute('aria-label', `Apply to ${label}`);
    const disconnect = node('button', 'Disconnect', 'text-button'); disconnect.type = 'button'; disconnect.setAttribute('aria-label', `Disconnect ${label}`);
    actions.append(apply, disconnect); row.append(name, status, actions); $('clients').append(row);
    clientUi.set(id, { checkbox, status, apply, disconnect });
    page.on(checkbox, 'change', () => { manualClientChoices.set(id, checkbox.checked); controls(); });
    page.on(apply, 'click', () => run(async () => {
      if (apply.disabled) return;
      $('setup-result').textContent = '';
      await check();
      if (apply.disabled) throw new Error('This connection changed. Check the project and app before applying.');
      await checkSavedConfig();
      await changeClient(id, commandId, true);
      $('setup-result').textContent = `${label} settings saved. Fully quit and reopen ${label}, then check the connection.`;
    }, `Configuring ${label}`));
    page.on(disconnect, 'click', () => run(async () => {
      if (disconnect.disabled) return;
      if (!await confirm(page, { title: `Disconnect ${label}?`, detail: 'Remove the Creator Works MCP entry only. Optional Unity CLI and unrelated servers are separate.', accept: 'Disconnect' })) return;
      $('setup-result').textContent = '';
      await check();
      if (disconnect.disabled) throw new Error('This connection changed. Check the app before disconnecting.');
      await changeClient(id, commandId, false);
    }, `Disconnecting ${label}`));
  }
  async function applyClient(commandId) {
    const channel = active();
    if (!onboarding || !channel || channel.unity_project_path !== $('project').value) throw new Error('Check this saved project or run reviewed setup first.');
    if ($('groups').value !== (config.tool_groups || 'core')) throw new Error('Save the changed capability profile before applying it.');
    const capabilities = capabilityView(config.tool_groups || 'core', onboarding.project);
    if (!capabilities.ready) throw new Error(capabilities.status);
    await page.call(`update_${commandId}_mcp_config`, { channel, mcpServerPath: config.mcp_server_path, toolGroups: config.tool_groups || 'core' });
  }
  async function checkSavedConfig() {
    const saved = await page.call('load_config');
    if (!sameSettingsExceptServer(config, saved) || config.mcp_server_path !== saved.mcp_server_path) requireReload('Saved settings changed during review.');
  }
  async function changeClient(id, commandId, connect) {
    try {
      if (connect) await applyClient(commandId);
      else await page.call(`remove_${commandId}_mcp_config`);
      await check();
    } catch (reason) { requireReload(reason); }
    const state = onboarding?.clients?.find(client => client.id === id);
    if (!checkedClient(state) || state.configured !== connect) requireReload('Hub could not confirm the change. Check again before trying another change.');
  }
  page.on($('project'), 'input', () => { syncProjectPicker(); invalidateConnection(); });
  page.on($('groups'), 'change', controls);
  page.on($('feedback-enabled'), 'change', () => { if (!$('feedback-enabled').checked) $('feedback-usage').checked = false; controls(); });
  page.on($('feedback-check'), 'click', () => run(() => readFeedback(), 'Checking project feedback'));
  page.on($('feedback-save'), 'click', async () => {
    if (page.busy() || feedbackProject === null || feedbackProject !== $('project').value || !onboarding?.project?.valid) return;
    const project = feedbackProject;
    const enabled = $('feedback-enabled').checked;
    const usageCheckIns = enabled && $('feedback-usage').checked;
    const saved = await run(async () => {
      if (project !== $('project').value || feedbackProject !== project || !onboarding?.project?.valid) throw new Error('Project changed before feedback could be saved. Check the selected project first.');
      clearFeedback('Saving project feedback preferences.');
      try {
        await page.call('set_project_feedback_settings', { unityProjectPath: project, enabled, usageCheckIns });
      } catch (reason) {
        $('feedback-status').textContent = 'Save failed or its outcome is unknown. Check project feedback before trying another save.';
        localError('feedback-error', 'Feedback preferences could not be confirmed. Check them before saving again. Earlier completed changes may remain.', reason);
        throw reason;
      }
      if (!await readFeedback(project)) throw new Error('Project feedback preferences could not be verified after saving. Check them before retrying; earlier changes may remain.');
      if ($('feedback-enabled').checked !== enabled || $('feedback-usage').checked !== usageCheckIns) throw new Error('Read-back feedback preferences differ from the requested values. Review the displayed project preferences before another save.');
    }, 'Saving project feedback');
    if (saved && feedbackProject === project) $('feedback-status').textContent += ' Preferences saved and checked.';
  });
  page.on($('check'), 'click', () => run(async () => { await check(); await checkProjectBadges(); }, 'Checking connection'));
  page.on($('assist-client'), 'change', () => { $('assist-result').textContent = ''; controls(); });
  async function copyConnectionCheck() {
    $('assist-details').open = true;
    try { await navigator.clipboard.writeText(liveCheck); $('assist-result').textContent = 'Copied. Paste the check into your AI app.'; }
    catch { $('assist-prompt').focus(); $('assist-result').textContent = 'Copy the question under Connection details and paste it into your AI app.'; }
  }
  page.on($('assist-copy'), 'click', copyConnectionCheck);
  async function assist(relink) {
    if ($('controls').disabled) return;
    const [action] = assistance();
    if (relink && !canRelink(action)) return;
    if (action === 'home') { api.openHome(); return; }
    if (action === 'browse' || action === 'check') { $(action).click(); return; }
    if (action === 'setup') { ($('setup').disabled ? $('project') : $('setup')).focus(); return; }
    if (action === 'runtime') { $('repair-runtime').click(); return; }
    if (action === 'client-status') { clientUi.get($('assist-client').value)?.status.focus(); return; }
    if (action === 'prompt' && !relink) { await copyConnectionCheck(); return; }
    const project = $('project').value, id = $('assist-client').value;
    const client = clients.find(([key]) => key === id);
    const connecting = action === 'connect' || relink;
    if (!(connecting && client) && !['install', 'update'].includes(action)) return;
    await run(async () => {
      const title = relink ? `Use this project in ${client[1]}?` : connecting ? `Connect ${client[1]}?` : action === 'install' ? 'Add the Unity bridge?' : 'Update the Unity bridge?';
      const detail = connecting ? `Set the user-level connection for ${client[1]} to the project shown here. Other AI apps and project-specific settings files are not changed. If the app uses a project-specific connection, it can still use that connection instead.`
        : 'Hub will write its bridge script and logo in Assets/Editor. An existing bridge script is backed up before replacement. AI app settings are not changed.';
      if (!await confirm(page, { title, detail: `Project: ${project}\n${detail}`, accept: relink ? 'Use this project' : connecting ? 'Connect this app' : 'Apply bridge change' })) return;
      await check();
      if ($('project').value !== project || $('assist-client').value !== id || assistance()[0] !== action || (relink && !canRelink(action))) {
        $('assist-result').textContent = 'The connection status changed. Review the new result; nothing was applied.'; return;
      }
      if (connecting) {
        await checkSavedConfig();
        await changeClient(id, client[2], true);
      } else {
        try {
          await page.call('install_unity_extension', { unityProjectPath: project });
          await check();
        } catch (reason) { requireReload(reason); }
        if (onboarding?.project?.bridgeCurrent !== true || onboarding.project.bridgeInstalled !== true) requireReload('Hub could not confirm the change. Do not repeat it until you have checked the connection again.');
      }
      if (project !== $('project').value || id !== $('assist-client').value) return;
      $('assist-result').textContent = connecting ? `Settings saved. Fully quit and reopen ${client[1]}, then try the read-only check.`
        : 'Bridge verified. Open the project in Unity and let it finish compiling, then check again.';
    }, 'Helping with the connection');
  }
  page.on($('assist-action'), 'click', () => assist(false));
  page.on($('assist-relink'), 'click', () => assist(true));
  page.on($('retry'), 'click', () => { if (!page.busy()) void api.retry('mcp'); });
  page.on($('product-check'), 'click', () => run(inspectProductSettings, 'Inspecting saved settings'));
  page.on($('product-later'), 'click', () => { if (!page.busy()) api.openHome(); });
  async function reviewProductSettings() {
    if (page.busy()) return;
    const wasReady = page.initialized && !$('controls').disabled && !productIssue;
    const wasReviewed = productReviewed;
    let keepReady = false;
    productReviewed = false;
    page.lock(true);
    productIssue = true; productVisibility();
    const reviewed = await run(async () => {
      const report = await page.call('review_product_settings');
      renderProductSettings(report, false);
      if (typeof report.approved !== 'boolean') throw new Error('Settings review outcome is unknown. Check retained settings before continuing.');
      // Report.status/backups alone cannot distinguish a native cancellation.
      if (report.approved !== true) {
        keepReady = wasReady && ['none', 'current', 'identical'].includes(report.status)
          && report.recovery.every(item => item.historical_completed);
        $('product-status').textContent = keepReady ? 'Review stopped. Earlier completed changes may remain. Your current setup is still ready.'
          : 'Review stopped. Earlier completed changes may remain. Continue when you are ready, or return Home for now.';
        return;
      }
      if (report.recovery.some(item => !item.historical_completed)) throw new Error('Settings recovery still needs review. Nothing was reset.');
      await reload();
    }, 'Reviewing saved settings');
    if (!reviewed) productError(page.errorMessage());
    if (reviewed && keepReady) {
      productReviewed = wasReviewed; productIssue = false; productVisibility(); page.lock(false);
    }
    if (reviewed && productReport?.approved === true && !$('controls').disabled) {
      try {
        if (['legacy-only', 'conflict'].includes(productReport.status)) rememberProductReview(productReport, localStorage);
      } catch (reason) { productError(reason); return; }
      productReviewed = true;
      $('product-title').textContent = 'Saved MCP setup';
      $('product-status').textContent = 'Your saved setup is ready. Your original files and backups are kept.';
      $('product-summary').hidden = true;
      $('product-review').textContent = 'Review saved setup';
      $('retry').hidden = true;
      page.initialized = true; api.changed();
    }
  }
  page.on($('product-review'), 'click', reviewProductSettings);
  page.on($('product-review-advanced'), 'click', reviewProductSettings);
  page.on($('repair-runtime'), 'click', async () => {
    let changed = false;
    const repaired = await run(async () => {
      const server = bundledServerPath(onboarding);
      if (!server || !config) throw new Error('Hub could not verify its bundled runtime. Your saved setup was kept.');
      if (!await confirm(page, { title: 'Use Hub MCP runtime?', detail: 'Only the saved MCP server location will change. Hub keeps a backup, your projects and preferences stay the same, and the older settings copy is not changed. AI-client connections and Unity files are not changed.', accept: 'Use Hub runtime' })) return;
      const before = await page.call('load_config');
      if (!sameSettingsExceptServer(config, before) || config.mcp_server_path !== before.mcp_server_path) {
        productError('Your settings changed. Check your saved setup before trying again.');
        requireReload('Your settings changed. Check your saved setup before trying again.');
      }
      const status = await page.call('get_onboarding_status', { unityProjectPath: null });
      if (bundledServerPath(status) !== server) throw new Error('Hub runtime changed during review. Your setup was kept.');
      const next = { ...before, mcp_server_path: server };
      await saveConfig(next);
      let after;
      try { after = await page.call('load_config'); }
      catch (reason) { productError(reason); requireReload(reason); }
      if (!sameSettingsExceptServer(before, after) || after.mcp_server_path?.replaceAll('\\', '/') !== server) {
        productError('The saved runtime location could not be confirmed.');
        requireReload('The saved runtime location could not be confirmed.');
      }
      config = after;
      changed = true;
      await reload();
      $('setup-result').textContent = 'Hub runtime selected. Projects, preferences and existing AI connections are unchanged. Finish the backup review to remember this setup.';
    }, 'Updating MCP runtime location');
    if (repaired && changed && !page.needsRestart() && ['legacy-only', 'conflict'].includes(productReport?.status)) await reviewProductSettings();
  });
  page.on($('discovered'), 'change', () => { if ($('discovered').value) { $('project').value = $('discovered').value; void run(check, 'Checking project'); } });
  page.on($('browse'), 'click', () => run(async () => { const path = await page.call('pick_project_folder'); if (path) { $('project').value = path; await check(); } }, 'Choosing project'));
  page.on($('add'), 'click', () => run(async () => {
    const channel = await page.call('add_project', { projectPath: $('project').value });
    if (typeof channel?.unity_project_path !== 'string' || !channel.unity_project_path.trim()) throw new Error('No confirmed project path was returned. Check the project before retrying.');
    const existing = config.channels.find(item => item.unity_project_path === channel.unity_project_path);
    const next = { ...config, channels: existing ? config.channels : [...config.channels, channel], active_channel_id: existing?.id || channel.id };
    await saveConfig(next); $('project').value = channel.unity_project_path; renderProjects(); await check(); await checkProjectBadges();
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
    const capabilities = capabilityView(config.tool_groups || 'core', onboarding.project);
    if (!capabilities.ready || $('groups').value !== (config.tool_groups || 'core')) throw new Error('Save and check capabilities before applying setup.');
    const project = $('project').value;
    const reviewed = selectedClients().map(([id]) => id);
    const projectEntry = onboarding.project.claudeProjectEntry;
    const cli = $('cli').checked;
    $('setup-result').textContent = '';
    if (!await confirm(page, { title: 'Review connection setup', detail: `Project: ${$('project').value}\nClients: ${selectedClients().map(([, name]) => name).join(', ')}\nCapabilities: ${capabilities.label}\nCustom scripts: ${config.enable_custom_scripts === true ? 'on' : 'off'}\nAll project tests: ${config.allow_all_tests !== false ? 'allowed' : 'restricted'}\nUnity CLI: ${$('cli').checked ? 'experimental' : 'off for selected clients'}`, accept: 'Apply setup' })) return;
    await check();
    await checkSavedConfig();
    const fresh = capabilityView(config.tool_groups || 'core', onboarding?.project);
    if ($('setup').disabled || $('project').value !== project || !fresh.ready || fresh.groups !== capabilities.groups ||
        cli !== $('cli').checked || selectedClients().map(([id]) => id).join(',') !== reviewed.join(',') ||
        (reviewed.includes('claude') && projectEntry !== onboarding.project.claudeProjectEntry)) {
      $('setup-result').textContent = 'The setup changed during review. Check the project and selected apps again. Nothing was applied.';
      return;
    }
    let result;
    try { result = await page.call('one_click_setup', {
      unityProjectPath: $('project').value,
      configureCodex: clientUi.get('codex').checkbox.checked, configureClaude: clientUi.get('claude').checkbox.checked,
      configureClaudeDesktop: clientUi.get('claudeDesktop').checkbox.checked, configureAntigravity: clientUi.get('antigravity').checkbox.checked,
      configureOpencode: clientUi.get('opencode').checkbox.checked, toolGroups: config.tool_groups || 'core', enableCustomScripts: config.enable_custom_scripts === true,
      configureUnityCli: cliTouched || config.unity_cli_enabled === true ? $('cli').checked : null,
      unityCliConsent: $('cli').checked ? cliConsent : null,
    }); } catch (reason) { requireReload(reason); }
    if (typeof result?.channel?.unity_project_path !== 'string' || !result.channel.unity_project_path.trim()) requireReload('Setup returned no confirmed project path.');
    $('project').value = result.channel.unity_project_path;
    cliTouched = false; await reload();
    if (active()?.unity_project_path !== result.channel.unity_project_path || onboarding?.project?.bridgeCurrent !== true ||
        onboarding.project.bridgeInstalled !== true || !reviewed.every(id => onboarding.clients.some(c => c.id === id && checkedClient(c) && c.configured))) {
      requireReload('Hub could not verify the project, bridge and selected AI settings after setup. Check connection again before making another change.');
    }
    const next = { ...config, connection_guide_version: 1 }; await saveConfig(next);
    $('setup-result').textContent = 'Settings saved. Open Unity and resolve Console errors. Fully quit and reopen changed AI clients, then check again. Earlier completed steps may remain if a later check fails.';
  }, 'Setting up MCP'));
  page.on($('bridges'), 'click', () => run(async () => {
    const value = await page.call('update_configured_unity_extensions');
    lines($('setup-result'), [`Bridges updated: ${value.updated}. Failed: ${value.failed.length}.`, ...value.failed]);
    await check();
    await checkProjectBadges();
  }, 'Updating bridges'));
  page.on($('bridge'), 'click', () => run(async () => { await page.call('install_unity_extension', { unityProjectPath: $('project').value }); await check(); await checkProjectBadges(); }, 'Installing Unity bridge'));
  page.on($('save'), 'click', () => {
    if ($('save').matches(':disabled')) return;
    return run(async () => {
    const next = { ...config, mcp_server_path: $('server').value.trim(), tool_groups: $('groups').value, auto_start: $('follow').checked, enable_custom_scripts: $('scripts').checked, allow_all_tests: $('tests').checked };
    const channel = active();
    const unityOptions = [['enable_custom_scripts', 'set_unity_custom_scripts'], ['allow_all_tests', 'set_unity_allow_all_tests']];
    $('setup-result').textContent = '';
    await saveConfig(next);
    if (channel) {
      // Only successful setters establish this session's baseline; loaded config is not Unity readback.
      const applied = appliedUnityOptions.get(channel.unity_project_path) || new Map();
      appliedUnityOptions.set(channel.unity_project_path, applied);
      for (const [key, command] of unityOptions) {
        if (applied.has(key) && applied.get(key) === next[key]) continue;
        applied.delete(key);
        try { await page.call(command, { unityProjectPath: channel.unity_project_path, enabled: next[key] }); }
        catch (reason) {
          $('setup-result').textContent = `Hub options are saved, but Unity options are not fully confirmed for ${channel.name}. Earlier completed changes are kept. Save options again to retry for this project.`;
          throw reason;
        }
        applied.set(key, next[key]);
      }
      await check(); await followActive(channel);
    }
    $('setup-result').textContent = next.auto_start ? 'Options saved; configured clients follow the active project. Restart changed clients, then check the connection.' : 'Options saved. Apply to selected clients or use reviewed setup to update their capabilities.';
    }, 'Saving options');
  });
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
    recovery = []; controls();
    try {
      const records = await page.call('pending_client_recovery');
      if (!Array.isArray(records) || records.length > 768 || records.some(item => !item
        || typeof item.canResume !== 'boolean' || typeof item.central !== 'boolean'
        || typeof item.clientName !== 'string' || typeof item.message !== 'string'
        || typeof item.operation !== 'string' || !/^[a-f0-9]{64}$/.test(item.operation)
        || !Array.isArray(item.clients) || !item.clients.length || item.clients.length > clients.length
        || (!item.central && item.clients.length !== 1) || new Set(item.clients).size !== item.clients.length
        || item.clients.some(id => !clients.some(([client]) => client === id)))) throw new Error('Recovery response is invalid. No recovery was requested.');
      recovery = records;
      lines($('recovery'), records.length ? records.map(item => `${item.clientName}: ${item.message}`) : ['No interrupted client changes found.']);
    } catch (reason) {
      lines($('recovery'), [`Could not inspect interrupted changes. Check again before resuming. ${text(reason)}`]);
      throw reason;
    } finally { controls(); }
  }
  page.on($('recovery-check'), 'click', () => run(readRecovery, 'Checking interrupted changes'));
  page.on($('recover'), 'click', () => run(async () => {
    const records = recovery.filter(item => item.canResume);
    if (!records.length) return;
    recovery = []; controls();
    let failure;
    try {
      for (const record of records) {
        const result = await page.call('recover_client_connection', { clients: record.clients, operation: record.operation, central: record.central });
        if (result?.completed !== true) throw new Error('Recovery was declined or needs manual inspection. Current files were kept.');
      }
    } catch (reason) { failure = reason; }
    try { await readRecovery(); }
    catch (reason) {
      if (failure) throw new Error(`${text(failure)} Recovery recheck also failed: ${text(reason)}`);
      throw reason;
    }
    if (failure) throw failure;
    await reload();
  }, 'Reviewing recovery'));
  page.on($('guide'), 'click', () => { if (!page.busy()) $('guide-dialog').showModal(); });
  page.on($('guide-start'), 'click', () => { $('guide-dialog').close(); $('project').focus(); });
  page.on($('guide-help'), 'click', () => { $('guide-dialog').close(); document.querySelector('#context-help-dialog').showModal(); });
  page.on($('guide-skip'), 'click', async () => {
    $('guide-error').hidden = true;
    const remembered = config?.connection_guide_version === 1 && !$('controls').disabled;
    const saved = remembered || await run(async () => { const next = { ...config, connection_guide_version: 1 }; await page.call('save_config', { config: next }); config = next; }, 'Saving guide preference');
    if (saved) { $('guide-dialog').close(); $('connection-heading').focus(); }
    else localError('guide-error', page.needsRestart()
      ? 'Close and reopen Hub before continuing. Earlier completed changes are kept.'
      : 'The guide preference could not be confirmed. Try again, or close this guide for now.',
    page.errorMessage() || 'The preference could not be confirmed.');
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
    dispose() { if (page.busy()) return false; disposed = true; latestSdkRequest++; disposeRouteNotice(); return disposePage(); },
    async initialize() {
      page.lock(true);
      let loaded = false;
      const complete = await run(async () => {
        if (await inspectProductSettings()) return;
        await reload(); loaded = true;
      }, 'Checking Unity connection');
      if (!complete && productIssue) productError(page.errorMessage());
      if (complete && !loaded) $('status').textContent = 'Review saved settings';
      if (complete && loaded && config.connection_guide_version !== 1 && !root.hidden) $('guide-dialog').showModal();
      if (complete && loaded) void checkLatestSdk();
      return complete && loaded;
    },
    event(name, value) {
      if (name === 'creator-mcp-lifecycle' && value?.state === 'disconnected') {
        page.enable(false, 'MCP disconnected. The last operation may be unknown. Check again before retrying.');
      }
    },
    help: [
      ['Coming from the old MCP app?', 'Use Home to update Creator Hub. Keep the old app installed while Hub reviews your setup. If you see Move to Hub, you can bring over recognised connections or choose Not now. If migration stops and Keep my current setup is offered, it keeps your settings without repeating the move.'],
      ['Do I need to enable managed MCP routing?', 'Choose Enable managed routing if you want Hub to keep connections it manages pointing to its tools across compatible updates. Not now leaves existing connections alone. This choice does not move an AI connection you set up yourself.'],
      ['Claude Code works but Hub shows no user-level setup', 'Hub checks settings for your user account. Claude Code can also connect through a project file called .mcp.json. If it already reaches the right project, leave that file alone.'],
      ['Which tool is this?', 'MCP connects compatible AI clients to Unity. It is not an AI model. Project Setup creates and validates projects; Hub brings both tools together.'],
      ['My AI cannot see MCP', 'Choose your project and pick the AI app under Connection status. Hub checks the project and its bridge, and can help you connect without setting everything up again. Fully quit and reopen a changed client. Use the read-only check in the AI app before trying another repair.'],
      ['AI costs are high', 'Your provider controls billing. Check usage limits, avoid unnecessary context and fast/high-cost modes, and consider a cheaper model for routine work. The app cannot cap token charges.'],
      ['Unity CLI', 'Optional and off by default. Integration is experimental in Creator Hub and Unity, requires explicit agreement and needs Unity 6 plus Unity Pipeline. MCP works without it.'],
      ['Setup failed or another app is running', 'Read the exact error. Keep backups, check the connection and review interrupted changes before retrying. Never close unrelated Node processes. Earlier completed steps may remain; no mutation is retried automatically.'],
    ],
  });
}
