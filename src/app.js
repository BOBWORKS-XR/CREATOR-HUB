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
  let hubUpdate = null;
  let busy = false;
  let launchRevision = -1;
  const byId = id => document.getElementById(id);
  const invoke = (command, args) => window.CreatorHubNative.invoke(command, args);
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
    title.innerHTML = hosted ? (view === 'setup' ? '<span>CREATOR</span> <strong>PROJECT</strong> SETUP' : '<span>CREATOR</span> <strong>WORKS</strong> MCP') : '<span>CREATOR</span> <strong>HUB</strong>';
    byId('mode-description').textContent = hosted ? (view === 'setup' ? 'Unity and Creator SDK. Android + Windows.' :
      (window.CreatorHosted.writable(view) ? 'Unity project connections and MCP setup.' : 'Unity project connections. Read-only preview.')) : 'Unity tools. One place.';
    document.querySelector('#view-plugins').classList.toggle('hidden', view !== 'plugins');
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
    busy = true; byId(`host-${app}-button`).disabled = true; renderState();
    try { await window.CreatorHosted.start(app); if (current === app) show(app); }
    catch (reason) { error.textContent = String(reason); error.classList.remove('hidden'); }
    finally { busy = false; byId(`host-${app}-button`).disabled = false; renderState(); }
  });
  window.addEventListener('creator-host-closed', () => show(current));

  function appState() { return inventory?.apps?.find(app => app.app === current); }
  function renderState() {
    byId('check-updates').disabled = busy;
    byId('preview-channel').disabled = busy;
    byId('hub-update-button').disabled = busy || !hubUpdate?.availableVersion || Boolean(hubUpdate?.installBlocked);
    byId('hub-update-status').textContent = !hubUpdate ? 'Hub update check is unavailable. Try Check for updates.'
      : hubUpdate.availableVersion ? `Version ${hubUpdate.availableVersion}${hubUpdate.downloaded ? ' is ready to install.' : ' is available.'}`
      : hubUpdate.warning ? 'Could not check for a Hub update.' : `You are using Hub ${hubUpdate.currentVersion}. No newer update was found.`;
    byId('hub-update-warning').textContent = hubUpdate?.installBlocked || hubUpdate?.warning || '';
    byId('hub-update-warning').classList.toggle('hidden', !byId('hub-update-warning').textContent);
    for (const app of inventory?.apps || []) {
      byId(`status-${app.app}`).textContent = app.issue ? 'Needs attention' : app.updateAvailable ? 'Update available' : app.installed ? `Installed ${app.installedVersion || ''}` : `Available ${app.availableVersion}`;
    }
    const state = appState();
    for (const app of ['setup', 'mcp']) {
      const button = byId(`host-${app}-button`);
      button.classList.toggle('hidden', current !== app || !state?.hostedPreview);
      button.disabled = busy;
      button.textContent = state?.hostedPreview === 'read-only' ? 'Open read-only development preview' : 'Open hosted development preview';
    }
    const blocked = busy || !inventory?.supported || !state || Boolean(state.issue);
    const opening = state?.installed && state.trusted && !state.updateAvailable;
    const needsRelease = !opening && state?.installBlocked;
    byId('release-button').disabled = needsRelease ? busy : blocked;
    byId('download-button').disabled = busy || !inventory?.supported || !state || state.downloaded || Boolean(state.installBlocked);
    byId('adopt-button').disabled = busy || !inventory?.supported;
    byId('open-button').disabled = blocked || !state?.trusted;
    byId('open-button').classList.toggle('hidden', !state?.installed || !state.updateAvailable);
    byId('primary-label').textContent = !state ? 'Unavailable' : opening ? 'Open app' : state.requiredHubVersion ? 'Update Hub first' : needsRelease ? 'Check for an update' : state.updateAvailable ? 'Update app' : 'Install app';
    byId('install-options').classList.toggle('hidden', Boolean(opening || needsRelease) || !state || !inventory?.supported);
    byId('download-button').classList.toggle('hidden', Boolean(opening || needsRelease));
    if (state) {
      const lines = [`Available version: ${state.availableVersion}`, state.installed ? `Your version: ${state.installedVersion || 'not verified'}` : state.issue ? 'App needs attention' : 'Not installed',
        state.installedPath ? `Location: ${state.installedPath}` : '',
        state.downloaded ? 'Download ready' : '', state.running ? 'Currently in use' : '',
        state.installerInteractive && !opening && !needsRelease ? 'This release uses its normal installer window. Keep the default folder.' : '', state.issue, state.checkWarning, state.installBlocked].filter(Boolean);
      byId('tool-state').replaceChildren(...lines.map(text => { const p = document.createElement('p'); p.textContent = text; return p; }));
    } else byId('tool-state').textContent = inventory?.supported === false ? 'Windows x64 app management is available in this build. macOS and Linux are not supported yet.' : 'App inventory is unavailable. Retry the update check.';
    byId('compatibility-status').textContent = state?.hostedPreview ? 'Test version available' : state?.trusted ? 'Your app is ready' : state?.detectedCopies?.length ? 'Choose your app' : state?.issue ? 'Check your app' : 'Get started';
    byId('compatibility-detail').textContent = state?.hostedPreview
      ? `This is a separate test version${state.hostedPreview === 'read-only' ? '; changes are disabled' : ''}. Open app takes you to your usual app with all its settings.`
      : 'Apps open in their own window and keep your settings. Using them inside Hub needs a future update, which is not available here yet.';
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
      choose.disabled = busy || !copy.verified;
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
    busy = true; renderState();
    byId('catalog-status').textContent = check ? 'Checking verified releases...' : 'Checking installed apps...';
    try {
      inventory = await invoke('app_inventory', { check, preview: byId('preview-channel').checked });
      if (!inventory || !Array.isArray(inventory.apps)) throw 'The app inventory response is unavailable.';
      try {
        const result = await invoke('hub_update_status', { online: check, preview: byId('preview-channel').checked });
        hubUpdate = result && typeof result.currentVersion === 'string' ? result : null;
      } catch (reason) { hubUpdate = { warning: String(reason) }; }
      byId('catalog-status').textContent = !inventory.supported ? 'App management requires Windows x64 in this build.'
        : inventory.apps.some(app => app.checkWarning) ? 'Some update checks failed. Last verified releases remain available.'
        : check ? 'Update check complete. Installation always needs your approval.' : 'Installed apps checked.';
    } catch (reason) { byId('catalog-status').textContent = String(reason); }
    finally { busy = false; renderState(); }
    if (check && byId('auto-download').checked && inventory?.supported) {
      for (const app of [...inventory.apps]) {
        if (!byId('auto-download').checked) break;
        if (app.updateAvailable && !app.downloaded && !app.issue && !app.installBlocked) await action('download_app', app.app, app.availableVersion);
      }
      if (byId('auto-download').checked && hubUpdate?.availableVersion && !hubUpdate.downloaded && !hubUpdate.installBlocked) await hubAction('download_hub_update');
    }
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
    if (busy || !Object.hasOwn(tools, app)) return;
    busy = true; renderState(); error.classList.add('hidden');
    byId('operation-progress').classList.add('hidden');
    try {
      const args = { app, ...extra };
      if (['download_app', 'install_app'].includes(command)) args.version = version;
      if (command === 'install_app') { args.reopen = byId('reopen-app').checked; args.closeRunning = byId('close-running').checked; }
      const message = await invoke(command, args);
      setProgress({ message, total: 0, cancellable: false });
    } catch (reason) { error.textContent = String(reason); error.classList.remove('hidden'); }
    finally {
      byId('cancel-download').classList.add('hidden');
      busy = false;
      await refresh(false);
    }
  }

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
  byId('check-updates').addEventListener('click', () => refresh(true));
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
