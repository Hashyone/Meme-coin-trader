import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface StoredBlockCursor {
  chainId: number;
  lastProcessedBlock: number;
  lastProcessedBlockHash?: string;
  updatedAt: number;
}

export interface StoredLogEvent {
  chainId: number;
  blockNumber: number;
  blockHash?: string;
  transactionHash: string;
  transactionIndex?: number;
  logIndex: number;
  contractAddress: string;
  topic0: string;
  payload: Record<string, unknown>;
  recordedAt: number;
}

interface StoreFile {
  cursor: StoredBlockCursor;
  events: StoredLogEvent[];
}

export class BlockEventStore {
  private state: StoreFile;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(private readonly filePath: string, state: StoreFile) {
    this.state = state;
  }

  static async open(filePath: string, chainId: number, initialBlock = 0): Promise<BlockEventStore> {
    try {
      const contents = await readFile(filePath, "utf8");
      const state = JSON.parse(contents) as StoreFile;
      if (state.cursor.chainId !== chainId) throw new Error("Persisted cursor chain ID does not match configured chain");
      return new BlockEventStore(filePath, state);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return new BlockEventStore(filePath, {
        cursor: { chainId, lastProcessedBlock: initialBlock, updatedAt: Date.now() },
        events: [],
      });
    }
  }

  get cursor(): StoredBlockCursor {
    return { ...this.state.cursor };
  }

  get events(): StoredLogEvent[] {
    return this.state.events.map((event) => ({ ...event, payload: { ...event.payload } }));
  }

  hasEvent(event: Pick<StoredLogEvent, "chainId" | "transactionHash" | "logIndex" | "contractAddress">): boolean {
    return this.state.events.some((stored) =>
      stored.chainId === event.chainId &&
      stored.transactionHash.toLowerCase() === event.transactionHash.toLowerCase() &&
      stored.logIndex === event.logIndex &&
      stored.contractAddress.toLowerCase() === event.contractAddress.toLowerCase(),
    );
  }

  async recordEvent(event: StoredLogEvent): Promise<boolean> {
    if (this.hasEvent(event)) return false;
    this.state.events.push({ ...event, recordedAt: event.recordedAt || Date.now() });
    await this.persist();
    return true;
  }

  async advanceCursor(blockNumber: number, blockHash?: string): Promise<void> {
    if (blockNumber < this.state.cursor.lastProcessedBlock) return;
    this.state.cursor = {
      chainId: this.state.cursor.chainId,
      lastProcessedBlock: blockNumber,
      lastProcessedBlockHash: blockHash,
      updatedAt: Date.now(),
    };
    await this.persist();
  }

  private async persist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(this.state, null, 2), "utf8");
      await rename(temporaryPath, this.filePath);
    });
    return this.writeQueue;
  }
}
