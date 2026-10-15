const { test } = require('node:test');
const assert = require('node:assert/strict');
const { admission, connectAndIdentify, EXPECTED, exercise, FALSE_GATES } = require('./linux-deb-helper-transaction-sdk.cjs');

test('exact opted-in repository/id/branch/push and unprivileged Linux only', () => {
  admission(EXPECTED, 'linux', 'x64', 1000);
  for (const key of Object.keys(EXPECTED)) assert.throws(() => admission({ ...EXPECTED, [key]: '' }, 'linux', 'x64', 1000));
  assert.throws(() => admission(EXPECTED, 'win32', 'x64', 1000));
  assert.throws(() => admission(EXPECTED, 'linux', 'x64', 0));
  for (const key of ['FLATPAK_ID', 'APPIMAGE', 'APPDIR', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'PYTHONPATH'])
    assert.throws(() => admission({ ...EXPECTED, [key]: 'injected' }, 'linux', 'x64', 1000));
  const container = { ...EXPECTED, CREATOR_LINUX_DEB_HELPER_CONTAINER_IMAGE: 'fixture', RUNNER_TEMP: '/__w/_temp' };
  admission(container, 'linux', 'x64', 1001);
  assert.throws(() => admission({ ...container, RUNNER_TEMP: '/home/runner/work/_temp' }, 'linux', 'x64', 1001));
  assert.throws(() => admission(container, 'linux', 'x64', 1000));
});

function fixture(failure) {
  const events = []; let retired = false;
  const files = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`resource-${index}`, {
    bytes: 1, sha256: 'same', md5: 'same', mode: 493, uid: 0, gid: 0, owner: 'creator-works-mcp' }]));
  return { events, deps: {
    async connect(alias, label) {
      events.push(`connect:${label}:${alias}`);
      return {
        async check() {
          events.push(`check:${label}:${retired ? 'after' : 'before'}`);
          if (failure === label) throw Error('SDK failed');
          return { pid: failure === 'pid' && retired ? 102 : 101, startTime: '500', referenceSha256: 'same' };
        },
        async close() {
          events.push(`close:${label}`);
          if (failure === 'close' && label === 'already-live') throw Error('Owned SDK close failed');
        },
      };
    },
    async snapshot(phase) {
      events.push(`snapshot:${phase}`);
      return { files: failure === 'hash' && retired ? { ...files, 'resource-0': { ...files['resource-0'], sha256: 'changed' } } : files };
    },
    async retire() {
      events.push('retire-once');
      if (failure === 'retire') throw Error('Helper refused; no retry');
      retired = true; return { status: 'experimental-transaction-verified' };
    },
    async repeat() {
      events.push('repeat-marker-negative-test');
      if (failure === 'repeat') throw Error('Wrong refusal');
      return { status: 'manual-repair-required' };
    },
    setup: {
      async snapshot(phase) { events.push(`setup-snapshot:${phase}`); if (failure === `setup-${phase}`) throw Error('Setup snapshot failed'); },
      async retire() { events.push('setup-retire-once'); if (failure === 'setup-retire') throw Error('Setup refused'); },
      async repeat() { events.push('setup-repeat'); if (failure === 'setup-repeat') throw Error('Setup repeat failed'); },
    },
    verifySettings() { events.push('settings'); return { sentinel: 'same' }; },
  } };
}

test('live SDK and both aliases surround both fixed transactions, then marker-only repeats', async () => {
  const { deps, events } = fixture();
  const report = { helperMechanismAccepted: false, productionGates: { ...FALSE_GATES } };
  await exercise(deps, report);
  assert.equal(events.filter(e => e === 'retire-once').length, 1);
  const at = events.indexOf('retire-once');
  assert.ok(events.indexOf('check:already-live:before') < at);
  assert.ok(events.indexOf('check:already-live:after') > at);
  for (const alias of ['node', 'node.exe']) {
    assert.ok(events.indexOf(`connect:before-${alias}:${alias}`) < at);
    assert.ok(events.indexOf(`connect:after-${alias}:${alias}`) > at);
  }
  assert.ok(events.indexOf('repeat-marker-negative-test') > events.indexOf('snapshot:after'));
  assert.equal(events.filter(e => e === 'setup-retire-once').length, 1);
  assert.ok(events.indexOf('setup-retire-once') > at);
  assert.ok(events.indexOf('setup-retire-once') < events.indexOf('check:already-live:after'));
  assert.ok(events.indexOf('setup-repeat') > events.indexOf('setup-snapshot:after'));
  assert.equal(events.at(-1), 'close:already-live');
  assert.equal(report.helperMechanismAccepted, true);
  assert.equal(report.setupHelperMechanismAccepted, true);
  assert.deepEqual(report.productionGates, FALSE_GATES);
});

test('failures never retry, earn acceptance, or run marker test before all postchecks', async () => {
  for (const failure of ['before-node.exe', 'retire', 'after-node', 'pid', 'hash', 'repeat', 'close',
    'setup-before', 'setup-retire', 'setup-after', 'setup-repeat']) {
    const { deps, events } = fixture(failure);
    const report = { helperMechanismAccepted: false, productionGates: { ...FALSE_GATES } };
    await assert.rejects(exercise(deps, report));
    assert.equal(report.helperMechanismAccepted, false);
    assert.notEqual(report.setupHelperMechanismAccepted, true);
    assert.deepEqual(report.productionGates, FALSE_GATES);
    assert.equal(events.at(-1), 'close:already-live');
    assert.ok(events.filter(e => e === 'retire-once').length <= 1);
    if (!['repeat', 'close', 'setup-repeat'].includes(failure)) assert.ok(!events.includes('repeat-marker-negative-test'));
    if (failure === 'before-node.exe') assert.ok(!events.includes('retire-once'));
  }
});

test('all production gates remain false and no auth or broad retirement acceptance is substituted', () => {
  assert.equal(Object.keys(FALSE_GATES).length, 17);
  assert.ok(Object.values(FALSE_GATES).every(value => value === false));
  assert.equal(FALSE_GATES.nativeContentionAccepted, false);
  assert.equal(FALSE_GATES.actualUserAuthenticationAccepted, false);
});

test('failed SDK connection, invalid PID or post-connect identity capture closes only its owned client', async () => {
  for (const failure of ['connect', 'pid', 'identity', 'start-time', null]) {
    const events = [];
    const client = {
      async connect() { events.push('connect'); if (failure === 'connect') throw Error('connect failed'); },
      async close() { events.push('close'); },
    };
    const transport = { pid: failure === 'pid' ? null : 101 };
    const identify = pid => {
      assert.equal(pid, 101); events.push('identify');
      if (failure === 'identity') throw Error('process disappeared');
      return failure === 'start-time' ? undefined : '500';
    };
    if (failure) {
      await assert.rejects(connectAndIdentify(client, transport, identify));
      assert.equal(events.at(-1), 'close');
      assert.equal(events.filter(event => event === 'close').length, 1);
    } else {
      assert.deepEqual(await connectAndIdentify(client, transport, identify), { pid: 101, startTime: '500' });
      assert.ok(!events.includes('close'));
    }
  }
});
