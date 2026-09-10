import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PduController } from '../dist/controller.js';
import { fakePdu, config } from './fake-pdu.mjs';

test('simultaneous reads share one full-PDU cache refresh', async t => {
  const server = await fakePdu({ split: true });
  const controller = new PduController(config(server.port));
  t.after(() => controller.stop()); t.after(() => server.close());
  await Promise.all(Array.from({ length: 12 }, () => controller.getOutlet(1)));
  await controller.getOutlet(2);
  assert.equal(server.sessions, 1);
  assert.equal(server.maxActive, 1);
});

test('writes serialize and verification observes the final physical state', async t => {
  const server = await fakePdu();
  const controller = new PduController(config(server.port));
  t.after(() => controller.stop()); t.after(() => server.close());
  await Promise.all([controller.command(1, 'off'), controller.command(2, 'off'), controller.command(1, 'on')]);
  const states = await controller.getStatus();
  assert.equal(states.get(1).on, true);
  assert.equal(states.get(2).on, false);
  assert.deepEqual(server.commands, ['off 1', 'off 2', 'on 1']);
  assert.equal(server.maxActive, 1);
  assert.equal(server.sessions, 4, 'three writes and one shared verification read');
});

test('a read invalidated by a queued write refreshes rather than returning stale state', async t => {
  const server = await fakePdu({ split: true });
  const controller = new PduController(config(server.port));
  t.after(() => controller.stop()); t.after(() => server.close());
  const read = controller.getOutlet(1);
  await delay(10);
  const write = controller.command(1, 'off');
  await write;
  assert.equal(await read, false);
  assert.equal(server.maxActive, 1);
});

test('missing outlet status is unknown, never false', async t => {
  const server = await fakePdu({ rows: '1 Present 1 On' });
  const controller = new PduController(config(server.port));
  t.after(() => controller.stop()); t.after(() => server.close());
  await assert.rejects(controller.getOutlet(2), { code: 'PROTOCOL' });
  assert.equal(await controller.getOutlet(1), true);
});

test('one failed PDU cannot block another; failures back off without reconnect storms', async t => {
  const badServer = await fakePdu({ hangStatus: true });
  const goodServer = await fakePdu();
  const bad = new PduController(config(badServer.port, { operationTimeoutMs: 200 }));
  const good = new PduController(config(goodServer.port));
  t.after(() => { bad.stop(); good.stop(); });
  t.after(() => badServer.close()); t.after(() => goodServer.close());
  const failed = assert.rejects(bad.getStatus(), { code: 'TIMEOUT' });
  assert.equal(await good.getOutlet(1), true);
  await failed;
  await assert.rejects(bad.getStatus(), { code: 'BUSY' });
  assert.equal(badServer.sessions, 1);
});

test('shutdown cancels active reads and rejects pending commands without sending them', async t => {
  const server = await fakePdu({ hangStatus: true });
  const controller = new PduController(config(server.port));
  t.after(() => server.close());
  const read = assert.rejects(controller.getStatus());
  const command = assert.rejects(controller.command(1, 'off'));
  await delay(20);
  controller.stop();
  await Promise.all([read, command]);
  assert.deepEqual(server.commands, []);
  await assert.rejects(controller.getStatus(), { code: 'STOPPED' });
});

test('queued commands expire before transmission', async t => {
  const server = await fakePdu({ hangStatus: true });
  const controller = new PduController(config(server.port, { queueTimeoutMs: 30, operationTimeoutMs: 150 }));
  t.after(() => controller.stop()); t.after(() => server.close());
  const read = assert.rejects(controller.getStatus());
  await assert.rejects(controller.command(1, 'off'), { code: 'BUSY' });
  await read;
  assert.deepEqual(server.commands, []);
});


test('throwing and rejecting status listeners cannot strand reads or break later operations', { timeout: 1500 }, async t => {
  const messages = [];
  const calls = [];
  const states = new Map([[1, { number: 1, name: 'Outlet 1', on: true }]]);
  const controller = new PduController(config(23), {
    async execute(_signal, action) { calls.push(action); return action ? undefined : states; },
  }, message => messages.push(message));
  t.after(() => controller.stop());
  controller.subscribe(() => { throw new Error('private credential sentinel'); });
  controller.subscribe(async () => { throw new Error('private credential sentinel'); });
  const healthyUpdates = [];
  controller.subscribe(status => { healthyUpdates.push(status); });
  assert.equal(await controller.getOutlet(1), true);
  assert.equal(await controller.command(1, 'ensure-on'), true);
  assert.equal(await controller.getOutlet(1), true);
  await delay(0);
  assert.deepEqual(calls, [undefined, 'ensure-on', undefined], 'listener failures do not introduce retries or cooldown');
  assert.equal(healthyUpdates.length, 2);
  assert.equal(messages.length, 4);
  assert.ok(messages.every(message => message.includes('status callback failed') && !message.includes('sentinel')));
});

test('failing error listeners preserve the original rejection and notify remaining subscribers', { timeout: 1500 }, async t => {
  const messages = [];
  const failure = new Error('protocol failure sentinel');
  const controller = new PduController(config(23), { async execute() { throw failure; } }, message => messages.push(message));
  t.after(() => controller.stop());
  controller.subscribe(() => { throw new Error('listener failure sentinel'); });
  controller.subscribe(async () => { throw new Error('async listener failure sentinel'); });
  let received;
  controller.subscribe((_status, error) => { received = error; });
  await assert.rejects(controller.getStatus(), error => error === failure);
  await assert.rejects(controller.getStatus(), { code: 'BUSY' });
  await delay(0);
  assert.equal(received, failure);
  assert.equal(messages.length, 2);
  assert.ok(messages.every(message => !message.includes('sentinel')));
});

test('a throwing error logger cannot break status delivery', { timeout: 1500 }, async t => {
  const fallback = t.mock.method(console, 'error', () => {});
  const controller = new PduController(config(23), {
    async execute() { return new Map([[1, { number: 1, name: 'Outlet 1', on: true }]]); },
  }, () => { throw new Error('logger sentinel'); });
  t.after(() => controller.stop());
  controller.subscribe(() => { throw new Error('callback sentinel'); });
  assert.equal(await controller.getOutlet(1), true);
  assert.equal(fallback.mock.callCount(), 1);
  assert.equal(fallback.mock.calls[0].arguments[0], 'PDU status callback failed: Unexpected internal error');
});
