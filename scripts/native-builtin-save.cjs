async function saveBuiltinSettings(frame, server) {
  await frame.locator('body').evaluate(async (_element, server) => {
    const invoke = (command, args = {}) => window.CreatorRuntime.invoke(command, args);
    const workflow = await invoke('begin_ui_operation');
    try {
      const config = await invoke('load_config');
      config.mcp_server_path = server;
      config.auto_start = true;
      config.tool_groups = 'core';
      await invoke('save_config', { config });
    } finally { await invoke('finish_ui_operation', { id: workflow }); }
  }, server);
}
module.exports = { saveBuiltinSettings };
