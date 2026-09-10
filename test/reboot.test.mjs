import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { RpcProtocol } from '../dist/protocol.js';
import { PduController } from '../dist/controller.js';
import { PowerAwareReboot } from '../dist/reboot.js';
import { PduError } from '../dist/errors.js';
import { fakePdu, config } from './fake-pdu.mjs';

test('fresh power state selects native on/reboot or a no-op in the same session', async t => {
  const server = await fakePdu();
  t.after(() => server.close());
  const protocol = new RpcProtocol(config(server.port));
  const execute = action => protocol.execute(new AbortController().signal, action, 1);
  await execute('ensure-on'); // already On: no-op
  await execute('reboot-if-on');
  server.states.set(1, false); // external change
  await execute('reboot-if-on'); // already Off: no-op
  await execute('ensure-on');
  assert.deepEqual(server.commands, ['reboot 1', 'on 1']);
  assert.equal(server.sessions, 4);
});

test('unknown fresh status never guesses or sends a power action', async t => {
  const server = await fakePdu({ rows: '2 Other 2 On' });
  t.after(() => server.close());
  await assert.rejects(new RpcProtocol(config(server.port)).execute(new AbortController().signal, 'reboot-if-on', 1), { code: 'PROTOCOL' });
  assert.deepEqual(server.commands, []);
});

test('power-aware action ignores stale cache, avoids needless verification on no-op', async t => {
  const server = await fakePdu();
  const controller = new PduController(config(server.port));
  t.after(() => controller.stop()); t.after(() => server.close());
  assert.equal(await controller.getOutlet(1), true);
  server.states.set(1, false);
  assert.equal(await controller.command(1, 'reboot-if-on'), false);
  assert.equal(await controller.getOutlet(1), false);
  assert.equal(server.sessions, 2);
  assert.deepEqual(server.commands, []);
});

test('native reboot restores power after network loss, recovery never resends it or sends On', { timeout: 12000 }, async t => {
  const server = await fakePdu({ rebootMs: 80, disconnectOnReboot: true });
  const controller = new PduController(config(server.port, { pollingIntervalMs: 0 }));
  let unavailable = 0;
  const reboot = new PowerAwareReboot(controller, 1, 100, () => unavailable++);
  t.after(() => { reboot.stop(); controller.stop(); }); t.after(() => server.close());
  const updates = [];
  controller.subscribe(status => { const on = status?.get(1)?.on; updates.push(on); if (on !== undefined) reboot.observe(on); });
  await assert.rejects(reboot.set(false), { code: 'UNCERTAIN' });
  await assert.rejects(reboot.set(false), { code: 'BUSY' });
  await assert.rejects(reboot.set(true), { code: 'BUSY' });
  await delay(200);
  assert.equal(server.states.get(1), true, 'PDU restored power without a plugin On command');
  for (let i = 0; i < 60 && updates.at(-1) !== true; i++) await delay(100);
  assert.equal(updates.at(-1), true, 'recovery reads return the HomeKit switch to On even with polling disabled');
  assert.deepEqual(server.commands, ['reboot 1']);
  assert.ok(unavailable > 0);
  assert.equal(server.maxActive, 1);
});

test('recovery timer never invents On, backs off and stops after ten minutes', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  let reads = 0;
  let actions = 0;
  let unknown = 0;
  const messages = [];
  const controller = {
    async command() { actions++; throw new PduError('UNCERTAIN', 'reply lost'); },
    async getStatus() { reads++; throw new PduError('UNREACHABLE', 'offline'); },
  };
  const reboot = new PowerAwareReboot(controller, 1, 3000, () => unknown++, undefined,
    (level, message) => messages.push({ level, message }));
  t.after(() => reboot.stop());
  await assert.rejects(reboot.set(false));
  for (let i = 0; i < 15; i++) {
    t.mock.timers.tick(60000);
    await Promise.resolve(); await Promise.resolve();
  }
  assert.equal(actions, 1);
  assert.ok(reads > 1 && reads <= 11);
  assert.equal(unknown, reads);
  const finishedReads = reads;
  t.mock.timers.tick(600000);
  await Promise.resolve();
  assert.equal(reads, finishedReads);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].level, 'warn');
  assert.match(messages[0].message, /recovery ended without confirming On/);
});

test('duplicate and opposite writes are blocked until a post-delay On confirmation', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const commands = [];
  const controller = {
    async command(_number, action) { commands.push(action); return true; },
    async getStatus() { return new Map([[1, { on: false }]]); },
  };
  const reboot = new PowerAwareReboot(controller, 1, 3000, () => {});
  t.after(() => reboot.stop());
  const first = reboot.set(false);
  await assert.rejects(reboot.set(false), { code: 'BUSY' });
  await first;
  reboot.observe(true); // too early to release guard
  await assert.rejects(reboot.set(true), { code: 'BUSY' });
  t.mock.timers.tick(3000);
  await Promise.resolve(); await Promise.resolve();
  await assert.rejects(reboot.set(false), { code: 'BUSY' });
  reboot.observe(true);
  await reboot.set(true);
  assert.deepEqual(commands, ['reboot-if-on', 'ensure-on']);
});

test('shutdown prevents queued actions and cancels read-only recovery', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  let commands = 0;
  let reads = 0;
  const controller = { async command() { commands++; return true; }, async getStatus() { reads++; return new Map(); } };
  const stopped = new PowerAwareReboot(controller, 1, 100, () => {});
  const pending = stopped.set(false);
  stopped.stop();
  await assert.rejects(pending, { code: 'STOPPED' });
  assert.equal(commands, 0);
  const reboot = new PowerAwareReboot(controller, 1, 100, () => {});
  await reboot.set(false);
  reboot.stop();
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(reads, 0);
  assert.equal(commands, 1);
});

for (const asyncFailure of [false, true]) {
  test(`recovery continues after a ${asyncFailure ? 'rejecting' : 'throwing'} unavailable callback`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    const messages = [];
    let reads = 0;
    let commands = 0;
    const controller = {
      async command() { commands++; return true; },
      async getStatus() {
        if (++reads === 1) throw new PduError('UNREACHABLE', 'offline');
        return new Map([[1, { on: true }]]);
      },
    };
    const unavailable = asyncFailure
      ? async () => { throw new Error('private async callback sentinel'); }
      : () => { throw new Error('private callback sentinel'); };
    const reboot = new PowerAwareReboot(controller, 1, 100, unavailable, message => messages.push(message));
    t.after(() => reboot.stop());
    const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
    await reboot.set(false);
    t.mock.timers.tick(100);
    await flush();
    assert.equal(messages.length, 1);
    assert.equal(messages[0], 'Outlet recovery callback failed: Unexpected internal error');
    await assert.rejects(reboot.set(false), { code: 'BUSY' });
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(reads, 2);
    assert.equal(commands, 1, 'recovery never retries a power command');
    await reboot.set(true); // Confirmed On ended the recovery guard.
    assert.equal(commands, 2);
  });
}
