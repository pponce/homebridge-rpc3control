import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectionTester } from '../dist/ui-test.js';
import { parseConfig } from '../dist/config.js';
import { addMissingOutlets, fromSeconds, loadConfig, newPdu, toSeconds } from '../homebridge-ui/public/model.js';
import { fakePdu, config } from './fake-pdu.mjs';

test('outlet generation fills gaps without replacing existing names, modes or settings', () => {
  const pdu = newPdu(1, 'fixed');
  const existing = { number: 3, name: 'Router reboot', mode: 'reboot', resetAfterMs: 1250, future: true };
  pdu.outlets = [existing];
  assert.equal(addMissingOutlets(pdu), 7);
  assert.strictEqual(pdu.outlets[0], existing);
  assert.equal(addMissingOutlets(pdu), 0);
  pdu.outletCount = 2;
  assert.equal(addMissingOutlets(pdu), 0);
  assert.equal(pdu.outlets.length, 8);
  assert.throws(() => parseConfig([{ ...pdu, host: 'pdu.local' }]), /outlet number/);
});

test('settings preserve millisecond precision and Homebridge metadata', () => {
  for (const ms of [0, 100, 1250, 15001, 86400000]) assert.equal(fromSeconds(toSeconds(ms)), ms);
  assert.equal(fromSeconds(''), null);
  const original = [{ platform: 'Rpc3Control', _bridge: { username: 'AA:BB:CC:DD:EE:FF' }, future: true, pdus: [config(23)] }, { platform: 'Rpc3Control', name: 'Keep extra block', pdus: [] }];
  const loaded = loadConfig(original);
  assert.deepEqual(loaded, original);
  loaded[0].pdus[0].name = 'Renamed';
  assert.equal(original[0].pdus[0].name, 'Test');
  assert.throws(() => loadConfig([{ pdus: {} }]), /JSON editor/);
});

test('connection preview is read-only, reports missing rows as Unknown, and redacts credentials', async t => {
  const server = await fakePdu({ login: true, rows: '1 Device 1 On\r\n2 Other 2 Off' });
  t.after(() => server.close());
  const tester = new ConnectionTester();
  const result = await tester.test({ ...config(server.port), action: 'reboot', outlet: 1 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.outlets.map(outlet => outlet.state), ['On', 'Off', 'Unknown', 'Unknown', 'Unknown', 'Unknown', 'Unknown', 'Unknown']);
  assert.deepEqual(server.commands, []);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal((await tester.test(config(server.port))).ok, false);
  assert.equal(server.sessions, 1);
});

test('preview serializes attempts and stops a hanging session', async t => {
  const server = await fakePdu({ hangLogin: true });
  t.after(() => server.close());
  const tester = new ConnectionTester();
  const first = tester.test(config(server.port));
  assert.match((await tester.test(config(server.port))).error, /already running/);
  tester.stop();
  assert.equal((await first).ok, false);
  assert.equal((await tester.test(config(server.port))).ok, false);
  assert.deepEqual(server.commands, []);
});

test('preview enforces deadline and rejects injected credentials without a connection', async t => {
  const server = await fakePdu({ hangLogin: true });
  t.after(() => server.close());
  const bad = await new ConnectionTester().test(config(server.port, { password: 'secret\rreboot 1' }));
  assert.equal(bad.ok, false);
  assert.equal(server.sessions, 0);
  const before = Date.now();
  const result = await new ConnectionTester().test(config(server.port, { operationTimeoutMs: 500 }));
  assert.equal(result.ok, false);
  assert.ok(Date.now() - before < 1500);
});
