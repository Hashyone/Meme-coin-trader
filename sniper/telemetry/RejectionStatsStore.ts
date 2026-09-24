import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface RejectionStats {
  totalCandidates: number;
  liquidityRejected: number;
  securityRejected: number;
  quoteRejected: number;
  routeRejected: number;
  priceImpactRejected: number;
  profitRejected: number;
  simulationRejected: number;
  executionEligible: number;
  reasons: Record<string, number>;
  combinations: Record<string, number>;
}

const emptyStats = (): RejectionStats => ({
  totalCandidates: 0,
  liquidityRejected: 0,
  securityRejected: 0,
  quoteRejected: 0,
  routeRejected: 0,
  priceImpactRejected: 0,
  profitRejected: 0,
  simulationRejected: 0,
  executionEligible: 0,
  reasons: {},
  combinations: {},
});

export class RejectionStatsStore {
  private constructor(private readonly filePath: string, private readonly stats: RejectionStats) {}

  static async open(filePath: string): Promise<RejectionStatsStore> {
    try {
      const stored = JSON.parse(await readFile(filePath, "utf8")) as Partial<RejectionStats>;
      return new RejectionStatsStore(filePath, { ...emptyStats(), ...stored, reasons: stored.reasons ?? {}, combinations: stored.combinations ?? {} });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return new RejectionStatsStore(filePath, emptyStats());
    }
  }

  record(rejectionReasons: string[]): void {
    this.stats.totalCandidates += 1;
    const reasons = [...new Set(rejectionReasons)].sort();
    if (reasons.length === 0) this.stats.executionEligible += 1;
    for (const reason of reasons) {
      this.stats.reasons[reason] = (this.stats.reasons[reason] ?? 0) + 1;
      if (reason.includes("LIQUIDITY")) this.stats.liquidityRejected += 1;
      if (reason.includes("SECURITY") || reason.includes("MINT") || reason.includes("FREEZE") || reason.includes("BLACKLIST") || reason.includes("TRANSFER")) this.stats.securityRejected += 1;
      if (reason.includes("QUOTE")) this.stats.quoteRejected += 1;
      if (reason.includes("ROUTE")) this.stats.routeRejected += 1;
      if (reason.includes("PRICE_IMPACT")) this.stats.priceImpactRejected += 1;
      if (reason.includes("PROFIT")) this.stats.profitRejected += 1;
      if (reason.includes("SIMULATION")) this.stats.simulationRejected += 1;
    }
    if (reasons.length > 0) {
      const key = reasons.join("+");
      this.stats.combinations[key] = (this.stats.combinations[key] ?? 0) + 1;
    }
  }

  snapshot(): RejectionStats {
    return JSON.parse(JSON.stringify(this.stats)) as RejectionStats;
  }

  async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(this.stats, null, 2), "utf8");
    await rename(temporaryPath, this.filePath);
  }
}