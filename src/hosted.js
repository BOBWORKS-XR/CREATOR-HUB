(() => {
  const invoke = (...args) => window.CreatorHubNative.invoke(...args);
  const apps = Object.freeze({
    setup: { id: 'creator-project-setup', title: 'Creator Project Setup', label: 'Setup', commands: new Set(['get_recipe', 'probe_environment', 'pick_parent_folder', 'create_project', 'open_project', 'launch_hub', 'restart_hub', 'register_project', 'inspect_project', 'run_existing_project', 'open_official_url']) },
    mcp: { id: 'creator-works-mcp', title: 'Creator Works MCP', label: 'MCP', commands: new Set(['get_hosted_snapshot', 'pick_project_folder', 'open_official_url']) },
  });
  const mcpWritable = new Set([
    'begin_ui_operation', 'finish_ui_operation', 'load_config', 'save_config',
    'discover_unity_projects', 'get_onboarding_status', 'add_project', 'one_click_setup',
    'get_project_sdk_profile', 'get_unity_extension_status', 'update_configured_unity_extensions',
    'update_codex_mcp_config', 'update_claude_mcp_config', 'update_antigravity_mcp_config',
    'update_opencode_mcp_config', 'remove_codex_mcp_config', 'remove_claude_mcp_config',
    'remove_antigravity_mcp_config', 'remove_opencode_mcp_config', 'install_unity_extension',
    'set_unity_custom_scripts', 'set_unity_allow_all_tests', 'get_project_feedback_settings',
    'set_project_feedback_settings', 'get_stable_release',
  ]);
  const panel = document.querySelector('#view-hosted');
  const sessions = new Map();
  const starting = new Set();
  let selected = null;
  const stop = document.querySelector('#hosted-stop');
  function render() {
    const state = sessions.get(selected);
    panel.classList.toggle('hidden', !state?.frame);
    panel.inert = !state?.frame;
    for (const [app, session] of sessions) {
      session.frame?.classList.toggle('hidden', app !== selected);
      if (session.frame) session.frame.inert = app !== selected;
    }
    document.querySelector('#hosted-status').textContent = state?.status || '';
    stop.disabled = !state || state.inFlight || state.workflow || state.closing;
    stop.textContent = state ? `Close ${apps[selected].label}` : 'Close view';
  }
  const decode = encoded => new TextDecoder().decode(Uint8Array.from(atob(encoded), c => c.charCodeAt(0)));

  function documentFor(files) {
    const mime = name => name.endsWith('.png') ? 'image/png' : name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.js') ? 'text/javascript' : 'text/css';
    const data = name => {
      if (!Object.hasOwn(files, name) || !/^[a-zA-Z0-9/_\-.]+$/.test(name) || name.includes('..')) throw new Error(`Missing hosted asset: ${name}`);
      return `data:${mime(name)};base64,${files[name]}`;
    };
    const doc = new DOMParser().parseFromString(decode(files['index.html']), 'text/html');
    if (doc.querySelector('base, iframe, object, embed, form')) throw new Error('Unsupported hosted document element.');
    for (const script of doc.querySelectorAll('script')) {
      if (!script.getAttribute('src')) throw new Error('Inline hosted scripts are not supported.');
      script.setAttribute('src', data(script.getAttribute('src')));
    }
    for (const style of doc.querySelectorAll('link')) {
      if (style.rel !== 'stylesheet') throw new Error('Unsupported hosted link.');
      const css = decode(files[style.getAttribute('href')]).replace(/url\(['"]?([^)'"\s]+)['"]?\)/g, (_, name) => `url("${data(name)}")`);
      style.setAttribute('href', `data:text/css;base64,${btoa(String.fromCharCode(...new TextEncoder().encode(css)))}`);
    }
    for (const img of doc.querySelectorAll('img[src]')) img.setAttribute('src', data(img.getAttribute('src')));
    const csp = doc.createElement('meta');
    csp.httpEquiv = 'Content-Security-Policy';
    csp.content = "default-src 'none'; script-src data:; style-src data:; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'";
    doc.head.prepend(csp);
    return '<!doctype html>' + doc.documentElement.outerHTML;
  }

  function disconnect(state, reason) {
    state.failed = true;
    state.port?.postMessage({ type: 'disconnect' });
    state.status = reason;
    render();
  }
  async function attach(app, state, result) {
    if (!result?.session || result.appId !== apps[app].id || !result.files) throw new Error('Invalid hosted app response.');
    state.writable = app === 'mcp' && result.hostingRevision === 2 && result.effectiveMode === 'writable';
    state.session = result.session;
    const frame = document.createElement('iframe');
    state.frame = frame;
    frame.title = apps[app].title;
    frame.id = `${app}-host-frame`;
    // Opaque origin; no parent DOM/Tauri access, popups, navigation or downloads.
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    const html = documentFor(result.files);
    const channel = new MessageChannel();
    const port = channel.port1;
    state.port = port;
    const loaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('App interface did not become ready. No operation was retried.')), 15000);
      let lastId = 0;
      port.onmessage = async ({ data }) => {
        if (!state.ready && !state.failed && data?.type === 'ready' && data.protocol === 1) { clearTimeout(timer); state.ready = true; resolve(); return; }
        if (state.failed || !state.ready || data?.type !== 'invoke') return;
        if (!Number.isSafeInteger(data.id) || data.id <= lastId) return disconnect(state, 'App sent a stale request.');
        lastId = data.id;
        if (!(apps[app].commands.has(data.command) || (state.writable && mcpWritable.has(data.command))) || !data.args || Array.isArray(data.args) || typeof data.args !== 'object' || new TextEncoder().encode(JSON.stringify(data.args)).length > 60000) {
          port.postMessage({ type: 'result', id: data.id, ok: false, error: 'Unsupported hosted app request.' }); return;
        }
        if (state.inFlight || state.closing) { port.postMessage({ type: 'result', id: data.id, ok: false, error: 'Another operation is running for this app.' }); return; }
        state.inFlight = true;
        render();
        try {
          const value = await invoke('hosted_app_call', { session: state.session, command: data.command, args: data.args });
          if (data.command === 'begin_ui_operation') state.workflow = true;
          if (data.command === 'finish_ui_operation') state.workflow = false;
          port.postMessage({ type: 'result', id: data.id, ok: true, result: value });
        } catch (error) { port.postMessage({ type: 'result', id: data.id, ok: false, error: String(error) }); }
        finally { state.inFlight = false; render(); }
      };
    });
    let connected = false;
    frame.addEventListener('load', () => {
      if (connected) return disconnect(state, 'App navigated unexpectedly. The existing connection was disabled.');
      connected = true;
      frame.contentWindow.postMessage({ type: 'creator-host-connect', protocol: 1,
        ...(app === 'mcp' ? { hostingRevision: result.hostingRevision, effectiveMode: state.writable ? 'writable' : 'read-only' } : {}) }, '*', [channel.port2]);
    });
    frame.srcdoc = html;
    document.querySelector('#hosted-content').append(frame);
    render();
    await loaded;
    state.status = `${apps[app].label} ${result.version}`;
    render();
  }
  window.CreatorHosted = {
    active: app => Boolean(sessions.get(app)?.ready),
    writable: app => Boolean(sessions.get(app)?.writable),
    async start(app) {
      if (!Object.hasOwn(apps, app)) throw new Error('Unsupported hosted app.');
      if (sessions.has(app) || starting.has(app)) return;
      starting.add(app);
      const state = { frame: null, port: null, session: null, ready: false, inFlight: false, failed: false, closing: false, status: 'Opening app' };
      sessions.set(app, state);
      try { await attach(app, state, await invoke('start_hosted_app', { app })); }
      catch (error) {
        if (state.session) { try { await invoke('abort_hosted_app', { session: state.session }); } catch { /* Native busy guard owns any running work. */ } }
        state.frame?.remove(); state.port?.close(); sessions.delete(app); render();
        throw error;
      } finally { starting.delete(app); }
    },
    show(app) { selected = app; render(); },
  };
  window.__TAURI__.event.listen('hosted-app-event', ({ payload }) => {
    for (const [app, state] of sessions) {
      const allowed = app === 'mcp' ? payload.name === 'creator-mcp-lifecycle' : ['setup-progress', 'existing-progress'].includes(payload.name);
      if (allowed && payload.session === state.session && !state.failed) state.port?.postMessage({ type: 'event', name: payload.name, payload: payload.payload });
    }
  });
  window.__TAURI__.event.listen('hosted-app-disconnected', ({ payload }) => {
    for (const state of sessions.values()) if (payload.session === state.session) disconnect(state, payload.error);
  });
  stop.addEventListener('click', async () => {
    const app = selected;
    const state = sessions.get(app);
    if (!state?.session || state.inFlight || state.workflow || state.closing) return;
    state.closing = true;
    render();
    // Confirmation is native: closing this view discards its unsaved form state.
    try {
      const closed = await invoke('stop_hosted_app', { session: state.session });
      if (closed === false) return;
      state.port?.close(); state.frame?.remove(); sessions.delete(app);
      window.dispatchEvent(new Event('creator-host-closed'));
    } catch (error) { state.status = String(error); }
    finally { state.closing = false; render(); }
  });
})();
