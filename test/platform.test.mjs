import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import register from '../dist/index.js';
import { Rpc3Platform } from '../dist/platform.js';
import { OutletAccessory } from '../dist/accessory.js';
import { PduController } from '../dist/controller.js';
import { accessoryKey } from '../dist/config.js';
import { config, fakePdu } from './fake-pdu.mjs';

class FakeCharacteristic {
  onGet(fn) { this.get = fn; return this; }
  onSet(fn) { this.set = fn; return this; }
}
class FakeService {
  chars = new Map();
  getCharacteristic(key) {
    if (!this.chars.has(key)) this.chars.set(key, new FakeCharacteristic());
    return this.chars.get(key);
  }
  setCharacteristic(key, value) { return this.updateCharacteristic(key, value); }
  updateCharacteristic(key, value) { this.getCharacteristic(key).value = value; return this; }
}
class FakeAccessory {
  context = {};
  services = new Map([['info', new FakeService()]]);
  constructor(name, uuid) { this.displayName = name; this.UUID = uuid; }
  getService(type) { return this.services.get(type); }
  addService(type) { const service = new FakeService(); this.services.set(type, service); return service; }
}
function fakeApi() {
  const api = new EventEmitter();
  const calls = { added: [], removed: [], updated: [], registration: [] };
  api.hap = {
    Service: { AccessoryInformation: 'info', Switch: 'switch' },
    Characteristic: Object.fromEntries(['Manufacturer', 'Model', 'SerialNumber', 'FirmwareRevision', 'Name', 'ConfiguredName', 'On'].map(key => [key, key])),
    HapStatusError: class extends Error { constructor(code) { super(String(code)); this.hapStatus = code; } },
    HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402, INVALID_VALUE_IN_REQUEST: -70410 },
    uuid: { generate: key => key },
  };
  api.platformAccessory = FakeAccessory;
  api.registerPlatformAccessories = (_plugin, _platform, items) => calls.added.push(...items);
  api.unregisterPlatformAccessories = (_plugin, _platform, items) => calls.removed.push(...items);
  api.updatePlatformAccessories = items => calls.updated.push(...items);
  api.registerPlatform = (...args) => calls.registration.push(args);
  return { api, calls };
}
const log = { info() {}, warn() {}, error() {}, debug() {} };

test('platform registers through standard API, restores identity, removes stale modes, and stores no credentials', async t => {
  const server = await fakePdu();
  t.after(() => server.close());
  const { api, calls } = fakeApi();
  t.after(() => api.emit('shutdown'));
  register(api);
  assert.equal(calls.registration[0][0], 'homebridge-rpc3control');
  assert.equal(calls.registration[0][1], 'Rpc3Control');
  const pdu = config(server.port);
  const existing = new FakeAccessory('Old name', accessoryKey(pdu.id, pdu.outlets[0]));
  existing.addService('switch');
  const removed = new FakeAccessory('Old role', accessoryKey(pdu.id, { number: 1, mode: 'reboot' }));
  const platform = new Rpc3Platform(log, { platform: 'Rpc3Control', pdus: [pdu] }, api);
  platform.configureAccessory(existing);
  platform.configureAccessory(removed);
  api.emit('didFinishLaunching');
  assert.equal(calls.added.length, 0);
  assert.deepEqual(calls.updated, [existing]);
  assert.deepEqual(calls.removed, [removed]);
  assert.equal(existing.displayName, 'Outlet 1');
  assert.deepEqual(existing.context, { pduId: 'test', outletNumber: 1, mode: 'power' });
  const on = existing.getService('switch').getCharacteristic('On');
  assert.equal(await on.get(), true);
  await on.set(false);
  assert.equal(await on.get(), false);
});

test('invalid configuration preserves cached accessories but makes their handlers unavailable', async () => {
  const { api, calls } = fakeApi();
  const existing = new FakeAccessory('Retained', 'existing');
  existing.addService('switch');
  const platform = new Rpc3Platform(log, { platform: 'Rpc3Control', pdus: [{ id: 'bad' }] }, api);
  platform.configureAccessory(existing);
  api.emit('didFinishLaunching');
  const on = existing.getService('switch').getCharacteristic('On');
  assert.throws(() => on.get(), { hapStatus: -70402 });
  assert.throws(() => on.set(true), { hapStatus: -70402 });
  assert.deepEqual(calls.removed, []);
  api.emit('shutdown');
});

test('power-aware HomeKit switch reads real state, reboots on Off and returns to On', async t => {
  const server = await fakePdu({ rebootMs: 40 });
  const controller = new PduController(config(server.port));
  const { api } = fakeApi();
  const accessory = new FakeAccessory('Router', 'router');
  const outlet = { number: 1, name: 'Router', mode: 'reboot', resetAfterMs: 100 };
  const handler = new OutletAccessory(api, log, accessory, controller, outlet);
  t.after(() => { handler.dispose(); controller.stop(); });
  t.after(() => server.close());
  const on = accessory.getService('switch').getCharacteristic('On');
  assert.equal(await on.get(), true);
  await on.set(false);
  await assert.rejects(on.set(false), { hapStatus: -70402 });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.deepEqual(server.commands, ['reboot 1']);
  assert.equal(on.value, true);
  assert.equal(await on.get(), true);
  await assert.rejects(handler.setOn('invalid'), { hapStatus: -70410 });
});

 test('reboot-only platforms perform startup status discovery', async t => {
  const server = await fakePdu();
  const { api, calls } = fakeApi();
  t.after(() => api.emit('shutdown'));
  t.after(() => server.close());
  const pdu = config(server.port);
  pdu.outlets[0].mode = 'reboot';
  new Rpc3Platform(log, { platform: 'Rpc3Control', pdus: [pdu] }, api);
  api.emit('didFinishLaunching');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(calls.added[0].getService('switch').getCharacteristic('On').value, true);
  assert.deepEqual(server.commands, []);
});

test('startup registration failure is logged, stops partial setup and preserves cached accessories', async t => {
  const server = await fakePdu();
  t.after(() => server.close());
  const { api, calls } = fakeApi();
  const messages = [];
  const pdu = config(server.port, { outlets: [
    { number: 1, name: 'First', mode: 'power', resetAfterMs: 3000 },
    { number: 2, name: 'Second', mode: 'power', resetAfterMs: 3000 },
  ] });
  const stale = new FakeAccessory('Retained', 'stale');
  stale.addService('switch');
  const originalRegister = api.registerPlatformAccessories;
  api.registerPlatformAccessories = (...args) => {
    if (calls.added.length) throw new Error('private startup sentinel');
    originalRegister(...args);
  };
  const platform = new Rpc3Platform({ ...log, error: message => messages.push(message) }, { platform: 'Rpc3Control', pdus: [pdu] }, api);
  platform.configureAccessory(stale);
  assert.doesNotThrow(() => api.emit('didFinishLaunching'));
  assert.equal(calls.added.length, 1);
  assert.deepEqual(calls.removed, []);
  for (const accessory of [stale, ...calls.added]) {
    const on = accessory.getService('switch').getCharacteristic('On');
    assert.throws(() => on.get(), { hapStatus: -70402 });
    assert.throws(() => on.set(true), { hapStatus: -70402 });
    assert.equal(on.value.hapStatus, -70402);
  }
  assert.equal(messages.length, 1);
  assert.equal(messages[0], 'RPC PDU startup failed: Unexpected internal error');
  api.emit('didFinishLaunching'); // Failure must not silently retry setup.
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(server.sessions, 0);
  assert.doesNotThrow(() => api.emit('shutdown'));
});

test('one damaged cached accessory cannot prevent invalid-configuration handling for others', () => {
  const { api } = fakeApi();
  const messages = [];
  const platform = new Rpc3Platform({ ...log, error: message => messages.push(message) }, { platform: 'Rpc3Control', pdus: [{}] }, api);
  const broken = new FakeAccessory('Broken', 'broken');
  broken.getService = () => { throw new Error('private accessory sentinel'); };
  const healthy = new FakeAccessory('Retained', 'healthy');
  healthy.addService('switch');
  platform.configureAccessory(broken);
  platform.configureAccessory(healthy);
  assert.doesNotThrow(() => api.emit('didFinishLaunching'));
  assert.throws(() => healthy.getService('switch').getCharacteristic('On').get(), { hapStatus: -70402 });
  assert.ok(messages.some(message => message.includes('Could not mark an RPC outlet unavailable')));
  assert.ok(messages.every(message => !message.includes('sentinel')));
  api.emit('shutdown');
});

test('shutdown continues disposing other resources if one handler throws', () => {
  const { api } = fakeApi();
  const messages = [];
  const platform = new Rpc3Platform({ ...log, error: message => messages.push(message) }, { platform: 'Rpc3Control' }, api);
  let stopped = 0;
  let disposed = 0;
  platform.controllers.push({ stop() { throw new Error('private stop sentinel'); } }, { stop() { stopped++; } });
  platform.handlers.push({ dispose() { throw new Error('private dispose sentinel'); } }, { dispose() { disposed++; } });
  assert.doesNotThrow(() => api.emit('shutdown'));
  assert.equal(stopped, 1);
  assert.equal(disposed, 1);
  assert.equal(messages.length, 2);
  assert.ok(messages.every(message => !message.includes('sentinel')));
  api.emit('shutdown');
  assert.equal(stopped, 1);
  assert.equal(disposed, 1);
});

function captureLogs() {
  const records = [];
  const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, message => records.push({ level, message })]));
  return { records, logger };
}

test('power actions log acceptance at info while HomeKit reads and cache hits stay at debug', async t => {
  const server = await fakePdu();
  const { records, logger } = captureLogs();
  const controller = new PduController(config(server.port), undefined, logger.error, logger.debug);
  const { api } = fakeApi();
  const handler = new OutletAccessory(api, logger, new FakeAccessory('Desk', 'desk'), controller, { number: 1, name: 'Desk', mode: 'power' });
  t.after(() => { handler.dispose(); controller.stop(); }); t.after(() => server.close());
  assert.equal(await handler.getOn(), true);
  assert.equal(await handler.getOn(), true);
  assert.equal(server.sessions, 1, 'logging must not add status requests');
  assert.ok(records.every(record => record.level === 'debug'));
  assert.ok(records.some(record => record.message.includes('Status read (HomeKit): cache hit')));
  assert.ok(records.some(record => record.message.includes('HomeKit state read returned On')));
  await handler.setOn(false);
  await handler.setOn(true);
  await controller.getStatus();
  assert.deepEqual(server.commands, ['off 1', 'on 1']);
  const info = records.filter(record => record.level === 'info').map(record => record.message);
  assert.deepEqual(info, [
    '[Test] Outlet 1 (Desk): HomeKit Off request: Off command accepted by PDU.',
    '[Test] Outlet 1 (Desk): HomeKit On request: On command accepted by PDU.',
  ]);
  assert.ok(records.every(record => !record.message.includes('secret') && !record.message.includes('admin')));
});

test('reboot logs no-ops, native command acceptance and exactly one confirmed recovery', async t => {
  const server = await fakePdu({ rebootMs: 40 });
  const { records, logger } = captureLogs();
  const controller = new PduController(config(server.port), undefined, logger.error, logger.debug);
  const { api } = fakeApi();
  const handler = new OutletAccessory(api, logger, new FakeAccessory('Router', 'router'), controller,
    { number: 1, name: 'Router', mode: 'reboot', resetAfterMs: 100 });
  t.after(() => { handler.dispose(); controller.stop(); }); t.after(() => server.close());
  await handler.setOn(true); // Already On.
  await handler.setOn(false);
  await new Promise(resolve => setTimeout(resolve, 250));
  await handler.getOn();
  await handler.getOn();
  const info = records.filter(record => record.level === 'info').map(record => record.message);
  assert.equal(info.length, 3);
  assert.match(info[0], /already On; no power command needed/);
  assert.match(info[1], /native Reboot command accepted by PDU/);
  assert.match(info[2], /Reboot request recovery: outlet power confirmed On/);
  assert.deepEqual(server.commands, ['reboot 1']);
  assert.ok(records.some(record => record.level === 'debug' && record.message.includes('Status read (recovery)')));
});

test('uncertain reboot is warned about without logging acceptance or premature recovery', async t => {
  const server = await fakePdu({ rebootMs: 40, disconnectOnReboot: true });
  const { records, logger } = captureLogs();
  const controller = new PduController(config(server.port), undefined, logger.error, logger.debug);
  const { api } = fakeApi();
  const handler = new OutletAccessory(api, logger, new FakeAccessory('Router', 'router'), controller,
    { number: 1, name: 'Router', mode: 'reboot', resetAfterMs: 100 });
  t.after(() => { handler.dispose(); controller.stop(); }); t.after(() => server.close());
  await assert.rejects(handler.setOn(false), { hapStatus: -70402 });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(records.filter(record => record.level === 'info').length, 0);
  assert.ok(records.some(record => record.level === 'warn' && record.message.includes('UNCERTAIN')));
  assert.deepEqual(server.commands, ['reboot 1']);
});

test('a throwing success logger does not turn an accepted command into failure or retry it', async t => {
  t.mock.method(console, 'error', () => {});
  const server = await fakePdu();
  const controller = new PduController(config(server.port));
  const { api } = fakeApi();
  const handler = new OutletAccessory(api, { ...log, info() { throw new Error('private logger sentinel'); } },
    new FakeAccessory('Desk', 'desk'), controller, { number: 1, name: 'Desk', mode: 'power' });
  t.after(() => { handler.dispose(); controller.stop(); }); t.after(() => server.close());
  await assert.doesNotReject(handler.setOn(false));
  await controller.getStatus();
  assert.deepEqual(server.commands, ['off 1']);
});

test('an Off reboot outlet logs an Off no-op, then an accepted On command and On recovery', async t => {
  const server = await fakePdu();
  server.states.set(1, false);
  const { records, logger } = captureLogs();
  const controller = new PduController(config(server.port));
  const { api } = fakeApi();
  const handler = new OutletAccessory(api, logger, new FakeAccessory('Router', 'router'), controller,
    { number: 1, name: 'Router', mode: 'reboot', resetAfterMs: 100 });
  t.after(() => { handler.dispose(); controller.stop(); }); t.after(() => server.close());
  await handler.setOn(false);
  await handler.setOn(true);
  await new Promise(resolve => setTimeout(resolve, 250));
  const info = records.filter(record => record.level === 'info').map(record => record.message);
  assert.equal(info.length, 3);
  assert.match(info[0], /already Off; no power command needed/);
  assert.match(info[1], /On command accepted by PDU/);
  assert.match(info[2], /On request recovery: outlet power confirmed On/);
  assert.deepEqual(server.commands, ['on 1']);
});
