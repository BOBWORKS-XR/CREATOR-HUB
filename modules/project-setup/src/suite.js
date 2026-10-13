(() => {
  const trigger = document.querySelector('#suite-trigger');
  const menu = document.querySelector('#suite-menu');
  const shell = document.querySelector('#suite-shell');
  const dismiss = document.querySelector('#suite-dismiss');
  const error = document.querySelector('#suite-error');
  window.CreatorCommunityInvoke = (command, args) => window.CreatorRuntime.invoke(command, args);
  function showPlugins(show) {
    if (document.documentElement.classList.contains('creator-hosted')) return;
    document.querySelector('#setup-workspace').classList.toggle('hidden', show);
    document.querySelector('#view-plugins').classList.toggle('hidden', !show);
    for (const [id, active] of [['suite-current', !show], ['suite-plugins', show]]) {
      const node = document.getElementById(id); node.classList.toggle('current', active);
      if (active) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current');
    }
    close();
    if (show) { window.CreatorCommunity.show(); document.getElementById('plugins-title').focus(); }
    else { window.CreatorCommunity.closePreview(); document.getElementById('new-mode').focus(); }
  }
  const links = Object.freeze({
    hub: 'https://github.com/BOBWORKS-XR/CREATOR-HUB/releases',
    mcp: 'https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/releases',
  });
  const items = () => [...menu.querySelectorAll('button:not(:disabled)')];
  const isOpen = () => trigger.getAttribute('aria-expanded') === 'true';
  function close(restoreFocus = false) {
    if (restoreFocus || menu.contains(document.activeElement)) trigger.focus({ preventScroll: true });
    shell.classList.remove('suite-expanded');
    document.body.classList.remove('suite-open');
    menu.inert = true;
    menu.setAttribute('aria-hidden', 'true');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', 'Open Creator apps');
  }
  trigger.addEventListener('click', () => {
    if (isOpen()) return close(true);
    shell.classList.add('suite-expanded');
    document.body.classList.add('suite-open');
    menu.inert = false;
    menu.setAttribute('aria-hidden', 'false');
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-label', 'Close Creator apps');
    menu.querySelector('button.suite-item')?.focus({ preventScroll: true });
  });
  document.querySelector('#suite-current').addEventListener('click', () => showPlugins(false));
  document.querySelector('#suite-plugins').addEventListener('click', () => showPlugins(true));
  dismiss.addEventListener('click', () => close(true));
  document.addEventListener('keydown', event => {
    if (isOpen() && event.key === 'Escape') { event.preventDefault(); close(true); }
  });
  document.addEventListener('pointerdown', event => {
    if (isOpen() && event.target !== dismiss && !shell.contains(event.target)) close();
  });
  document.addEventListener('focusin', event => {
    if (isOpen() && !shell.contains(event.target)) close();
  });
  menu.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = items();
    const current = buttons.indexOf(document.activeElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[index]?.focus({ preventScroll: true });
  });
  for (const button of menu.querySelectorAll('[data-suite-link]')) {
    button.addEventListener('click', async () => {
      error.classList.add('hidden');
      try {
        await window.CreatorRuntime.invoke('open_official_url', { url: links[button.dataset.suiteLink] });
      } catch (reason) {
        error.textContent = `Could not open the link: ${String(reason)}`;
        error.classList.remove('hidden');
      }
    });
  }
})();
