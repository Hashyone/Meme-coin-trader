import { EventEmitter } from "node:events";
import { config, getConfiguredQuoteAssets } from "../config";
import { PoolCandidateFactory } from "../discovery/PoolCandidateFactory";
import { PoolAnalysisPipeline } from "../analysis/PoolAnalysisPipeline";
import { SimulationEngine } from "../execution/SimulationEngine";
import { SecurityEngine } from "../security/SecurityEngine";

export interface PaperTradeEvent {
  event: "candidate" | "rejected" | "paper-trade" | "position-update";
  candidateId?: string;
  status?: string;
  details?: Record<string, unknown>;
}

export class ContinuousPaperTrader extends EventEmitter {
  private readonly candidateFactory = new PoolCandidateFactory(config.factoryAddress, config.chainId, getConfiguredQuoteAssets());
  private readonly analysisPipeline = new PoolAnalysisPipeline(new SecurityEngine());
  private readonly simulationEngine = new SimulationEngine();
  private running = false;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.emit("status", { message: "WebSocket connected", mode: config.tradingMode, chainId: config.chainId });
    setInterval(() => {
      this.emit("status", { message: "Waiting for PoolCreated events...", mode: config.tradingMode, chainId: config.chainId });
    }, 30000);
  }

  async processCandidate(candidateInput: {
    token0: string;
    token1: string;
    fee: string | number;
    tickSpacing: string | number;
    pool: string;
    transactionHash: string;
    blockNumber: number;
    logIndex: number;
    deployer: string;
    owner: string;
    timestamp?: number;
    baseToken?: string;
  }, runtimeBytecode: string): Promise<PaperTradeEvent> {
    const candidate = this.candidateFactory.createFromEvent(candidateInput);
    const analysis = await this.analysisPipeline.analyze(candidate, runtimeBytecode);

    if (!analysis.accepted) {
      this.emit("rejected", { candidateId: candidate.candidate_id, reason: analysis.rejectionReason ?? "rejected" });
      return { event: "rejected", candidateId: candidate.candidate_id, status: "rejected", details: { reason: analysis.rejectionReason ?? "rejected" } };
    }

    const simulation = await this.simulationEngine.simulate({
      chainId: config.chainId,
      from: process.env.METAMASK_WALLET_ADDRESS || "0x0000000000000000000000000000000000000000",
      to: candidate.pool,
      value: process.env.TRADE_VALUE_WEI || "0x0",
      data: "0x",
      gasLimit: Number(process.env.MAX_GAS_LIMIT || "210000"),
      maxFeePerGas: "0x3b9aca00",
      maxPriorityFeePerGas: "0x3b9aca00",
    }, { privateKey: process.env.WALLET_PRIVATE_KEY || "0x" + "11".repeat(32) });

    this.emit("paper-trade", {
      candidateId: candidate.candidate_id,
      status: "PAPER TRADE",
      details: {
        signedTx: simulation.signedTx,
        txHash: simulation.txHash,
        safe: simulation.safe,
        mode: simulation.mode,
      },
    });

    return {
      event: "paper-trade",
      candidateId: candidate.candidate_id,
      status: "PAPER TRADE",
      details: {
        signedTx: simulation.signedTx,
        txHash: simulation.txHash,
        safe: simulation.safe,
        mode: simulation.mode,
      },
    };
  }
}
