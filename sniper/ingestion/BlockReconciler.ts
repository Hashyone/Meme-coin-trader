import { DetectionEvent } from "../types";
import { BlockEventStore, StoredLogEvent } from "../storage/BlockEventStore";

export interface ReconciliationProvider {
  getBlockNumber(): Promise<number>;
  getBlock(blockNumber: number): Promise<{ hash?: string | null } | null>;
  getLogs(filter: { fromBlock: number; toBlock: number; address: string[]; topics: string[][] }): Promise<DetectionEvent[]>;
}

export interface ReconciliationSource {
  address: string;
  topic: string;
}

export class BlockReconciler {
  constructor(
    private readonly provider: ReconciliationProvider,
    private readonly store: BlockEventStore,
    private readonly sources: ReconciliationSource[],
    private readonly onEvent: (event: DetectionEvent) => Promise<void> | void,
  ) {}

  async reconcile(): Promise<{ fromBlock: number; toBlock: number; recovered: number; duplicates: number }> {
    const fromBlock = this.store.cursor.lastProcessedBlock + 1;
    const toBlock = await this.provider.getBlockNumber();
    if (fromBlock > toBlock) return { fromBlock, toBlock, recovered: 0, duplicates: 0 };

    const logs = await this.provider.getLogs({
      fromBlock,
      toBlock,
      address: [...new Set(this.sources.map((source) => source.address.toLowerCase()))],
      topics: [[...new Set(this.sources.map((source) => source.topic.toLowerCase()))]],
    });

    const orderedLogs = [...logs].sort((left, right) =>
      left.blockNumber - right.blockNumber || left.logIndex - right.logIndex,
    );
    let recovered = 0;
    let duplicates = 0;
    for (const log of orderedLogs) {
      const stored = this.toStoredEvent(log);
      if (await this.store.recordEvent(stored)) {
        await this.onEvent(log);
        recovered += 1;
      } else {
        duplicates += 1;
      }
    }

    const tip = await this.provider.getBlock(toBlock);
    await this.store.advanceCursor(toBlock, tip?.hash ?? undefined);
    return { fromBlock, toBlock, recovered, duplicates };
  }

  async recordLiveEvent(event: DetectionEvent): Promise<boolean> {
    const accepted = await this.recordLiveEvents([event]);
    return accepted > 0;
  }

  async recordLiveEvents(events: DetectionEvent[]): Promise<number> {
    let accepted = 0;
    let highestBlock = 0;
    for (const event of events) {
      if (await this.store.recordEvent(this.toStoredEvent(event))) {
        await this.onEvent(event);
        accepted += 1;
        highestBlock = Math.max(highestBlock, event.blockNumber);
      }
    }
    if (accepted > 0) {
      const block = await this.provider.getBlock(highestBlock);
      await this.store.advanceCursor(highestBlock, block?.hash ?? undefined);
    }
    return accepted;
  }

  private toStoredEvent(event: DetectionEvent): StoredLogEvent {
    return {
      chainId: this.store.cursor.chainId,
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
      logIndex: event.logIndex,
      contractAddress: event.address,
      topic0: event.topics[0] ?? "",
      payload: { ...event, topics: [...event.topics] },
      recordedAt: Date.now(),
    };
  }
}
