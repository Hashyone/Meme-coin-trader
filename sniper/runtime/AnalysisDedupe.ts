/**
 * Reconciliation replays blocks, so the listener can deliver the same launch event to a handler twice: the
 * `Recovered log:` backfill re-emits events that were already handled live. Persistence de-dupes by event, but
 * the analysis queue did not, so a single launch ran the whole pipeline twice and reached two terminal
 * decisions -- two buys of the same token once the wallet is funded. This guard sits on the queue boundary,
 * which is the last point before execution.
 *
 * The key is the event's own identity, not the token: a launch and its later graduation are separate events on
 * the same token and both must run, so the lane is part of the key.
 */
export class AnalysisDedupe {
  private readonly claimed = new Set<string>();

  /**
   * Mirrors `BlockEventStore.hasEvent`, which identifies an event by transaction hash and log index: whatever
   * persistence already treats as the same event, this treats as the same event, so the two layers cannot
   * disagree about what a duplicate is.
   */
  static key(kind: string, subject: string, transactionHash: string, logIndex: number): string {
    // Addresses arrive both checksummed and lowercased depending on which path resolved them, so the identity
    // must be case-folded or a re-delivery in the other casing would not be recognised as the same event.
    return [kind, subject.toLowerCase(), transactionHash.toLowerCase(), logIndex].join(":");
  }

  /** Returns true for the first claim of a key and false for every repeat, so callers can drop duplicates. */
  claim(key: string): boolean {
    if (this.claimed.has(key)) return false;
    this.claimed.add(key);
    return true;
  }

  get size(): number {
    return this.claimed.size;
  }
}
