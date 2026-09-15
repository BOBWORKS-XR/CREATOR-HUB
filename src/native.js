(() => {
  const key = window.__CREATOR_SHELL_KEY__;
  delete window.__CREATOR_SHELL_KEY__;
  const invoke = window.__TAURI__.core.invoke;
  const discovery = new Set(['project_inventory', 'app_inventory', 'hub_update_status', 'community_projects']);
  let pendingDiscovery = Promise.resolve();
  window.CreatorHubNative = Object.freeze({
    version: window.__CREATOR_HUB_VERSION__,
    invoke: (command, args = {}) => {
      const run = () => invoke(command, args, key ? { headers: { 'x-creator-shell-key': key } } : undefined);
      if (!discovery.has(command)) return run();
      // These scans share the native Manager lock. Queue reads, never user actions.
      const result = pendingDiscovery.then(run);
      pendingDiscovery = result.catch(() => {});
      return result;
    },
  });
})();
