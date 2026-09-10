import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { fakePdu, config } from './fake-pdu.mjs';

test('packaged UI server handles real Homebridge IPC without power actions or credential leaks', { timeout: 15000 }, async t => {
  const server = await fakePdu({ login: true });
  t.after(() => server.close());
  const child = fork('homebridge-ui/server.js', { silent: true });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'exit');
      child.kill();
      await closed;
    }
  });
  const [ready] = await once(child, 'message');
  assert.equal(ready.action, 'ready');
  let id = 0;
  async function request(path, body) {
    const response = once(child, 'message');
    child.send({ action: 'request', requestId: String(++id), path, body });
    const [message] = await response;
    assert.equal(message.payload.success, true);
    return message.payload.data;
  }
  assert.equal((await request('/validate', { platform: 'Rpc3Control', pdus: [config(server.port)] })).valid, true);
  assert.equal((await request('/validate', { platform: 'Rpc3Control', pdus: [config(server.port, { outletCount: 0 })] })).valid, false);
  const preview = await request('/test-connection', { ...config(server.port), action: 'off', outlet: 1 });
  assert.equal(preview.ok, true);
  assert.equal(preview.outlets.length, 8);
  assert.deepEqual(server.commands, []);
  assert.equal(logs.includes('secret'), false);
  assert.equal(JSON.stringify(preview).includes('secret'), false);
});
