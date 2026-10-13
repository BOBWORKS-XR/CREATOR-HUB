(() => {
  // Standalone and hosted views share app.js; only their native transport differs.
  if (window === window.parent) {
    window.CreatorRuntime = {
      invoke: (command, args) => window.__TAURI__.core.invoke(command, args),
      listen: (name, callback) => window.__TAURI__.event.listen(name, callback),
    };
    return;
  }
  const pending = new Map();
  const listeners = new Map();
  let sequence = 0;
  let port;
  let failed = false;
  let connect;
  const ready = new Promise(resolve => { connect = resolve; });
  function disconnect(reason) {
    failed = true;
    for (const request of pending.values()) request.reject(reason);
    pending.clear();
    for (const callback of listeners.get('creator-lifecycle-close-blocked') || []) callback({ payload: reason });
    const error = document.querySelector('#action-error');
    if (error) { error.textContent = reason; error.classList.remove('hidden'); }
    document.querySelector('main').inert = true;
  }
  window.addEventListener('message', event => {
    if (port || event.source !== window.parent || event.data?.type !== 'creator-host-connect'
      || event.data?.protocol !== 1 || event.ports.length !== 1) return;
    port = event.ports[0];
    port.onmessage = ({ data }) => {
      if (data?.type === 'disconnect') return disconnect('Hub lost its connection to Setup. No command will be retried automatically.');
      if (data?.type === 'event') {
        for (const callback of listeners.get(data.name) || []) callback({ payload: data.payload });
      } else if (data?.type === 'result' && pending.has(data.id)) {
        const request = pending.get(data.id);
        pending.delete(data.id);
        if (data.ok) request.resolve(data.result); else request.reject(data.error);
      }
    };
    document.documentElement.classList.add('creator-hosted');
    connect();
    port.postMessage({ type: 'ready', protocol: 1 });
  });
  window.CreatorRuntime = {
    async invoke(command, args = {}) {
      await ready;
      if (failed) throw new Error('Setup is disconnected.');
      if (pending.size >= 16) throw new Error('Too many pending Setup operations.');
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        port.postMessage({ type: 'invoke', id, command, args });
      });
    },
    async listen(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
      return () => listeners.get(name)?.delete(callback);
    },
  };
})();
