(() => {
  const key = window.__CREATOR_SHELL_KEY__;
  delete window.__CREATOR_SHELL_KEY__;
  const invoke = window.__TAURI__.core.invoke;
  const discovery = new Set(['project_inventory', 'app_inventory', 'hub_update_status', 'community_projects', 'pending_hosted_restore', 'restore_hosted_app']);
  const hostedReads = new Set(['get_hosted_snapshot', 'probe_environment', 'get_recipe',
    'get_onboarding_status', 'get_project_sdk_profile', 'get_unity_extension_status',
    'get_project_feedback_settings', 'get_stable_release']);
  let pendingDiscovery = Promise.resolve();
  window.CreatorHubNative = Object.freeze({
    version: window.__CREATOR_HUB_VERSION__,
    invoke: (command, args = {}) => {
      const run = () => invoke(command, args, key ? { headers: { 'x-creator-shell-key': key } } : undefined);
      if (!discovery.has(command) && !(command === 'hosted_app_call' && hostedReads.has(args.command))) return run();
      // Restoration and background reads share the native Manager lock. Queue
      // them together; mutations, workflow release and cancellation stay immediate.
      const result = pendingDiscovery.then(run);
      pendingDiscovery = result.catch(() => {});
      return result;
    },
  });
})();
