import type { PduConfig } from './config.js';
import { PduError } from './errors.js';
import { TelnetTransport } from './telnet.js';
import type { Transport } from './telnet.js';

export interface OutletState { number: number; name: string; on: boolean; }
export type StatusMap = Map<number, OutletState>;
export type Action = 'on' | 'off' | 'reboot' | 'ensure-on' | 'reboot-if-on';
export type TransportFactory = (signal: AbortSignal) => Transport;

const LOGIN = [/Enter username\s*>/i, /Enter password\s*>/i, /Enter Selection\s*>/i];
const RPC_PROMPT = /RPC-\d+[A-Za-z0-9-]*\s*>/i;
const REJECTION = /(?:^|[\r\n])\s*(?:error\b|invalid\b|access denied\b|permission denied\b|unknown command\b|command (?:failed|not recognized)\b)/i;

export function parseStatus(text: string, outletCount: number): StatusMap {
  const statuses: StatusMap = new Map();
  // CSI decoration is not part of outlet names. Parse only complete status rows.
  const plain = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  for (const line of plain.split(/[\r\n]+/)) {
    const row = /^\s*(\d+)\s+(.+?)\s+(\d+)\s+(On|Off)\s*$/i.exec(line);
    if (!row) continue;
    // Preserve the Python parser: the third field is the physical outlet number.
    const number = Number(row[3]);
    if (number < 1 || number > outletCount || statuses.has(number)) {
      throw new PduError('PROTOCOL', 'Status contains duplicate or out-of-range outlet numbers; check outletCount');
    }
    statuses.set(number, { number, name: row[2]!.trim(), on: row[4]!.toLowerCase() === 'on' });
  }
  if (statuses.size === 0) throw new PduError('PROTOCOL', 'No recognizable outlet status rows were returned');
  return statuses;
}

export class RpcProtocol {
  private config: PduConfig;
  private factory: TransportFactory;

  constructor(config: PduConfig, factory: TransportFactory = signal => new TelnetTransport(signal)) {
    this.config = config;
    this.factory = factory;
  }

  async execute(signal: AbortSignal, action?: Action, outlet?: number): Promise<StatusMap | undefined> {
    if (action && (outlet === undefined || !Number.isInteger(outlet) || outlet < 1 || outlet > this.config.outletCount)) {
      throw new PduError('CONFIG', 'Outlet number is outside the configured PDU range');
    }
    if (action && !['on', 'off', 'reboot', 'ensure-on', 'reboot-if-on'].includes(action)) throw new PduError('CONFIG', 'Unsupported outlet action');
    const transport = this.factory(signal);
    let atRpcPrompt = false;
    let sent = false;
    let accepted = false;
    let rejected = false;
    try {
      await transport.connect(this.config.host, this.config.port, this.config.connectTimeoutMs);
      await this.login(transport);
      transport.send('1\r');
      const initial = await transport.expect([RPC_PROMPT], this.config.operationTimeoutMs);
      atRpcPrompt = true;
      if (!action) return parseStatus(initial.before, this.config.outletCount);

      let command = action;
      if (action === 'ensure-on' || action === 'reboot-if-on') {
        // Decide from fresh status in this same queued session, never the UI cache.
        const statuses = parseStatus(initial.before, this.config.outletCount);
        const state = statuses.get(outlet!);
        if (!state) throw new PduError('PROTOCOL', 'Outlet state is unknown; no power command was sent');
        if ((action === 'ensure-on' && state.on) || (action === 'reboot-if-on' && !state.on)) return statuses;
        command = action === 'ensure-on' ? 'on' : 'reboot';
      }
      atRpcPrompt = false;
      // Once transmission is attempted, an absent reply is uncertain. Never replay it.
      sent = true;
      transport.send(`${command} ${outlet}\r`);
      const response = await transport.expect([RPC_PROMPT], this.config.operationTimeoutMs);
      atRpcPrompt = true;
      if (REJECTION.test(response.before)) {
        rejected = true;
        throw new PduError('PROTOCOL', 'PDU rejected the outlet command');
      }
      // The legacy protocol acknowledges completion by returning to its command prompt.
      accepted = true;
      return undefined;
    } catch (error) {
      if (sent && !accepted && !rejected) {
        throw new PduError('UNCERTAIN', 'Command was sent but acceptance could not be confirmed; it has not been retried');
      }
      throw error;
    } finally {
      // Cleanup must not change an already accepted command into an apparent failure.
      if (atRpcPrompt && !signal.aborted) {
        try {
          transport.send('MENU\r');
          await transport.expect([LOGIN[2]!], 500);
          transport.send('6\r');
          // Allow the logout bytes to be transmitted before destroying the socket.
          await new Promise(resolve => setTimeout(resolve, 25));
        } catch { /* Always close below, even if logout fails. */ }
      }
      await transport.close();
    }
  }

  private async login(transport: Transport): Promise<void> {
    let prompt;
    try {
      prompt = await transport.expect(LOGIN, 200);
    } catch (error) {
      if (!(error instanceof PduError) || error.code !== 'TIMEOUT') throw error;
      transport.send('\r');
      try {
        prompt = await transport.expect(LOGIN, 1500);
      } catch (wakeError) {
        if (!(wakeError instanceof PduError) || wakeError.code !== 'TIMEOUT') throw wakeError;
        transport.send('MENU\r');
        prompt = await transport.expect(LOGIN, this.config.operationTimeoutMs);
      }
    }
    let usernameSent = false;
    let passwordSent = false;
    for (let attempts = 0; attempts < 3; attempts++) {
      if (prompt.index === 2) return;
      if (prompt.index === 0) {
        if (usernameSent) throw new PduError('PROTOCOL', 'PDU requested the username again; check credentials');
        usernameSent = true;
        transport.send(`${this.config.username}\r`);
      } else {
        if (passwordSent) throw new PduError('PROTOCOL', 'PDU requested the password again; check credentials');
        passwordSent = true;
        transport.send(`${this.config.password}\r`);
      }
      prompt = await transport.expect(LOGIN, this.config.operationTimeoutMs);
    }
    if (prompt.index !== 2) throw new PduError('PROTOCOL', 'PDU login did not reach the selection menu');
  }
}
