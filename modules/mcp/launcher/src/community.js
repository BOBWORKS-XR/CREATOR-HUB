/* Shared retirement view. The same UTC cutoff is enforced by the native opener. */
(() => {
  const root = document.getElementById('view-plugins');
  if (!root) return;
  const cutoff = Date.UTC(2026, 9, 20);
  const invoke = () => (window.CreatorCommunityInvoke || window.CreatorHubNative.invoke)('open_plugins_website');
  const title = document.createElement('h2');
  title.id = 'plugins-title'; title.tabIndex = -1; title.textContent = 'Creator Plugins';
  const heading = document.createElement('div'); heading.className = 'community-heading'; heading.append(title);
  const notice = document.createElement('p'); notice.className = 'community-retirement'; notice.setAttribute('role', 'status');
  const preservation = document.createElement('p'); preservation.className = 'community-subtitle';
  preservation.textContent = 'Existing imported assets and Unity project files are unchanged.';
  const website = document.createElement('button'); website.type = 'button'; website.className = 'community-secondary';
  const symbol = document.createElement('span'); symbol.className = 'icon icon-external'; symbol.setAttribute('aria-hidden', 'true');
  website.append(symbol, document.createTextNode('Visit creatorplugins.store'));
  const message = document.createElement('p'); message.className = 'community-message'; message.setAttribute('role', 'status'); message.hidden = true;
  let previous = null;
  function render() {
    const now = Date.now();
    const available = Number.isFinite(now) && now >= 0 && now < cutoff;
    if (available === previous) return available;
    previous = available;
    notice.textContent = available
      ? 'Creator Plugins is retiring from the Creator apps on 20 October 2026.'
      : 'Creator Plugins has been retired from the Creator apps.';
    if (available) root.insertBefore(website, message);
    else { website.remove(); message.textContent = ''; message.hidden = true; }
    for (const node of document.querySelectorAll('[data-plugins-status]')) node.textContent = available ? 'Retiring' : 'Retired';
    return available;
  }
  website.addEventListener('click', async () => {
    if (!render()) return;
    website.disabled = true; message.hidden = true;
    try { await invoke(); }
    catch (error) { if (render()) { message.textContent = String(error); message.hidden = false; } }
    finally { website.disabled = false; }
  });
  root.replaceChildren(heading, notice, preservation, message);
  window.CreatorCommunity = Object.freeze({ show: render, closePreview() {} });
  render();
  // Re-evaluate after sleep/backgrounding and across midnight without an update.
  window.addEventListener('focus', render);
  document.addEventListener('visibilitychange', render);
  setInterval(render, 60_000);
})();
