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

