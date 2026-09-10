import type { PduConfig } from './config.js';
import { PduError, reportError } from './errors.js';
import type { ErrorReporter } from './errors.js';
import { RpcProtocol } from './protocol.js';
import type { Action, StatusMap } from './protocol.js';

interface Job {
  action?: Action;
  outlet?: number;
  generation: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: StatusMap | undefined) => void;
  reject: (error: unknown) => void;
}

export type StatusListener = (status: StatusMap | undefined, error?: unknown) => void | Promise<void>;
export interface Protocol {
  execute(signal: AbortSignal, action?: Action, outlet?: number): Promise<StatusMap | undefined>;
}

export class PduController {
  readonly config: PduConfig;
  private protocol: Protocol;
  private queue: Job[] = [];
  private running = false;
  private stopped = false;
  private abort?: AbortController;
  private cache?: StatusMap;
  private cachedAt = 0;
  private generation = 0;
  private refresh?: Promise<StatusMap>;
  private failureCount = 0;
  private retryAt = 0;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private listeners = new Set<StatusListener>();
  private report: ErrorReporter;

  constructor(config: PduConfig, protocol: Protocol = new RpcProtocol(config), report: ErrorReporter = console.error) {
    this.config = config;
    this.protocol = protocol;
    this.report = report;
  }

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(status?: StatusMap, error?: unknown): void {
    // UI/listener failures are not PDU failures: preserve the operation result,
    // continue notifying other outlets, and never recurse through notify to log.
    for (const listener of this.listeners) {
      try {
        void Promise.resolve(listener(status, error)).catch(failure => {
          reportError(this.report, 'PDU status callback failed', failure);
        });
      } catch (failure) { reportError(this.report, 'PDU status callback failed', failure); }
    }
  }

  private invalidate(): void { this.cachedAt = 0; this.generation++; }

  async getStatus(force = false): Promise<StatusMap> {
    if (this.stopped) throw new PduError('STOPPED', 'PDU controller is stopped');
    if (!force && this.cache && this.cachedAt > 0 && Date.now() - this.cachedAt < this.config.cacheTtlMs) {
      return this.cache;
    }
    const promise = this.refresh ?? this.enqueue(undefined, undefined, this.generation).then(result => {
      if (!result) throw new PduError('PROTOCOL', 'Status request returned no data');
      return result;
    });
    this.refresh = promise;
    let result: StatusMap;
    try { result = await promise; }
    finally { if (this.refresh === promise) this.refresh = undefined; }
    // A write queued during an active read invalidates that snapshot. Coalesce again
    // after the write rather than serving a response from before the requested action.
    if (this.cache !== result || this.cachedAt === 0) return this.getStatus(true);
    return result;
  }

  async getOutlet(number: number): Promise<boolean> {
    const status = (await this.getStatus()).get(number);
    if (!status) throw new PduError('PROTOCOL', 'Requested outlet was absent from the status response');
    return status.on;
  }

  async command(outlet: number, action: Action): Promise<boolean> {
    if (!Number.isInteger(outlet) || outlet < 1 || outlet > this.config.outletCount || !['on', 'off', 'reboot', 'ensure-on', 'reboot-if-on'].includes(action)) {
      throw new PduError('CONFIG', 'Invalid outlet action');
    }
    this.invalidate();
    try {
      const result = await this.enqueue(action, outlet, this.generation);
      return result === undefined; // Status map means a confirmed no-op.
    } finally {
      // One deferred refresh, shared by all waiting HomeKit reads; never retry the write.
      if (!this.stopped && action !== 'ensure-on' && action !== 'reboot-if-on') void this.getStatus(true).catch(() => {});
    }
  }

  private enqueue(action: Action | undefined, outlet: number | undefined, generation: number): Promise<StatusMap | undefined> {
    if (this.stopped) return Promise.reject(new PduError('STOPPED', 'PDU controller is stopped'));
    if (Date.now() < this.retryAt) return Promise.reject(new PduError('BUSY', 'PDU is cooling down after a connection or protocol failure'));
    if (this.queue.length >= 32) return Promise.reject(new PduError('BUSY', 'PDU command queue is full'));
    return new Promise((resolve, reject) => {
      const job: Job = {
        action, outlet, generation, resolve, reject,
        timer: setTimeout(() => {
          const index = this.queue.indexOf(job);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new PduError('BUSY', 'PDU queue deadline exceeded; request was not sent'));
        }, this.config.queueTimeoutMs),
      };
      // Keep user writes FIFO, ahead of status work that has not started.
      const firstRead = this.queue.findIndex(entry => !entry.action);
      if (action && firstRead >= 0) this.queue.splice(firstRead, 0, job);
      else this.queue.push(job);
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    let activeJob: Job | undefined;
    try {
      while (this.queue.length && !this.stopped) {
        const job = this.queue.shift()!;
        activeJob = job;
        clearTimeout(job.timer);
        if (Date.now() < this.retryAt) {
          job.reject(new PduError('BUSY', 'PDU is cooling down; request was not sent'));
          continue;
        }
        this.abort = new AbortController();
        job.generation = this.generation;
        const deadline = setTimeout(() => this.abort?.abort(), this.config.operationTimeoutMs);
        try {
          const result = await this.protocol.execute(this.abort.signal, job.action, job.outlet);
          if (this.stopped) throw new PduError('STOPPED', 'PDU controller stopped during operation');
          this.failureCount = 0;
          this.retryAt = 0;
          if (job.action && !result) this.invalidate();
          if (result && job.generation === this.generation) {
            this.cache = result;
            this.cachedAt = Date.now();
            this.notify(result);
          }
          job.resolve(result);
        } catch (error) {
          this.cachedAt = 0;
          this.failureCount++;
          this.retryAt = Date.now() + Math.min(300000, 5000 * 2 ** Math.min(this.failureCount - 1, 6));
          job.reject(error);
          if (!this.stopped) this.notify(undefined, error);
        } finally {
          clearTimeout(deadline);
          this.abort = undefined;
        }
      }
    } catch (error) {
      // Last-resort boundary for the detached worker. Settle the active request
      // and queued work without replaying any potentially transmitted action.
      activeJob?.reject(error);
      reportError(this.report, 'PDU worker stopped after an internal failure', error);
      this.stop();
    } finally { this.running = false; }
  }

  startPolling(offsetMs = 0): void {
    if (this.stopped || this.pollTimer || !this.config.outlets.length) return;
    const poll = async () => {
      try { await this.getStatus(true); } catch { /* Failure is reported through subscriptions. */ }
      if (!this.stopped && this.config.pollingIntervalMs > 0) {
        const delay = Math.max(this.config.pollingIntervalMs, this.retryAt - Date.now());
        this.pollTimer = setTimeout(run, delay);
        this.pollTimer.unref();
      }
    };
    const run = () => {
      void poll().catch(error => reportError(this.report, 'PDU polling stopped after an internal failure', error));
    };
    // Initial discovery remains useful even when recurring polling is disabled.
    this.pollTimer = setTimeout(run, offsetMs);
    this.pollTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    try { this.abort?.abort(); }
    catch (error) { reportError(this.report, 'PDU session cancellation failed', error); }
    for (const job of this.queue.splice(0)) {
      clearTimeout(job.timer);
      job.reject(new PduError('STOPPED', 'PDU controller stopped before request was sent'));
    }
    this.listeners.clear();
  }
}
