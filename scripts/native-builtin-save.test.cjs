const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { saveBuiltinSettings } = require('./native-builtin-save.cjs');

for (const failSave of [false, true]) {
  test(`native save uses the locator's second argument and releases its workflow: failure=${failSave}`, async () => {
    const server = 'C:\\owned-fixture\\server\\creator-works-mcp.mjs';
    const calls = [];
    const context = vm.createContext({ element: { tagName: 'BODY' }, server,
      window: { CreatorRuntime: { invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === 'begin_ui_operation') return 33;
        if (command === 'load_config') return { mcp_server_path: 'old', auto_start: false, tool_groups: 'full', futureSetting: 'preserve' };
        if (command === 'save_config') {
          assert.equal(args.config.mcp_server_path, server);
          assert.equal(args.config.auto_start, true);
          assert.equal(args.config.tool_groups, 'core');
          assert.equal(args.config.futureSetting, 'preserve');
          if (failSave) throw Error('injected save failure');
          return null;
        }
        assert.equal(command, 'finish_ui_operation');
        assert.equal(args.id, 33);
      } } },
    });
    const frame = { locator: selector => {
      assert.equal(selector, 'body');
      return { evaluate: (callback, argument) => {
        assert.equal(argument, server);
        return vm.runInContext(`(${callback})(element, server)`, context);
      } };
    } };
    if (failSave) await assert.rejects(saveBuiltinSettings(frame, server), /injected save failure/);
    else await saveBuiltinSettings(frame, server);
    assert.deepEqual(calls.map(call => call.command), ['begin_ui_operation', 'load_config', 'save_config', 'finish_ui_operation']);
  });
}
