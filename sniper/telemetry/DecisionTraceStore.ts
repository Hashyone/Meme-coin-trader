import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface DecisionTrace {
  schemaVersion: 1;
  traceId: string;
  observedAt: string;
  chainId: number;
  source: {
    protocol: string;
    factory: string;
    pool?: string;
    transactionHash: string;
    blockNumber: number;
    logIndex: number;
  };
  candidate: {
    token: string;
    token0?: string;
    token1?: string;
    baseToken?: string;
    deployer?: string;
    owner?: string;
  };
  stages: Record<string, {
    status: "PASS" | "REJECT" | "ERROR" | "SKIPPED";
    evidence?: Record<string, unknown>;
    reasons?: string[];
  }>;
  final: {
    accepted: boolean;
    rejectionReasons: string[];
  };
}

function serialize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, serialize(entry)]));
  }
  return value;
}

export class DecisionTraceStore {
  private constructor(private readonly filePath: string) {}

  static async open(filePath: string): Promise<DecisionTraceStore> {
    await mkdir(dirname(filePath), { recursive: true });
    return new DecisionTraceStore(filePath);
  }

  async append(trace: DecisionTrace): Promise<void> {
    await appendFile(this.filePath, `${JSON.stringify(serialize(trace))}\n`, "utf8");
  }
}
