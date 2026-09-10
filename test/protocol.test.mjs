import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { TelnetDecoder, TelnetTransport } from '../dist/telnet.js';
import { RpcProtocol, parseStatus } from '../dist/protocol.js';
import { fakePdu, config } from './fake-pdu.mjs';

test('Telnet handles embedded, fragmented negotiation and escaped IAC without loops', () => {
  const replies = [];
  const decoder = new TelnetDecoder(bytes => replies.push([...bytes]));
  const bytes = Buffer.from([65, 255, 251, 1, 255, 251, 1, 66, 255, 253, 24, 255, 250, 24, 1, 255, 240, 67, 255, 255, 13, 0]);
  const output = Buffer.concat([...bytes].map(byte => decoder.decode(Buffer.from([byte]))));
  assert.deepEqual([...output], [65, 66, 67, 255, 13]);
  assert.deepEqual(replies, [[255, 253, 1], [255, 252, 24]]);
});

test('parser preserves physical-number field and supports names with spaces', () => {
  const result = parseStatus('99 Network Switch 12 Off\r\n1 Home-Server 1 On', 16);
  assert.equal(result.get(12).on, false);
  assert.equal(result.get(12).name, 'Network Switch');
  assert.equal(result.has(2), false);
  assert.throws(() => parseStatus('1 A 1 On\n2 B 1 Off', 8), /duplicate/);
  assert.throws(() => parseStatus('1 A 9 On', 8), /out-of-range/);
  assert.throws(() => parseStatus('1 A 1 Unknown', 8), /No recognizable/);
});

for (const options of [
  {}, { login: true }, { login: true, passwordless: true },
  { wakeOnly: true }, { menuFallback: true }, { split: true, negotiate: true, login: true },
]) {
  test(`status login flow ${JSON.stringify(options)}`, async t => {
    const server = await fakePdu(options);
    t.after(() => server.close());
    const result = await new RpcProtocol(config(server.port)).execute(new AbortController().signal);
    assert.equal(result.size, 8);
    assert.equal(result.get(1).on, true);
    assert.deepEqual(server.commands, []);
  });
}

test('native power and reboot commands use configurable physical numbers', async t => {
  const server = await fakePdu({ count: 16, model: 16 });
  t.after(() => server.close());
  const protocol = new RpcProtocol(config(server.port, { outletCount: 16 }));
  for (const action of ['off', 'on', 'reboot']) await protocol.execute(new AbortController().signal, action, 12);
  assert.deepEqual(server.commands, ['off 12', 'on 12', 'reboot 12']);
});

test('post-transmission disconnect reports uncertainty and never retries', async t => {
  const server = await fakePdu({ disconnectOnCommand: true });
  t.after(() => server.close());
  await assert.rejects(new RpcProtocol(config(server.port)).execute(new AbortController().signal, 'reboot', 1), { code: 'UNCERTAIN' });
  assert.deepEqual(server.commands, ['reboot 1']);
});

test('explicit rejection is not reported as acceptance or uncertainty', async t => {
  const server = await fakePdu({ rejectCommand: true });
  t.after(() => server.close());
  await assert.rejects(new RpcProtocol(config(server.port)).execute(new AbortController().signal, 'off', 1), { code: 'PROTOCOL' });
});

test('wrong credentials fail without echoing passwords in the error', async t => {
  const server = await fakePdu({ login: true });
  t.after(() => server.close());
  await assert.rejects(new RpcProtocol(config(server.port, { password: 'private-example' })).execute(new AbortController().signal), error => {
    assert.equal(error.code, 'PROTOCOL');
    assert.equal(error.message.includes('private-example'), false);
    return true;
  });
});

test('transport rejects hanging reads on abort and closes the socket', async t => {
  const server = await fakePdu({ hangLogin: true });
  t.after(() => server.close());
  const abort = new AbortController();
  const transport = new TelnetTransport(abort.signal);
  await transport.connect('127.0.0.1', server.port, 500);
  const waiting = transport.expect([/never/], 1000);
  abort.abort();
  await assert.rejects(waiting, { code: 'TIMEOUT' });
  await transport.close();
});


for (const scenario of ['oversized', 'cancelled']) {
  test(`transport never accepts buffered prompts after ${scenario} responses`, async t => {
    const server = createServer(socket => {
      socket.on('error', () => {});
      socket.end(scenario === 'oversized' ? 'x'.repeat(65537) + 'RPC-3>' : 'ready>RPC-3>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const abort = new AbortController();
    const transport = new TelnetTransport(abort.signal);
    t.after(async () => {
      await transport.close();
      await new Promise(resolve => server.close(resolve));
    });
    await transport.connect('127.0.0.1', server.address().port, 500);
    if (scenario === 'cancelled') {
      await transport.expect([/ready>/], 1000);
      abort.abort();
    }
    await assert.rejects(transport.expect([/RPC-3>/], 1000), {
      code: scenario === 'oversized' ? 'PROTOCOL' : 'TIMEOUT',
    });
  });
}
