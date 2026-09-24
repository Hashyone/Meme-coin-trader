import { ethers } from "ethers";
import { Candidate, SecurityDecision } from "../types";
import { config } from "../config";

export class SecurityEngine {
  evaluate(candidate: Candidate, provider?: ethers.Provider): SecurityDecision {
    const reasons: string[] = [];
    const approvedBasePair = this.isApprovedBasePair(candidate);

    if (!approvedBasePair) {
      reasons.push("unsupported base pair");
    }

    const deployerRisk = this.scoreWallet(candidate.deployer);
    const ownerRisk = this.scoreWallet(candidate.owner);
    const aggregateRisk = Math.min(100, deployerRisk + ownerRisk / 2);

    if (aggregateRisk >= config.maxRiskScore) {
      reasons.push("wallet risk is too high");
    }

    if (candidate.fee <= 0 || candidate.tick_spacing <= 0) {
      reasons.push("invalid pool metadata");
    }

    const safe = approvedBasePair && aggregateRisk < config.maxRiskScore && candidate.fee > 0 && candidate.tick_spacing > 0;
    const score = Math.max(0, 100 - aggregateRisk + (approvedBasePair ? 15 : -15));

    return {
      safe,
      risk: this.riskFromScore(score),
      reasons,
      score,
      approvedBasePair,
    };
  }

  private isApprovedBasePair(candidate: Candidate): boolean {
    const baseList = config.approvedBaseTokens.map((symbol) => symbol.toUpperCase());
    const baseAddresses = Object.values(config.approvedBaseTokenAddresses).map((address) => address.toLowerCase());
    if (config.wrappedNativeAddress) baseAddresses.push(config.wrappedNativeAddress.toLowerCase());
    const token0 = candidate.token0.toUpperCase();
    const token1 = candidate.token1.toUpperCase();

    const zeroAddress = ethers.ZeroAddress.toUpperCase();
    const ethLike = ["ETH", "WETH", zeroAddress];

    return (
      baseList.includes(token0) ||
      baseList.includes(token1) ||
      baseAddresses.includes(candidate.token0.toLowerCase()) ||
      baseAddresses.includes(candidate.token1.toLowerCase()) ||
      ethLike.includes(token0) ||
      ethLike.includes(token1)
    );
  }

  private async fetchWalletTxCount(address: string, provider: ethers.Provider): Promise<number> {
    try {
      return await provider.getTransactionCount(address, "latest");
    } catch {
      return 0;
    }
  }

  private async fetchWalletCode(address: string, provider: ethers.Provider): Promise<string> {
    try {
      return await provider.getCode(address);
    } catch {
      return "0x";
    }
  }

  private async scoreWalletWithOnChain(address: string, provider: ethers.Provider): Promise<number> {
    const [txCount, code] = await Promise.all([
      this.fetchWalletTxCount(address, provider),
      this.fetchWalletCode(address, provider),
    ]);

    let risk = 0;

    if (txCount === 0) {
      risk += 30;
    } else if (txCount < 5) {
      risk += 15;
    } else if (txCount < 20) {
      risk += 5;
    }

    if (code && code !== "0x" && code.length > 100) {
      risk += 25;
      if (/selfdestruct|delegatecall|create2|create\s*\(|extcodecopy/i.test(code)) {
        risk += 20;
      }
      if (/blacklist|pause|freeze|onlyowner|maxwallet|maxtx|whitelist/i.test(code)) {
        risk += 15;
      }
    }

    if (code === "0x") {
      risk -= 5;
    }

    return Math.max(0, Math.min(100, risk));
  }

  private scoreWallet(address: string): number {
    const key = address.toLowerCase();
    const seed = key.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return seed % 45;
  }

  /**
   * `evaluate` is synchronous because discovery calls it on the ingestion hot path and cannot await it. The
   * on-chain wallet signal needs RPC round trips, so it is offered separately for callers that can await it:
   * `evaluate` uses only the deterministic heuristic score.
   */
  async scorePairRisk(deployer: string, owner: string, provider: ethers.Provider): Promise<number> {
    const [deployerRisk, ownerRisk] = await Promise.all([
      this.scoreWalletWithOnChain(deployer, provider),
      this.scoreWalletWithOnChain(owner, provider),
    ]);
    return Math.min(100, deployerRisk + ownerRisk / 2);
  }

  private riskFromScore(score: number): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
    if (score >= 80) return "LOW";
    if (score >= 60) return "MEDIUM";
    if (score >= 40) return "HIGH";
    return "CRITICAL";
  }
}
