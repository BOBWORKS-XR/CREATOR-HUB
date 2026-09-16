(() => {
  const tools = Object.freeze({
    mcp: {
      title: 'Creator Works MCP', letter: 'M', summary: 'Connect your AI client to a real Unity project.',
      facts: [['Clients', 'Codex, Claude Code and compatible MCP clients'], ['Tools', 'Scene, prefab, component and asset operations'], ['SDK support', 'Creator SDK, Banter and Unity Visual Scripting']],
    },
    setup: {
      title: 'Creator Project Setup', letter: 'P', summary: 'Create and validate a Unity project for the Creator SDK.',
      facts: [['Project setup', 'Pinned Unity, URP and Creator SDK recipe'], ['Build platforms', 'Android and Windows requirements'], ['Existing projects', 'Read-only inspection, reviewed repairs and settings backup']],
    },
  });
  const title = document.querySelector('#page-title');
  const trigger = document.querySelector('#suite-trigger');
  const menu = document.querySelector('#suite-menu');
  const shell = document.querySelector('#suite-shell');
  const dismiss = document.querySelector('#suite-dismiss');
  const error = document.querySelector('#action-error');
  let current = 'hub';
  let inventory = null;
  let inventoryError = '';
  let hubUpdate = null;
  let busy = false;
  let launchRevision = -1;
  const byId = id => document.getElementById(id);
  const invoke = (command, args) => window.CreatorHubNative.invoke(command, args);
  if (typeof window.CreatorHubNative.version === 'string') document.querySelector('.footer-version').textContent = window.CreatorHubNative.version;
  for (const [id, key] of [['preview-channel', 'preview'], ['auto-download', 'auto-download']]) {
    byId(id).checked = true;
    try {
      const saved = localStorage.getItem(`creator-hub.${key}`);
      byId(id).checked = saved === null || saved === 'true';
    } catch { /* Keep the default when preference storage is unavailable. */ }
  }
  function close(restore = false) {
    if (restore || menu.contains(document.activeElement)) trigger.focus({ preventScroll: true });
    shell.classList.remove('suite-expanded');
    document.body.classList.remove('suite-open');
    menu.inert = true;
    menu.setAttribute('aria-hidden', 'true');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', 'Open Creator apps');
  }
  function show(view) {
    if (!['hub', 'plugins', 'projects'].includes(view) && !Object.hasOwn(tools, view)) return;
    current = view;
    close();
    error.classList.add('hidden');
    document.querySelector('#view-hub').classList.toggle('hidden', view !== 'hub');
    byId('hub-pages').classList.toggle('hidden', !['hub', 'projects'].includes(view));
    byId('view-projects').classList.toggle('hidden', view !== 'projects');
    for (const item of byId('hub-pages').querySelectorAll('[data-view]')) {
      item.classList.toggle('current', item.dataset.view === view);
      if (item.dataset.view === view) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
    if (view === 'projects') window.CreatorProjects.show();
    const hosted = window.CreatorHosted.active(view);
    window.CreatorHosted.show(hosted ? view : null);
    document.body.classList.toggle('hosting-app', hosted);
    document.querySelector('#view-detail').classList.toggle('hidden', !Object.hasOwn(tools, view) || hosted);
    const pageBrand = view === 'plugins' ? '<span>CREATOR</span> <strong>PLUGINS</strong>' : '<span>CREATOR</span> <strong>HUB</strong>';
    title.innerHTML = hosted ? (view === 'setup' ? '<span>CREATOR</span> <strong>PROJECT</strong> SETUP' : '<span>CREATOR</span> <strong>WORKS</strong> MCP') : pageBrand;
    shell.querySelector('.suite-brand').innerHTML = pageBrand;
    trigger.replaceChildren(menu.querySelector(`[data-view="${view === 'plugins' ? 'plugins' : 'hub'}"] .suite-mark`).cloneNode(true));
    byId('mode-description').textContent = hosted ? (view === 'setup' ? 'Unity and Creator SDK. Android + Windows.' :
      (window.CreatorHosted.writable(view) ? 'Unity project connections and MCP setup.' : 'Unity project connections. Read-only preview.')) : view === 'plugins' ? 'Made by the community. Shared with creators.' : 'Unity tools. One place.';
    document.querySelector('#view-plugins').classList.toggle('hidden', view !== 'plugins');
    if (view === 'plugins') window.CreatorCommunity.show();
    else window.CreatorCommunity.closePreview();
    for (const item of menu.querySelectorAll('[data-view]')) {
      const selected = item.dataset.view === (view === 'projects' ? 'hub' : view);
      item.classList.toggle('current', selected);
      if (selected) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
    if (Object.hasOwn(tools, view)) {
      const tool = tools[view];
      document.querySelector('#tool-title').textContent = tool.title;
      document.querySelector('#tool-letter').textContent = tool.letter;
      document.querySelector('#tool-summary').textContent = tool.summary;
      const facts = document.querySelector('#tool-facts');
      facts.replaceChildren(...tool.facts.map(([label, value]) => {
        const row = document.createElement('div');
        const dt = document.createElement('dt');
        const dd = document.createElement('dd');
        dt.textContent = label; dd.textContent = value; row.append(dt, dd); return row;
      }));
    }
    const target = view === 'hub' || hosted ? title : document.querySelector(view === 'projects' ? '#projects-title' : view === 'plugins' ? '#plugins-title' : '#tool-title');
    target.tabIndex = -1;
    target.focus();
    renderState();
  }
  for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => show(button.dataset.view));
  trigger.addEventListener('click', () => {
    if (trigger.getAttribute('aria-expanded') === 'true') return close(true);
    shell.classList.add('suite-expanded');
    document.body.classList.add('suite-open');
    menu.inert = false;
    menu.setAttribute('aria-hidden', 'false');
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-label', 'Close Creator apps');
    menu.querySelector(`[data-view="${current === 'projects' ? 'hub' : current}"]`).focus({ preventScroll: true });
  });
  document.addEventListener('keydown', event => {
    if (trigger.getAttribute('aria-expanded') === 'true' && event.key === 'Escape') { event.preventDefault(); close(true); }
  });
  dismiss.addEventListener('click', () => close(true));
  for (const name of ['pointerdown', 'focusin']) document.addEventListener(name, event => {
    if (event.target !== dismiss && !shell.contains(event.target)) close();
  });
  menu.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...menu.querySelectorAll('button')];
    const index = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next].focus({ preventScroll: true });
  });
  async function open(resource) {
    error.classList.add('hidden');
    try { await invoke('open_resource', { resource }); }
    catch (reason) { error.textContent = String(reason); error.classList.remove('hidden'); }
  }
  for (const button of document.querySelectorAll('[data-resource]')) button.addEventListener('click', () => open(button.dataset.resource));
  document.querySelector('#source-button').addEventListener('click', () => { if (Object.hasOwn(tools, current)) open(`${current}-source`); });
  for (const app of ['setup', 'mcp']) byId(`host-${app}-button`).addEventListener('click', async () => {
    if (busy) return;
    error.classList.add('hidden');
    busy = true; byId(`host-${app}-button`).disabled = true; renderState();
    byId('compatibility-detail').textContent = 'Opening in Hub... Check for a permission window from the installed app.';
    try { await window.CreatorHosted.start(app); if (current === app) show(app); }
    catch (reason) { error.textContent = String(reason); error.classList.remove('hidden'); }
    finally { busy = false; byId(`host-${app}-button`).disabled = false; renderState(); }
  });
  window.addEventListener('creator-host-closed', () => show(current));

  function appState() { return inventory?.apps?.find(app => app.app === current); }
  function canDisconnectForUpdate(state) {
    return state?.app === 'mcp' && state.installed && state.trusted && !state.issue && state.updateAvailable
      && !state.installBlocked && !state.requiredHubVersion && state.updateBlockers?.length > 0
      && state.updateBlockers.every(blocker => blocker.kind === 'connection');
  }
  function acceptInventory(result) {
    if (!result || typeof result.supported !== 'boolean' || !Array.isArray(result.apps)
      || result.apps.some(app => !app || !Object.hasOwn(tools, app.app))) throw 'The app inventory response is unavailable.';
    inventory = result;
    inventoryError = '';
  }
  function updateReason(state) {
    if (inventoryError) return 'App discovery failed. Retry before updating; last-known versions are shown.';
    if (!inventory?.supported) return 'App updates require Windows x64 in this build.';
    if (state.issue) return state.issue;
    if (!state.trusted) return 'This installation must be verified before updating.';
    if (state.installBlocked) return state.installBlocked;
    if (state.requiredHubVersion) return `Update Creator Hub to ${state.requiredHubVersion} first.`;
    if (window.CreatorHosted.active(state.app)) return 'Updating asks to close this app\'s Hub view first. Unsaved work is not closed automatically.';
    if (canDisconnectForUpdate(state)) return 'MCP connections are running. Disconnect and update asks permission to stop only MCP\'s private runtime, then continues to installation.';
    if (state.updateBlockers?.length) return state.updateBlockers.some(b => b.kind === 'connection')
      ? 'Other processes are also blocking this update. Disconnect MCP only can stop the private MCP runtime after confirmation; other blockers must be resolved separately.'
      : 'Close the listed app or disconnect its MCP connection, then Check for updates. Unrecognised processes will not be closed.';
    return '';
  }
  function renderState() {
    byId('check-updates').disabled = busy;
    byId('retry-inventory').disabled = busy;
    byId('inventory-error').classList.toggle('hidden', !inventoryError);
    byId('inventory-error-message').textContent = inventoryError ? `App discovery failed: ${inventoryError}${inventory ? ' Last-known versions are shown; retry before using app controls.' : ''}` : '';
    if (!inventory) for (const app of ['mcp', 'setup']) byId(`status-${app}`).textContent = busy ? 'Checking' : 'Unavailable';
    byId('preview-channel').disabled = busy;
    byId('hub-update-button').disabled = busy || !hubUpdate?.availableVersion || Boolean(hubUpdate?.installBlocked);
    byId('hub-update-status').textContent = !hubUpdate ? 'Hub update check is unavailable. Try Check for updates.'
      : hubUpdate.availableVersion ? `Version ${hubUpdate.availableVersion}${hubUpdate.downloaded ? ' is ready to install.' : ' is available.'}`
      : hubUpdate.warning ? 'Could not check for a Hub update.' : `You are using Hub ${hubUpdate.currentVersion}. No newer update was found.`;
    byId('hub-update-warning').textContent = hubUpdate?.installBlocked || hubUpdate?.warning || '';
    byId('hub-update-warning').classList.toggle('hidden', !byId('hub-update-warning').textContent);
    for (const app of inventory?.apps || []) {
      byId(`status-${app.app}`).textContent = app.issue ? 'Needs attention' : app.updateAvailable ? 'Update available' : app.installed ? `Installed ${app.installedVersion || ''}` : `Available ${app.availableVersion}`;
      const update = byId(`update-${app.app}`), reason = byId(`update-reason-${app.app}`);
      const available = Boolean(app.installed && app.updateAvailable);
      const hosted = window.CreatorHosted.active(app.app);
      update.classList.toggle('hidden', !available);
      update.disabled = busy || Boolean(inventoryError) || !inventory.supported || Boolean(app.issue) || !app.trusted
        || (!app.requiredHubVersion && (Boolean(app.installBlocked) || (!hosted && Boolean(app.updateBlockers?.length) && !canDisconnectForUpdate(app))));
      const updateLabel = app.requiredHubVersion ? 'Update Hub first' : canDisconnectForUpdate(app) ? 'Disconnect and update' : 'Update app';
      update.querySelector('span:last-child').textContent = updateLabel;
      update.setAttribute('aria-label', `${updateLabel}: ${tools[app.app].title}`);
      reason.textContent = available ? updateReason(app) : '';
      reason.classList.toggle('hidden', !reason.textContent);
    }
    const state = appState();
    const mcp = inventory?.apps?.find(app => app.app === 'mcp');
    const canDisconnect = Boolean(mcp?.installed && mcp.trusted && !mcp.issue && mcp.updateBlockers?.some(b => b.kind === 'connection'));
    for (const id of ['disconnect-mcp-row', 'disconnect-mcp-detail']) {
      byId(id).classList.toggle('hidden', !canDisconnect || (id.endsWith('detail') && current !== 'mcp'));
      byId(id).disabled = busy || Boolean(inventoryError) || !inventory?.supported;
    }
    const hostedMismatch = state?.hostedCompatible === false;
    const canHost = state?.installed && state.trusted && state.hostedPreview && state.hostedCompatible === true && !state.issue;
    for (const app of ['setup', 'mcp']) {
      const button = byId(`host-${app}-button`);
      button.classList.toggle('hidden', current !== app || !state?.hostedPreview);
      button.disabled = busy || Boolean(inventoryError) || !canHost;
      button.textContent = state?.hostedPreview === 'read-only' ? 'Open in Hub (read-only)' : 'Open in Hub';
    }
    const blocked = busy || Boolean(inventoryError) || !inventory?.supported || !state || Boolean(state.issue);
    const opening = state?.installed && state.trusted && !state.updateAvailable;
    const blockers = state?.updateBlockers || [];
    const needsRelease = !opening && state?.installBlocked;
    byId('release-button').disabled = needsRelease ? busy || Boolean(inventoryError) : blocked || (!opening && blockers.length > 0 && !canDisconnectForUpdate(state));
    byId('release-button').classList.toggle('hidden', Boolean(opening && canHost));
    byId('download-button').disabled = busy || Boolean(inventoryError) || !inventory?.supported || !state || state.downloaded || Boolean(state.installBlocked);
    byId('adopt-button').disabled = busy || Boolean(inventoryError) || !inventory?.supported;
    byId('open-button').disabled = blocked || !state?.trusted;
    byId('open-button').classList.toggle('hidden', !state?.installed || (!state.updateAvailable && !canHost));
    byId('open-button').textContent = canHost ? 'Open separately' : 'Open app';
    byId('primary-label').textContent = !state ? busy ? 'Checking' : 'Unavailable' : opening ? 'Open app' : state.requiredHubVersion ? 'Update Hub first' : needsRelease ? 'Check for an update' : canDisconnectForUpdate(state) ? 'Disconnect and update' : state.updateAvailable ? 'Update app' : 'Install app';
    byId('install-options').classList.toggle('hidden', Boolean(opening || needsRelease) || !state || !inventory?.supported);
    byId('download-button').classList.toggle('hidden', Boolean(opening || needsRelease));
    if (state) {
      const lines = [`Available version: ${state.availableVersion}`, state.installed ? `Your version: ${state.installedVersion || 'not verified'}` : state.issue ? 'App needs attention' : 'Not installed',
        state.installedPath ? `Location: ${state.installedPath}` : '',
        state.downloaded ? 'Download ready' : '', state.running ? 'Currently in use' : '',
        state.installerInteractive && !opening && !needsRelease ? 'This release uses its normal installer window. Keep the default folder.' : '', state.issue, state.checkWarning, state.installBlocked].filter(Boolean);
      byId('tool-state').replaceChildren(...lines.map(text => { const p = document.createElement('p'); p.textContent = text; return p; }));
    } else byId('tool-state').textContent = inventory?.supported === false ? 'Windows x64 app management is available in this build. macOS and Linux are not supported yet.' : busy ? 'Checking installed apps and available updates...' : 'App inventory is unavailable. Use Retry app discovery above.';
    byId('update-blockers').classList.toggle('hidden', !state || (!state.issue && !blockers.length));
    byId('update-blockers-help').textContent = canDisconnectForUpdate(state)
      ? 'Disconnect and update asks permission to stop only MCP\'s private runtime before installation. Finish active AI work first. AI apps, Unity and unrelated Node processes stay open.' : blockers.length
      ? `${blockers.some(b => b.kind === 'connection') ? 'Finish active AI work, then use Disconnect MCP only to stop its private runtime, including stuck connections. You will be asked to confirm. If your client reconnects automatically, pause or disable this MCP in that client first.' : 'Finish your work, then disconnect MCP in your AI app or close the listed app.'} Check again when ready. Hub will not force-close AI apps, Unity or unrelated Node processes. Do not end unfamiliar tasks. Uninstalling is not needed.`
      : 'Resolve the issue above, then check again. Nothing will be installed by this check.';
    byId('recheck-app').disabled = busy;
    byId('update-blockers-details').classList.toggle('hidden', !blockers.length);
    byId('update-blockers-list').replaceChildren(...blockers.map(blocker => {
      const row = document.createElement('li');
      const name = document.createElement('strong');
      name.textContent = `${blocker.kind === 'connection' ? 'MCP runtime in use' : blocker.kind === 'possibleConnection' ? 'Possible MCP connection' : 'Another app copy'}: ${blocker.name} (PID ${blocker.pid})`;
      row.append(name);
      for (const text of [blocker.executable, blocker.parent ? `Started by ${blocker.parent.name} (PID ${blocker.parent.pid})` : 'Starting app could not be identified.', blocker.parent?.executable].filter(Boolean)) {
        const line = document.createElement('p'); line.textContent = text; row.append(line);
      }
      return row;
    }));
    byId('compatibility-status').textContent = inventoryError ? 'App discovery needs attention' : !state ? 'Checking compatibility' : hostedMismatch ? 'Update needed for Hub' : canHost ? 'Ready to open in Hub' : state?.trusted ? 'Your app is ready' : state?.detectedCopies?.length ? 'Choose your app' : state?.issue ? 'Check your app' : 'Get started';
    byId('compatibility-detail').textContent = inventoryError || !state
      ? 'Hub needs a completed app check to show installation, update and Open in Hub options.'
      : hostedMismatch
      ? `${state.requiredHubVersion ? 'Update Hub first, then check this app for updates.' : state.updateAvailable ? 'Update this app to open it inside Hub.' : 'Check for updates to get matching versions of Hub and this app.'} You can still use Open app for a separate window.`
      : state?.hostedPreview
      ? `Uses your installed app and existing settings${state.hostedPreview === 'read-only' ? '; changes are disabled' : ''}. This app version asks for permission when opening in Hub. Open separately remains available.`
      : 'This app version opens in its own window and keeps your settings. Check for updates to find a Hub-compatible version.';
    const copies = byId('detected-copies');
    copies.replaceChildren();
    for (const copy of state?.detectedCopies || []) {
      const row = document.createElement('div');
      row.className = 'detected-copy';
      const detail = document.createElement('div');
      const label = document.createElement('strong');
      label.textContent = copy.verified ? `Version ${copy.version}` : 'Copy not recognised';
      const location = document.createElement('p');
      location.textContent = copy.path;
      detail.append(label, location);
      const choose = document.createElement('button');
      choose.type = 'button'; choose.className = 'text-button'; choose.textContent = 'Use this copy';
      choose.disabled = busy || Boolean(inventoryError) || !copy.verified;
      choose.addEventListener('click', () => action('use_existing_app', current, undefined, { path: copy.path }));
      row.append(detail, choose); copies.append(row);
    }
  }

  function setProgress(payload) {
    byId('operation-progress').classList.remove('hidden');
    byId('progress-message').textContent = payload.message;
    byId('cancel-download').classList.toggle('hidden', !payload.cancellable);
    byId('cancel-download').disabled = false;
    byId('download-progress').hidden = !payload.total;
    if (payload.total) {
      byId('download-progress').max = payload.total;
      byId('download-progress').value = Math.min(payload.received, payload.total);
    }
    byId('progress-bytes').textContent = payload.total ? `${(payload.received / 1048576).toFixed(1)} / ${(payload.total / 1048576).toFixed(1)} MB` : '';
  }

  async function refresh(check = false) {
    if (busy) return;
    let succeeded = false;
    let hubChecked = false;
    busy = true; renderState();
    byId('catalog-status').textContent = check ? 'Checking verified releases...' : 'Checking installed apps...';
    try {
      const result = await invoke('app_inventory', { check, preview: byId('preview-channel').checked });
      acceptInventory(result);
      byId('catalog-status').textContent = !inventory.supported ? 'App management requires Windows x64 in this build.'
        : inventory.apps.some(app => app.checkWarning) ? 'Some update checks failed. Last verified releases remain available.'
        : check ? 'Update check complete. Installation always needs your approval.' : 'Installed apps checked.';
      succeeded = true;
    } catch (reason) { inventoryError = String(reason); byId('catalog-status').textContent = inventoryError; }
    // A broken companion scan must not hide a Hub update that can repair it.
    try {
      const result = await invoke('hub_update_status', { online: check, preview: byId('preview-channel').checked });
      if (!result || typeof result.currentVersion !== 'string') throw 'Hub update response is unavailable.';
      hubUpdate = result;
      hubChecked = true;
    } catch (reason) { hubUpdate = { warning: String(reason) }; }
    finally { busy = false; renderState(); }
    if (check && succeeded && byId('auto-download').checked && inventory?.supported) {
      for (const app of [...inventory.apps]) {
        if (!byId('auto-download').checked) break;
        if (app.updateAvailable && !app.downloaded && !app.issue && !app.installBlocked) await action('download_app', app.app, app.availableVersion);
      }
    }
    if (check && hubChecked && byId('auto-download').checked && hubUpdate?.availableVersion && !hubUpdate.downloaded && !hubUpdate.installBlocked) await hubAction('download_hub_update');
    return succeeded;
  }

  async function hubAction(command) {
    if (busy || !hubUpdate?.availableVersion || hubUpdate.installBlocked) return;
    busy = true; renderState(); error.classList.add('hidden');
    try {
      const message = await invoke(command, { version: hubUpdate.availableVersion });
      setProgress({ message, total: 0, cancellable: false });
    } catch (reason) { error.textContent = String(reason); error.classList.remove('hidden'); }
    finally { byId('cancel-download').classList.add('hidden'); busy = false; await refresh(false); }
  }

  async function action(command, app = current, version = appState()?.availableVersion, extra = {}) {
    if (busy || inventoryError || !Object.hasOwn(tools, app)) return;
    busy = true; renderState(); error.classList.add('hidden');
    byId('operation-progress').classList.add('hidden');
    try {
      const args = { app, ...extra };
      if (['download_app', 'install_app'].includes(command)) args.version = version;
      if (command === 'install_app') { args.reopen = extra.reopen ?? byId('reopen-app').checked; args.closeRunning = extra.closeRunning ?? byId('close-running').checked; }
      if (command === 'install_app' && canDisconnectForUpdate(inventory?.apps?.find(item => item.app === app))) {
        setProgress({ message: 'Waiting for permission to disconnect MCP...', total: 0, cancellable: false });
        await invoke('disconnect_mcp', { app });
        // Keep controls locked across confirmation and recheck. Never install from
        // the pre-disconnect snapshot or keep stopping a reconnecting client.
        setProgress({ message: 'Checking MCP connections before installation...', total: 0, cancellable: false });
        acceptInventory(await invoke('app_inventory', { check: false, preview: byId('preview-channel').checked }));
        const updated = inventory.apps.find(item => item.app === app);
        if (!inventory.supported || !updated?.installed || !updated.trusted || updated.issue
          || !updated.updateAvailable || updated.availableVersion !== version || updated.installBlocked || updated.requiredHubVersion) {
          throw 'Update not started. The app or available release changed; review its current status and try again.';
        }
        if (updated.updateBlockers?.length) throw 'Update not started. MCP is still in use or a client reconnected. Pause this MCP in your AI client, then try again. No new connections were stopped.';
      }
      const message = await invoke(command, args);
      setProgress({ message, total: 0, cancellable: false });
    } catch (reason) { byId('operation-progress').classList.add('hidden'); error.textContent = String(reason); error.classList.remove('hidden'); }
    finally {
      byId('cancel-download').classList.add('hidden');
      busy = false;
      await refresh(false);
    }
  }

  for (const app of ['mcp', 'setup']) byId(`update-${app}`).addEventListener('click', async () => {
    if (busy) return;
    let state = inventory?.apps?.find(item => item.app === app);
    if (!state?.installed || !state.updateAvailable || !inventory.supported || state.issue || !state.trusted) return;
    if (state.requiredHubVersion) { byId('hub-update-title').focus(); return refresh(true); }
    if (state.installBlocked) return;
    if (window.CreatorHosted.active(app)) {
      busy = true; renderState();
      let closed = false;
      try { closed = await window.CreatorHosted.close(app); }
      finally { busy = false; renderState(); }
      if (!closed) {
        error.textContent = 'Update not started. The app view is still open; finish its work or approve closing it before updating.';
        error.classList.remove('hidden'); return;
      }
      if (!await refresh(false)) return;
      state = inventory?.apps?.find(item => item.app === app);
    }
    if (!state?.installed || !state.updateAvailable || state.issue || !state.trusted || state.installBlocked || state.requiredHubVersion
      || (state.updateBlockers?.length && !canDisconnectForUpdate(state))) return;
    // Row updates stay on Apps and never inherit another app's hidden close/reopen choices.
    await action('install_app', app, state.availableVersion, { reopen: false, closeRunning: false });
  });
  byId('release-button').addEventListener('click', () => {
    const state = appState();
    if (state?.requiredHubVersion && !(state.installed && state.trusted && !state.updateAvailable)) {
      show('hub'); byId('hub-update-title').focus();
      return refresh(true);
    }
    if (state?.installBlocked && !(state.installed && state.trusted && !state.updateAvailable)) return refresh(true);
    if (state) action(state.installed && state.trusted && !state.updateAvailable ? 'open_app' : 'install_app');
  });
  byId('download-button').addEventListener('click', () => action('download_app'));
  byId('open-button').addEventListener('click', () => action('open_app'));
  byId('adopt-button').addEventListener('click', () => action('use_existing_app'));
  for (const id of ['disconnect-mcp-row', 'disconnect-mcp-detail']) byId(id).addEventListener('click', () => action('disconnect_mcp', 'mcp'));
  byId('check-updates').addEventListener('click', () => refresh(true));
  byId('retry-inventory').addEventListener('click', () => refresh(false));
  byId('recheck-app').addEventListener('click', async () => {
    if (busy) return;
    const app = current;
    byId('update-blockers-status').textContent = 'Checking running apps...';
    const succeeded = await refresh(false);
    byId('update-blockers-status').textContent = succeeded ? 'Check complete. Review the app status above.' : 'Could not check running apps. Try again.';
    if (succeeded && app === current && !appState()?.issue && !appState()?.updateBlockers?.length) {
      error.classList.add('hidden');
      byId('release-button').focus();
    }
  });
  byId('hub-update-button').addEventListener('click', () => hubAction('install_hub_update'));
  byId('cancel-download').addEventListener('click', async () => {
    byId('cancel-download').disabled = true;
    try { await invoke('cancel_download'); } catch (reason) { error.textContent = String(reason); error.classList.remove('hidden'); }
  });
  for (const [id, key] of [['preview-channel', 'preview'], ['auto-download', 'auto-download']]) {
    byId(id).addEventListener('change', () => {
      try { localStorage.setItem(`creator-hub.${key}`, String(byId(id).checked)); } catch { /* Session preference still applies. */ }
      if (id === 'preview-channel') refresh(true);
    });
  }
  async function start() {
    function applyLaunch(request) {
      if (!request || !['hub', 'mcp', 'setup'].includes(request.view) || !Number.isSafeInteger(request.revision) || request.revision <= launchRevision) return;
      launchRevision = request.revision;
      // Navigation keeps existing hosted views intact; it never starts an installation.
      show(request.view);
    }
    try {
      await window.__TAURI__.event.listen('app-progress', event => setProgress(event.payload));
      await window.__TAURI__.event.listen('close-blocked', event => { error.textContent = event.payload; error.classList.remove('hidden'); });
      await window.__TAURI__.event.listen('hub-launch-view', event => applyLaunch(event.payload));
      applyLaunch(await invoke('get_launch_request'));
    } catch (reason) { error.textContent = `Progress reporting unavailable: ${String(reason)}`; error.classList.remove('hidden'); }
    await refresh(false);
    await refresh(true);
  }
  start();
})();
