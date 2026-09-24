/**
 * Runs submitted tasks with a ceiling on how many are in flight at once.
 *
 * The sniper's launch analyses do not depend on each other -- each screens, measures and prices its own token --
 * so the only reason they ran strictly one after another was the shape of the caller's loop. Measuring the live
 * run showed what that cost: the hop from `PONS V2 LAUNCH DISCOVERED` to the first `PONS SECURITY SCREEN` was
 * p50 5.97s and max 24.93s, while every stage inside a single launch stayed flat (2.34s p50 for the
 * concentration measurement, 0.37s for the gate-to-decision hop). That hop does almost no RPC work of its own --
 * its floor is 0.99s, so under a second of its median is the launch's own work and the remaining ~5s is waiting
 * behind the launches queued ahead of it.
 *
 * The ceiling is what keeps that from becoming an unbounded fan-out against the RPC endpoint, which is already
 * the other measured failure mode of this bot.
 */
export class ConcurrencyPool {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly outstanding = new Set<Promise<unknown>>();

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("CONCURRENCY_LIMIT_MUST_BE_POSITIVE_INTEGER");
    }
  }

  get concurrencyLimit(): number {
    return this.limit;
  }

  get running(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  /**
   * Returns when the task finishes. Tasks start in submission order until the ceiling is reached; later tasks
   * start as earlier ones release their slot.
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    const running = this.start(task);
    this.outstanding.add(running);
    // Both handlers remove the same entry: a rejected task must not leave the set populated, or `drain` would
    // wait forever, and attaching only a success handler would surface the rejection as an unhandled one.
    void running.then(
      () => this.outstanding.delete(running),
      () => this.outstanding.delete(running),
    );
    return running;
  }

  /** Resolves once nothing is running or waiting, so a caller can shut down without abandoning work mid-flight. */
  async drain(): Promise<void> {
    while (this.outstanding.size > 0) {
      await Promise.allSettled([...this.outstanding]);
    }
  }

  private async start<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next) next();
  }
}
