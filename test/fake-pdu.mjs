import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

/** Synthetic fixtures based on the Python parser, not captured hardware transcripts. */
export async function fakePdu(options = {}) {
  const count = options.count ?? 8;
  const states = new Map(Array.from({ length: count }, (_, n) => [n + 1, true]));
  const commands = [];
  const sockets = new Set();
  let sessions = 0;
  let maxActive = 0;
  const rows = () => options.rows ?? [...states].map(([n, on]) => `${n} Outlet-${n} ${n} ${on ? 'On' : 'Off'}`).join('\r\n');
  const server = createServer(socket => {
    sockets.add(socket);
    sessions++;
    maxActive = Math.max(maxActive, sockets.size);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let stage = options.login ? 'username' : 'menu';
    let buffer = '';
    let skip = 0;
    let sending = Promise.resolve();
    const send = data => {
      sending = sending.then(async () => {
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (options.split) {
          for (let i = 0; i < bytes.length; i += 3) {
            if (socket.destroyed) return;
            socket.write(bytes.subarray(i, i + 3));
            await delay(1);
          }
        } else if (!socket.destroyed) socket.write(bytes);
      });
    };
    const prompt = () => stage === 'username' ? 'Enter username>' : stage === 'password' ? 'Enter password>' : 'Enter Selection>';
    const status = () => send(`${rows()}\r\nType "Help" for a list of commands\r\nRPC-${options.model ?? 3}>`);
    if (options.negotiate) send(Buffer.from([255, 251, 1, 255, 251, 3, 255, 253, 24]));
    send('BayTech RPC\r\nUnit ID: Test\r\n');
    if (!options.wakeOnly && !options.menuFallback && !options.hangLogin) send(prompt());
    socket.on('data', chunk => {
      for (const byte of chunk) {
        if (skip) { skip--; continue; }
        if (byte === 255) { skip = 2; continue; }
        if (byte === 10 || byte === 0) continue;
        if (byte !== 13) { buffer += String.fromCharCode(byte); continue; }
        const command = buffer;
        buffer = '';
        if (options.hangLogin) continue;
        if (!command) {
          if (!options.menuFallback) send(prompt());
        } else if (stage === 'username') {
          if (command !== (options.username ?? 'admin')) { send(prompt()); continue; }
          stage = options.passwordless ? 'menu' : 'password';
          send(prompt());
        } else if (stage === 'password') {
          if (command !== (options.password ?? 'secret')) { send(prompt()); continue; }
          stage = 'menu';
          send(prompt());
        } else if (command === 'MENU') {
          stage = 'menu'; send(prompt());
        } else if (stage === 'menu' && command === '6') {
          socket.end();
        } else if (stage === 'menu' && command === '1') {
          stage = 'rpc';
          if (!options.hangStatus) status();
        } else if (stage === 'rpc') {
          commands.push(command);
          const [action, number] = command.split(' ');
          if (options.disconnectOnCommand) { socket.destroy(); continue; }
          if (options.rejectCommand) { send('Invalid command\r\nRPC-3>'); continue; }
          if (action === 'on' || action === 'off') states.set(Number(number), action === 'on');
          if (options.hangCommand) continue;
          send(`${command}\r\n`);
          status();
        }
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port, commands, states,
    get sessions() { return sessions; },
    get active() { return sockets.size; },
    get maxActive() { return maxActive; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

export function config(port, overrides = {}) {
  return {
    id: 'test', name: 'Test', host: '127.0.0.1', port,
    username: 'admin', password: 'secret', outletCount: 8,
    pollingIntervalMs: 0, cacheTtlMs: 15000, connectTimeoutMs: 500,
    operationTimeoutMs: 2000, queueTimeoutMs: 3000,
    outlets: [{ number: 1, name: 'Outlet 1', mode: 'power', resetAfterMs: 100 }],
    ...overrides,
  };
}
