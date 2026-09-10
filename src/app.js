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
  let busy = false;
  const byId = id => document.getElementById(id);
  const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
  try {
    byId('preview-channel').checked = localStorage.getItem('creator-hub.preview') === 'true';
    byId('auto-download').checked = localStorage.getItem('creator-hub.auto-download') === 'true';
  } catch { /* Preferences remain off if storage is unavailable. */ }
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
    if (!['hub', 'plugins'].includes(view) && !Object.hasOwn(tools, view)) return;
    current = view;
    close();
    error.classList.add('hidden');
    document.querySelector('#view-hub').classList.toggle('hidden', view !== 'hub');
    document.querySelector('#view-detail').classList.toggle('hidden', !Object.hasOwn(tools, view));
    document.querySelector('#view-plugins').classList.toggle('hidden', view !== 'plugins');
    for (const item of menu.querySelectorAll('[data-view]')) {
      item.classList.toggle('current', item.dataset.view === view);
      if (item.dataset.view === view) item.setAttribute('aria-current', 'page');
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
    const target = view === 'hub' ? title : document.querySelector(view === 'plugins' ? '#plugins-title' : '#tool-title');
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
    menu.querySelector(`[data-view="${current}"]`).focus({ preventScroll: true });
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
    try { await window.__TAURI__.core.invoke('open_resource', { resource }); }
    catch (reason) { error.textContent = String(reason); error.classList.remove('hidden'); }
  }
  for (const button of document.querySelectorAll('[data-resource]')) button.addEventListener('click', () => open(button.dataset.resource));
  document.querySelector('#source-button').addEventListener('click', () => { if (Object.hasOwn(tools, current)) open(`${current}-source`); });

  function appState() { return inventory?.apps?.find(app => app.app === current); }
  function renderState() {
    byId('check-updates').disabled = busy;
    byId('preview-channel').disabled = busy;
    for (const app of inventory?.apps || []) {
      byId(`status-${app.app}`).textContent = app.issue ? 'Needs attention' : app.updateAvailable ? 'Update available' : app.installed ? `Installed ${app.installedVersion || ''}` : `Available ${app.availableVersion}`;
    }
    const state = appState();
    const blocked = busy || !inventory?.supported || !state || Boolean(state.issue);
    byId('release-button').disabled = blocked;
    byId('download-button').disabled = busy || !inventory?.supported || !state || state.downloaded;
    byId('adopt-button').disabled = busy || !inventory?.supported;
    byId('open-button').disabled = blocked || !state?.trusted;
    byId('open-button').classList.toggle('hidden', !state?.installed || !state.updateAvailable);
    const opening = state?.installed && state.trusted && !state.updateAvailable;
    byId('primary-label').textContent = !state ? 'Unavailable' : opening ? 'Open app' : state.updateAvailable ? 'Update app' : 'Install app';
    byId('install-options').classList.toggle('hidden', Boolean(opening) || !state || !inventory?.supported);
    byId('download-button').classList.toggle('hidden', Boolean(opening));
    if (state) {
      const lines = [`Available: ${state.availableVersion}`, state.installed ? `Installed: ${state.installedVersion || 'unverified'}` : 'Not installed',
        state.downloaded ? 'Verified download ready' : '', state.running ? 'App or MCP connection is running' : '',
        state.installerInteractive && !opening ? 'This release uses its normal installer window. Keep the default folder.' : '', state.issue, state.checkWarning].filter(Boolean);
      byId('tool-state').replaceChildren(...lines.map(text => { const p = document.createElement('p'); p.textContent = text; return p; }));
    } else byId('tool-state').textContent = inventory?.supported === false ? 'Windows x64 app management is available in this build. macOS and Linux are not supported yet.' : 'App inventory is unavailable. Retry the update check.';
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
      byId('catalog-status').textContent = !inventory.supported ? 'App management requires Windows x64 in this build.'
        : inventory.apps.some(app => app.checkWarning) ? 'Some update checks failed. Last verified releases remain available.'
        : check ? 'Update check complete. Installation always needs your approval.' : 'Installed apps checked.';
    } catch (reason) { byId('catalog-status').textContent = String(reason); }
    finally { busy = false; renderState(); }
    if (check && byId('auto-download').checked && inventory?.supported) {
      for (const app of [...inventory.apps]) {
        if (!byId('auto-download').checked) break;
        if (app.updateAvailable && !app.downloaded && !app.issue) await action('download_app', app.app, app.availableVersion);
      }
    }
  }

  async function action(command, app = current, version = appState()?.availableVersion) {
    if (busy || !Object.hasOwn(tools, app)) return;
    busy = true; renderState(); error.classList.add('hidden');
    byId('operation-progress').classList.add('hidden');
    try {
      const args = { app };
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
    if (state) action(state.installed && state.trusted && !state.updateAvailable ? 'open_app' : 'install_app');
  });
  byId('download-button').addEventListener('click', () => action('download_app'));
  byId('open-button').addEventListener('click', () => action('open_app'));
  byId('adopt-button').addEventListener('click', () => action('use_existing_app'));
  byId('check-updates').addEventListener('click', () => refresh(true));
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
    try {
      await window.__TAURI__.event.listen('app-progress', event => setProgress(event.payload));
      await window.__TAURI__.event.listen('close-blocked', event => { error.textContent = event.payload; error.classList.remove('hidden'); });
    } catch (reason) { error.textContent = `Progress reporting unavailable: ${String(reason)}`; error.classList.remove('hidden'); }
    await refresh(false);
    await refresh(true);
  }
  start();
})();
