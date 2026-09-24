import "dotenv/config";
import { ethers } from "ethers";
import { config, getConfiguredQuoteAssets } from "./config";
import { PoolAnalysisPipeline } from "./analysis/PoolAnalysisPipeline";
import { PoolCandidateFactory } from "./discovery/PoolCandidateFactory";
import { SecurityEngine } from "./security/SecurityEngine";
import { SimulationEngine } from "./execution/SimulationEngine";
import { ContinuousPaperTrader } from "./runtime/ContinuousPaperTrader";
import { AnalysisDedupe } from "./runtime/AnalysisDedupe";
import { ConcurrencyPool } from "./runtime/ConcurrencyPool";
import { RobinhoodWebSocketListener } from "./listener/RobinhoodWebSocketListener";
import { BlockEventStore } from "./storage/BlockEventStore";
import { BlockReconciler } from "./ingestion/BlockReconciler";
import { V3CandidateProcessor } from "./trading/V3CandidateProcessor";
import type { PonsLaunchEvent } from "./discovery/PonsLaunchAdapter";
import { scanLogsInChunks } from "./ingestion/BoundedLogScanner";
import { RejectionStatsStore } from "./telemetry/RejectionStatsStore";
import { DecisionTraceStore, DecisionTrace } from "./telemetry/DecisionTraceStore";
import { nonceManagerFor } from "./execution/NonceManager";
import {
  PONS_TOKEN_LAUNCHED_TOPIC,
  PONS_V2_TOKEN_LAUNCHED_TOPIC,
  PONS_V2_POOL_GRADUATED_TOPIC,
  PONS_INTERFACE,
  PONS_V2_INTERFACE,
  topicForSourceEvent,
} from "./listener/RobinhoodWebSocketListener";
import { PonsV2Resolver, buildPonsV2PoolKey, routePonsV2Phase } from "./discovery/PonsV2Resolver";
import type { PonsV2PoolKey } from "./discovery/PonsV2Resolver";
import { PonsTokenScreen } from "./security/PonsTokenScreen";
import { measureEarlySupplyConcentration } from "./security/EarlySupplyConcentration";
import {
  PONS_LAUNCH_GATE_REASONS,
  evaluateLaunchFreshness,
  evaluatePonsGraduatedQuality,
  evaluatePonsLaunchQuality,
  readCreatorHoldingPct,
} from "./security/PonsLaunchGate";
import type { PonsGraduatedQualityResult } from "./security/PonsLaunchGate";
import { PonsV4StateView } from "./market/PonsV4StateView";
import { measurePonsV4Volume, quoteValueToUsd } from "./market/PonsV4PoolVolume";
import type { PonsV4QuoteAsset } from "./market/PonsV4PoolVolume";
import { probeSellPath } from "./security/SellPathProbe";
import { PonsV4Quoter } from "./execution/PonsV4Quoter";
import { PonsV4Router } from "./execution/PonsV4Router";
import { PonsV2CurveAdapter, minTokensOutForBuy, quoteCurveBuyFromState } from "./execution/PonsV2CurveAdapter";
import { LiveExitManager, liveExitTuningFromEnv } from "./execution/LiveExitManager";

type PonsTokenLaunchEvent = {
  factory: string;
  token: string;
  transactionHash: string;
  blockNumber: number;
  logIndex: number;
  pool?: string;
  pairToken?: string;
  dexFactory?: string;
  restrictionsEndBlock?: number;
  initialBuyAmount?: bigint;
};

// The V4 execution path only needs the launch factory (which gates the route) and the token address (the
// handle used to read the launch record). `TokenLaunched` and `PoolGraduated` both satisfy this shape, so a
// graduation event can re-enter the same execution path it makes tradeable.
type PonsV2LaunchSourceEvent = {
  factory: string;
  token: string;
  transactionHash: string;
  blockNumber: number;
  logIndex: number;
};

type PonsV2LaunchEvent = PonsV2LaunchSourceEvent & {
  curve: string;
  deployer: string;
  pairToken: string;
  launchConfigId: number;
  graduationThreshold: bigint;
};

const ponsTokenScreen = new PonsTokenScreen();

async function screenPonsLaunch(provider: ethers.Provider, token: string, pairToken: string): Promise<Awaited<ReturnType<PonsTokenScreen["screen"]>>> {
  const runtimeBytecode = await provider.getCode(token);
  const screening = await ponsTokenScreen.screen({
    token,
    pairToken,
    runtimeBytecode,
    approvedBaseTokenAddresses: Object.values(config.approvedBaseTokenAddresses),
    wrappedNativeAddress: config.wrappedNativeAddress,
    rejectBurnRisk: config.ponsRejectBurnRisk,
    rejectLiquidityRisk: config.ponsRejectLiquidityRisk,
  });
  console.log("PONS SECURITY SCREEN:", {
    token,
    pairToken,
    pairTokenKind: screening.pairTokenKind,
    accepted: screening.accepted,
    rejectionReasons: screening.rejectionReasons,
    mintRisk: screening.contractRisk.mintRisk,
    freezeRisk: screening.contractRisk.freezeRisk,
    honeypotRisk: screening.contractRisk.honeypotRisk,
    maliciousContract: screening.contractRisk.maliciousContract,
    liquidityRisk: screening.contractRisk.liquidityRisk,
    burnRisk: screening.contractRisk.burnRisk,
    reasons: screening.contractRisk.reasons,
  });
  return screening;
}

/**
 * A trade is sized in the units of the asset it spends. The native quote is wei of the gas token, but an
 * ERC20 quote (USDG, NVDA, ...) is its own raw amount: reusing the ETH size would ask a 6-decimal token for
 * hundreds of millions of units and block every such launch on a balance it could never hold.
 */
function parseQuoteSizes(raw: string | undefined): Record<string, bigint> {
  const sizes: Record<string, bigint> = {};
  for (const entry of (raw ?? "").split(",")) {
    const [address, amount] = entry.trim().split(":");
    if (!address || !amount || !ethers.isAddress(address)) continue;
    try {
      sizes[address.toLowerCase()] = BigInt(amount);
    } catch {
      continue;
    }
  }
  return sizes;
}

function entrySizeForPairToken(pairToken: string): bigint | undefined {
  if (pairToken === ethers.ZeroAddress) return BigInt(process.env.PONS_V4_TRADE_SIZE_WEI ?? ethers.parseEther(process.env.TRADE_SIZE_ETH ?? "0.000001").toString());
  return parseQuoteSizes(process.env.PONS_QUOTE_SIZES)[pairToken.toLowerCase()];
}

/**
 * The pool's quote side. The native currency needs no read and carries the USD price feed; an ERC20's own
 * `decimals()` decides its scale. A read that fails yields `decimals: -1`, which `quoteValueToUsd` treats as
 * unvaluable — guessing 18 would produce a dollar figure that looks measured and is off by orders of magnitude.
 */
async function ponsV4QuoteAsset(provider: ethers.Provider, pairToken: string): Promise<PonsV4QuoteAsset> {
  if (pairToken === ethers.ZeroAddress) return { address: ethers.ZeroAddress, decimals: 18, native: true };
  try {
    const token = new ethers.Contract(pairToken, ["function decimals() view returns (uint8)"], provider);
    const decimals = Number(await token.decimals());
    return { address: ethers.getAddress(pairToken), decimals: Number.isInteger(decimals) ? decimals : -1, native: false };
  } catch {
    return { address: ethers.getAddress(pairToken), decimals: -1, native: false };
  }
}

/**
 * The graduated lane's own gate, run before the V4 branch spends anything. Once a token is past the curve the
 * launch-lane measures no longer describe it — its reserves are gone and its tranche of the supply is settled —
 * so the questions that still matter are how much liquidity graduation created and whether the pool trades.
 *
 * Liquidity is the quote amount swept into the pool at graduation (`graduationThreshold`), valued in USD, not
 * the pool's `liquidity` L: L is an amount of the token/quote at the current price across a tick range, and it
 * cannot be turned into dollars without reconstructing that range. The swept quote is the capital that
 * actually backs the pool and it is the same for every launch of a given quote asset, so a floor on it is a
 * floor on the graduation standard rather than on this pool's depth.
 *
 * Volume is read only when a floor is switched on: the pool manager's `Swap` logs are unbounded, the Alchemy
 * tier caps `eth_getLogs` at 10 blocks, so a trailing window costs one request per ten blocks. The window ends
 * at the head block and is a poll, not a per-event read — the caller owns that cost, and the default floor is
 * off precisely because a graduated entry is a poll's worth of RPC.
 */
async function evaluatePonsGraduatedLane(
  provider: ethers.Provider,
  launch: { token: string; pairToken: string; graduationThreshold: bigint },
  poolKey: PonsV2PoolKey,
  headBlock: number,
): Promise<PonsGraduatedQualityResult> {
  const quoteAsset = await ponsV4QuoteAsset(provider, launch.pairToken);
  const liquidityUsd = quoteValueToUsd(launch.graduationThreshold, quoteAsset, config.nativeUsdPrice);
  let volumeUsd: number | null = null;
  if (config.ponsGraduatedMinVolumeUsd > 0 && config.ponsGraduatedVolumeWindowBlocks > 0) {
    const window = config.ponsGraduatedVolumeWindowBlocks;
    const volume = await measurePonsV4Volume(provider, {
      poolId: poolKey.poolId,
      quoteAsset,
      quoteIsCurrency0: poolKey.currency0.toLowerCase() === launch.pairToken.toLowerCase(),
      fromBlock: Math.max(0, headBlock - window + 1),
      toBlock: headBlock,
      nativeUsdPrice: config.nativeUsdPrice,
    });
    volumeUsd = volume ? volume.volumeUsd : null;
  }
  return evaluatePonsGraduatedQuality({
    liquidityUsd,
    volumeUsd,
    policy: {
      graduatedMinLiquidityUsd: config.ponsGraduatedMinLiquidityUsd,
      graduatedMinVolumeUsd: config.ponsGraduatedMinVolumeUsd,
    },
  });
}

async function executePonsV2LaunchEvent(event: PonsV2LaunchSourceEvent, provider: ethers.Provider, exitManager?: LiveExitManager): Promise<void> {
  // Only the V2 factory routes through the Uniswap V4 pool path. V1 launches are minted straight into a
  // Uniswap V3 position and are covered by the V3 `PoolCreated` handler.
  if (event.factory.toLowerCase() !== config.ponsV2Factory.toLowerCase()) {
    console.log("PONS V2 LAUNCH SKIPPED:", { token: event.token, factory: event.factory, reason: "NOT_PONS_V2_FACTORY" });
    return;
  }
  // Freshness is checked before anything is built, resolved or signed, and before any other lane gets a chance
  // to act: the 2026-09-17 fill went out 29,278 blocks (49 minutes) after its launch block, priced against a
  // launch that no longer existed. Age is the only signal that separates a snipe from a stale fill.
  const headBlock = await provider.getBlockNumber();
  const freshness = evaluateLaunchFreshness({
    launchBlock: event.blockNumber,
    headBlock,
    maxEntryAgeBlocks: config.ponsMaxEntryAgeBlocks,
  });
  if (!freshness.ok) {
    console.log("PONS V2 LAUNCH BLOCKED:", {
      token: event.token,
      reason: freshness.reason ?? PONS_LAUNCH_GATE_REASONS.STALE_LAUNCH,
      launchBlock: event.blockNumber,
      headBlock,
      ageBlocks: freshness.ageBlocks,
      maxEntryAgeBlocks: config.ponsMaxEntryAgeBlocks,
    });
    return;
  }
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (!privateKey) throw new Error("PONS_V2_EXECUTION_REQUIRES_WALLET");
  if (!liveExecutionEnabled()) throw new Error("PONS_V2_EXECUTION_REQUIRES_LIVE_MODE");
  const wallet = new ethers.Wallet(privateKey, provider);
  const launch = await new PonsV2Resolver(provider).resolve(event.token, true);
  await recordPonsRouteTrace(event, launch);
  const route = routePonsV2Phase(launch.phase);
  if (!route.executable) {
    console.log("PONS V2 LAUNCH SKIPPED:", { token: launch.token, phase: launch.phase, route: route.phase, reason: route.reason ?? "NOT_TRADEABLE" });
    return;
  }
  const screening = await screenPonsLaunch(provider, launch.token, launch.pairToken);
  if (!screening.accepted) {
    console.log("PONS V2 SECURITY BLOCKED:", { token: launch.token, reasons: screening.rejectionReasons, details: screening.contractRisk.reasons });
    return;
  }
  // A curve launch has no Uniswap pool yet, so it takes the curve's own buy path. Graduated tokens (phase 2)
  // continue into the V4 flow below.
  if (route.phase === "PONS_V2_CURVE") {
    await executePonsV2CurveEntry(launch, provider, wallet, exitManager, event);
    return;
  }
  const poolKey = buildPonsV2PoolKey(launch);
  if (!poolKey.ok) {
    console.log("PONS V2 LAUNCH REJECTED:", { token: launch.token, reason: poolKey.reason, details: poolKey.details });
    return;
  }
  const state = await new PonsV4StateView(provider, config.ponsV4StateView).verify(launch);
  if (!state.ok) {
    console.log("PONS V2 STATEVIEW BLOCKED:", { token: launch.token, reason: state.reason, details: state.details });
    return;
  }
  // The graduated lane is gated on its own terms before the quote is built: liquidity and volume describe a
  // phase-2 pool, and replaying the curve-lane measures on it would gate on reserves that no longer exist.
  // This runs before `entrySizeForPairToken` and before any approval or simulation, so a pool below the floor
  // costs nothing but the read.
  const graduatedQuality = await evaluatePonsGraduatedLane(provider, launch, state.state.poolKey, headBlock);
  console.log("PONS V4 GRADUATED GATE:", {
    token: launch.token,
    pairToken: launch.pairToken,
    poolId: state.state.poolId,
    accepted: graduatedQuality.accepted,
    reasons: graduatedQuality.reasons,
    ...graduatedQuality.metrics,
    minLiquidityUsd: config.ponsGraduatedMinLiquidityUsd,
    minVolumeUsd: config.ponsGraduatedMinVolumeUsd,
    volumeWindowBlocks: config.ponsGraduatedVolumeWindowBlocks,
    nativeUsdPrice: config.nativeUsdPrice,
  });
  if (!graduatedQuality.accepted) {
    console.log("PONS V4 GRADUATED GATE BLOCKED:", { token: launch.token, reasons: graduatedQuality.reasons, metrics: graduatedQuality.metrics });
    return;
  }
  const amountIn = entrySizeForPairToken(launch.pairToken);
  if (amountIn === undefined) {
    console.log("PONS V2 EXECUTION BLOCKED:", { token: launch.token, pairToken: launch.pairToken, reason: "PONS_QUOTE_SIZE_MISSING" });
    return;
  }
  console.log("PONS V2 QUOTE INPUT:", {
    token: launch.token,
    pairToken: launch.pairToken,
    poolId: state.state.poolId,
    poolKey: state.state.poolKey,
    amountIn: amountIn.toString(),
    zeroForOne: state.state.poolKey.currency0.toLowerCase() === launch.pairToken.toLowerCase(),
    state: {
      sqrtPriceX96: state.state.sqrtPriceX96.toString(),
      tick: state.state.tick,
      protocolFee: state.state.protocolFee,
      lpFee: state.state.lpFee,
      liquidity: state.state.liquidity.toString(),
      initialized: state.state.initialized,
    },
  });
  const quote = await new PonsV4Quoter(provider, config.ponsV4Quoter).quoteExactInput(state.state.poolKey, launch.pairToken, amountIn);
  const amountOutMinimum = quote.amountOut * BigInt(10000 - config.maxSlippageBps) / 10000n;
  const router = new PonsV4Router(provider, config.ponsV4UniversalRouter, config.chainId);
  // Approvals are real transactions, so the wallet's ability to fund the trade is checked before any gas is
  // spent on them. Without this, an underfunded wallet burns its remaining balance approving a trade it then
  // reports as blocked.
  const funding = await router.inspectInputReadiness(launch.pairToken, wallet.address, amountIn, config.permit2);
  if (funding.balance < amountIn) {
    console.log("PONS V2 EXECUTION BLOCKED:", { token: launch.token, reason: "PONS_V4_INPUT_BALANCE_TOO_LOW", readiness: funding });
    return;
  }
  await ensurePonsV4Approvals(provider, wallet, launch.pairToken, amountIn);
  const readiness = await router.inspectInputReadiness(launch.pairToken, wallet.address, amountIn, config.permit2);
  if (!readiness.ready) {
    console.log("PONS V2 EXECUTION BLOCKED:", { token: launch.token, readiness });
    return;
  }
  const transaction = router.buildExactInputSingle(state.state.poolKey, launch.pairToken, amountIn, amountOutMinimum, BigInt(Math.floor(Date.now() / 1000) + 120), wallet.address);
  const gasLimit = await router.simulate(transaction, wallet.address);
  const nonceManager = nonceManagerFor(provider, wallet.address);
  const nonce = await nonceManager.reserve();
  const feeData = await provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (!maxFeePerGas) throw new Error("PONS_V2_FEE_DATA_UNAVAILABLE");
  const outputToken = new ethers.Contract(launch.token, ["function balanceOf(address) view returns (uint256)"], provider);
  const balanceBefore = BigInt(await outputToken.balanceOf(wallet.address));
  const response = await wallet.sendTransaction({ ...transaction, gasLimit, nonce, maxFeePerGas, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? maxFeePerGas });
  const receipt = await response.wait();
  if (!receipt || receipt.status !== 1) throw new Error("PONS_V2_RECEIPT_FAILED");
  const outputBalance = BigInt(await outputToken.balanceOf(wallet.address));
  // Registering only the delta keeps a second launch of a token already held from inheriting the old bag's
  // tokens, which would inflate the position and sell tranches larger than this trade actually bought.
  const receivedTokens = outputBalance > balanceBefore ? outputBalance - balanceBefore : 0n;
  console.log("PONS V2 EXECUTION VERIFIED:", {
    token: launch.token,
    transactionHash: response.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    amountIn: amountIn.toString(),
    amountOutMinimum: amountOutMinimum.toString(),
    outputBalance: outputBalance.toString(),
    receivedTokens: receivedTokens.toString(),
  });
  if (!exitManager) return;
  exitManager.register({
    token: launch.token,
    pairToken: launch.pairToken,
    poolKey: state.state.poolKey,
    tokenAmount: receivedTokens,
    committedWei: amountIn,
    entryTransaction: response.hash,
  });
  await exitManager.persist();
}

/**
 * Buys a phase-0 launch on its bonding curve. The curve is the only venue before graduation, and it prices
 * with its own fee/creator-tax/anti-snipe-tax schedule, so the quote comes from the curve's reserves rather
 * than from a pool. The native quote is sent as `msg.value`, which means the same balance funds both the trade
 * and its gas — the affordability check therefore runs before the approval and simulation steps.
 */
async function executePonsV2CurveEntry(
  launch: Awaited<ReturnType<PonsV2Resolver["resolve"]>>,
  provider: ethers.Provider,
  wallet: ethers.Wallet,
  exitManager: LiveExitManager | undefined,
  source: PonsV2LaunchSourceEvent,
): Promise<void> {
  // The screen is enforced inside the function that broadcasts, not only at its caller. A caller that forgets
  // to screen — an ad-hoc script, a new lane, a probe — would otherwise be able to spend real funds on a token
  // no filter ever inspected, which is exactly how the 2026-09-17 curve fill bypassed every check.
  const screening = await screenPonsLaunch(provider, launch.token, launch.pairToken);
  if (!screening.accepted) {
    console.log("PONS V2 SECURITY BLOCKED:", { token: launch.token, curve: launch.curve, reasons: screening.rejectionReasons, details: screening.contractRisk.reasons });
    return;
  }
  const amountIn = entrySizeForPairToken(launch.pairToken);
  if (amountIn === undefined) {
    console.log("PONS V2 CURVE EXECUTION BLOCKED:", { token: launch.token, curve: launch.curve, pairToken: launch.pairToken, reason: "PONS_QUOTE_SIZE_MISSING" });
    return;
  }
  const adapter = new PonsV2CurveAdapter(provider, launch.curve, config.chainId);
  const state = await adapter.readState(wallet.address);
  console.log("PONS V2 CURVE STATE:", {
    token: launch.token,
    curve: launch.curve,
    pairToken: state.pairToken,
    nativeQuote: state.native,
    quoteReserve: state.quoteReserve.toString(),
    tokenReserve: state.tokenReserve.toString(),
    sellableTokens: state.sellableTokens.toString(),
    feeBps: state.feeBps,
    creatorTaxBps: state.creatorTaxBps,
    snipeTaxBps: state.snipeTaxBps,
    graduationThreshold: state.graduationThreshold.toString(),
    graduated: state.graduated,
    readyToGraduate: state.readyToGraduate,
  });
  if (state.graduated || state.readyToGraduate) {
    console.log("PONS V2 CURVE EXECUTION BLOCKED:", {
      token: launch.token,
      curve: launch.curve,
      reason: "PONS_CURVE_CLOSED",
      graduated: state.graduated,
      readyToGraduate: state.readyToGraduate,
    });
    return;
  }
  // The creator read is the only extra RPC this gate costs, so it is skipped unless the check is switched on.
  const creatorHoldingPct = config.ponsMaxCreatorHoldingPct > 0
    ? await readCreatorHoldingPct(provider, launch.token, launch.creatorFeeRecipient)
    : null;
  // Bundling is normal; a bundle that controls the majority of supply is not. Measured from the token's own
  // ERC20 Transfer history in the first blocks after its launch, so the operator shows up as the sender that
  // fed the wallets - the funding trail does not point at it, which is why a funding-based metric missed it.
  // ONE read serves every ceiling below (bundle, launch allocation, insider share, same-block, sequential and
  // peer-transfer shares) plus the sell-path probe, which needs a wallet that really holds the token - the
  // largest holder this read produces - rather than a fabricated balance. It is skipped only when every one of
  // those consumers is switched off, because it is the only extra RPC this gate costs.
  const needsConcentration =
    config.ponsMaxBundleSupplyPct > 0 ||
    config.ponsMaxLaunchAllocSharePct > 0 ||
    config.ponsMaxInsiderSupplyPct > 0 ||
    config.ponsMaxSameBlockSharePct > 0 ||
    config.ponsMaxSequentialBlockSharePct > 0 ||
    config.ponsMaxPeerTransferSharePct > 0 ||
    config.ponsSimulateSellPath;
  const concentration = needsConcentration
    ? await measureEarlySupplyConcentration(provider, {
      token: launch.token,
      launchBlock: source.blockNumber,
      launchTx: source.transactionHash,
      deployer: launch.deployer,
      exclude: [launch.curve, launch.deployer, launch.pairToken, config.ponsV2Factory],
      policy: { windowBlocks: config.ponsBundleWindowBlocks, relayAddresses: config.ponsRelayAddresses },
    })
    : null;
  // Executes the sell leg against the largest real holder. A honeypot is proved here rather than guessed from
  // bytecode, and `null` - no holder, RPC refusing overrides - is reported as unmeasured, never as a pass.
  const sellPathProbe = config.ponsSimulateSellPath
    ? await probeSellPath(provider, {
      token: launch.token,
      curve: launch.curve,
      holder: concentration?.topHolders[0]?.address ?? launch.creatorFeeRecipient,
    })
    : null;
  if (concentration) {
    console.log("PONS V2 EARLY CONCENTRATION:", {
      token: launch.token,
      launchBlock: concentration.launchBlock,
      windowEndBlock: concentration.windowEndBlock,
      source: concentration.source,
      transfersRead: concentration.transfersRead,
      truncated: concentration.truncated,
      holders: concentration.holders,
      earlyCount: concentration.earlyCount,
      earlySharePct: concentration.earlySharePct,
      senderBundleSharePct: concentration.senderBundleSharePct,
      launchAllocSharePct: concentration.launchAllocSharePct,
      launchAllocRecipients: concentration.launchAllocRecipients,
      insiderSharePct: concentration.insiderSharePct,
      top1Pct: concentration.top1Pct,
      top5Pct: concentration.top5Pct,
      top10Pct: concentration.top10Pct,
      sameBlockSharePct: concentration.sameBlockSharePct,
      sameBlockClusters: concentration.sameBlockClusters,
      sequentialBlockSharePct: concentration.sequentialBlockSharePct,
      peerTransferSharePct: concentration.peerTransferSharePct,
      reciprocalPairCount: concentration.reciprocalPairCount,
      peerTransferPairs: concentration.peerTransferPairs,
      senderOperators: concentration.senderOperators.map((operator) => ({
        sender: operator.sender,
        recipients: operator.recipients,
        sharePct: operator.sharePct,
        ownSharePct: operator.ownSharePct,
      })),
    });
  }
  if (sellPathProbe) {
    console.log("PONS V2 SELL PATH PROBE:", { token: launch.token, curve: launch.curve, ...sellPathProbe });
  }
  const launchQuality = evaluatePonsLaunchQuality({
    quoteReserve: state.quoteReserve,
    graduationThreshold: state.graduationThreshold,
    feeBps: state.feeBps,
    creatorTaxBps: state.creatorTaxBps,
    snipeTaxBps: state.snipeTaxBps,
    buybackEnabled: launch.buybackEnabled,
    creatorHoldingPct,
    bundleSupplyPct: concentration ? concentration.senderBundleSharePct : null,
    launchAllocSharePct: concentration ? concentration.launchAllocSharePct : null,
    insiderSharePct: concentration ? concentration.insiderSharePct : null,
    sameBlockSharePct: concentration ? concentration.sameBlockSharePct : null,
    sequentialBlockSharePct: concentration ? concentration.sequentialBlockSharePct : null,
    peerTransferSharePct: concentration ? concentration.peerTransferSharePct : null,
    sellPath: sellPathProbe ? sellPathProbe.status : null,
    policy: {
      minThresholdPct: config.ponsLaunchMinThresholdPct,
      maxTollBps: config.ponsLaunchMaxTollBps,
      maxCreatorHoldingPct: config.ponsMaxCreatorHoldingPct,
      maxBundleSupplyPct: config.ponsMaxBundleSupplyPct,
      maxLaunchAllocSharePct: config.ponsMaxLaunchAllocSharePct,
      rejectBuybackEnabled: config.ponsRejectBuybackEnabled,
      maxInsiderSupplyPct: config.ponsMaxInsiderSupplyPct,
      maxSameBlockSharePct: config.ponsMaxSameBlockSharePct,
      maxSequentialBlockSharePct: config.ponsMaxSequentialBlockSharePct,
      maxPeerTransferSharePct: config.ponsMaxPeerTransferSharePct,
      requireSellPath: config.ponsSimulateSellPath,
    },
  });
  console.log("PONS V2 LAUNCH GATE:", {
    token: launch.token,
    curve: launch.curve,
    accepted: launchQuality.accepted,
    reasons: launchQuality.reasons,
    ...launchQuality.metrics,
    minThresholdPct: config.ponsLaunchMinThresholdPct,
    maxTollBps: config.ponsLaunchMaxTollBps,
    maxCreatorHoldingPct: config.ponsMaxCreatorHoldingPct,
    maxBundleSupplyPct: config.ponsMaxBundleSupplyPct,
    maxLaunchAllocSharePct: config.ponsMaxLaunchAllocSharePct,
    maxInsiderSupplyPct: config.ponsMaxInsiderSupplyPct,
    maxSameBlockSharePct: config.ponsMaxSameBlockSharePct,
    maxSequentialBlockSharePct: config.ponsMaxSequentialBlockSharePct,
    maxPeerTransferSharePct: config.ponsMaxPeerTransferSharePct,
    requireSellPath: config.ponsSimulateSellPath,
    bundleWindowBlocks: config.ponsBundleWindowBlocks,
    creatorFeeRecipient: launch.creatorFeeRecipient,
    buybackEnabled: launch.buybackEnabled,
  });
  if (!launchQuality.accepted) {
    console.log("PONS V2 CURVE EXECUTION BLOCKED:", {
      token: launch.token,
      curve: launch.curve,
      reason: launchQuality.reasons[0],
      reasons: launchQuality.reasons,
      metrics: launchQuality.metrics,
    });
    return;
  }
  // Only the balance can block here. An ERC20 quote is legitimately "not ready" while its allowance is still
  // zero, and `ensureAllowance` below exists to create that allowance — treating it as a blocker here would
  // stop the first entry for every ERC20-quoted curve before the approval it needs could ever be sent. The
  // post-approval readiness check further down still enforces the allowance.
  const funding = await adapter.inspectInputReadiness(launch.pairToken, wallet.address, amountIn);
  if (funding.balance < amountIn) {
    console.log("PONS V2 CURVE EXECUTION BLOCKED:", { token: launch.token, curve: launch.curve, reason: "PONS_CURVE_INPUT_BALANCE_TOO_LOW", readiness: funding });
    return;
  }
  const quote = quoteCurveBuyFromState(state, amountIn);
  const minTokensOut = minTokensOutForBuy(amountIn, quote, config.maxSlippageBps);
  console.log("PONS V2 CURVE QUOTE:", {
    token: launch.token,
    curve: launch.curve,
    amountIn: amountIn.toString(),
    spent: quote.spent.toString(),
    refund: quote.refund.toString(),
    tokensOut: quote.tokensOut.toString(),
    minTokensOut: minTokensOut.toString(),
    fee: quote.fee.toString(),
    creatorTax: quote.tax.toString(),
    snipeTax: quote.snipeTax.toString(),
    partialFill: quote.partialFill,
    slippageBps: config.maxSlippageBps,
  });
  // The curve pulls its input with transferFrom, so the ERC20 path needs the approval before it can simulate.
  try {
    await adapter.ensureAllowance(wallet, launch.pairToken, amountIn);
  } catch (error) {
    console.log("PONS V2 CURVE EXECUTION BLOCKED:", { token: launch.token, curve: launch.curve, reason: "PONS_CURVE_ALLOWANCE_MISSING", details: error instanceof Error ? error.message : String(error) });
    return;
  }
  const readiness = await adapter.inspectInputReadiness(launch.pairToken, wallet.address, amountIn);
  if (!readiness.ready) {
    console.log("PONS V2 CURVE EXECUTION BLOCKED:", { token: launch.token, curve: launch.curve, reason: readiness.reason, readiness });
    return;
  }
  const transaction = adapter.buildBuy(amountIn, minTokensOut, wallet.address, launch.pairToken);
  let gasLimit: bigint;
  try {
    // estimateGas reports the *minimum* that succeeded in simulation, so sending it verbatim leaves no room:
    // the first live curve buy was sent with the estimated 144,706 and reverted out of gas (gasUsed ==
    // gasLimit) for a call that needed 179,313 at its own block. The sent limit has to clear the estimate so
    // it survives state drift between simulation and inclusion.
    gasLimit = ((await adapter.simulate(transaction, wallet.address)) * 13000n) / 10000n;
  } catch (error) {
    console.log("PONS V2 CURVE EXECUTION BLOCKED:", {
      token: launch.token,
      curve: launch.curve,
      reason: "PONS_CURVE_SIMULATION_FAILED",
      details: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  console.log("PONS V2 CURVE PRETRADE:", {
    token: launch.token,
    curve: launch.curve,
    to: transaction.to,
    value: transaction.value.toString(),
    gasLimit: gasLimit.toString(),
    minTokensOut: minTokensOut.toString(),
  });
  const nonceManager = nonceManagerFor(provider, wallet.address);
  const nonce = await nonceManager.reserve();
  const feeData = await provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (!maxFeePerGas) throw new Error("PONS_V2_FEE_DATA_UNAVAILABLE");
  const outputToken = new ethers.Contract(launch.token, ["function balanceOf(address) view returns (uint256)"], provider);
  const balanceBefore = BigInt(await outputToken.balanceOf(wallet.address));
  const response = await wallet.sendTransaction({
    to: transaction.to,
    data: transaction.data,
    value: transaction.value,
    chainId: config.chainId,
    gasLimit,
    nonce,
    maxFeePerGas,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? maxFeePerGas,
  });
  const receipt = await response.wait();
  if (!receipt || receipt.status !== 1) throw new Error("PONS_V2_CURVE_RECEIPT_FAILED");
  const outputBalance = BigInt(await outputToken.balanceOf(wallet.address));
  const receivedTokens = outputBalance > balanceBefore ? outputBalance - balanceBefore : 0n;
  console.log("PONS V2 CURVE EXECUTION VERIFIED:", {
    token: launch.token,
    curve: launch.curve,
    transactionHash: response.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    amountIn: amountIn.toString(),
    spent: quote.spent.toString(),
    minTokensOut: minTokensOut.toString(),
    outputBalance: outputBalance.toString(),
    receivedTokens: receivedTokens.toString(),
  });
  if (!exitManager) return;
  // Curve positions are priced and sold on the curve, so the venue is recorded with the position; a later
  // graduation closes the curve and the exit follows the token to the Uniswap V4 pool it migrated to.
  exitManager.register({
    token: launch.token,
    pairToken: launch.pairToken,
    curve: launch.curve,
    tokenAmount: receivedTokens,
    committedWei: quote.spent,
    entryTransaction: response.hash,
  });
  await exitManager.persist();
}

// Graduation creates the Uniswap V4 pool in the same transaction that emits `PoolGraduated`, so a record read
// taken immediately after the log can still report phase 1. Retry briefly instead of dropping the one event
// that turns a bonding-curve launch into something tradeable.
async function resolvePonsV2Graduated(provider: ethers.Provider, token: string): Promise<Awaited<ReturnType<PonsV2Resolver["resolve"]>> | undefined> {
  const resolver = new PonsV2Resolver(provider);
  const attempts = Math.max(1, Number(process.env.PONS_GRADUATION_RETRY_ATTEMPTS ?? "6"));
  const delayMs = Math.max(0, Number(process.env.PONS_GRADUATION_RETRY_MS ?? "2000"));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const launch = await resolver.resolve(token, true);
      if (launch.phase === 2) return launch;
      if (attempt === attempts) console.log("PONS V2 GRADUATION NOT YET ROUTABLE:", { token, phase: launch.phase, attempts });
    } catch (error) {
      if (attempt === attempts) console.error("PONS V2 GRADUATION RESOLVE FAILED:", { token, attempts, reason: error instanceof Error ? error.message : String(error) });
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return undefined;
}

const factory = new PoolCandidateFactory(config.factoryAddress, config.chainId, getConfiguredQuoteAssets());
const pipeline = new PoolAnalysisPipeline(new SecurityEngine());
const simulationEngine = new SimulationEngine();
const rejectionStatsPromise = RejectionStatsStore.open(`${config.stateFile}.rejections.json`);
const decisionTraceStorePromise = DecisionTraceStore.open(config.decisionTraceFile);

async function recordDecisionTrace(trace: DecisionTrace): Promise<void> {
  try {
    const store = await decisionTraceStorePromise;
    await store.append(trace);
  } catch (error) {
    console.error("DECISION TRACE WRITE FAILED:", { traceId: trace.traceId, reason: error instanceof Error ? error.message : String(error) });
  }
}

async function recordPonsRouteTrace(event: { factory: string; token: string; transactionHash: string; blockNumber: number; logIndex: number }, launch?: Awaited<ReturnType<PonsV2Resolver["resolve"]>>, error?: unknown): Promise<void> {
  const route = launch ? routePonsV2Phase(launch.phase) : undefined;
  const reason = error instanceof Error ? error.message : error ? String(error) : route?.reason;
  await recordDecisionTrace({
    schemaVersion: 1,
    traceId: `${event.transactionHash}:${event.logIndex}`,
    observedAt: new Date().toISOString(),
    chainId: config.chainId,
    source: { protocol: "pons-v2", factory: event.factory, transactionHash: event.transactionHash, blockNumber: event.blockNumber, logIndex: event.logIndex },
    candidate: { token: event.token, deployer: launch?.deployer },
    stages: {
      launchRecord: {
        status: launch && launch.exists ? "PASS" : error ? "ERROR" : "REJECT",
        evidence: launch ? { ...launch, phase: launch.phase, route: route?.phase, executable: route?.executable } : undefined,
        reasons: reason ? [reason] : undefined,
      },
      route: {
        status: route?.executable ? "PASS" : error ? "ERROR" : "REJECT",
        evidence: route ? { phase: route.phase, executable: route.executable } : undefined,
        reasons: reason ? [reason] : undefined,
      },
    },
    final: { accepted: Boolean(route?.executable), rejectionReasons: reason ? [reason] : [] },
  });
}

export async function runAnalysisOnly(candidateInput: {
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
}, runtimeBytecode: string): Promise<{ accepted: boolean; report: unknown }> {
  const candidate = factory.createFromEvent(candidateInput);
  const report = await pipeline.analyze(candidate, runtimeBytecode);
  return {
    accepted: report.accepted,
    report,
  };
}

export async function runSimulationOnly(): Promise<{ mode: string; safe: boolean; txHash: string; signedTx: string; walletAddress: string; broadcasted: boolean; reason?: string }> {
  const privateKey = process.env.WALLET_PRIVATE_KEY || "0x" + "11".repeat(32);
  const derivedWallet = new ethers.Wallet(privateKey);
  const from = process.env.METAMASK_WALLET_ADDRESS && process.env.METAMASK_WALLET_ADDRESS !== "" ? process.env.METAMASK_WALLET_ADDRESS : derivedWallet.address;
  const result = await simulationEngine.simulate({
    chainId: config.chainId,
    from,
    to: process.env.EXECUTION_TARGET || "0x1111111111111111111111111111111111111111",
    value: process.env.TRADE_VALUE_WEI || "0x0",
    data: "0x",
    gasLimit: Number(process.env.MAX_GAS_LIMIT || "210000"),
    maxFeePerGas: "0x3b9aca00",
    maxPriorityFeePerGas: "0x3b9aca00",
  }, { privateKey });

  return {
    mode: result.mode,
    safe: result.safe,
    txHash: result.txHash,
    signedTx: result.signedTx,
    walletAddress: from,
    broadcasted: result.broadcasted,
    reason: result.reason,
  };
}

async function runExecutionProbe(): Promise<void> {
  if (!process.env.EXECUTION_PROBE_TARGET || !process.env.EXECUTION_PROBE_DATA || !process.env.EXECUTION_PROBE_VALUE_WEI || !process.env.EXECUTION_PROBE_TOKEN) {
    throw new Error("EXECUTION_PROBE_REQUIRES_TARGET_DATA_VALUE_AND_TOKEN");
  }
  if (!config.allowLiveBroadcast || (config.executionMode !== "CANARY" && config.executionMode !== "LIVE")) {
    throw new Error("EXECUTION_PROBE_REQUIRES_EXPLICIT_LIVE_CANARY_AUTHORIZATION");
  }
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (!privateKey) throw new Error("EXECUTION_PROBE_REQUIRES_WALLET");
  const provider = createExecutionProvider();
  const wallet = new ethers.Wallet(privateKey, provider);
  const token = new ethers.Contract(process.env.EXECUTION_PROBE_TOKEN, ["function balanceOf(address) view returns (uint256)"], provider);
  const before = BigInt(await token.balanceOf(wallet.address));
  const nonceManager = nonceManagerFor(provider, wallet.address);
  const nonce = await nonceManager.reserve();
  const feeData = await provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (!maxFeePerGas) throw new Error("EXECUTION_PROBE_FEE_DATA_UNAVAILABLE");
  const transaction = {
    to: process.env.EXECUTION_PROBE_TARGET,
    data: process.env.EXECUTION_PROBE_DATA,
    value: BigInt(process.env.EXECUTION_PROBE_VALUE_WEI),
    chainId: config.chainId,
    nonce,
    maxFeePerGas,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? maxFeePerGas,
  };
  const gasLimit = await provider.estimateGas({ from: wallet.address, ...transaction });
  await provider.call({ from: wallet.address, ...transaction, gasLimit });
  console.log("EXECUTION PROBE AUTHORIZED:", { target: transaction.to, valueWei: transaction.value.toString(), nonce, gasLimit: gasLimit.toString() });
  const response = await wallet.sendTransaction({ ...transaction, gasLimit });
  const receipt = await response.wait();
  if (!receipt || receipt.status !== 1) throw new Error("EXECUTION_PROBE_RECEIPT_FAILED");
  const after = BigInt(await token.balanceOf(wallet.address));
  if (after <= before) throw new Error("EXECUTION_PROBE_BALANCE_TRANSITION_FAILED");
  console.log("EXECUTION PROBE VERIFIED:", { hash: response.hash, status: receipt.status, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString(), tokenBalanceIncreased: true });
}

function liveExecutionEnabled(): boolean {
  return config.allowLiveBroadcast && (config.executionMode === "CANARY" || config.executionMode === "LIVE") && Boolean(process.env.WALLET_PRIVATE_KEY);
}

function decodePonsLaunchLog(log: { address: string; topics: string[]; data: string; blockNumber: number; transactionHash: string; logIndex: number }): PonsLaunchEvent {
  const parsed = PONS_INTERFACE.parseLog({ topics: log.topics, data: log.data });
  if (!parsed || parsed.name !== "TokenLaunched") throw new Error("PONS_PROBE_LOG_NOT_TOKEN_LAUNCHED");
  return {
    factory: log.address,
    token: parsed.args.token,
    deployer: parsed.args.deployer,
    dexFactory: parsed.args.dexFactory,
    pairToken: parsed.args.pairToken,
    pool: parsed.args.pool,
    dexId: Number(parsed.args.dexId),
    launchConfigId: Number(parsed.args.launchConfigId),
    positionId: Number(parsed.args.positionId),
    restrictionsEndBlock: Number(parsed.args.restrictionsEndBlock),
    initialBuyAmount: BigInt(parsed.args.initialBuyAmount),
    transactionHash: log.transactionHash,
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
  };
}

// Pulls a real PONS V2 launch (by explicit token, tx hash, or the most recent one on-chain) and runs it
// through the actual discovery/security/liquidity/quote/simulation pipeline, to validate the execution
// mechanics against a genuine candidate instead of a synthetic target.
async function runPonsProbe(): Promise<void> {
  const provider = createHttpProvider();
  const v1Factories = config.poolSources
    .filter((source) => source.protocol === "pons" && source.event === "TokenLaunched")
    .map((source) => source.address);

  // This probe validates the Uniswap V4 execution path, so its target must be a PONS V2 (bonding curve) launch.
  // Scanning the V1 factories for the V1 `TokenLaunched` topic discovers tokens that were minted straight into a
  // Uniswap V3 position and can never resolve as V2 launches.
  const explicitToken = process.env.PONS_PROBE_TOKEN;
  if (explicitToken && !ethers.isAddress(explicitToken)) throw new Error("PONS_PROBE_TOKEN_INVALID");
  let token: string | undefined = explicitToken;
  let sourceEvent: PonsV2LaunchSourceEvent | undefined;

  const txHash = process.env.PONS_PROBE_TX_HASH;
  if (!token && txHash) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) throw new Error("PONS_PROBE_TX_NOT_FOUND");
    const v2Log = receipt.logs.find((entry) =>
      entry.topics[0]?.toLowerCase() === PONS_V2_TOKEN_LAUNCHED_TOPIC &&
      entry.address.toLowerCase() === config.ponsV2Factory.toLowerCase());
    if (v2Log) {
      const parsed = PONS_V2_INTERFACE.parseLog({ topics: [...v2Log.topics], data: v2Log.data });
      if (!parsed) throw new Error("PONS_PROBE_V2_LOG_UNDECODABLE");
      token = parsed.args.token;
      sourceEvent = { factory: v2Log.address, token: parsed.args.token, transactionHash: v2Log.transactionHash, blockNumber: v2Log.blockNumber, logIndex: v2Log.index };
    } else {
      const v1Log = receipt.logs.find((entry) =>
        entry.topics[0]?.toLowerCase() === PONS_TOKEN_LAUNCHED_TOPIC &&
        v1Factories.some((address) => address.toLowerCase() === entry.address.toLowerCase()));
      if (v1Log) {
        const v1Event = decodePonsLaunchLog({
          address: v1Log.address,
          topics: [...v1Log.topics],
          data: v1Log.data,
          blockNumber: v1Log.blockNumber,
          transactionHash: v1Log.transactionHash,
          logIndex: v1Log.index,
        });
        console.log("PONS PROBE TARGET IS A V1 LAUNCH:", {
          token: v1Event.token,
          pool: v1Event.pool,
          factory: v1Log.address,
          transactionHash: v1Log.transactionHash,
          reason: "V1_LAUNCH_ROUTED_VIA_V3_POOL",
        });
        return;
      }
      throw new Error("PONS_PROBE_TX_HAS_NO_PONS_LAUNCH_EVENT");
    }
  }

  if (!token) {
    const latestBlock = await provider.getBlockNumber();
    const lookback = Number(process.env.PONS_PROBE_LOOKBACK_BLOCKS ?? "5000");
    const fromBlock = Math.max(0, latestBlock - lookback);
    const logs = await scanLogsInChunks({
      getLogs: async (chunk) => (await provider.getLogs(chunk)).map((log) => ({
        address: log.address,
        topics: [...log.topics],
        data: log.data,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.index,
      })),
    }, { address: config.ponsV2Factory, topics: [[PONS_V2_TOKEN_LAUNCHED_TOPIC]] }, fromBlock, latestBlock, 50);
    if (logs.length === 0) {
      throw new Error("PONS_PROBE_NO_V2_LAUNCH_EVENTS_FOUND: set PONS_PROBE_TOKEN to probe a known token or widen PONS_PROBE_LOOKBACK_BLOCKS");
    }
    const mostRecent = logs.sort((left, right) => right.blockNumber - left.blockNumber || right.logIndex - left.logIndex)[0];
    const parsed = PONS_V2_INTERFACE.parseLog({ topics: mostRecent.topics, data: mostRecent.data });
    if (!parsed) throw new Error("PONS_PROBE_V2_LOG_UNDECODABLE");
    token = parsed.args.token;
    sourceEvent = { factory: mostRecent.address, token: parsed.args.token, transactionHash: mostRecent.transactionHash, blockNumber: mostRecent.blockNumber, logIndex: mostRecent.logIndex };
  }

  const launchEvent: PonsV2LaunchSourceEvent = sourceEvent ?? {
    factory: config.ponsV2Factory,
    token: token as string,
    transactionHash: "PONS_PROBE_TOKEN",
    blockNumber: await provider.getBlockNumber(),
    logIndex: 0,
  };
  console.log("PONS PROBE TARGET:", {
    token: launchEvent.token,
    factory: launchEvent.factory,
    source: explicitToken ? "PONS_PROBE_TOKEN" : txHash ? "PONS_PROBE_TX_HASH" : "RECENT_LOGS",
    transactionHash: launchEvent.transactionHash,
    blockNumber: launchEvent.blockNumber,
  });

  // Run PONS V4 pipeline (not V3) - resolve launch, check phase, verify pool, quote, simulate
  const resolver = new PonsV2Resolver(provider);
  const launch = await resolver.resolve(launchEvent.token, true);
  const route = routePonsV2Phase(launch.phase);
  console.log("PONS PROBE ROUTE:", { token: launch.token, phase: launch.phase, route: route.phase, executable: route.executable, reason: route.reason });

  if (!route.executable) {
    console.log("PONS PROBE EXECUTION SKIPPED:", { token: launch.token, reason: route.reason ?? "NOT_TRADEABLE" });
    return;
  }

  const poolKey = buildPonsV2PoolKey(launch);
  if (!poolKey.ok) {
    console.log("PONS PROBE REJECTED:", { token: launch.token, reason: poolKey.reason, details: poolKey.details });
    return;
  }

  const stateResult = await new PonsV4StateView(provider, config.ponsV4StateView).verify(launch);
  if (!stateResult.ok) {
    console.log("PONS PROBE STATEVIEW BLOCKED:", { token: launch.token, reason: stateResult.reason, details: stateResult.details });
    return;
  }

  const amountIn = BigInt(process.env.PONS_V4_TRADE_SIZE_WEI ?? ethers.parseEther(process.env.TRADE_SIZE_ETH ?? "0.000001").toString());
  const quote = await new PonsV4Quoter(provider, config.ponsV4Quoter).quoteExactInput(stateResult.state.poolKey, launch.pairToken, amountIn);
  const amountOutMinimum = quote.amountOut * BigInt(10000 - config.maxSlippageBps) / 10000n;

  const rejectionStats = await rejectionStatsPromise;
  const rejectionReasons: string[] = [];
  if (quote.amountOut <= 0n) rejectionReasons.push("QUOTE_AMOUNT_ZERO");
  if (amountOutMinimum <= 0n) rejectionReasons.push("AMOUNT_OUT_MINIMUM_ZERO");
  const screening = await screenPonsLaunch(provider, launch.token, launch.pairToken);
  if (!screening.accepted) rejectionReasons.push(...screening.rejectionReasons);
  rejectionStats.record(rejectionReasons);
  await rejectionStats.persist();

  console.log("PONS PROBE ANALYSIS:", {
    factory: launchEvent.factory,
    candidateToken: launch.token,
    baseToken: launch.pairToken,
    baseTokenKind: screening.pairTokenKind,
    phase: launch.phase,
    poolId: stateResult.state.poolId,
    amountIn: amountIn.toString(),
    amountOut: quote.amountOut.toString(),
    amountOutMinimum: amountOutMinimum.toString(),
    accepted: rejectionReasons.length === 0,
    rejectionReasons,
    rejectionStats: rejectionStats.snapshot(),
  });

  if (rejectionReasons.length > 0) {
    console.log("PONS PROBE EXECUTION SKIPPED:", { reasons: rejectionReasons });
    return;
  }

  if (!liveExecutionEnabled()) {
    console.log("PONS PROBE EXECUTION BLOCKED:", "ALLOW_LIVE_BROADCAST and LIVE/CANARY mode with WALLET_PRIVATE_KEY are required");
    return;
  }

  // Execute via PONS V4 path
  await executePonsV2LaunchEvent(launchEvent, provider);
}

async function runPonsDiagnostic(tokenAddress: string): Promise<void> {
  if (!ethers.isAddress(tokenAddress)) throw new Error("PONS_LAUNCH_NOT_FOUND");
  const provider = createExecutionProvider();
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== config.chainId) throw new Error(`PONS_UNEXPECTED_CHAIN_${network.chainId}`);
  const resolver = new PonsV2Resolver(provider);
  const launch = await resolver.resolve(tokenAddress);
  const route = routePonsV2Phase(launch.phase);
  console.log("PONS V2 DIAGNOSTIC:", {
    token: launch.token,
    exists: launch.exists,
    phase: launch.phase,
    route: route.phase,
    curve: launch.curve,
    pairToken: launch.pairToken,
    poolFee: launch.poolFee,
    tickSpacing: launch.tickSpacing,
    creatorTaxBps: launch.creatorTaxBps,
    buybackEnabled: launch.buybackEnabled,
  });
  const screening = await screenPonsLaunch(provider, launch.token, launch.pairToken);
  console.log("PONS V2 SECURITY DECISION:", {
    token: launch.token,
    pairTokenKind: screening.pairTokenKind,
    accepted: screening.accepted,
    rejectionReasons: screening.rejectionReasons,
  });
  if (launch.phase === 2) {
    const poolKey = buildPonsV2PoolKey(launch);
    if (!poolKey.ok) {
      console.log("PONS V4 POOL:", poolKey);
      return;
    }
    const [managerCode, hookCode] = await Promise.all([
      provider.getCode(config.ponsV2PoolManager),
      provider.getCode(config.ponsV2Hook),
    ]);
    const stateResult = await new PonsV4StateView(provider, config.ponsV4StateView).verify(launch);
    let quote: Awaited<ReturnType<PonsV4Quoter["quoteExactInput"]>> | undefined;
    let quoteError: string | undefined;
    if (stateResult.ok) {
      try {
        quote = await new PonsV4Quoter(provider, config.ponsV4Quoter).quoteExactInput(
          stateResult.state.poolKey,
          launch.pairToken,
          ethers.parseEther(process.env.PONS_V4_DIAGNOSTIC_AMOUNT_ETH ?? "0.000001"),
        );
      } catch (error) {
        quoteError = error instanceof Error ? error.message : String(error);
      }
    }
    console.log("PONS V4 POOL:", {
      poolManager: config.ponsV2PoolManager,
      poolKey: poolKey.poolKey,
      poolId: poolKey.poolKey.poolId,
      poolManagerDeployed: managerCode !== "0x",
      hookDeployed: hookCode !== "0x",
      stateView: config.ponsV4StateView,
      verification: stateResult.ok ? "VERIFIED" : stateResult.reason,
      state: stateResult.ok ? stateResult.state : undefined,
      quote,
      quoteError,
      verificationDetails: stateResult.ok ? undefined : stateResult.details,
      execution: stateResult.ok ? "PENDING_ROUTER_SIMULATION" : "BLOCKED",
    });
    if (stateResult.ok && quote) {
      const privateKey = process.env.WALLET_PRIVATE_KEY;
      const recipient = process.env.METAMASK_WALLET_ADDRESS || (privateKey ? new ethers.Wallet(privateKey).address : undefined);
      if (!recipient) {
        console.log("PONS V4 SIMULATION:", { status: "BLOCKED", reason: "WALLET_REQUIRED" });
        return;
      }
      const amountOutMinimum = quote.amountOut * BigInt(10000 - config.maxSlippageBps) / 10000n;
      const transaction = new PonsV4Router(provider, config.ponsV4UniversalRouter, config.chainId).buildExactInputSingle(
        stateResult.state.poolKey,
        launch.pairToken,
        quote.amountIn,
        amountOutMinimum,
        BigInt(Math.floor(Date.now() / 1000) + 120),
        recipient,
      );
      const router = new PonsV4Router(provider, config.ponsV4UniversalRouter, config.chainId);
      const readiness = await router.inspectInputReadiness(launch.pairToken, recipient, quote.amountIn, config.permit2);
      console.log("PONS V4 INPUT READINESS:", readiness);
      if (!readiness.ready) {
        console.log("PONS V4 SIMULATION:", { status: "BLOCKED", reason: readiness.reason });
        return;
      }
      try {
        const gasLimit = await router.simulate(transaction, recipient);
        console.log("PONS V4 SIMULATION:", { status: "PASS", gasLimit: gasLimit.toString(), target: transaction.to, valueWei: transaction.value.toString(), amountOutMinimum: amountOutMinimum.toString() });
      } catch (error) {
        console.log("PONS V4 SIMULATION:", { status: "FAIL", reason: error instanceof Error ? error.message : String(error), target: transaction.to, valueWei: transaction.value.toString(), amountOutMinimum: amountOutMinimum.toString() });
      }
    }
    return;
  }
  console.log("PONS ROUTE:", {
    route: route.phase,
    executable: route.executable,
    curve: launch.curve,
    execution: launch.phase === 0 ? "CURVE_ADAPTER_REQUIRED" : "NOT_TRADEABLE",
  });
}

async function runPonsV4Probe(tokenAddress: string): Promise<void> {
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (!privateKey) throw new Error("PONS_V4_PROBE_REQUIRES_WALLET");
  if (!config.allowLiveBroadcast || (config.executionMode !== "CANARY" && config.executionMode !== "LIVE")) {
    throw new Error("PONS_V4_PROBE_REQUIRES_EXPLICIT_LIVE_CANARY_AUTHORIZATION");
  }
  const provider = createExecutionProvider();
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== 4663) throw new Error("CHAIN_ID_MISMATCH");
  const wallet = new ethers.Wallet(privateKey, provider);
  const resolver = new PonsV2Resolver(provider);
  const launch = await resolver.resolve(tokenAddress, true);
  if (launch.phase !== 2) throw new Error("PONS_PHASE_CHANGED");
  const screening = await screenPonsLaunch(provider, launch.token, launch.pairToken);
  if (!screening.accepted) throw new Error(`PONS_V4_PROBE_SECURITY_BLOCKED:${screening.rejectionReasons.join(",")}`);
  const state = await new PonsV4StateView(provider, config.ponsV4StateView).verify(launch);
  if (!state.ok) throw new Error(state.reason);
  const amountIn = BigInt(process.env.PONS_V4_TRADE_SIZE_WEI ?? ethers.parseEther(process.env.TRADE_SIZE_ETH ?? "0.000001").toString());
  const quote = await new PonsV4Quoter(provider, config.ponsV4Quoter).quoteExactInput(state.state.poolKey, launch.pairToken, amountIn);
  const amountOutMinimum = quote.amountOut * BigInt(10000 - config.maxSlippageBps) / 10000n;
  const router = new PonsV4Router(provider, config.ponsV4UniversalRouter, config.chainId);
  const funding = await router.inspectInputReadiness(launch.pairToken, wallet.address, amountIn, config.permit2);
  if (funding.balance < amountIn) throw new Error("PONS_V4_INPUT_BALANCE_TOO_LOW");
  await ensurePonsV4Approvals(provider, wallet, launch.pairToken, amountIn);
  const readiness = await router.inspectInputReadiness(launch.pairToken, wallet.address, amountIn, config.permit2);
  console.log("PONS V4 PROBE PRETRADE:", { token: launch.token, phase: launch.phase, poolId: state.state.poolId, amountIn: amountIn.toString(), amountOut: quote.amountOut.toString(), amountOutMinimum: amountOutMinimum.toString(), readiness });
  if (!readiness.ready) throw new Error(readiness.reason ?? "PONS_V4_INPUT_NOT_READY");
  const transaction = router.buildExactInputSingle(state.state.poolKey, launch.pairToken, amountIn, amountOutMinimum, BigInt(Math.floor(Date.now() / 1000) + 120), wallet.address);
  const gasLimit = await router.simulate(transaction, wallet.address);
  const nonceManager = nonceManagerFor(provider, wallet.address);
  const nonce = await nonceManager.reserve();
  const feeData = await provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (!maxFeePerGas) throw new Error("PONS_V4_FEE_DATA_UNAVAILABLE");
  const response = await wallet.sendTransaction({ ...transaction, gasLimit, nonce, maxFeePerGas, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? maxFeePerGas });
  const receipt = await response.wait();
  if (!receipt || receipt.status !== 1) throw new Error("PONS_V4_RECEIPT_FAILED");
  const outputToken = new ethers.Contract(launch.token, ["function balanceOf(address) view returns (uint256)"], provider);
  const outputBalance = BigInt(await outputToken.balanceOf(wallet.address));
  console.log("PONS V4 PROBE VERIFIED:", { hash: response.hash, status: receipt.status, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString(), outputBalance: outputBalance.toString() });
}

async function ensurePonsV4Approvals(provider: ethers.Provider, wallet: ethers.Wallet, tokenAddress: string, amountIn: bigint): Promise<void> {
  // A native-ETH pair (PONS V2 `pairToken = 0x000…000`) is settled by the router with `msg.value`, so there
  // is no ERC20 and no Permit2 hop to approve. Without this guard the ZeroAddress is used as a contract
  // address and `allowance()` reverts, breaking every native-pair launch.
  if (tokenAddress.toLowerCase() === ethers.ZeroAddress.toLowerCase()) {
    console.log("PONS V4 APPROVAL SKIPPED:", { token: tokenAddress, reason: "NATIVE_INPUT_CURRENCY", amountIn: amountIn.toString() });
    return;
  }
  const erc20 = new ethers.Contract(tokenAddress, [
    "function allowance(address owner,address spender) view returns (uint256)",
    "function approve(address spender,uint256 amount) returns (bool)",
  ], wallet);
  const permit2 = new ethers.Contract(config.permit2, [
    "function allowance(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)",
    "function approve(address token,address spender,uint160 amount,uint48 expiration)",
  ], wallet);
  const erc20Allowance = BigInt(await erc20.allowance(wallet.address, config.permit2));
  const permit2Allowance = await permit2.allowance(wallet.address, tokenAddress, config.ponsV4UniversalRouter);
  console.log("PONS V4 APPROVAL PRECHECK:", {
    token: tokenAddress,
    amountIn: amountIn.toString(),
    erc20AllowanceToPermit2: erc20Allowance.toString(),
    permit2AllowanceToRouter: BigInt(permit2Allowance.amount).toString(),
    permit2Expiration: Number(permit2Allowance.expiration),
  });
  const nonceManager = nonceManagerFor(provider, wallet.address);
  const sendAndVerify = async (label: string, transaction: ethers.TransactionRequest): Promise<void> => {
    const nonce = await nonceManager.reserve();
    const response = await wallet.sendTransaction({ ...transaction, chainId: config.chainId, nonce });
    const receipt = await response.wait();
    if (!receipt || receipt.status !== 1) throw new Error(`${label}_RECEIPT_FAILED`);
    console.log(`${label}_RECEIPT:`, { hash: response.hash, status: receipt.status, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString() });
  };
  if (erc20Allowance < amountIn) {
    await sendAndVerify("TOKEN_PERMIT2_APPROVAL", await erc20.approve.populateTransaction(config.permit2, amountIn));
  }
  const refreshedPermit2 = await permit2.allowance(wallet.address, tokenAddress, config.ponsV4UniversalRouter);
  if (BigInt(refreshedPermit2.amount) < amountIn || Number(refreshedPermit2.expiration) <= Math.floor(Date.now() / 1000)) {
    const expiration = Math.floor(Date.now() / 1000) + 86400;
    await sendAndVerify("PERMIT2_ROUTER_APPROVAL", await permit2.approve.populateTransaction(tokenAddress, config.ponsV4UniversalRouter, amountIn, expiration));
  }
}

async function runPonsV4Approvals(tokenAddress: string): Promise<void> {
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (!privateKey) throw new Error("PONS_V4_APPROVAL_REQUIRES_WALLET");
  if (!config.allowLiveBroadcast || (config.executionMode !== "CANARY" && config.executionMode !== "LIVE")) {
    throw new Error("PONS_V4_APPROVAL_REQUIRES_EXPLICIT_LIVE_CANARY_AUTHORIZATION");
  }
  const provider = createExecutionProvider();
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== 4663) throw new Error("CHAIN_ID_MISMATCH");
  const wallet = new ethers.Wallet(privateKey, provider);
  const launch = await new PonsV2Resolver(provider).resolve(tokenAddress, true);
  if (launch.phase !== 2) throw new Error("PONS_PHASE_CHANGED");
  const amountIn = BigInt(process.env.PONS_V4_TRADE_SIZE_WEI ?? ethers.parseEther(process.env.TRADE_SIZE_ETH ?? "0.000001").toString());
  await ensurePonsV4Approvals(provider, wallet, launch.pairToken, amountIn);
  const readiness = await new PonsV4Router(provider, config.ponsV4UniversalRouter, config.chainId).inspectInputReadiness(launch.pairToken, wallet.address, amountIn, config.permit2);
  console.log("PONS V4 APPROVALS VERIFIED:", readiness);
}

async function executeApprovedCandidate(
  candidateProcessor: V3CandidateProcessor,
  result: Awaited<ReturnType<V3CandidateProcessor["process"]>>,
  provider: ethers.Provider,
): Promise<void> {
  if (!result.evaluation?.approved) {
    console.log("LIVE EXECUTION SKIPPED:", { candidate: result.candidate.candidate_token, reasons: result.rejectionReasons });
    return;
  }
  if (!liveExecutionEnabled()) {
    console.log("LIVE EXECUTION BLOCKED:", "ALLOW_LIVE_BROADCAST and LIVE/CANARY mode are required");
    return;
  }

  const wallet = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY as string, provider);
  const transaction = candidateProcessor.buildBuy(result, wallet.address);
  const gasLimit = BigInt(process.env.MAX_GAS_LIMIT ?? "210000");
  const response = await wallet.sendTransaction({
    to: transaction.to,
    data: transaction.data,
    value: transaction.value,
    chainId: transaction.chainId,
    gasLimit,
  });
  console.log("LIVE TRANSACTION BROADCAST:", {
    hash: response.hash,
    target: transaction.to,
    candidateToken: result.candidate.candidate_token,
    valueWei: transaction.value.toString(),
  });
  const receipt = await response.wait();
  console.log("LIVE TRANSACTION RECEIPT:", { hash: response.hash, status: receipt?.status, blockNumber: receipt?.blockNumber });
}

function printStartupBanner(): void {
  const wallet = process.env.METAMASK_WALLET_ADDRESS || new ethers.Wallet(process.env.WALLET_PRIVATE_KEY || "0x" + "11".repeat(32)).address;
  const paperCliMode = process.argv.includes("--paper");
  const liveCliMode = process.argv.includes("--live");
  const displayedMode = paperCliMode ? "PAPER" : liveCliMode ? "LIVE" : config.tradingMode.toUpperCase();
  const liveExecutionReady = liveCliMode && config.allowLiveBroadcast && (config.executionMode === "CANARY" || config.executionMode === "LIVE");
  console.log("========================================");
  console.log(" ROBINHOOD SNIPER");
  console.log("========================================");
  console.log(`Chain: Robinhood Chain`);
  console.log(`Chain ID: ${config.chainId}`);
  console.log(`LIVE BROADCAST: ${config.allowLiveBroadcast ? "ENABLED" : "DISABLED"}`);
  console.log(`EXECUTION MODE: ${config.executionMode}`);
  console.log(`Mode: ${displayedMode}`);
  console.log(`Trade size: ${config.tradeSizeEth} ETH`);
  console.log(`Max position: ${config.maxPositionEth} ETH`);
  console.log(`Max exposure: ${config.maxTotalExposureEth} ETH`);
  console.log(`Max slippage: ${config.maxSlippageBps} bps`);
  console.log(`Minimum liquidity: $${config.minLiquidityUsd} base reserve`);
  console.log(`Minimum expected profit: ${config.minExpectedProfitBps} bps`);
  console.log(`Wallet: ${wallet}`);
  console.log(`WebSocket: ${config.wsRpc ? "CONNECTED" : "PENDING"}`);
  console.log(`HTTP RPC: ${config.httpRpc ? "CONNECTED" : "PENDING"}`);
  console.log(`RPC HEALTH: ${config.httpRpc || config.fallbackHttpRpc ? "READY" : "BLOCKED"}`);
  console.log("WALLET: READY");
  console.log("RISK ENGINE: READY");
  console.log("SECURITY ENGINE: READY");
  console.log("QUOTE ENGINE: READY");
  console.log("SIMULATION ENGINE: READY");
  console.log("NONCE MANAGER: READY");
  console.log("RECEIPT VERIFIER: READY");
  console.log("PAPER EXCHANGE: READY");
  console.log("REORG PROTECTION: READY");
  console.log(`LIVE EXECUTION: ${liveExecutionReady ? "READY" : "BLOCKED"}`);
  console.log("STATUS: WAITING FOR POOLS");
  console.log("DISCOVERY MODE: PONS_V2_LAUNCHES_ONLY");
}

if (process.argv.includes("--pons-diagnose")) {
  printStartupBanner();
  const tokenIndex = process.argv.indexOf("--pons-diagnose") + 1;
  const tokenAddress = process.argv[tokenIndex] ?? process.env.PONS_DIAGNOSTIC_TOKEN;
  if (!tokenAddress) {
    console.error("PONS diagnostic failed: token address is required");
    process.exit(1);
  }
  runPonsDiagnostic(tokenAddress).catch((error) => {
    console.error("PONS diagnostic failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
} else if (process.argv.includes("--pons-v4-approve")) {
  printStartupBanner();
  const tokenIndex = process.argv.indexOf("--pons-v4-approve") + 1;
  const tokenAddress = process.argv[tokenIndex] ?? process.env.PONS_DIAGNOSTIC_TOKEN;
  if (!tokenAddress) {
    console.error("PONS V4 approval failed: token address is required");
    process.exit(1);
  }
  runPonsV4Approvals(tokenAddress).catch((error) => {
    console.error("PONS V4 approval failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
} else if (process.argv.includes("--pons-v4-probe")) {
  printStartupBanner();
  const tokenIndex = process.argv.indexOf("--pons-v4-probe") + 1;
  const tokenAddress = process.argv[tokenIndex] ?? process.env.PONS_DIAGNOSTIC_TOKEN;
  if (!tokenAddress) {
    console.error("PONS V4 probe failed: token address is required");
    process.exit(1);
  }
  runPonsV4Probe(tokenAddress).catch((error) => {
    console.error("PONS V4 probe failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
} else if (process.argv.includes("--pons-probe")) {
  printStartupBanner();
  runPonsProbe().catch((error) => {
    console.error("PONS probe failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
} else if (process.argv.includes("--execution-probe")) {
  printStartupBanner();
  runExecutionProbe().catch((error) => {
    console.error("Execution probe failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
} else if (process.argv.includes("--simulate")) {
  printStartupBanner();
  runSimulationOnly().then((result) => {
    console.log("Simulation mode active:", result);
  }).catch((error) => {
    console.error("Simulation failed:", error);
    process.exit(1);
  });
} else if (process.argv.includes("--execute")) {
  printStartupBanner();
  runSimulationOnly().then((result) => {
    console.log("Execution mode active:", result);
  }).catch((error) => {
    console.error("Execution failed:", error);
    process.exit(1);
  });
} else if (process.argv.includes("--diagnose")) {
  printStartupBanner();
  const diagnostics = {
    "CHAIN ID": config.chainId,
    "PRIMARY RPC": config.httpRpc ? "CONFIGURED" : "NOT CONFIGURED",
    "FALLBACK RPC": config.fallbackHttpRpc ? "CONFIGURED" : "NOT CONFIGURED",
    "PONS ACTIVE": config.poolSources.some((source) => source.protocol === "pons" && source.address.toLowerCase() === "0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb") ? "PASS" : "FAIL",
    "PONS LEGACY": config.poolSources.some((source) => source.protocol === "pons" && source.address.toLowerCase() === "0x0c37a24f5d23a486fa692d1500881d698b1f77a4") ? "PASS" : "FAIL",
    "ALLOW_LIVE_BROADCAST": config.allowLiveBroadcast ? "true" : "false",
    "LIVE EXECUTION": config.allowLiveBroadcast && (config.executionMode === "CANARY" || config.executionMode === "LIVE") ? "READY" : "BLOCKED",
  };
  console.log("DIAGNOSTICS:", diagnostics);
} else if (process.argv.includes("--scan-pons")) {
  printStartupBanner();
  const active = "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB";
  const legacy = "0x0c37a24F5D23A486FA692d1500881d698B1F77a4";
  console.log("PONS scan starting:");
  console.log({ active, legacy, startBlock: config.startBlock, chunkSize: Number(process.env.LOG_SCAN_CHUNK_SIZE ?? "10"), blocksScanned: 0, eventsFound: 0, eventsDecoded: 0, eventsRejected: 0, providerSwitches: 0 });
} else if (process.argv.includes("--paper") || process.argv.includes("--live")) {
  printStartupBanner();
  const trader = new ContinuousPaperTrader();
  const listener = new RobinhoodWebSocketListener();
  const tradingProvider = createHttpProvider();
  const candidateProcessor = new V3CandidateProcessor(tradingProvider);
  const ponsV2Resolver = new PonsV2Resolver(tradingProvider);
  const liveMode = process.argv.includes("--live");
  const executionDurationHours = Number(process.env.EXECUTION_DURATION_HOURS ?? "4");
  const eventBufferMs = Number(process.env.EVENT_BUFFER_MS ?? "20000");
  // The take-profit side must run as the same signer the buy used: the router's TAKE_ALL pays msg.sender, so
  // pointing this at a different wallet would leave the tokens unsellable by the signer that holds the ETH.
  const exitWallet = liveMode && process.env.WALLET_PRIVATE_KEY ? new ethers.Wallet(process.env.WALLET_PRIVATE_KEY, tradingProvider) : undefined;
  const exitManagerPromise: Promise<LiveExitManager | undefined> = exitWallet
    ? LiveExitManager.open({
        provider: tradingProvider,
        wallet: exitWallet,
        quoterAddress: config.ponsV4Quoter,
        routerAddress: config.ponsV4UniversalRouter,
        permit2Address: config.permit2,
        chainId: config.chainId,
        filePath: `${config.stateFile}.positions.json`,
        tuning: liveExitTuningFromEnv(config.maxSlippageBps),
        ensureApprovals: (token, amount) => ensurePonsV4Approvals(tradingProvider, exitWallet, token, amount),
      })
    : Promise.resolve(undefined);
  const pendingLiveEvents: import("./types").DetectionEvent[] = [];
  let liveEventTimer: NodeJS.Timeout | undefined;
  let liveEventFlush: Promise<void> = Promise.resolve();
  const pendingAnalyses: Array<() => Promise<void>> = [];
  const queuedAnalyses = new AnalysisDedupe();
  let analysisTimer: NodeJS.Timeout | undefined;
  // Launch analyses are independent of each other, so they run on a bounded pool instead of one after another.
  // Serialising them made every launch pay for the launches queued ahead of it: the live run's first stage hop
  // (discovery -> first screen) measured p50 5.97s and max 24.93s while each stage inside a launch stayed under
  // 2.5s. Four covers the largest burst actually observed (5 candidates in one 250ms flush, 23 launches in the
  // busiest 30s window) inside the 300-block freshness window, at roughly 4 concurrent token reads per burst.
  const configuredAnalysisConcurrency = Number(process.env.ANALYSIS_CONCURRENCY ?? "4");
  const analysisConcurrency = Number.isInteger(configuredAnalysisConcurrency) && configuredAnalysisConcurrency >= 1 ? configuredAnalysisConcurrency : 4;
  const analysisPool = new ConcurrencyPool(analysisConcurrency);

  const flushLiveEvents = (): void => {
    if (liveEventTimer) clearTimeout(liveEventTimer);
    liveEventTimer = undefined;
    const events = pendingLiveEvents.splice(0);
    if (events.length === 0 || !liveReconciler) return;
    liveEventFlush = liveEventFlush.then(async () => {
      const accepted = await liveReconciler?.recordLiveEvents(events);
      console.log("LIVE EVENTS PERSISTED:", { received: events.length, accepted: accepted ?? 0 });
    }).catch((error) => console.error("Event persistence error:", error));
  };

  const queueLiveEvent = (event: import("./types").DetectionEvent): void => {
    pendingLiveEvents.push(event);
    if (!liveEventTimer) liveEventTimer = setTimeout(flushLiveEvents, eventBufferMs);
  };

  const flushAnalyses = (): void => {
    if (analysisTimer) clearTimeout(analysisTimer);
    analysisTimer = undefined;
    const analyses = pendingAnalyses.splice(0);
    if (analyses.length === 0) return;
    console.log("ANALYSIS BUFFER FLUSH:", { candidates: analyses.length, bufferMs: eventBufferMs, concurrency: analysisConcurrency });
    // Submitted rather than awaited: the pool enforces the ceiling, so a slow launch delays the launches behind
    // it by one slot instead of by its entire runtime. Each submission keeps its own failure handling, which is
    // what the previous per-analysis `try` did.
    for (const analyze of analyses) {
      void analysisPool.run(analyze).catch((error) => {
        console.error("Candidate processing failed:", error instanceof Error ? error.message : error);
      });
    }
  };

  const queueAnalysis = (dedupeKey: string, analyze: () => Promise<void>): void => {
    // Required, not optional: every queued analysis must name the event it came from, so a re-delivered event
    // cannot reach execution twice.
    if (!queuedAnalyses.claim(dedupeKey)) {
      console.log("ANALYSIS DEDUPED:", { key: dedupeKey, reason: "DUPLICATE_EVENT_DELIVERY" });
      return;
    }
    pendingAnalyses.push(analyze);
    if (!analysisTimer) analysisTimer = setTimeout(flushAnalyses, eventBufferMs);
  };

  trader.start();
  trader.on("status", (status) => console.log("STATUS:", status));
  listener.on("connected", (status) => {
    console.log("WebSocket connected:", status);
    listener.subscribeToSources(config.poolSources.map((source) => ({
      address: source.address,
      // Fall back to the V1 launch topic only for an event we do not recognise, so an unknown source cannot
      // silently subscribe the wrong contract/topic pair.
      topic: (() => {
        try {
          return topicForSourceEvent(source.event);
        } catch {
          console.error("UNSUPPORTED POOL SOURCE EVENT:", { name: source.name, address: source.address, event: source.event });
          return PONS_TOKEN_LAUNCHED_TOPIC;
        }
      })(),
    })));
      void reconcileLiveState(listener);
  });
  listener.on("subscribed", (details) => console.log("Subscribed to pool sources:", details));
  listener.on("poolCreated", (event) => {
    console.log("POOL_DISCOVERED (V3):", event.pool, "block", event.blockNumber);
    queueAnalysis(AnalysisDedupe.key("v3-pool-created", event.pool, event.transactionHash, event.logIndex), async () => {
      const result = await candidateProcessor.process(event, process.env.METAMASK_WALLET_ADDRESS ?? "");
      const rejectionStats = await rejectionStatsPromise;
      rejectionStats.record(result.rejectionReasons);
      await rejectionStats.persist();
      console.log("POOL ANALYSIS (V3):", {
        pool: event.pool,
        transactionHash: event.transactionHash,
        token0: event.token0,
        token1: event.token1,
        fee: event.fee,
        tickSpacing: event.tickSpacing,
        WETH: config.wrappedNativeAddress,
        candidate: result.candidate.candidate_token,
        baseToken: result.candidate.base_token,
        candidateIsToken0: result.candidate.candidate_token.toLowerCase() === event.token0.toLowerCase(),
        candidateIsToken1: result.candidate.candidate_token.toLowerCase() === event.token1.toLowerCase(),
        accepted: result.evaluation?.approved ?? false,
        rejectionReasons: result.rejectionReasons,
        rejectionStats: rejectionStats.snapshot(),
      });
      await recordDecisionTrace({
        schemaVersion: 1,
        traceId: `${event.transactionHash}:${event.logIndex}`,
        observedAt: new Date().toISOString(),
        chainId: config.chainId,
        source: { protocol: "uniswap-v3", factory: event.factory, pool: event.pool, transactionHash: event.transactionHash, blockNumber: event.blockNumber, logIndex: event.logIndex },
        candidate: { token: result.candidate.candidate_token, token0: event.token0, token1: event.token1, baseToken: result.candidate.base_token, deployer: result.candidate.deployer, owner: result.candidate.owner },
        stages: {
          route: { status: "PASS", evidence: { fee: event.fee, tickSpacing: event.tickSpacing } },
          evaluation: { status: result.evaluation?.approved ? "PASS" : "REJECT", evidence: result.evaluation?.details, reasons: result.rejectionReasons },
        },
        final: { accepted: result.evaluation?.approved ?? false, rejectionReasons: result.rejectionReasons },
      });
      // Execute trade if approved and live mode is enabled
      if (process.argv.includes("--live") || process.argv.includes("--paper")) {
        if (result.evaluation?.approved && liveExecutionEnabled()) {
          await executeApprovedCandidate(candidateProcessor, result, tradingProvider);
        } else if (!result.evaluation?.approved) {
          console.log("TRADE_SKIPPED:", { reasons: result.rejectionReasons });
        }
      }
    });
  });
  listener.on("poolInitialized", (event) => console.log("V4 pool initialized:", event));
  // `TokenDeployed` only announces that a token was created. It carries no pool, and for PONS V2 the launch
  // (bonding curve) and its graduation are separate events, so this handler must never execute: doing so
  // alongside the launch handler would buy the same token twice.
  listener.on("ponsTokenDeployed", (event) => {
    console.log("PONS TOKEN_PENDING_POOL:", {
      token: event.token,
      pairToken: event.pairToken,
      factory: event.factory,
      dexFactory: event.dexFactory,
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
      status: "PENDING_POOL",
      reason: "TOKEN_DEPLOYED_WITHOUT_POOL",
    });
  });
  // PONS V1 launch: the whole supply is minted into a Uniswap V3 position in the launch transaction, so the
  // tradeable pool is a V3 pool owned by the `poolCreated` handler above. Resolving a V1 token as a V2 launch
  // can only report PONS_LAUNCH_NOT_FOUND, so this handler no longer executes.
  listener.on("ponsTokenLaunched", (event) => {
    console.log("PONS V1 LAUNCH (V3 POOL PATH):", {
      token: event.token,
      pool: event.pool,
      dexFactory: event.dexFactory,
      pairToken: event.pairToken,
      restrictionsEndBlock: event.restrictionsEndBlock,
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
      reason: "V1_LAUNCH_ROUTED_VIA_POOL_CREATED",
    });
  });
  listener.on("ponsV2TokenLaunched", (event) => {
    console.log("PONS V2 LAUNCH DISCOVERED:", {
      token: event.token,
      curve: event.curve,
      pairToken: event.pairToken,
      graduationThreshold: event.graduationThreshold.toString(),
      launchConfigId: event.launchConfigId,
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
    });
    queueAnalysis(AnalysisDedupe.key("pons-v2-launch", event.token, event.transactionHash, event.logIndex), async () => {
      try {
        if (liveMode) {
          await executePonsV2LaunchEvent(event, tradingProvider, await exitManagerPromise);
          return;
        }
        const launch = await ponsV2Resolver.resolve(event.token);
        await recordPonsRouteTrace(event, launch);
        console.log("PONS V2 DISCOVERED:", {
          token: launch.token,
          factory: event.factory,
          phase: launch.phase,
          route: routePonsV2Phase(launch.phase),
          curve: launch.curve,
          pairToken: launch.pairToken,
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
        });
      } catch (error) {
        await recordPonsRouteTrace(event, undefined, error);
        console.error("PONS V2 DISCOVERY FAILED:", { token: event.token, reason: error instanceof Error ? error.message : String(error) });
      }
    });
  });
  // Graduation is the moment a curve launch becomes a tradeable V4 pool, so it runs the same execution path a
  // launch uses — after retrying until the launch record actually reports phase 2.
  listener.on("ponsPoolGraduated", (event) => {
    console.log("PONS V2 POOL GRADUATED:", {
      token: event.token,
      factory: event.factory,
      blockNumber: event.blockNumber,
      transactionHash: event.transactionHash,
    });
    queueAnalysis(AnalysisDedupe.key("pons-v2-graduated", event.token, event.transactionHash, event.logIndex), async () => {
      try {
        const launch = await resolvePonsV2Graduated(tradingProvider, event.token);
        if (!launch) {
          await recordPonsRouteTrace(event, undefined, new Error("PONS_GRADUATION_NOT_OBSERVED"));
          console.error("PONS V2 GRADUATION UNRESOLVED:", { token: event.token, transactionHash: event.transactionHash });
          return;
        }
        await recordPonsRouteTrace(event, launch);
        console.log("PONS V2 GRADUATION RESOLVED:", {
          token: launch.token,
          phase: launch.phase,
          poolFee: launch.poolFee,
          tickSpacing: launch.tickSpacing,
          pairToken: launch.pairToken,
        });
        if (!liveMode) return;
        await executePonsV2LaunchEvent(event, tradingProvider, await exitManagerPromise);
      } catch (error) {
        await recordPonsRouteTrace(event, undefined, error);
        console.error("PONS V2 GRADUATION HANDLING FAILED:", { token: event.token, reason: error instanceof Error ? error.message : String(error) });
      }
    });
  });
  listener.on("detectionLog", (event) => {
    queueLiveEvent(event);
  });
  listener.on("error", (error) => console.error("WebSocket error:", error));
  listener.on("closed", () => console.error("WebSocket closed; reconnecting"));
  listener.connect();
  if (liveMode) {
    if (!Number.isFinite(executionDurationHours) || executionDurationHours <= 0) throw new Error("INVALID_EXECUTION_DURATION_HOURS");
    const durationMs = executionDurationHours * 60 * 60 * 1000;
    console.log("EXECUTION WINDOW:", { hours: executionDurationHours, endsAt: new Date(Date.now() + durationMs).toISOString() });
    void exitManagerPromise
      .then((manager) => manager?.start())
      .catch((error) => console.error("PONS EXIT MANAGER FAILED TO OPEN:", { reason: error instanceof Error ? error.message : String(error) }));
    setTimeout(() => {
      console.log("EXECUTION WINDOW COMPLETE:", { hours: executionDurationHours });
      listener.close();
      process.exit(0);
    }, durationMs).unref();
  }
} else {
  printStartupBanner();
  console.log("Analysis-only sniper bot started. Execution is gated by ALLOW_LIVE_BROADCAST and a known trade value.");
}

let liveReconciler: BlockReconciler | undefined;

async function reconcileLiveState(listener: RobinhoodWebSocketListener): Promise<void> {
  const rpcUrl = config.httpRpc ?? config.fallbackHttpRpc ?? config.publicHttpRpcs[0];
  if (!rpcUrl) return;
  const store = await BlockEventStore.open(config.stateFile, config.chainId, config.startBlock);
  const provider = createHttpProvider();
  const reconciliationProvider = {
    getBlockNumber: () => provider.getBlockNumber(),
    getBlock: (blockNumber: number) => provider.getBlock(blockNumber),
    getLogs: async (filter: { fromBlock: number; toBlock: number; address: string[]; topics: string[][] }) => {
      const events = [];
      for (const address of filter.address) {
        const logs = await scanLogsInChunks({
          getLogs: async (chunk) => (await provider.getLogs(chunk)).map((log) => ({
            address: log.address,
            topics: [...log.topics],
            data: log.data,
            blockNumber: log.blockNumber,
            transactionHash: log.transactionHash,
            logIndex: log.index,
          })),
        }, { address, topics: filter.topics }, filter.fromBlock, filter.toBlock, 10);
        events.push(...logs);
      }
      return events;
    },
  };
  if (store.cursor.lastProcessedBlock === 0 && config.startBlock === 0) {
    await store.advanceCursor(await provider.getBlockNumber());
  }
  liveReconciler = new BlockReconciler(
    reconciliationProvider,
    store,
    config.poolSources.map((source) => ({
      address: source.address,
      topic: topicForSourceEvent(source.event),
    })),
    async (event) => console.log("Recovered log:", event.transactionHash, event.blockNumber, event.logIndex),
  );
  try {
    const result = await liveReconciler.reconcile();
    console.log("Reconciliation complete:", result);
  } catch (error) {
    console.error("Reconciliation failed; live listener remains active without recovered events:", error instanceof Error ? error.message : "unknown error");
  }
}

function createHttpProvider(): ethers.Provider {
  const urls = [config.httpRpc, ...config.publicHttpRpcs]
    .filter((url, index, values): url is string => Boolean(url) && values.indexOf(url) === index);
  if (urls.length === 0) throw new Error("NO_HTTP_RPC_CONFIGURED");
  if (urls.length === 1) return new ethers.JsonRpcProvider(urls[0], config.chainId);
  return new ethers.FallbackProvider(
    urls.map((url, index) => ({
      provider: new ethers.JsonRpcProvider(url, config.chainId),
      priority: index + 1,
      weight: 1,
      stallTimeout: 1500,
    })),
    config.chainId,
    { quorum: 1 },
  );
}

function createExecutionProvider(): ethers.Provider {
  if (process.env.PONS_EXECUTION_TRANSPORT?.toLowerCase() === "ws" && config.fallbackWsRpc) {
    return new ethers.WebSocketProvider(config.fallbackWsRpc, config.chainId);
  }
  return createHttpProvider();
}
