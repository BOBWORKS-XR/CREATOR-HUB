(() => {
  const key = window.__CREATOR_SHELL_KEY__;
  delete window.__CREATOR_SHELL_KEY__;
  const invoke = window.__TAURI__.core.invoke;
  window.CreatorHubNative = Object.freeze({
    invoke: (command, args = {}) => invoke(command, args, key ? { headers: { 'x-creator-shell-key': key } } : undefined),
  });
})();
