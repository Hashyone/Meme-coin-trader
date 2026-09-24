import { DetectionEvent } from "../types";

export interface LogScannerProvider {
  getLogs(filter: { address: string; topics: string[][]; fromBlock: number; toBlock: number }): Promise<DetectionEvent[]>;
}

export async function scanLogsInChunks(
  provider: LogScannerProvider,
  filter: { address: string; topics: string[][] },
  fromBlock: number,
  toBlock: number,
  chunkSize = Number(process.env.LOG_SCAN_CHUNK_SIZE ?? "10"),
): Promise<DetectionEvent[]> {
  if (!Number.isFinite(chunkSize) || chunkSize < 1) throw new Error("INVALID_LOG_CHUNK_SIZE");
  const events: DetectionEvent[] = [];
  let currentChunk = Math.max(1, Math.min(chunkSize, Math.max(1, toBlock - fromBlock + 1)));
  let start = fromBlock;

  while (start <= toBlock) {
    const end = Math.min(toBlock, start + currentChunk - 1);
    try {
      const logs = await provider.getLogs({ ...filter, fromBlock: start, toBlock: end });
      events.push(...logs);
      start = end + 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const shouldReduceRange = reason.includes("range") || reason.includes("429") || reason.includes("-32005") || reason.includes("-32000") || reason.includes("too large") || reason.includes("overflow");
      if (!shouldReduceRange) throw error;
      const nextChunk = Math.max(1, Math.floor(currentChunk / 2));
      if (nextChunk === currentChunk) throw new Error(`LOG_RANGE_RETRY_FAILED:${reason}`);
      currentChunk = nextChunk;
      if (start === fromBlock) {
        continue;
      }
      start = Math.max(fromBlock, start - currentChunk);
    }
  }

  const seen = new Set<string>();
  return events
    .sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex)
    .filter((event) => {
      const key = `${event.transactionHash.toLowerCase()}:${event.logIndex}:${event.address.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
