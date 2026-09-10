import { PduError } from './errors.js';

/** Timer changes only the UI. The only physical action is the supplied native reboot. */
export class RebootSwitch {
  private action: () => Promise<void>;
  private update: (on: boolean) => void;
  private resetAfterMs: number;
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private active = false;
  private stopped = false;

  constructor(action: () => Promise<void>, update: (on: boolean) => void, resetAfterMs: number) {
    this.action = action;
    this.update = update;
    this.resetAfterMs = resetAfterMs;
  }

  get on(): boolean { return this.active; }

  async set(on: boolean): Promise<void> {
    if (this.stopped) throw new PduError('STOPPED', 'Reboot switch is stopped');
    if (!on) return; // No command, cancellation, or release of duplicate suppression.
    if (this.pending) return this.pending;
    if (this.active) return;
    this.active = true;
    this.update(true);
    // Schedule through a microtask so the guard is set before action can throw.
    this.pending = Promise.resolve().then(() => {
      if (this.stopped) throw new PduError('STOPPED', 'Reboot switch stopped before request was sent');
      return this.action();
    }).then(() => {
      if (this.stopped) return;
      this.timer = setTimeout(() => {
        this.active = false;
        this.timer = undefined;
        this.update(false);
      }, this.resetAfterMs);
      this.timer.unref();
    }).catch(error => {
      this.active = false;
      if (!this.stopped) this.update(false);
      throw error;
    });
    try { await this.pending; } finally { this.pending = undefined; }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.active = false;
  }
}
