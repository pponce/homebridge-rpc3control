import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig, accessoryKey } from '../dist/config.js';

const pdu = () => ({ id: 'rack', name: 'Rack', host: '192.0.2.1', outletCount: 16, outlets: [{ number: 12, name: 'Switch', mode: 'reboot' }] });

test('configuration supports multiple PDUs and larger counts with explicit bounds', () => {
  const parsed = parseConfig([pdu(), { ...pdu(), id: 'other', host: '192.0.2.2' }]);
  assert.equal(parsed[0].outlets[0].number, 12);
  assert.equal(parsed[0].outlets[0].resetAfterMs, 3000);
  assert.throws(() => parseConfig([{ ...pdu(), outletCount: 8 }]), /outlet number/);
  assert.throws(() => parseConfig([pdu(), pdu()]), /Duplicate/);
  assert.throws(() => parseConfig([{ ...pdu(), password: 'secret\rreboot 1' }]), /Credentials/);
  assert.throws(() => parseConfig([{ ...pdu(), pollingIntervalMs: 1 }]), /Polling/);
  assert.throws(() => parseConfig([{ ...pdu(), outlets: [{ number: 1, name: 'Bad', mode: 'other' }] }]), /mode/);
  assert.throws(() => parseConfig([{ ...pdu(), host: 'telnet://192.0.2.1' }]), /host/);
});

test('identity survives renaming, and separates control roles and PDU IDs', () => {
  const first = { number: 1, name: 'Before', mode: 'power' };
  assert.equal(accessoryKey('rack', first), accessoryKey('rack', { ...first, name: 'After' }));
  assert.notEqual(accessoryKey('rack', first), accessoryKey('rack', { ...first, mode: 'reboot' }));
  assert.notEqual(accessoryKey('rack', first), accessoryKey('other', first));
});
