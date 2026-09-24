import { Candidate } from "../types";
import { KnownQuoteAsset, resolveCandidatePair } from "./PairResolver";

export class PoolCandidateFactory {
  private readonly factoryAddress: string;
  private readonly chainId: number;
  private readonly knownQuoteAssets: KnownQuoteAsset[];

  constructor(factoryAddress: string, chainId: number, knownQuoteAssets: KnownQuoteAsset[] = []) {
    this.factoryAddress = factoryAddress.toLowerCase();
    this.chainId = chainId;
    this.knownQuoteAssets = knownQuoteAssets;
  }

  createFromEvent(input: {
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
    baseTokenAddress?: string;
  }): Candidate {
    const feeValue = Number(input.fee);
    const tick = Number(input.tickSpacing);
    const baseToken = (input.baseToken ?? "ETH").toUpperCase();
    const tokenA = input.token0.toLowerCase();
    const tokenB = input.token1.toLowerCase();

    const candidate: Candidate = {
      candidate_id: `${this.chainId}:${input.pool.toLowerCase()}:${input.transactionHash}:${input.logIndex}`,
      chain_id: this.chainId,
      factory: this.factoryAddress,
      pool: input.pool.toLowerCase(),
      token0: tokenA,
      token1: tokenB,
      fee: Number.isFinite(feeValue) ? feeValue : 0,
      tick_spacing: Number.isFinite(tick) ? tick : 0,
      creation_block: input.blockNumber,
      creation_timestamp: input.timestamp ?? Math.floor(Date.now() / 1000),
      creation_tx: input.transactionHash.toLowerCase(),
      deployer: input.deployer.toLowerCase(),
      owner: input.owner.toLowerCase(),
      base_token: baseToken,
      candidate_token: this.chooseCandidateToken(tokenA, tokenB, baseToken, input.baseTokenAddress),
    };

    return candidate;
  }

  private chooseCandidateToken(tokenA: string, tokenB: string, baseToken: string, baseTokenAddress?: string): string {
    const resolved = resolveCandidatePair(tokenA, tokenB, this.knownQuoteAssets);
    if (resolved.pairClassification === "NO_SPECULATIVE_PAIR") throw new Error("NO_SPECULATIVE_PAIR");
    if (resolved.candidateToken) return resolved.candidateToken;
    if (baseTokenAddress) {
      const normalizedBaseAddress = baseTokenAddress.toLowerCase();
      if (tokenA === normalizedBaseAddress) return tokenB;
      if (tokenB === normalizedBaseAddress) return tokenA;
    }
    const upperA = tokenA.toUpperCase();
    const upperB = tokenB.toUpperCase();
    const normalizedBase = baseToken.toUpperCase();

    if (upperA === normalizedBase || upperB === normalizedBase) {
      return upperA === normalizedBase ? tokenB : tokenA;
    }

    if ((normalizedBase === "ETH" || normalizedBase === "WETH") && tokenA === "0x0000000000000000000000000000000000000000") return tokenB;
    if ((normalizedBase === "ETH" || normalizedBase === "WETH") && tokenB === "0x0000000000000000000000000000000000000000") return tokenA;
    throw new Error("BASE_TOKEN_NOT_FOUND_IN_POOL");
  }
}
