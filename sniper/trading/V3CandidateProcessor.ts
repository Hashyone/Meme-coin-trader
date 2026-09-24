import { ethers } from "ethers";
import { config, getConfiguredQuoteAssets } from "../config";
import { PoolAnalysisPipeline } from "../analysis/PoolAnalysisPipeline";
import { PoolCandidateFactory } from "../discovery/PoolCandidateFactory";
import { V3MarketStateResolver } from "../market/V3MarketStateResolver";
import { V3TradeAdapter } from "../execution/V3TradeAdapter";
import { evaluateTrade, TradeEvaluation } from "./TradeEvaluation";
import { Candidate } from "../types";

export interface PoolCreatedInput {
  factory: string;
  token0: string;
  token1: string;
  fee: number;
  tickSpacing: number;
  pool: string;
  transactionHash: string;
  blockNumber: number;
  logIndex: number;
}

export interface V3CandidateResult {
  candidate: Candidate;
  state?: Awaited<ReturnType<V3MarketStateResolver["resolve"]>>;
  evaluation?: TradeEvaluation;
  rejectionReasons: string[];
}

export class V3CandidateProcessor {
  private readonly factory = new PoolCandidateFactory(config.factoryAddress, config.chainId, getConfiguredQuoteAssets());
  private readonly analysis = new PoolAnalysisPipeline();
  private readonly resolver: V3MarketStateResolver;
  private readonly adapter: V3TradeAdapter;

  constructor(private readonly provider: ethers.Provider) {
    this.resolver = new V3MarketStateResolver(provider, config.factoryAddress);
    this.adapter = new V3TradeAdapter(provider);
  }

  async process(event: PoolCreatedInput, recipient: string): Promise<V3CandidateResult> {
    const deployer = await this.resolver.resolveDeployer(event.transactionHash);
    const candidate = this.factory.createFromEvent({
      ...event,
      deployer,
      owner: "UNKNOWN",
      baseToken: this.baseTokenFor(event.token0, event.token1),
      baseTokenAddress: this.baseTokenAddressFor(event.token0, event.token1),
    });
    const rejectionReasons: string[] = [];
    let state: V3CandidateResult["state"];
    try {
      state = await this.resolver.resolve(candidate);
    } catch (error) {
      rejectionReasons.push(error instanceof Error ? error.message : "INVALID_PAIR");
      return { candidate, rejectionReasons };
    }

    try {
      const amountIn = tradeSizeWei();
      const buy = await this.adapter.quoteBuy(state, amountIn);
      const sell = await this.adapter.quoteSell(state, buy.amountOut);
      console.log("V3 QUOTES:", {
        pool: candidate.pool,
        candidateToken: candidate.candidate_token,
        baseToken: candidate.base_token,
        amountIn: amountIn.toString(),
        buyAmountOut: buy.amountOut.toString(),
        sellAmountOut: sell.amountOut.toString(),
        buyGasEstimate: buy.gasEstimate.toString(),
        sellGasEstimate: sell.gasEstimate.toString(),
        quotedAtBlock: sell.quotedAtBlock,
      });
      if (state.baseLiquidityUsd < config.minLiquidityUsd) rejectionReasons.push("LIQUIDITY_TOO_LOW");
      const code = await this.provider.getCode(candidate.candidate_token);
      const security = await this.analysis.analyze(candidate, code);
      if (!security.accepted) {
        rejectionReasons.push("SECURITY_FAILURE");
        if (security.contractRisk.mintRisk) rejectionReasons.push("MINT_RISK");
        if (security.contractRisk.freezeRisk) rejectionReasons.push("ACTIVE_FREEZE_AUTHORITY");
        if (security.contractRisk.honeypotRisk) rejectionReasons.push("TRANSFER_RESTRICTION");
        if (security.contractRisk.rugpullRisk) rejectionReasons.push("LIQUIDITY_RISK");
      }
      if (rejectionReasons.length > 0) return { candidate, state, rejectionReasons };
      const feeData = await this.provider.getFeeData();
      const effectiveGasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
      const evaluation = evaluateTrade({
        amountInWei: amountIn,
        expectedBuyAmountWei: buy.amountOut,
        expectedSellAmountWei: sell.amountOut,
        buyGasWei: buy.gasEstimate,
        sellGasWei: sell.gasEstimate,
        effectiveGasPriceWei: effectiveGasPrice,
        liquidityWei: BigInt(Math.floor(state.baseLiquidityUsd * 1e18)),
        priceImpactBps: 0,
        slippageBps: config.maxSlippageBps,
        observedBlock: state.observedBlock,
        quoteBlock: sell.quotedAtBlock,
        currentBlock: await this.provider.getBlockNumber(),
        openPositions: 0,
        totalExposureWei: 0n,
        dailyLossWei: 0n,
      }, config);
      return { candidate, state, evaluation, rejectionReasons: evaluation.rejectionReasons };
    } catch (error) {
      rejectionReasons.push(error instanceof Error ? error.message : "NO_VALID_ROUTE");
      return { candidate, state, rejectionReasons };
    }
  }

  buildBuy(result: V3CandidateResult, recipient: string): ReturnType<V3TradeAdapter["buildBuyTransaction"]> {
    if (!result.state || !result.evaluation?.approved) throw new Error("CANDIDATE_NOT_TRADEABLE");
    return this.adapter.buildBuyTransaction(result.state, recipient, result.evaluation.amountInWei, result.evaluation.expectedBuyAmountWei);
  }

  private baseTokenFor(token0: string, token1: string): string {
    if (this.isWrappedNative(token0) || this.isWrappedNative(token1)) return "WETH";
    const configured = Object.entries(config.approvedBaseTokenAddresses);
    const match = configured.find(([, address]) => address.toLowerCase() === token0.toLowerCase() || address.toLowerCase() === token1.toLowerCase());
    if (!match) return "UNKNOWN";
    return match[0];
  }

  private baseTokenAddressFor(token0: string, token1: string): string | undefined {
    if (this.isWrappedNative(token0)) return token0;
    if (this.isWrappedNative(token1)) return token1;
    const configured = Object.values(config.approvedBaseTokenAddresses);
    return configured.find((address) => address.toLowerCase() === token0.toLowerCase() || address.toLowerCase() === token1.toLowerCase());
  }

  private isWrappedNative(address: string): boolean {
    return Boolean(config.wrappedNativeAddress) && address.toLowerCase() === config.wrappedNativeAddress?.toLowerCase();
  }
}

function tradeSizeWei(): bigint {
  const value = process.env.TRADE_SIZE_ETH ?? "0.01";
  const [whole, fraction = ""] = value.trim().split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction) || fraction.length > 18) throw new Error("INVALID_TRADE_SIZE_ETH");
  return BigInt(whole) * 10n ** 18n + BigInt((fraction + "0".repeat(18)).slice(0, 18));
}
