import { PduError, reportError, writeLog } from './errors.js';
import type { ErrorReporter } from './errors.js';
import type { Action, StatusMap } from './protocol.js';

interface Controller {
  command(outlet: number, action: Action): Promise<boolean>;
  getStatus(force?: boolean, source?: 'recovery'): Promise<StatusMap>;
}

/** Timers only read status. The PDU alone performs the native off/on cycle. */
export class PowerAwareReboot {
  private pending?: Promise<boolean>;
  private timer?: ReturnType<typeof setTimeout>;
  private recovering = false;
  private stopped = false;
  private verifyAfter = 0;
  private recoverUntil = 0;
  private attempts = 0;
  private actionLabel = 'Power-aware action';

  constructor(
    private controller: Controller,
    private outlet: number,
    private checkDelayMs: number,
    private unavailable: () => void | Promise<void>,
    private report: ErrorReporter = console.error,
    private activity: (level: 'info' | 'warn', message: string) => void = () => {},
  ) {}

  async set(on: boolean): Promise<boolean> {
    if (this.stopped) throw new PduError('STOPPED', 'Power-aware reboot switch is stopped');
    if (this.pending || this.recovering) {
      // Do not acknowledge an opposite/duplicate write as a completed power change.
      throw new PduError('BUSY', 'Outlet action is in progress; waiting to confirm power state');
    }
    this.pending = Promise.resolve().then(async () => {
      if (this.stopped) throw new PduError('STOPPED', 'Switch stopped before command was sent');
      try {
        const sent = await this.controller.command(this.outlet, on ? 'ensure-on' : 'reboot-if-on');
        if (sent) this.startRecovery(on);
        return sent;
      } catch (error) {
        // The PDU may already be rebooting the very network path carrying its reply.
        if (error instanceof PduError && error.code === 'UNCERTAIN') this.startRecovery(on);
        throw error;
      }
    });
    try { return await this.pending; } finally { this.pending = undefined; }
  }

  private startRecovery(on: boolean): void {
    if (this.stopped) return;
    this.recovering = true;
    this.actionLabel = on ? 'On request' : 'Reboot request';
    this.attempts = 0;
    this.verifyAfter = Date.now() + this.checkDelayMs;
    this.recoverUntil = this.verifyAfter + 600000;
    this.schedule(this.checkDelayMs);
  }

  observe(on: boolean): void {
    if (this.recovering && on && Date.now() >= this.verifyAfter) {
      this.finish();
      writeLog(message => this.activity('info', message), `${this.actionLabel} recovery: outlet power confirmed On.`);
    }
  }

  private schedule(delay: number): void {
    if (this.stopped || !this.recovering) return;
    this.timer = setTimeout(() => {
      void this.verify().catch(error => {
        reportError(this.report, 'Outlet recovery stopped after an internal failure', error);
        this.finish();
      });
    }, delay);
    this.timer.unref();
  }

  private async verify(): Promise<void> {
    this.timer = undefined;
    if (this.stopped || !this.recovering) return;
    try {
      const state = (await this.controller.getStatus(true, 'recovery')).get(this.outlet);
      if (state) this.observe(state.on);
      else this.markUnavailable();
    } catch { if (!this.stopped) this.markUnavailable(); }
    if (this.stopped || !this.recovering) return;
    if (Date.now() >= this.recoverUntil) {
      // No endless background traffic. Later reads/actions still require real status.
      this.finish();
      writeLog(message => this.activity('warn', message), `${this.actionLabel} recovery ended without confirming On; check the outlet. No power command was retried.`);
      return;
    }
    const interval = Math.min(60000, 5000 * 2 ** Math.min(this.attempts++, 4));
    this.schedule(Math.min(interval, this.recoverUntil - Date.now()));
  }

  private markUnavailable(): void {
    try {
      void Promise.resolve(this.unavailable()).catch(error => {
        reportError(this.report, 'Outlet recovery callback failed', error);
      });
    } catch (error) { reportError(this.report, 'Outlet recovery callback failed', error); }
  }

  private finish(): void {
    this.recovering = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  stop(): void { this.stopped = true; this.finish(); }
}
