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
