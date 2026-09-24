export type TradingMode = "analysis" | "paper" | "live";
export type ExecutionMode = "DISABLED" | "PAPER" | "CANARY" | "LIVE" | "HALTED" | "EMERGENCY";

export interface PoolSource {
  name: string;
  address: string;
  protocol: "uniswap-v3" | "uniswap-v4" | "pons" | "launchpad";
  // `TokenLaunched` is the V1 signature (launch straight into a Uniswap V3 position) and `TokenLaunchedV2` the
  // V2 signature (per-token bonding curve). They share a name but not a topic, so they must stay distinct.
  event: "PoolCreated" | "Initialize" | "TokenDeployed" | "TokenLaunched" | "TokenLaunchedV2" | "PoolGraduated";
}

export interface BotConfig {
  chainId: number;
  wsRpc?: string;
  httpRpc?: string;
  fallbackWsRpc?: string;
  fallbackHttpRpc?: string;
  publicHttpRpcs: string[];
  executionMode: ExecutionMode;
  allowLiveBroadcast: boolean;
  factoryAddress: string;
  quoterV2Address: string;
  swapRouter02Address: string;
  wrappedNativeAddress?: string;
  ponsV2Factory: string;
  ponsV2Hook: string;
  ponsV2PoolManager: string;
  ponsV4PositionManager: string;
  ponsV4Quoter: string;
  ponsV4StateView: string;
  ponsV4UniversalRouter: string;
  permit2: string;
  poolSources: PoolSource[];
  approvedBaseTokens: string[];
  approvedBaseTokenAddresses: Record<string, string>;
  maxRiskScore: number;
  minSecurityScore: number;
  tradingMode: TradingMode;
  tradeSizeEth: number;
  minTradeSizeEth: number;
  maxTradeSizeEth: number;
  maxOpenPositions: number;
  maxTotalExposureEth: number;
  maxPositionEth: number;
  minExpectedProfitEth: number;
  minExpectedProfitPercent: number;
  maxSlippageBps: number;
  maxSellTaxBps: number;
  maxBuyTaxBps: number;
  minLiquidityEth: number;
  minLiquidityUsd: number;
  ponsMaxEntryAgeBlocks: number;
  ponsLaunchMinThresholdPct: number;
  ponsLaunchMaxTollBps: number;
  ponsMaxCreatorHoldingPct: number;
  ponsMaxBundleSupplyPct: number;
  ponsMaxLaunchAllocSharePct: number;
  ponsBundleWindowBlocks: number;
  ponsMaxInsiderSupplyPct: number;
  ponsMaxSameBlockSharePct: number;
  ponsMaxSequentialBlockSharePct: number;
  ponsMaxPeerTransferSharePct: number;
  ponsSimulateSellPath: boolean;
  ponsRejectBurnRisk: boolean;
  ponsRejectLiquidityRisk: boolean;
  ponsRelayAddresses: string[];
  ponsRejectBuybackEnabled: boolean;
  ponsGraduatedMinLiquidityUsd: number;
  ponsGraduatedMinVolumeUsd: number;
  ponsGraduatedVolumeWindowBlocks: number;
  nativeUsdPrice: number;
  minExpectedProfitBps: number;
  maxPriceImpactBps: number;
  maxGasEth: number;
  maxDailyLossEth: number;
  maxConsecutiveFailures: number;
  tradeCooldownMs: number;
  maxAnalysisWorkers: number;
  candidateTtlSeconds: number;
  stateFile: string;
    decisionTraceFile: string;
  startBlock: number;
  maxStaleBlocks: number;
  maxDailyLossLimitReached: boolean;
}

const DEFAULT_APPROVED_BASES = ["ETH", "WETH", "USDC", "USDT"];
const ROBINHOOD_UNISWAP_V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const ROBINHOOD_UNISWAP_V4_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const ROBINHOOD_UNISWAP_V3_QUOTER_V2 = "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7";
const ROBINHOOD_UNISWAP_V3_SWAP_ROUTER_02 = "0xcaf681a66d020601342297493863e78c959e5cb2";
const ROBINHOOD_WRAPPED_NATIVE = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const ROBINHOOD_PONS_ACTIVE_FACTORY = "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB";
const ROBINHOOD_PONS_LEGACY_FACTORY = "0x0c37a24F5D23A486FA692d1500881d698B1F77a4";
const ROBINHOOD_PONS_V2_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const ROBINHOOD_PONS_V2_HOOK = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";
const ROBINHOOD_V4_POSITION_MANAGER = "0x58daec3116aae6d93017baaea7749052e8a04fa7";
const ROBINHOOD_V4_QUOTER = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94";
const ROBINHOOD_V4_STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const ROBINHOOD_V4_UNIVERSAL_ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

function parseNumber(value: string | undefined, fallback: number): number {
  const result = Number(value ?? String(fallback));
  return Number.isFinite(result) ? result : fallback;
}

function buildBlockmachineWsRpc(): string | undefined {
  const configuredUrl = process.env.ROBINHOOD_BLOCKMACHINE_WS_RPC_URL ?? process.env.ROBINHOOD_BLOCKMACHINE_WS_RPC;
  const baseUrl = configuredUrl ?? process.env.ROBINHOOD_BLOCKMACHINE_WS_BASE_URL;
  if (!baseUrl) return undefined;
  return baseUrl;
}

function buildBlockmachineHttpRpc(): string | undefined {
  const configuredUrl = process.env.ROBINHOOD_BLOCKMACHINE_HTTP_RPC_URL;
  if (configuredUrl) return configuredUrl;
  const baseUrl = process.env.ROBINHOOD_BLOCKMACHINE_WS_BASE_URL;
  if (!baseUrl || !process.env.ROBINHOOD_BLOCKMACHINE_API_KEY) return undefined;
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = `/${process.env.ROBINHOOD_BLOCKMACHINE_API_KEY}`;
  url.search = "";
  return url.toString();
}

function buildPublicHttpRpcs(): string[] {
  const configured = (process.env.ROBINHOOD_PUBLIC_HTTP_RPCS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  return [...new Set([
    ...configured,
    "https://rpc.mainnet.chain.robinhood.com",
    "https://robinhood-rpc.publicnode.com",
    "https://rpc.ordofi.network",
  ])];
}

export function loadConfig(): BotConfig {
  const raw = (process.env.APPROVED_BASE_TOKENS ?? DEFAULT_APPROVED_BASES.join(",")).split(",").map((token) => token.trim().toUpperCase()).filter(Boolean);
  const tradingMode = (process.env.TRADING_MODE ?? "paper").toLowerCase() as TradingMode;
  const approvedBaseTokenAddresses: Record<string, string> = {};
  for (const entry of (process.env.APPROVED_BASE_TOKEN_ADDRESSES ?? "").split(",")) {
    const [symbol, address] = entry.trim().split(":");
    if (symbol && address && /^0x[0-9a-fA-F]{40}$/.test(address)) approvedBaseTokenAddresses[symbol.toUpperCase()] = address;
  }
  const activePonsFactory = process.env.PONS_ACTIVE_FACTORY ?? ROBINHOOD_PONS_ACTIVE_FACTORY;
  const legacyPonsFactory = process.env.PONS_LEGACY_FACTORY ?? ROBINHOOD_PONS_LEGACY_FACTORY;
  const ponsV2Factory = process.env.PONS_V2_FACTORY ?? ROBINHOOD_PONS_V2_FACTORY;
  const poolSources: PoolSource[] = [
    {
      name: "Uniswap V3",
      address: process.env.UNISWAP_V3_FACTORY ?? ROBINHOOD_UNISWAP_V3_FACTORY,
      protocol: "uniswap-v3",
      event: "PoolCreated",
    },
    {
      name: "Uniswap V4",
      address: process.env.UNISWAP_V4_POOL_MANAGER ?? ROBINHOOD_UNISWAP_V4_POOL_MANAGER,
      protocol: "uniswap-v4",
      event: "Initialize",
    },
    {
      name: "PONS",
      address: activePonsFactory,
      protocol: "pons",
      event: "TokenDeployed",
    },
    {
      name: "PONS",
      address: activePonsFactory,
      protocol: "pons",
      event: "TokenLaunched",
    },
  ];

  if (legacyPonsFactory && legacyPonsFactory.toLowerCase() !== activePonsFactory.toLowerCase()) {
    poolSources.push({ name: "PONS_LEGACY", address: legacyPonsFactory, protocol: "pons", event: "TokenLaunched" });
  }
  if (![activePonsFactory, legacyPonsFactory].some((address) => address?.toLowerCase() === ponsV2Factory.toLowerCase())) {
    poolSources.push({ name: "PONS_V2", address: ponsV2Factory, protocol: "pons", event: "TokenDeployed" });
    poolSources.push({ name: "PONS_V2", address: ponsV2Factory, protocol: "pons", event: "TokenLaunchedV2" });
    poolSources.push({ name: "PONS_V2", address: ponsV2Factory, protocol: "pons", event: "PoolGraduated" });
  }

  const launchpadSources = (process.env.LAUNCHPAD_SOURCES ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const entry of launchpadSources) {
    const [name, address] = entry.split(":");
    if (name && address && /^0x[0-9a-fA-F]{40}$/.test(address)) {
      poolSources.push({ name, address, protocol: "launchpad", event: "PoolCreated" });
    }
  }

  const executionMode = ((process.env.EXECUTION_MODE ?? process.env.TRADING_MODE ?? "PAPER").toUpperCase() as ExecutionMode);
  const allowLiveBroadcast = (process.env.ALLOW_LIVE_BROADCAST ?? "false").toLowerCase() === "true";
  const configValue: BotConfig = {
    chainId: Number(process.env.ROBINHOOD_CHAIN_ID ?? "4663"),
    wsRpc: process.env.ROBINHOOD_WS_RPC_URL ?? process.env.ROBINHOOD_WS_RPC,
    httpRpc: process.env.ROBINHOOD_HTTP_RPC_URL ?? process.env.ROBINHOOD_HTTP_RPC,
    fallbackWsRpc: buildBlockmachineWsRpc() ?? process.env.ROBINHOOD_FALLBACK_WS_RPC_URL ?? process.env.ROBINHOOD_FALLBACK_WS_RPC,
    fallbackHttpRpc: buildBlockmachineHttpRpc() ?? process.env.ROBINHOOD_FALLBACK_HTTP_RPC_URL ?? process.env.ROBINHOOD_FALLBACK_HTTP_RPC,
    publicHttpRpcs: buildPublicHttpRpcs(),
    executionMode: ["DISABLED", "PAPER", "CANARY", "LIVE", "HALTED", "EMERGENCY"].includes(executionMode) ? executionMode : "PAPER",
    allowLiveBroadcast,
    factoryAddress: process.env.UNISWAP_V3_FACTORY ?? ROBINHOOD_UNISWAP_V3_FACTORY,
    quoterV2Address: process.env.UNISWAP_V3_QUOTER_V2 ?? ROBINHOOD_UNISWAP_V3_QUOTER_V2,
    swapRouter02Address: process.env.UNISWAP_V3_SWAP_ROUTER_02 ?? ROBINHOOD_UNISWAP_V3_SWAP_ROUTER_02,
    wrappedNativeAddress: process.env.ROBINHOOD_WRAPPED_NATIVE ?? ROBINHOOD_WRAPPED_NATIVE,
    ponsV2Factory: process.env.PONS_V2_FACTORY ?? ROBINHOOD_PONS_V2_FACTORY,
    ponsV2Hook: process.env.PONS_V2_HOOK ?? ROBINHOOD_PONS_V2_HOOK,
    ponsV2PoolManager: process.env.UNISWAP_V4_POOL_MANAGER ?? ROBINHOOD_UNISWAP_V4_POOL_MANAGER,
    ponsV4PositionManager: process.env.PONS_V4_POSITION_MANAGER ?? ROBINHOOD_V4_POSITION_MANAGER,
    ponsV4Quoter: process.env.PONS_V4_QUOTER ?? ROBINHOOD_V4_QUOTER,
    ponsV4StateView: process.env.PONS_V4_STATE_VIEW ?? ROBINHOOD_V4_STATE_VIEW,
    ponsV4UniversalRouter: process.env.PONS_V4_UNIVERSAL_ROUTER ?? ROBINHOOD_V4_UNIVERSAL_ROUTER,
    permit2: process.env.PERMIT2 ?? PERMIT2,
    poolSources,
    approvedBaseTokens: raw,
    approvedBaseTokenAddresses,
    maxRiskScore: parseNumber(process.env.MAX_RISK_SCORE, 80),
    minSecurityScore: parseNumber(process.env.MIN_SECURITY_SCORE, 65),
    tradingMode: ["analysis", "paper", "live"].includes(tradingMode) ? tradingMode : "paper",
    tradeSizeEth: parseNumber(process.env.TRADE_SIZE_ETH, 0.01),
    minTradeSizeEth: parseNumber(process.env.MIN_TRADE_SIZE_ETH, 0.001),
    maxTradeSizeEth: parseNumber(process.env.MAX_TRADE_SIZE_ETH, 1),
    maxOpenPositions: parseNumber(process.env.MAX_OPEN_POSITIONS, 3),
    maxTotalExposureEth: parseNumber(process.env.MAX_TOTAL_EXPOSURE_ETH, 0.05),
    maxPositionEth: parseNumber(process.env.MAX_POSITION_ETH, 0.01),
    minExpectedProfitEth: parseNumber(process.env.MIN_EXPECTED_PROFIT_ETH, 0.001),
    minExpectedProfitPercent: parseNumber(process.env.MIN_EXPECTED_PROFIT_PERCENT, 5),
    maxSlippageBps: parseNumber(process.env.MAX_SLIPPAGE_BPS, 100),
    maxSellTaxBps: parseNumber(process.env.MAX_SELL_TAX_BPS, 200),
    maxBuyTaxBps: parseNumber(process.env.MAX_BUY_TAX_BPS, 200),
    minLiquidityEth: parseNumber(process.env.MIN_LIQUIDITY_ETH, 0.05),
    minLiquidityUsd: parseNumber(process.env.MIN_LIQUIDITY_USD, 1000),
    // PONS V2 launch lane. The launch floor is a share of the curve's own `graduationThreshold` because a
    // literal dollar floor cannot be met at t+3s: every curve seeds at exactly 40% of its threshold, so
    // $10,000 of native liquidity *is* the graduation event. The graduated-lane floors below are the literal
    // dollar minimums, and they stay at 0 until the graduated pool's own liquidity and volume are measured.
    ponsMaxEntryAgeBlocks: parseNumber(process.env.PONS_MAX_ENTRY_AGE_BLOCKS, 300),
    ponsLaunchMinThresholdPct: parseNumber(process.env.PONS_LAUNCH_MIN_THRESHOLD_PCT, 30),
    ponsLaunchMaxTollBps: parseNumber(process.env.PONS_LAUNCH_MAX_TOLL_BPS, 1000),
    // A ceiling on the creator's remaining bag, not a floor. Measured over 37 launches: a creator holding
    // >=1% of supply at t+3s preceded a net-drained curve 7 times out of 8, while a creator holding <1%
    // preceded a drain 1 time in 29. The readings only separate if taken at entry - read minutes later the
    // bag is already gone and the signal looks like a constant zero. 0 = off.
    ponsMaxCreatorHoldingPct: parseNumber(process.env.PONS_MAX_CREATOR_HOLDING_PCT, 0),
    // Ceiling on the supply the coordinated early buyers control, measured from the token's own ERC20
    // Transfer history in the first blocks after launch. Bundling itself is normal; a bundle that controls a
    // majority is not. Measured over 52 live launches: 3 crossed 30%, 1 crossed 40%, none crossed 50%. 0 = off.
    ponsMaxBundleSupplyPct: parseNumber(process.env.PONS_MAX_BUNDLE_SUPPLY_PCT, 0),
    // Ceiling on the supply the LAUNCH TRANSACTION ITSELF gave away to addresses outside the curve. Unlike
    // the bundle share this needs no window of buys - it is known the moment the launch block is read, and it
    // comes out of the same `alchemy_getAssetTransfers` call the bundle share already makes. Measured over 52
    // live launches: 42 allocate nothing, 10 allocate 5.79-27.25%, and none of the 24 recipients still held
    // anything when re-read. A 15% ceiling refuses 7 of the 52 and shares only one of them with the bundle
    // ceiling above. 0 = off.
    ponsMaxLaunchAllocSharePct: parseNumber(process.env.PONS_MAX_LAUNCH_ALLOC_PCT, 0),
    ponsBundleWindowBlocks: parseNumber(process.env.PONS_BUNDLE_WINDOW_BLOCKS, 40),
    // The four coordination ceilings below all read the same concentration measurement as the bundle share.
    // Insider share is the literal "do the insiders hold a majority" test and it is a tripwire, not a filter:
    // the curve holds ~99.98% of supply at entry, so the largest insider share measured over 52 launches was
    // 40.4% and a 50% default refuses nothing. It is kept because it becomes live the moment a curve releases
    // more of its supply inside the entry window. Same-block, sequential-block and peer-transfer shares are
    // the discriminating ones - they need no shared sender or a shared block, adjacent blocks fed by
    // different senders, or holders trading with each other, respectively. All default to 0 (off) until the
    // census reports their distributions.
    ponsMaxInsiderSupplyPct: parseNumber(process.env.PONS_MAX_INSIDER_SUPPLY_PCT, 50),
    ponsMaxSameBlockSharePct: parseNumber(process.env.PONS_MAX_SAME_BLOCK_SHARE_PCT, 0),
    ponsMaxSequentialBlockSharePct: parseNumber(process.env.PONS_MAX_SEQUENTIAL_BLOCK_SHARE_PCT, 0),
    ponsMaxPeerTransferSharePct: parseNumber(process.env.PONS_MAX_PEER_TRANSFER_SHARE_PCT, 0),
    // Execute the sell leg against a real holder via eth_call + stateOverride. This is the only honeypot test
    // that cannot be pattern-evaded, but it needs an eth_call the RPC may refuse, so it starts off and is
    // switched on only after the probe reports a measured pass rate.
    ponsSimulateSellPath: (process.env.PONS_SIMULATE_SELL_PATH ?? "false").toLowerCase() === "true",
    // The two contract-risk flags the analyzer has always computed and the screen has always discarded.
    // They are word-and-selector pattern matches over printable runtime bytecode, not proof: "burn" and
    // "removeLiquidity" appear in ordinary revert strings, so a token can trip them without ever being able to
    // burn or pull its own liquidity. They stay off by default and are turned on only after a census shows how
    // much flow they cost; the proof-level exit test is `ponsSimulateSellPath`.
    ponsRejectBurnRisk: (process.env.PONS_REJECT_BURN_RISK ?? "false").toLowerCase() === "true",
    ponsRejectLiquidityRisk: (process.env.PONS_REJECT_LIQUIDITY_RISK ?? "false").toLowerCase() === "true",
    // Private forwarders that sit between a bundle operator and its wallets, so the sender is resolved one
    // hop back to whoever funded the relay inside the same window.
    ponsRelayAddresses: (process.env.PONS_RELAY_ADDRESSES ?? "0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc")
      .split(",")
      .map((address) => address.trim().toLowerCase())
      .filter(Boolean),
    ponsRejectBuybackEnabled: (process.env.PONS_REJECT_BUYBACK_ENABLED ?? "false").toLowerCase() === "true",
    ponsGraduatedMinLiquidityUsd: parseNumber(process.env.PONS_GRADUATED_MIN_LIQUIDITY_USD, 0),
    ponsGraduatedMinVolumeUsd: parseNumber(process.env.PONS_GRADUATED_MIN_VOLUME_USD, 0),
    // Blocks of Uniswap V4 swap history the graduated lane sums for its volume floor. 300 blocks is ~30
    // seconds at this chain's block rate and costs 30 requests because the RPC caps eth_getLogs at 10 blocks.
    ponsGraduatedVolumeWindowBlocks: parseNumber(process.env.PONS_GRADUATED_VOLUME_WINDOW_BLOCKS, 300),
    nativeUsdPrice: parseNumber(process.env.ROBINHOOD_NATIVE_USD_PRICE, 2454.12),
    minExpectedProfitBps: parseNumber(process.env.MIN_EXPECTED_PROFIT_BPS, 50),
    maxPriceImpactBps: parseNumber(process.env.MAX_PRICE_IMPACT_BPS, 200),
    maxGasEth: parseNumber(process.env.MAX_GAS_ETH, 0.005),
    maxDailyLossEth: parseNumber(process.env.MAX_DAILY_LOSS_ETH, 0.02),
    maxConsecutiveFailures: parseNumber(process.env.MAX_CONSECUTIVE_FAILURES, 5),
    tradeCooldownMs: parseNumber(process.env.TRADE_COOLDOWN_MS, 1000),
    maxAnalysisWorkers: parseNumber(process.env.MAX_ANALYSIS_WORKERS, 2),
    candidateTtlSeconds: parseNumber(process.env.CANDIDATE_TTL_SECONDS, 120),
    stateFile: process.env.STATE_FILE ?? "./data/sniper-state.json",
      decisionTraceFile: process.env.DECISION_TRACE_FILE ?? "./data/decision-traces.jsonl",
    startBlock: parseNumber(process.env.START_BLOCK, 0),
    maxStaleBlocks: parseNumber(process.env.MAX_STALE_BLOCKS, 2),
    maxDailyLossLimitReached: false,
  };

  if (configValue.maxAnalysisWorkers < 1) throw new Error("MAX_ANALYSIS_WORKERS must be >= 1");
  if (configValue.tradeSizeEth <= 0) throw new Error("TRADE_SIZE_ETH must be > 0");
  if (configValue.maxOpenPositions < 1) throw new Error("MAX_OPEN_POSITIONS must be >= 1");

  return configValue;
}

export function hasRuntimeRpcConfig(): boolean {
  return Boolean(config.wsRpc || config.fallbackWsRpc) && Boolean(config.httpRpc || config.fallbackHttpRpc);
}

export function getConfiguredQuoteAssets(): Array<{ address: string; symbol: string; verified: boolean; enabled: boolean }> {
  const assets = Object.entries(config.approvedBaseTokenAddresses).map(([symbol, address]) => ({ address: address.toLowerCase(), symbol, verified: true, enabled: true }));
  if (config.wrappedNativeAddress) assets.push({ address: config.wrappedNativeAddress.toLowerCase(), symbol: "WETH", verified: true, enabled: true });
  return assets;
}

export const config = loadConfig();
