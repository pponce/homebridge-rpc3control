import { parseConfig } from './config.js';
import { safeError } from './errors.js';
import { RpcProtocol } from './protocol.js';

/** Read-only settings preview. This process is separate from the platform worker. */
export class ConnectionTester {
  private active?: AbortController;
  private nextAllowed = 0;
  private stopped = false;

  async test(value: unknown) {
    if (this.stopped) return { ok: false, error: 'Settings server is shutting down.' };
    if (this.active) return { ok: false, error: 'A connection test is already running. Please wait.' };
    if (Date.now() < this.nextAllowed) return { ok: false, error: 'Please wait five seconds between connection tests.' };
    let config;
    try {
      // Ignore any action/outlet fields in the request. This endpoint only reads status.
      config = parseConfig([value])[0]!;
    } catch (error) { return { ok: false, error: safeError(error) }; }
    const abort = new AbortController();
    this.active = abort;
    const timer = setTimeout(() => abort.abort(), Math.min(config.operationTimeoutMs, 10000));
    try {
      const status = await new RpcProtocol(config).execute(abort.signal);
      const outlets = Array.from({ length: config.outletCount }, (_, index) => {
        const number = index + 1;
        const state = status?.get(number);
        return { number, name: state?.name ?? '', state: state ? (state.on ? 'On' : 'Off') : 'Unknown' };
      });
      return { ok: true, checkedAt: new Date().toISOString(), outlets };
    } catch (error) { return { ok: false, error: safeError(error) }; }
    finally {
      clearTimeout(timer);
      this.active = undefined;
      this.nextAllowed = Date.now() + 5000;
    }
  }

  stop(): void { this.stopped = true; this.active?.abort(); }
}
