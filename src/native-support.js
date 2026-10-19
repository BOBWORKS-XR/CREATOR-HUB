(() => {
  const active = window.__CREATOR_HUB_NATIVE_SUPPORT_PROTOCOL__ === 1;
  if (!active) {
    window.CreatorNativeSupport = Object.freeze({ active: false });
    return;
  }
  const byId = id => document.getElementById(`native-support-${id}`);
  const invoke = command => window.CreatorHubNative.invoke(command);
  let state = null;
  let busy = false;
  document.body.classList.add('native-support-mode');
  byId('page').classList.remove('hidden');
  document.getElementById('platform-status').textContent = 'Linux';
  if (typeof window.CreatorHubNative.version === 'string') {
    document.querySelector('.footer-version').textContent = window.CreatorHubNative.version;
  }

  function render() {
    byId('install').hidden = state?.phase !== 'available';
    byId('install').disabled = busy || state?.phase !== 'available';
    byId('recover').hidden = state?.phase !== 'recovery';
    byId('recover').disabled = busy;
    byId('check').disabled = busy;
    if (!busy) byId('cancel').hidden = true;
  }
  function accept(value) {
    if (!value || value.mode !== 'bootstrap'
      || !['available', 'recovery', 'complete', 'blocked'].includes(value.phase)
      || typeof value.message !== 'string' || value.message.length > 4096) {
      throw Error('Native setup status is unavailable. Nothing will be retried automatically.');
    }
    state = value;
    byId('status').textContent = value.message;
  }
  function error(reason) {
    state = { phase: 'blocked' };
    byId('error').textContent = String(reason);
    byId('error').hidden = false;
    render();
  }
  async function call(command) {
    if (busy) return;
    busy = true;
    byId('error').hidden = true;
    render();
    try { accept(await invoke(command)); }
    catch (reason) { error(reason); }
    finally { busy = false; render(); }
  }
  byId('install').addEventListener('click', () => {
    if (state?.phase === 'available') call('install_native_support');
  });
  byId('recover').addEventListener('click', () => {
    if (state?.phase === 'recovery') call('review_native_support_recovery');
  });
  byId('check').addEventListener('click', () => call('native_support_status'));
  byId('cancel').addEventListener('click', async () => {
    if (!busy || byId('cancel').hidden || byId('cancel').disabled) return;
    byId('cancel').disabled = true;
    try { await invoke('cancel_download'); }
    catch (reason) {
      byId('error').textContent = String(reason);
      byId('error').hidden = false;
    }
  });
  window.CreatorNativeSupport = Object.freeze({
    active: true,
    error,
    async run() {
      try {
        await window.__TAURI__?.event?.listen('app-progress', ({ payload }) => {
          if (!busy || !payload || typeof payload.message !== 'string') return;
          byId('status').textContent = payload.message;
          byId('cancel').hidden = payload.cancellable !== true;
          byId('cancel').disabled = false;
        });
      } catch (reason) { error(reason); return; }
      await call('native_support_status');
      byId('title').focus();
    },
  });
  render();
})();
