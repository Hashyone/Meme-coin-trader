export interface NonceProvider { getTransactionCount(address: string, blockTag: "latest" | "pending"): Promise<number>; }

export class NonceManager {
  private nextNonce?: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly provider: NonceProvider, private readonly address: string) {}

  async initialize(): Promise<number> {
    const pending = await this.provider.getTransactionCount(this.address, "pending");
    const latest = await this.provider.getTransactionCount(this.address, "latest");
    if (pending < latest) throw new Error("NONCE_STATE_INCONSISTENT");
    this.nextNonce = pending;
    return pending;
  }

  async reserve(): Promise<number> {
    let reserved = -1;
    this.queue = this.queue.then(async () => {
      if (this.nextNonce === undefined) await this.initialize();
      reserved = this.nextNonce as number;
      this.nextNonce = reserved + 1;
    });
    await this.queue;
    return reserved;
  }

  async reconcile(): Promise<void> {
    const pending = await this.provider.getTransactionCount(this.address, "pending");
    if (this.nextNonce !== undefined && pending > this.nextNonce) this.nextNonce = pending;
  }
}

const managers = new Map<string, NonceManager>();

/**
 * The counter and the queue that make `reserve()` safe live on the instance, so every caller must reach the same
 * instance. Constructing one per call site gave each caller its own: two concurrent reservations both read the
 * account's pending nonce, both returned it, and the second transaction went out on a nonce that was already in
 * flight — one buy replacing the other rather than following it. The entry lanes and the exit scheduler sign from
 * the same wallet, so the key is the address and not the caller.
 *
 * Every caller in this process talks to the same chain, which is why the key does not include the provider.
 */
export function nonceManagerFor(provider: NonceProvider, address: string): NonceManager {
  const key = address.toLowerCase();
  let manager = managers.get(key);
  if (!manager) {
    manager = new NonceManager(provider, address);
    managers.set(key, manager);
  }
  return manager;
}
