import { BotConfig } from "../config";

export interface TradeEvaluationInput {
  amountInWei: bigint;
  expectedBuyAmountWei: bigint;
  expectedSellAmountWei: bigint;
  buyGasWei: bigint;
  sellGasWei: bigint;
  effectiveGasPriceWei: bigint;
  liquidityWei: bigint;
  priceImpactBps: number;
  slippageBps: number;
  buyTaxBps?: number;
  sellTaxBps?: number;
  observedBlock: number;
  quoteBlock: number;
  currentBlock: number;
  openPositions: number;
  totalExposureWei: bigint;
  dailyLossWei: bigint;
  lastTradeAt?: number;
  now?: number;
}

export interface TradeEvaluation {
  approved: boolean;
  rejectionReasons: string[];
  details: Record<string, string | number | boolean | null>;
  amountInWei: bigint;
  expectedBuyAmountWei: bigint;
  expectedSellAmountWei: bigint;
  grossProfitWei: bigint;
  totalGasWei: bigint;
  gasCostWei: bigint;
  netProfitWei: bigint;
  netProfitBps: number;
  priceImpactBps: number;
  slippageBps: number;
  buyTaxBps: number | "UNKNOWN";
  sellTaxBps: number | "UNKNOWN";
  observedBlock: number;
  quoteBlock: number;
}

export function evaluateTrade(input: TradeEvaluationInput, config: BotConfig): TradeEvaluation {
  const buyTaxBps = input.buyTaxBps ?? "UNKNOWN";
  const sellTaxBps = input.sellTaxBps ?? "UNKNOWN";
  const totalGasWei = input.buyGasWei + input.sellGasWei;
  const gasCostWei = totalGasWei * input.effectiveGasPriceWei;
  const grossProfitWei = input.expectedSellAmountWei - input.amountInWei;
  const taxCostWei = input.expectedSellAmountWei * BigInt(typeof sellTaxBps === "number" ? sellTaxBps : 0) / 10_000n;
  const netProfitWei = grossProfitWei - gasCostWei - taxCostWei;
  const netProfitBps = input.amountInWei > 0n ? Number(netProfitWei * 10_000n / input.amountInWei) : -100_000;
  const rejectionReasons: string[] = [];
  const now = input.now ?? Date.now();
  const staleBlocks = Math.max(input.currentBlock - input.observedBlock, input.currentBlock - input.quoteBlock);
  const minLiquidityWei = BigInt(Math.floor(config.minLiquidityEth * 1e18));
  const maxExposureWei = BigInt(Math.floor(config.maxTotalExposureEth * 1e18));
  const maxGasThresholdWei = BigInt(Math.floor(config.maxGasEth * 1e18));
  const maxDailyLossWei = BigInt(Math.floor(config.maxDailyLossEth * 1e18));

  if (input.amountInWei <= 0n) rejectionReasons.push("TRADE_SIZE_INVALID");
  if (input.totalExposureWei + input.amountInWei > maxExposureWei) rejectionReasons.push("MAX_EXPOSURE_REACHED");
  if (input.liquidityWei < minLiquidityWei) rejectionReasons.push("LIQUIDITY_TOO_LOW");
  if (netProfitWei < BigInt(Math.floor(config.minExpectedProfitEth * 1e18))) rejectionReasons.push("EXPECTED_PROFIT_TOO_LOW");
  if (netProfitBps < config.minExpectedProfitBps) rejectionReasons.push("EXPECTED_PROFIT_BPS_TOO_LOW");
  if (input.slippageBps > config.maxSlippageBps) rejectionReasons.push("MAX_SLIPPAGE_EXCEEDED");
  if (input.priceImpactBps > config.maxPriceImpactBps) rejectionReasons.push("PRICE_IMPACT_TOO_HIGH");
  if (buyTaxBps === "UNKNOWN") rejectionReasons.push("BUY_TAX_UNKNOWN");
  else if (buyTaxBps > config.maxBuyTaxBps) rejectionReasons.push("BUY_TAX_TOO_HIGH");
  if (sellTaxBps === "UNKNOWN") rejectionReasons.push("SELL_TAX_UNKNOWN");
  else if (sellTaxBps > config.maxSellTaxBps) rejectionReasons.push("SELL_TAX_TOO_HIGH");
  if (gasCostWei > maxGasThresholdWei) rejectionReasons.push("GAS_TOO_HIGH");
  if (staleBlocks > config.maxStaleBlocks) rejectionReasons.push("STALE_MARKET_STATE");
  if (input.openPositions >= config.maxOpenPositions) rejectionReasons.push("MAX_OPEN_POSITIONS_REACHED");
  if (input.dailyLossWei >= maxDailyLossWei) rejectionReasons.push("DAILY_LOSS_LIMIT_REACHED");
  if (input.lastTradeAt !== undefined && now - input.lastTradeAt < config.tradeCooldownMs) rejectionReasons.push("TRADE_COOLDOWN_ACTIVE");

  const details = {
    amountInWei: input.amountInWei.toString(),
    expectedBuyAmountWei: input.expectedBuyAmountWei.toString(),
    expectedSellAmountWei: input.expectedSellAmountWei.toString(),
    liquidityWei: input.liquidityWei.toString(),
    minLiquidityWei: minLiquidityWei.toString(),
    gasCostWei: gasCostWei.toString(),
    netProfitWei: netProfitWei.toString(),
    netProfitBps,
    buyTaxBps: buyTaxBps === "UNKNOWN" ? "UNKNOWN" : Number(buyTaxBps),
    sellTaxBps: sellTaxBps === "UNKNOWN" ? "UNKNOWN" : Number(sellTaxBps),
    staleBlocks,
    maxSlippageBps: config.maxSlippageBps,
    maxPriceImpactBps: config.maxPriceImpactBps,
    maxGasEth: config.maxGasEth,
    approved: rejectionReasons.length === 0,
  };

  return {
    approved: rejectionReasons.length === 0,
    rejectionReasons,
    details,
    amountInWei: input.amountInWei,
    expectedBuyAmountWei: input.expectedBuyAmountWei,
    expectedSellAmountWei: input.expectedSellAmountWei,
    grossProfitWei,
    totalGasWei,
    gasCostWei,
    netProfitWei,
    netProfitBps,
    priceImpactBps: input.priceImpactBps,
    slippageBps: input.slippageBps,
    buyTaxBps,
    sellTaxBps,
    observedBlock: input.observedBlock,
    quoteBlock: input.quoteBlock,
  };
}
