(() => {
  const tools = Object.freeze({
    mcp: {
      title: 'Creator Works MCP', letter: 'M', summary: 'Connect your AI client to a real Unity project.',
      facts: [['Clients', 'Codex, Claude Code and compatible MCP clients'], ['Tools', 'Scene, prefab, component and asset operations'], ['SDK support', 'Creator SDK, Banter and Unity Visual Scripting'], ['Installation', 'Standalone release. Hub-managed installation is in development.']],
    },
    setup: {
      title: 'Creator Project Setup', letter: 'P', summary: 'Create and validate a Unity project for the Creator SDK.',
      facts: [['Project setup', 'Pinned Unity, URP and Creator SDK recipe'], ['Build platforms', 'Android and Windows requirements'], ['Existing projects', 'Read-only inspection, reviewed repairs and settings backup'], ['Installation', 'Standalone release. Hub-managed installation is in development.']],
    },
  });
  const title = document.querySelector('#page-title');
  const trigger = document.querySelector('#suite-trigger');
  const menu = document.querySelector('#suite-menu');
  const error = document.querySelector('#action-error');
  let current = 'hub';
  function close(restore = false) {
    menu.classList.add('hidden');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', 'Open Creator apps');
    if (restore) trigger.focus();
  }
  function show(view) {
    if (view !== 'hub' && !Object.hasOwn(tools, view)) return;
    current = view;
    close();
    error.classList.add('hidden');
    document.querySelector('#view-hub').classList.toggle('hidden', view !== 'hub');
    document.querySelector('#view-detail').classList.toggle('hidden', view === 'hub');
    for (const item of menu.querySelectorAll('[data-view]')) {
      item.classList.toggle('current', item.dataset.view === view);
      if (item.dataset.view === view) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
    if (view !== 'hub') {
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
    const target = view === 'hub' ? title : document.querySelector('#tool-title');
    target.tabIndex = -1;
    target.focus();
  }
  for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => show(button.dataset.view));
  trigger.addEventListener('click', () => {
    if (!menu.classList.contains('hidden')) return close(true);
    menu.classList.remove('hidden');
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-label', 'Close Creator apps');
    menu.querySelector(`[data-view="${current}"]`).focus();
  });
  document.querySelector('#suite-close').addEventListener('click', () => close(true));
  document.addEventListener('keydown', event => {
    if (!menu.classList.contains('hidden') && event.key === 'Escape') { event.preventDefault(); close(true); }
  });
  for (const name of ['pointerdown', 'focusin']) document.addEventListener(name, event => {
    if (!menu.contains(event.target) && !trigger.contains(event.target)) close();
  });
  menu.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...menu.querySelectorAll('button')];
    const index = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next].focus();
  });
  async function open(resource) {
    error.classList.add('hidden');
    try { await window.__TAURI__.core.invoke('open_resource', { resource }); }
    catch (reason) { error.textContent = String(reason); error.classList.remove('hidden'); }
  }
  for (const button of document.querySelectorAll('[data-resource]')) button.addEventListener('click', () => open(button.dataset.resource));
  document.querySelector('#release-button').addEventListener('click', () => { if (Object.hasOwn(tools, current)) open(`${current}-releases`); });
  document.querySelector('#source-button').addEventListener('click', () => { if (Object.hasOwn(tools, current)) open(`${current}-source`); });
})();
