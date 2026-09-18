import { Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { PduError } from './errors.js';

const IAC = 255;
const WILL = 251;
const WONT = 252;
const DO = 253;
const DONT = 254;

/** Incremental NVT parser: negotiation commands may be embedded or split anywhere. */
export class TelnetDecoder {
  private state: 'text' | 'iac' | 'option' | 'sub' | 'sub-iac' = 'text';
  private command = 0;
  private remoteOptions = new Set<number>();
  private localOptions = new Set<number>();
  private reply: (data: Buffer) => void;

  constructor(reply: (data: Buffer) => void) { this.reply = reply; }

  decode(chunk: Buffer): Buffer {
    const output: number[] = [];
    for (const byte of chunk) {
      switch (this.state) {
        case 'text':
          if (byte === IAC) this.state = 'iac';
          else if (byte !== 0) output.push(byte); // NVT CR-NUL and padding.
          break;
        case 'iac':
          if (byte === IAC) { output.push(byte); this.state = 'text'; }
          else if (byte >= WILL && byte <= DONT) { this.command = byte; this.state = 'option'; }
          else this.state = byte === 250 ? 'sub' : 'text';
          break;
        case 'option':
          this.negotiate(this.command, byte);
          this.state = 'text';
          break;
        case 'sub':
          if (byte === IAC) this.state = 'sub-iac';
          break;
        case 'sub-iac':
          this.state = byte === 240 ? 'text' : 'sub';
          break;
      }
    }
    return Buffer.from(output);
  }

  private negotiate(command: number, option: number): void {
    if (command === WILL) {
      if (option === 1 || option === 3) { // Remote echo and suppress-go-ahead.
        if (!this.remoteOptions.has(option)) {
          this.remoteOptions.add(option);
          this.reply(Buffer.from([IAC, DO, option]));
        }
      } else this.reply(Buffer.from([IAC, DONT, option]));
    } else if (command === DO) {
      if (option === 3) {
        if (!this.localOptions.has(option)) {
          this.localOptions.add(option);
          this.reply(Buffer.from([IAC, WILL, option]));
        }
      } else this.reply(Buffer.from([IAC, WONT, option]));
    } else if (command === WONT && this.remoteOptions.delete(option)) {
      this.reply(Buffer.from([IAC, DONT, option]));
    } else if (command === DONT && this.localOptions.delete(option)) {
      this.reply(Buffer.from([IAC, WONT, option]));
    }
  }
}

export interface PromptMatch { index: number; before: string; }
export interface Transport {
  connect(host: string, port: number, timeoutMs: number): Promise<void>;
  expect(patterns: RegExp[], timeoutMs: number): Promise<PromptMatch>;
  send(text: string): void;
  close(): Promise<void>;
}

export class TelnetTransport implements Transport {
  private socket = new Socket();
  private decoder: TelnetDecoder;
  private utf8 = new StringDecoder('utf8');
  private buffer = '';
  private terminalError?: PduError;
  private wake?: () => void;
  private signal: AbortSignal;
  private abort: () => void;

  constructor(signal: AbortSignal) {
    this.signal = signal;
    this.decoder = new TelnetDecoder(data => { if (this.socket.writable) this.socket.write(data); });
    this.abort = () => this.fail(new PduError('TIMEOUT', 'Session cancelled or operation deadline exceeded'));
    signal.addEventListener('abort', this.abort, { once: true });
    this.socket.on('data', data => {
      const chunk = typeof data === 'string' ? Buffer.from(data) : data;
      this.buffer += this.utf8.write(this.decoder.decode(chunk));
      if (this.buffer.length > 65536) this.fail(new PduError('PROTOCOL', 'Device response exceeded 64 KiB'));
      else this.wake?.();
    });
    this.socket.on('error', () => this.fail(new PduError('UNREACHABLE', 'PDU network connection failed')));
    this.socket.on('close', () => {
      this.terminalError ??= new PduError('CLOSED', 'PDU closed the connection');
      this.wake?.();
    });
  }

  private fail(error: PduError): void {
    this.terminalError ??= error;
    this.socket.destroy();
    this.wake?.();
  }

  async connect(host: string, port: number, timeoutMs: number): Promise<void> {
    if (this.signal.aborted) { this.abort(); throw this.terminalError; }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new PduError('TIMEOUT', 'PDU connection timed out')), timeoutMs);
      const done = (error?: PduError) => {
        clearTimeout(timer);
        this.socket.off('connect', connected);
        this.socket.off('close', closed);
        if (error) reject(error); else resolve();
      };
      const connected = () => { this.socket.setNoDelay(true); done(); };
      const closed = () => done(this.terminalError ?? new PduError('CLOSED', 'Connection closed'));
      this.socket.once('connect', connected);
      this.socket.once('close', closed);
      this.socket.connect({ host, port });
    });
  }

  expect(patterns: RegExp[], timeoutMs: number): Promise<PromptMatch> {
    if (this.wake) return Promise.reject(new PduError('PROTOCOL', 'Concurrent prompt reads are not supported'));
    return new Promise((resolve, reject) => {
      const finish = (match?: PromptMatch, error?: PduError) => {
        clearTimeout(timer);
        this.wake = undefined;
        if (error) reject(error); else resolve(match!);
      };
      const timer = setTimeout(() => finish(undefined, new PduError('TIMEOUT', 'Expected PDU prompt did not arrive')), timeoutMs);
      this.wake = () => {
        // Only an orderly peer close may leave a usable final response.
        if (this.terminalError && this.terminalError.code !== 'CLOSED') {
          finish(undefined, this.terminalError);
          return;
        }
        let best: { index: number; start: number; end: number } | undefined;
        for (const [index, pattern] of patterns.entries()) {
          const match = pattern.exec(this.buffer);
          if (match && (!best || match.index < best.start)) best = { index, start: match.index, end: match.index + match[0].length };
        }
        // Accept a complete response even when the peer closes immediately afterwards.
        if (best) {
          const result = { index: best.index, before: this.buffer.slice(0, best.start) };
          this.buffer = this.buffer.slice(best.end);
          finish(result);
        } else if (this.terminalError) finish(undefined, this.terminalError);
      };
      this.wake();
    });
  }

  send(text: string): void {
    if (this.terminalError) throw this.terminalError;
    if (!this.socket.writable || this.signal.aborted) throw new PduError('CLOSED', 'PDU connection is not writable');
    // Preserve the reference controller carriage return; escape literal IAC bytes.
    const bytes = Buffer.from(text, 'utf8');
    const escaped: number[] = [];
    for (const byte of bytes) { escaped.push(byte); if (byte === IAC) escaped.push(byte); }
    this.socket.write(Buffer.from(escaped));
  }

  async close(): Promise<void> {
    this.signal.removeEventListener('abort', this.abort);
    if (this.socket.closed) return;
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); this.socket.off('close', done); resolve(); };
      const timer = setTimeout(done, 250);
      this.socket.once('close', done);
      this.socket.destroy();
    });
  }
}
