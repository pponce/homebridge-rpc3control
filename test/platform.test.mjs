import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import register from '../dist/index.js';
import { Rpc3Platform } from '../dist/platform.js';
import { OutletAccessory } from '../dist/accessory.js';
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

test('HomeKit adapter maps errors and reboot UI updates cannot reenter command handlers', async () => {
  const { api } = fakeApi();
  const commands = [];
  const controller = {
    config: config(23),
    async command(number, action) { commands.push([number, action]); },
    async getOutlet() { throw new Error('offline'); },
    subscribe() { return () => {}; },
  };
  const accessory = new FakeAccessory('Reboot', 'reboot');
  const outlet = { number: 1, name: 'Reboot', mode: 'reboot', resetAfterMs: 20 };
  const handler = new OutletAccessory(api, log, accessory, controller, outlet);
  const on = accessory.getService('switch').getCharacteristic('On');
  assert.equal(await on.get(), false);
  await on.set(true);
  await on.set(false);
  await on.set(true);
  await delay(40);
  assert.deepEqual(commands, [[1, 'reboot']]);
  assert.equal(on.value, false);
  handler.dispose();
  const power = new OutletAccessory(api, log, new FakeAccessory('Power', 'power'), controller, { ...outlet, mode: 'power' });
  await assert.rejects(power.getOn(), { hapStatus: -70402 });
  await assert.rejects(power.setOn('invalid'), { hapStatus: -70410 });
  power.dispose();
});
