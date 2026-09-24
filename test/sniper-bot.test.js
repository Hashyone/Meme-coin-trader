const { expect } = require("chai");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const {
  PoolCandidateFactory,
  resolveCandidatePair,
  SecurityEngine,
  MarketIntelligence,
  WalletProfileStore,
  SimulationEngine,
  BlockEventStore,
  BlockReconciler,
  V3TradeAdapter,
  config,
  evaluateTrade,
  PaperExchange,
  getFeeData,
  gasCostWithinLimit,
  NonceManager,
  ConcurrencyPool,
  LiveExitManager,
  ReceiptVerifier,
  RobinhoodWebSocketListener,
  assertPonsRestrictionsExpired,
  scanLogsInChunks,
  RejectionStatsStore,
  DecisionTraceStore,
  routePonsV2Phase,
  buildPonsV2PoolKey,
  PONS_V2_HOOK,
  PonsV4Router,
  v4SwapDirection,
  PONS_LAUNCH_GATE_REASONS,
  evaluateLaunchFreshness,
  evaluatePonsLaunchQuality,
  evaluatePonsGraduatedQuality,
  quoteValueToUsd,
  probeSellPath,
  measurePonsV4Volume,
  PONS_V4_SWAP_ABI,
  PONS_V2_POOL_MANAGER,
  PonsTokenScreen,
  PONS_SCREEN_REJECTIONS,
  AnalysisDedupe,
} = require("../dist/sniper/index.js");
const { ethers } = require("ethers");

// Runtime bytecode carries function *selectors*, never names, so the only place a pattern such as "burn(" can
// appear is a printable string literal. Encoding ASCII straight into code is how the tests reproduce one.
const asciiBytecode = (text) => `0x${Buffer.from(text, "utf8").toString("hex")}`;

describe("Robinhood Chain sniper bot core logic", function () {
  it("creates a candidate with deployer and owner metadata", function () {
    const factory = new PoolCandidateFactory("0xFactory", 4663);
    const candidate = factory.createFromEvent({
      token0: "0x0000000000000000000000000000000000000000",
      token1: "0x1111111111111111111111111111111111111111",
      fee: 3000,
      tickSpacing: 60,
      pool: "0x2222222222222222222222222222222222222222",
      transactionHash: "0xabc",
      blockNumber: 123,
      logIndex: 7,
      deployer: "0xDeployer",
      owner: "0xOwner",
      timestamp: 1700000000,
      baseToken: "ETH",
    });

    expect(candidate.chain_id).to.equal(4663);
    expect(candidate.deployer).to.equal("0xdeployer");
    expect(candidate.owner).to.equal("0xowner");
    expect(candidate.base_token).to.equal("ETH");
  });

  it("identifies the non-WETH side regardless of token slot", function () {
    const factory = new PoolCandidateFactory("0xFactory", 4663);
    const weth = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
    const token = "0x1111111111111111111111111111111111111111";
    const create = (token0, token1) => factory.createFromEvent({
      token0,
      token1,
      baseToken: "WETH",
      baseTokenAddress: weth,
      fee: 3000,
      tickSpacing: 60,
      pool: "0x2222222222222222222222222222222222222222",
      transactionHash: "0xabc",
      blockNumber: 123,
      logIndex: 7,
      deployer: "0xDeployer",
      owner: "0xOwner",
    });

    expect(create(weth, token).candidate_token).to.equal(token);
    expect(create(token, weth).candidate_token).to.equal(token);
  });

  it("normalizes approved quote assets and rejects ambiguous pairs", function () {
    const weth = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
    const stock = "0x5555555555555555555555555555555555555555";
    const token = "0x1111111111111111111111111111111111111111";
    const quotes = [
      { address: weth, symbol: "WETH", verified: true },
      { address: stock, symbol: "STOCK", verified: true },
    ];

    expect(resolveCandidatePair(weth, token, quotes).candidateToken).to.equal(token);
    expect(resolveCandidatePair(token, weth, quotes).candidateToken).to.equal(token);
    expect(resolveCandidatePair(stock, token, quotes).quoteSymbol).to.equal("STOCK");
    expect(resolveCandidatePair(token, stock, quotes).candidateToken).to.equal(token);
    expect(resolveCandidatePair(weth, weth, quotes).pairClassification).to.equal("NO_SPECULATIVE_PAIR");
    expect(resolveCandidatePair(token, "0x6666666666666666666666666666666666666666", quotes).pairClassification).to.equal("UNKNOWN_PAIR");
  });

  it("routes PONS v2 phases without treating phase zero as V4", function () {
    expect(routePonsV2Phase(0)).to.deep.equal({ phase: "PONS_V2_CURVE", executable: true });
    expect(routePonsV2Phase(1).executable).to.equal(false);
    expect(routePonsV2Phase(2)).to.deep.equal({ phase: "UNISWAP_V4", executable: true });
    expect(routePonsV2Phase(3).executable).to.equal(false);
    expect(routePonsV2Phase(99).reason).to.equal("PONS_PHASE_UNKNOWN");
  });

  it("builds the PONS v2 V4 PoolKey and PoolId with ABI encoding", function () {
    const token = "0xD5f1afEA47b1A9eab414D2ee740cF1d6d039E725";
    const pairToken = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
    const launch = { exists: true, token, pairToken, poolFee: 0, tickSpacing: 60, phase: 2 };
    const result = buildPonsV2PoolKey(launch);
    expect(result.ok).to.equal(true);
    expect(result.poolKey.currency0).to.equal(pairToken.toLowerCase());
    expect(result.poolKey.currency1).to.equal(token);
    expect(result.poolKey.hooks).to.equal(PONS_V2_HOOK);
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "uint24", "int24", "address"],
      [pairToken, token, 0, 60, PONS_V2_HOOK],
    );
    expect(result.poolKey.poolId).to.equal(ethers.keccak256(encoded));
  });

  it("does not fabricate a V4 pool for a PONS v2 curve phase", function () {
    const result = buildPonsV2PoolKey({
      exists: true,
      token: "0x1111111111111111111111111111111111111111",
      pairToken: "0x2222222222222222222222222222222222222222",
      poolFee: 0,
      tickSpacing: 60,
      phase: 0,
    });
    expect(result).to.deep.equal({ ok: false, reason: "PONS_NOT_GRADUATED", details: "PHASE_0" });
  });

  it("uses the input currency to determine V4 swap direction", function () {
    const poolKey = {
      currency0: "0x1111111111111111111111111111111111111111",
      currency1: "0x2222222222222222222222222222222222222222",
      fee: 0,
      tickSpacing: 200,
      hooks: PONS_V2_HOOK,
      poolId: "0x" + "00".repeat(32),
    };
    expect(v4SwapDirection(poolKey, poolKey.currency0)).to.equal(true);
    expect(v4SwapDirection(poolKey, poolKey.currency1)).to.equal(false);
    expect(() => v4SwapDirection(poolKey, "0x3333333333333333333333333333333333333333")).to.throw("PONS_V4_INPUT_CURRENCY_NOT_IN_POOL");
  });

  it("builds V4 Universal Router calldata with native value only for native input", function () {
    const poolKey = {
      currency0: "0x0000000000000000000000000000000000000000",
      currency1: "0x2222222222222222222222222222222222222222",
      fee: 0,
      tickSpacing: 200,
      hooks: PONS_V2_HOOK,
      poolId: "0x" + "00".repeat(32),
    };
    const router = new PonsV4Router({ estimateGas: async () => 123n }, "0x4444444444444444444444444444444444444444", 4663);
    const transaction = router.buildExactInputSingle(poolKey, poolKey.currency0, 1000n, 900n, 9999999999n, "0x5555555555555555555555555555555555555555");
    expect(transaction.zeroForOne).to.equal(true);
    expect(transaction.value).to.equal(1000n);
    expect(transaction.data).to.match(/^0x/);
  });

  it("encodes the official Universal Router 2.1.1 V4 swap action layout", function () {
    const poolKey = {
      currency0: "0x1111111111111111111111111111111111111111",
      currency1: "0x2222222222222222222222222222222222222222",
      fee: 0,
      tickSpacing: 200,
      hooks: PONS_V2_HOOK,
      poolId: "0x" + "00".repeat(32),
    };
    const router = new PonsV4Router({ estimateGas: async () => 123n }, "0x4444444444444444444444444444444444444444", 4663);
    const transaction = router.buildExactInputSingle(poolKey, poolKey.currency0, 1000n, 900n, 9999999999n, "0x5555555555555555555555555555555555555555");
    const iface = new ethers.Interface(["function execute(bytes commands,bytes[] inputs,uint256 deadline) payable"]);
    const decoded = iface.decodeFunctionData("execute", transaction.data);
    const [commands, inputs] = decoded;
    const [actions, actionInputs] = ethers.AbiCoder.defaultAbiCoder().decode(["bytes", "bytes[]"], inputs[0]);
    const swap = ethers.AbiCoder.defaultAbiCoder().decode(["tuple(tuple(address,address,uint24,int24,address) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)"], actionInputs[0]);
    const settle = ethers.AbiCoder.defaultAbiCoder().decode(["address","uint256"], actionInputs[1]);
    const take = ethers.AbiCoder.defaultAbiCoder().decode(["address","uint256"], actionInputs[2]);
    expect(commands).to.equal("0x10");
    expect(actions).to.equal("0x060c0f");
    expect(swap[0][0][0].toLowerCase()).to.equal(poolKey.currency0.toLowerCase());
    expect(swap[0][1]).to.equal(true);
    expect(swap[0][2]).to.equal(1000n);
    expect(swap[0][3]).to.equal(900n);
    expect(swap[0][4]).to.equal(0n);
    expect(settle[0].toLowerCase()).to.equal(poolKey.currency0.toLowerCase());
    expect(take[0].toLowerCase()).to.equal(poolKey.currency1.toLowerCase());
    expect(take[1]).to.equal(0n);
  });

  it("returns evidence for rejected trades instead of bare labels", function () {
    const evaluation = evaluateTrade({
      amountInWei: 1n * 10n ** 18n,
      expectedBuyAmountWei: 1n * 10n ** 18n,
      expectedSellAmountWei: 1n * 10n ** 18n,
      buyGasWei: 1n * 10n ** 15n,
      sellGasWei: 1n * 10n ** 15n,
      effectiveGasPriceWei: 1n * 10n ** 9n,
      liquidityWei: 1n,
      priceImpactBps: 0,
      slippageBps: 20,
      observedBlock: 100,
      quoteBlock: 100,
      currentBlock: 101,
      openPositions: 0,
      totalExposureWei: 0n,
      dailyLossWei: 0n,
    }, config);

    expect(evaluation.approved).to.equal(false);
    expect(evaluation.rejectionReasons).to.include("LIQUIDITY_TOO_LOW");
    expect(evaluation.details).to.have.property("minLiquidityWei");
    expect(evaluation.details.liquidityWei).to.equal("1");
    expect(Number(evaluation.details.netProfitWei)).to.be.lessThan(0);
  });

  it("returns concrete input-readiness evidence for native V4 routing", async function () {
    const router = new PonsV4Router({
      getBalance: async () => 10n,
    }, "0x4444444444444444444444444444444444444444", 4663);

    const readiness = await router.inspectInputReadiness(
      "0x0000000000000000000000000000000000000000",
      "0x5555555555555555555555555555555555555555",
      100n,
      "0x0000000000000000000000000000000000000001",
    );

    expect(readiness.ready).to.equal(false);
    expect(readiness.reason).to.equal("PONS_V4_INPUT_BALANCE_TOO_LOW");
    expect(readiness.details).to.have.property("balance");
    expect(readiness.details.balance).to.equal("10");
  });

  it("persists rejection statistics without changing safety thresholds", async function () {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sniper-rejections-"));
    const statsPath = path.join(directory, "rejections.json");
    const stats = await RejectionStatsStore.open(statsPath);
    stats.record(["LIQUIDITY_TOO_LOW", "SECURITY_FAILURE"]);
    stats.record([]);
    await stats.persist();
    const restarted = await RejectionStatsStore.open(statsPath);
    expect(restarted.snapshot().totalCandidates).to.equal(2);
    expect(restarted.snapshot().reasons.LIQUIDITY_TOO_LOW).to.equal(1);
    expect(restarted.snapshot().executionEligible).to.equal(1);
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("persists versioned decision traces with precise numeric evidence", async function () {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sniper-traces-"));
    const tracePath = path.join(directory, "decision-traces.jsonl");
    const traces = await DecisionTraceStore.open(tracePath);
    await traces.append({
      schemaVersion: 1,
      traceId: "0xabc:7",
      observedAt: new Date(0).toISOString(),
      chainId: 4663,
      source: { protocol: "pons", factory: "0x1111111111111111111111111111111111111111", transactionHash: "0xabc", blockNumber: 7, logIndex: 7 },
      candidate: { token: "0x2222222222222222222222222222222222222222" },
      stages: { evaluation: { status: "REJECT", evidence: { amountInWei: 10n }, reasons: ["LIQUIDITY_TOO_LOW"] } },
      final: { accepted: false, rejectionReasons: ["LIQUIDITY_TOO_LOW"] },
    });
    const [line] = (await fs.readFile(tracePath, "utf8")).trim().split("\n");
    const trace = JSON.parse(line);
    expect(trace.schemaVersion).to.equal(1);
    expect(trace.source.transactionHash).to.equal("0xabc");
    expect(trace.stages.evaluation.evidence.amountInWei).to.equal("10");
    expect(trace.final.rejectionReasons).to.deep.equal(["LIQUIDITY_TOO_LOW"]);
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("approves safe candidate pools with approved base assets", function () {
    const engine = new SecurityEngine();
    const result = engine.evaluate({
      candidate_id: "1:pool",
      chain_id: 4663,
      factory: "0xFactory",
      pool: "0xpool",
      token0: "0x0000000000000000000000000000000000000000",
      token1: "0x1111111111111111111111111111111111111111",
      fee: 3000,
      tick_spacing: 60,
      creation_block: 123,
      creation_timestamp: 1700000000,
      creation_tx: "0xabc",
      deployer: "0x1111111111111111111111111111111111111111",
      owner: "0x2222222222222222222222222222222222222222",
      base_token: "ETH",
      candidate_token: "0x1111111111111111111111111111111111111111",
    });

    expect(result.approvedBasePair).to.equal(true);
    expect(result.safe).to.equal(true);
  });

  it("recognizes the configured wrapped-native address as an approved base", function () {
    const originalWrappedNative = config.wrappedNativeAddress;
    config.wrappedNativeAddress = "0x5555555555555555555555555555555555555555";
    const result = new SecurityEngine().evaluate({
      candidate_id: "address-base",
      chain_id: 4663,
      factory: config.factoryAddress,
      pool: "0x2222222222222222222222222222222222222222",
      token0: config.wrappedNativeAddress,
      token1: "0x1111111111111111111111111111111111111111",
      fee: 3000,
      tick_spacing: 60,
      creation_block: 1,
      creation_timestamp: 1,
      creation_tx: "0xabc",
      deployer: "0x1111111111111111111111111111111111111111",
      owner: "0x2222222222222222222222222222222222222222",
      base_token: "WETH",
      candidate_token: "0x1111111111111111111111111111111111111111",
    });
    expect(result.approvedBasePair).to.equal(true);
    config.wrappedNativeAddress = originalWrappedNative;
  });

  it("promotes wallets when they cross the $20M milestone", function () {
    const market = new MarketIntelligence();
    const metrics = market.calculateMarketCap("token", 20, 1_000_000);
    const milestone = market.evaluateMilestone("0xabc", "token", metrics);

    expect(milestone).to.not.equal(null);
    expect(milestone.market_cap).to.be.at.least(20_000_000);
  });

  it("tracks wallet history and promotion states", function () {
    const store = new WalletProfileStore();
    const profile = store.upsert("0xabc");
    expect(profile.wallet_class).to.equal("UNKNOWN");

    const updated = store.recordMilestone({
      wallet: "0xabc",
      token: "token",
      timestamp: 1700000000,
      block: 100,
      market_cap: 25_000_000,
      price: 25,
      liquidity: 1000,
      volume: 500,
      supply: 1_000_000,
      measurement_method: "exact",
    });

    expect(updated.wallet_class).to.equal("HIGH_VALUE_DEPLOYER");
    expect(updated.watch_status).to.equal(true);
    expect(updated.successful_20m_launches).to.equal(1);
  });

  it("builds a safe simulation payload when execution mode is enabled", async function () {
    const engine = new SimulationEngine();
    const result = await engine.simulate({
      chainId: 4663,
      from: "0x0000000000000000000000000000000000000000",
      to: "0x1111111111111111111111111111111111111111",
      value: "0x0",
      data: "0x",
      gasLimit: 210000,
      maxFeePerGas: "0x3b9aca00",
      maxPriorityFeePerGas: "0x3b9aca00",
    }, { privateKey: process.env.WALLET_PRIVATE_KEY || "0x" + "11".repeat(32) });

    expect(result.mode).to.equal("simulation");
    expect(result.safe).to.equal(true);
    expect(result.signedTx).to.be.a("string");
  });

  it("recovers missed blocks exactly once and restores the cursor after restart", async function () {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sniper-stage1-"));
    const storePath = path.join(directory, "state.json");
    const address = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
    const topic = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";
    const logs = [103, 104, 105].map((blockNumber) => ({
      address,
      topics: [topic],
      data: "0x",
      blockNumber,
      transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
      logIndex: 0,
    }));
    const provider = {
      async getBlockNumber() { return 105; },
      async getBlock(blockNumber) { return { hash: `0x${blockNumber.toString(16).padStart(64, "0")}` }; },
      async getLogs() { return [...logs, logs[1]]; },
    };
    const store = await BlockEventStore.open(storePath, 4663);
    await store.advanceCursor(102, "0x66");
    const processed = [];
    const reconciler = new BlockReconciler(provider, store, [{ address, topic }], async (event) => {
      processed.push(event.blockNumber);
    });

    const result = await reconciler.reconcile();
    expect(result.fromBlock).to.equal(103);
    expect(result.toBlock).to.equal(105);
    expect(result.recovered).to.equal(3);
    expect(result.duplicates).to.equal(1);
    expect(processed).to.deep.equal([103, 104, 105]);
    expect(store.cursor.lastProcessedBlock).to.equal(105);

    const restarted = await BlockEventStore.open(storePath, 4663);
    expect(restarted.cursor.lastProcessedBlock).to.equal(105);
    expect(restarted.events).to.have.length(3);
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("builds genuine V3 router calldata and requires wrapped native configuration", function () {
    const adapter = new V3TradeAdapter({ getBlockNumber: async () => 100 });
    const state = {
      pool: "0x2222222222222222222222222222222222222222",
      token0: { address: "0x1111111111111111111111111111111111111111" },
      token1: { address: "0x3333333333333333333333333333333333333333" },
      fee: 3000,
    };
    const originalWrappedNative = config.wrappedNativeAddress;
    config.wrappedNativeAddress = state.token0.address;
    const transaction = adapter.buildBuyTransaction(
      state,
      "0x4444444444444444444444444444444444444444",
      1000n,
      900n,
    );
    const decoded = new ethers.Interface(["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) returns (uint256)"]).decodeFunctionData("exactInputSingle", transaction.data);
    expect(transaction.to).to.equal(config.swapRouter02Address);
    expect(decoded[0].tokenIn).to.equal(state.token0.address);
    expect(decoded[0].tokenOut).to.equal(state.token1.address);
    expect(decoded[0].amountIn).to.equal(1000n);
    expect(decoded[0].amountOutMinimum).to.equal(900n);

    config.wrappedNativeAddress = undefined;
    expect(() => adapter.buildBuyTransaction(state, "0x4444444444444444444444444444444444444444", 1n, 1n)).to.throw("ROBINHOOD_WRAPPED_NATIVE_REQUIRED");
    config.wrappedNativeAddress = originalWrappedNative;
  });

  it("approves only a known profitable trade", function () {
    const result = evaluateTrade({
      amountInWei: 10n ** 16n,
      expectedBuyAmountWei: 1000n,
      expectedSellAmountWei: 12n * 10n ** 15n,
      buyGasWei: 100000n,
      sellGasWei: 100000n,
      effectiveGasPriceWei: 1n,
      liquidityWei: 10n ** 18n,
      priceImpactBps: 10,
      slippageBps: 10,
      buyTaxBps: 50,
      sellTaxBps: 50,
      observedBlock: 100,
      quoteBlock: 100,
      currentBlock: 100,
      openPositions: 0,
      totalExposureWei: 0n,
      dailyLossWei: 0n,
      now: 1000,
    }, config);
    expect(result.approved).to.equal(true);
    expect(result.rejectionReasons).to.deep.equal([]);
  });

  it("blocks unsafe trades with explicit hard-gate reasons", function () {
    const result = evaluateTrade({
      amountInWei: 10n ** 16n,
      expectedBuyAmountWei: 1000n,
      expectedSellAmountWei: 10n ** 16n,
      buyGasWei: 10n ** 15n,
      sellGasWei: 10n ** 15n,
      effectiveGasPriceWei: 10n,
      liquidityWei: 0n,
      priceImpactBps: 500,
      slippageBps: 500,
      observedBlock: 90,
      quoteBlock: 90,
      currentBlock: 100,
      openPositions: config.maxOpenPositions,
      totalExposureWei: 10n ** 18n,
      dailyLossWei: 10n ** 18n,
      now: 1000,
    }, config);
    expect(result.approved).to.equal(false);
    expect(result.rejectionReasons).to.include.members([
      "LIQUIDITY_TOO_LOW",
      "MAX_SLIPPAGE_EXCEEDED",
      "PRICE_IMPACT_TOO_HIGH",
      "BUY_TAX_UNKNOWN",
      "SELL_TAX_UNKNOWN",
      "GAS_TOO_HIGH",
      "STALE_MARKET_STATE",
      "MAX_OPEN_POSITIONS_REACHED",
      "MAX_EXPOSURE_REACHED",
      "DAILY_LOSS_LIMIT_REACHED",
    ]);
  });

  it("persists paper positions, P/L, and progressive milestones", async function () {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sniper-paper-"));
    const statePath = path.join(directory, "paper.json");
    const exchange = await PaperExchange.open(statePath, 100n);
    await exchange.buy({ id: "position-1", token: "0xToken", pool: "0xPool", amountInWei: 10n, tokenAmount: 100n, entryPriceWei: 1n, block: 100, gasWei: 1n });
    expect(exchange.snapshot.ethBalanceWei).to.equal(90n);
    expect(await exchange.applyProfitMilestones("position-1", 20n)).to.deep.equal([20n]);
    expect(await exchange.applyProfitMilestones("position-1", 20n)).to.deep.equal([]);
    await exchange.sell("position-1", 20n, 4n, 1n);
    expect(exchange.snapshot.realizedPnlWei).to.equal(1n);
    const restarted = await PaperExchange.open(statePath, 100n);
    expect(restarted.getPosition("position-1").remainingTokenAmount).to.equal(80n);
    expect(restarted.getPosition("position-1").highestProfitMilestone).to.equal(100);
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("uses current fee data and serializes nonce reservations", async function () {
    const fee = await getFeeData({ getFeeData: async () => ({ maxFeePerGas: 3n, maxPriorityFeePerGas: 2n }) });
    expect(fee.maxFeePerGas).to.equal(3n);
    expect(fee.maxPriorityFeePerGas).to.equal(2n);
    expect(gasCostWithinLimit(1_000_000n, 1n)).to.equal(true);
    const manager = new NonceManager({ getTransactionCount: async (_address, tag) => tag === "pending" ? 8 : 7 }, "0xwallet");
    expect(await Promise.all([manager.reserve(), manager.reserve(), manager.reserve()])).to.deep.equal([8, 9, 10]);
  });

  it("rejects inconsistent nonce state", async function () {
    const manager = new NonceManager({ getTransactionCount: async (_address, tag) => tag === "pending" ? 3 : 4 }, "0xwallet");
    let error;
    try { await manager.initialize(); } catch (caught) { error = caught; }
    expect(error.message).to.equal("NONCE_STATE_INCONSISTENT");
  });

  it("requires a successful receipt and verified balance transition", async function () {
    const verifier = new ReceiptVerifier({
      waitForTransaction: async () => ({ status: 1, nonce: 4, blockNumber: 10, gasUsed: 100n, gasPrice: 2n }),
      getTransaction: async () => ({ nonce: 4 }),
    });
    const receipt = await verifier.waitForSuccess("0xhash", [{ address: "0xtoken", before: 0n, after: 5n }]);
    expect(receipt.gasCostWei).to.equal(200n);
    const failed = new ReceiptVerifier({
      waitForTransaction: async () => ({ status: 1, nonce: 4, blockNumber: 10, gasUsed: 100n, gasPrice: 2n }),
      getTransaction: async () => ({ nonce: 4 }),
    });
    let error;
    try { await failed.waitForSuccess("0xhash", [{ address: "0xtoken", before: 5n, after: 5n }]); } catch (caught) { error = caught; }
    expect(error.message).to.equal("BALANCE_TRANSITION_NOT_VERIFIED");
  });

  it("decodes PONS token deployment and launch events", function () {
    const listener = new RobinhoodWebSocketListener("", "", false);
    const deployed = [];
    const launched = [];
    listener.on("ponsTokenDeployed", (event) => deployed.push(event));
    listener.on("ponsTokenLaunched", (event) => launched.push(event));
    const pons = new ethers.Interface([
      "event TokenDeployed(address indexed token,address indexed deployer,address indexed dexFactory,address pairToken,uint256 dexId,uint256 launchConfigId)",
      "event TokenLaunched(address indexed token,address indexed deployer,address indexed dexFactory,address pairToken,address pool,uint256 dexId,uint256 launchConfigId,uint256 positionId,uint256 restrictionsEndBlock,uint256 initialBuyAmount)",
    ]);
    for (const name of ["TokenDeployed", "TokenLaunched"]) {
      const values = name === "TokenDeployed"
        ? ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222", config.factoryAddress, "0x3333333333333333333333333333333333333333", 1, 2]
        : ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222", config.factoryAddress, "0x3333333333333333333333333333333333333333", "0x4444444444444444444444444444444444444444", 1, 2, 3, 500, 7000];
      const encoded = pons.encodeEventLog(pons.getEvent(name), values);
      listener.decodeLogMessage(JSON.stringify({ params: { result: { address: "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB", topics: encoded.topics, data: encoded.data, blockNumber: "0x10", transactionHash: "0xabc", logIndex: "0x1" } } }));
    }
    expect(deployed[0].token).to.equal("0x1111111111111111111111111111111111111111");
    expect(launched[0].pool).to.equal("0x4444444444444444444444444444444444444444");
    expect(launched[0].restrictionsEndBlock).to.equal(500);
    expect(launched[0].initialBuyAmount).to.equal(7000n);
  });

  it("enforces PONS launch restrictions and bounded log scanning", async function () {
    expect(() => assertPonsRestrictionsExpired(99, 100)).to.throw("TRADING_RESTRICTED_UNTIL_100");
    expect(() => assertPonsRestrictionsExpired(100, 100)).not.to.throw();
    const calls = [];
    const events = await scanLogsInChunks({
      getLogs: async (filter) => {
        calls.push([filter.fromBlock, filter.toBlock]);
        return [{ address: "0x1", topics: ["0xtopic"], data: "0x", blockNumber: filter.fromBlock, transactionHash: `0x${filter.fromBlock}`, logIndex: 0 }];
      },
    }, { address: "0xfactory", topics: [["0xtopic"]] }, 100, 125, 10);
    expect(calls).to.deep.equal([[100, 109], [110, 119], [120, 125]]);
    expect(events).to.have.length(3);
  });

  it("blocks live submission unless the switch and execution mode allow it", async function () {
    process.env.ALLOW_LIVE_BROADCAST = "false";
    process.env.EXECUTION_MODE = "LIVE";
    process.env.WALLET_PRIVATE_KEY = "0x" + "11".repeat(32);
    process.env.EXECUTION_TARGET = "0x1111111111111111111111111111111111111111";
    process.env.TRADE_VALUE_WEI = "0x1";
    const engine = new SimulationEngine();
    const result = await engine.simulate({
      chainId: 4663,
      from: "0x0000000000000000000000000000000000000000",
      to: "0x1111111111111111111111111111111111111111",
      value: "0x0",
      data: "0x",
      gasLimit: 210000,
      maxFeePerGas: "0x3b9aca00",
      maxPriorityFeePerGas: "0x3b9aca00",
    }, { privateKey: process.env.WALLET_PRIVATE_KEY });
    expect(result.broadcasted).to.equal(false);
    expect(result.reason).to.equal("LIVE_EXECUTION_BLOCKED");
    process.env.ALLOW_LIVE_BROADCAST = "true";
    process.env.EXECUTION_MODE = "CANARY";
    const allowed = await engine.simulate({
      chainId: 4663,
      from: "0x0000000000000000000000000000000000000000",
      to: "0x1111111111111111111111111111111111111111",
      value: "0x0",
      data: "0x",
      gasLimit: 210000,
      maxFeePerGas: "0x3b9aca00",
      maxPriorityFeePerGas: "0x3b9aca00",
    }, { privateKey: process.env.WALLET_PRIVATE_KEY }, {
      getTransactionCount: async () => 0,
      estimateGas: async () => 210000n,
      call: async () => "0x",
      broadcastTransaction: async (signedTx) => ({ hash: ethers.keccak256(signedTx) }),
    });
    expect(allowed.broadcasted).to.equal(true);
    delete process.env.EXECUTION_MODE;
    delete process.env.WALLET_PRIVATE_KEY;
    delete process.env.EXECUTION_TARGET;
    delete process.env.TRADE_VALUE_WEI;
  });
});

describe("PONS V2 launch gate", function () {
  // Measured on chain: every native curve seeds 1.68e18 against a 4.2e18 threshold and every USDG curve seeds
  // 3.236e9 against 8.09e9 - exactly 40% of the curve's own threshold in both lanes.
  const NATIVE_SEED = 1680000000000000000n;
  const NATIVE_THRESHOLD = 4200000000000000000n;
  const USDG_SEED = 3236000000n;
  const USDG_THRESHOLD = 8090000000n;

  const qualityPolicy = {
    minThresholdPct: 30,
    maxTollBps: 1000,
    maxCreatorHoldingPct: 0,
    maxBundleSupplyPct: 0,
    maxLaunchAllocSharePct: 0,
    rejectBuybackEnabled: false,
    maxInsiderSupplyPct: 0,
    maxSameBlockSharePct: 0,
    maxSequentialBlockSharePct: 0,
    maxPeerTransferSharePct: 0,
    requireSellPath: false,
  };

  const quality = (overrides) => evaluatePonsLaunchQuality({
    quoteReserve: NATIVE_SEED,
    graduationThreshold: NATIVE_THRESHOLD,
    feeBps: 100,
    creatorTaxBps: 200,
    snipeTaxBps: 0,
    buybackEnabled: false,
    creatorHoldingPct: null,
    bundleSupplyPct: null,
    launchAllocSharePct: null,
    insiderSharePct: null,
    sameBlockSharePct: null,
    sequentialBlockSharePct: null,
    peerTransferSharePct: null,
    sellPath: null,
    policy: qualityPolicy,
    ...overrides,
  });

  it("rejects the 49-minute-late launch block and accepts an in-window one", function () {
    // The real incident: launch block 65706944, fill broadcast at block 65736222.
    const late = evaluateLaunchFreshness({ launchBlock: 65706944, headBlock: 65736222, maxEntryAgeBlocks: 300 });
    expect(late.ok).to.equal(false);
    expect(late.ageBlocks).to.equal(29278);
    expect(late.reason).to.equal(PONS_LAUNCH_GATE_REASONS.STALE_LAUNCH);

    const intime = evaluateLaunchFreshness({ launchBlock: 65706944, headBlock: 65706974, maxEntryAgeBlocks: 300 });
    expect(intime.ok).to.equal(true);
    expect(intime.ageBlocks).to.equal(30);
    expect(intime.reason).to.equal(undefined);
  });

  it("treats the freshness window as inclusive at its boundary", function () {
    const boundary = evaluateLaunchFreshness({ launchBlock: 1000, headBlock: 1300, maxEntryAgeBlocks: 300 });
    expect(boundary.ok).to.equal(true);
    const past = evaluateLaunchFreshness({ launchBlock: 1000, headBlock: 1301, maxEntryAgeBlocks: 300 });
    expect(past.ok).to.equal(false);
  });

  it("measures the seed reserve as 40% of the curve's own threshold in both quote lanes", function () {
    const native = quality({});
    expect(native.accepted).to.equal(true);
    expect(native.metrics.thresholdPct).to.equal(40);

    const usdg = quality({ quoteReserve: USDG_SEED, graduationThreshold: USDG_THRESHOLD });
    expect(usdg.accepted).to.equal(true);
    expect(usdg.metrics.thresholdPct).to.equal(40);
  });

  it("rejects a curve whose quote reserve has been drained below the threshold share", function () {
    const drained = quality({ quoteReserve: 100000000000000000n });
    expect(drained.accepted).to.equal(false);
    expect(drained.reasons).to.include(PONS_LAUNCH_GATE_REASONS.LIQUIDITY_BELOW_THRESHOLD_PCT);
    expect(drained.metrics.thresholdPct).to.be.lessThan(30);
  });

  it("treats the threshold share as inclusive at its boundary", function () {
    const boundary = quality({ quoteReserve: 1260000000000000000n });
    expect(boundary.metrics.thresholdPct).to.equal(30);
    expect(boundary.accepted).to.equal(true);
    const justUnder = quality({ quoteReserve: 1259999999999999999n });
    expect(justUnder.accepted).to.equal(false);
  });

  it("rejects a threshold no reserve can satisfy rather than accepting it", function () {
    const unknown = quality({ graduationThreshold: 0n });
    expect(unknown.accepted).to.equal(false);
    expect(unknown.reasons).to.include(PONS_LAUNCH_GATE_REASONS.LIQUIDITY_BELOW_THRESHOLD_PCT);
  });

  it("rejects the measured 552 bps round-trip toll once it exceeds the ceiling", function () {
    const affordable = quality({ feeBps: 100, creatorTaxBps: 180, snipeTaxBps: 0 });
    expect(affordable.metrics.tollBps).to.equal(280);
    expect(affordable.accepted).to.equal(true);

    const gouged = quality({ feeBps: 600, creatorTaxBps: 600, snipeTaxBps: 100 });
    expect(gouged.metrics.tollBps).to.equal(1300);
    expect(gouged.accepted).to.equal(false);
    expect(gouged.reasons).to.include(PONS_LAUNCH_GATE_REASONS.TOLL_TOO_HIGH);
  });

  it("leaves the creator check off by default and enforces the ceiling only when switched on", function () {
    const disabled = quality({ creatorHoldingPct: 100, policy: { ...qualityPolicy, maxCreatorHoldingPct: 0 } });
    expect(disabled.accepted).to.equal(true);

    const unsoldBag = quality({ creatorHoldingPct: 5, policy: { ...qualityPolicy, maxCreatorHoldingPct: 1 } });
    expect(unsoldBag.accepted).to.equal(false);
    expect(unsoldBag.reasons).to.include(PONS_LAUNCH_GATE_REASONS.CREATOR_BAG_UNSOLD);

    const emptied = quality({ creatorHoldingPct: 0, policy: { ...qualityPolicy, maxCreatorHoldingPct: 1 } });
    expect(emptied.accepted).to.equal(true);
    expect(emptied.metrics.creatorHoldingPct).to.equal(0);

    // The measured boundary: exactly at the ceiling passes, a hair above it does not.
    const atCeiling = quality({ creatorHoldingPct: 1, policy: { ...qualityPolicy, maxCreatorHoldingPct: 1 } });
    expect(atCeiling.accepted).to.equal(true);
  });

  it("fails closed when the creator read cannot be taken and the check is switched on", function () {
    const unreadable = quality({ creatorHoldingPct: null, policy: { ...qualityPolicy, maxCreatorHoldingPct: 1 } });
    expect(unreadable.accepted).to.equal(false);
    expect(unreadable.reasons).to.include(PONS_LAUNCH_GATE_REASONS.CREATOR_HOLDING_UNKNOWN);
  });

  it("flags an already-enabled buyback switch only when asked to", function () {
    const ignored = quality({ buybackEnabled: true });
    expect(ignored.accepted).to.equal(true);
    const rejected = quality({ buybackEnabled: true, policy: { ...qualityPolicy, rejectBuybackEnabled: true } });
    expect(rejected.accepted).to.equal(false);
    expect(rejected.reasons).to.include(PONS_LAUNCH_GATE_REASONS.BUYBACK_ENABLED);
  });

  it("leaves the bundle ceiling off by default even on a majority-controlled launch", function () {
    const disabled = quality({ bundleSupplyPct: 68 });
    expect(disabled.accepted).to.equal(true);
    expect(disabled.metrics.bundleSupplyPct).to.equal(68);
  });

  it("refuses only the coordinated launches above the ceiling and admits the rest of measured flow", function () {
    const policy = { ...qualityPolicy, maxBundleSupplyPct: 30 };

    // The measured distribution over 52 live launches: median 2.45%, p90 15.35%, and 13 of 52 crossed 10%.
    // None of those is a fan-out, and none is refused.
    expect(quality({ bundleSupplyPct: 2.45, policy }).accepted).to.equal(true);
    expect(quality({ bundleSupplyPct: 15.35, policy }).accepted).to.equal(true);

    // The three launches a 30% ceiling refuses, each one operator fanning the token to 13-24 wallets.
    for (const share of [40.28, 38.15, 35.23]) {
      const refused = quality({ bundleSupplyPct: share, policy });
      expect(refused.accepted).to.equal(false);
      expect(refused.reasons).to.include(PONS_LAUNCH_GATE_REASONS.BUNDLE_ABOVE_CEILING);
    }
  });

  it("treats the bundle ceiling as inclusive at its boundary", function () {
    const policy = { ...qualityPolicy, maxBundleSupplyPct: 30 };
    expect(quality({ bundleSupplyPct: 30, policy }).accepted).to.equal(true);
    expect(quality({ bundleSupplyPct: 30.01, policy }).accepted).to.equal(false);
  });

  it("fails closed when the bundle read cannot be taken and the ceiling is on", function () {
    const unreadable = quality({ bundleSupplyPct: null, policy: { ...qualityPolicy, maxBundleSupplyPct: 30 } });
    expect(unreadable.accepted).to.equal(false);
    expect(unreadable.reasons).to.include(PONS_LAUNCH_GATE_REASONS.BUNDLE_MEASUREMENT_UNKNOWN);
  });

  it("keeps the bundle and creator ceilings independent", function () {
    const bundled = quality({
      bundleSupplyPct: 45,
      creatorHoldingPct: 0,
      policy: { ...qualityPolicy, maxBundleSupplyPct: 30, maxCreatorHoldingPct: 1 },
    });
    expect(bundled.reasons).to.deep.equal([PONS_LAUNCH_GATE_REASONS.BUNDLE_ABOVE_CEILING]);

    const hoarded = quality({
      bundleSupplyPct: 1,
      creatorHoldingPct: 4,
      policy: { ...qualityPolicy, maxBundleSupplyPct: 30, maxCreatorHoldingPct: 1 },
    });
    expect(hoarded.reasons).to.deep.equal([PONS_LAUNCH_GATE_REASONS.CREATOR_BAG_UNSOLD]);
  });

  // The four coordination ceilings read the same concentration result as the bundle check. Each one is a
  // ceiling, off at 0, and fail-closed on a null, so the shape of every test below is the same four cases.
  const ceilingCases = [
    {
      name: "insider share",
      input: "insiderSharePct",
      policy: "maxInsiderSupplyPct",
      above: PONS_LAUNCH_GATE_REASONS.INSIDER_SUPPLY_ABOVE_CEILING,
      unknown: PONS_LAUNCH_GATE_REASONS.INSIDER_SUPPLY_UNKNOWN,
    },
    {
      name: "same-block share",
      input: "sameBlockSharePct",
      policy: "maxSameBlockSharePct",
      above: PONS_LAUNCH_GATE_REASONS.SAME_BLOCK_SHARE_ABOVE_CEILING,
      unknown: PONS_LAUNCH_GATE_REASONS.SAME_BLOCK_SHARE_UNKNOWN,
    },
    {
      name: "sequential-block share",
      input: "sequentialBlockSharePct",
      policy: "maxSequentialBlockSharePct",
      above: PONS_LAUNCH_GATE_REASONS.SEQUENTIAL_BLOCK_SHARE_ABOVE_CEILING,
      unknown: PONS_LAUNCH_GATE_REASONS.SEQUENTIAL_BLOCK_SHARE_UNKNOWN,
    },
    {
      name: "peer-transfer share",
      input: "peerTransferSharePct",
      policy: "maxPeerTransferSharePct",
      above: PONS_LAUNCH_GATE_REASONS.PEER_TRANSFER_SHARE_ABOVE_CEILING,
      unknown: PONS_LAUNCH_GATE_REASONS.PEER_TRANSFER_SHARE_UNKNOWN,
    },
  ];

  for (const testCase of ceilingCases) {
    it(`leaves the ${testCase.name} ceiling off at 0, enforces it inclusively, and fails closed on a null`, function () {
      const off = quality({ [testCase.input]: 99 });
      expect(off.accepted).to.equal(true);
      expect(off.metrics[testCase.input]).to.equal(99);

      const policy = { ...qualityPolicy, [testCase.policy]: 20 };
      expect(quality({ [testCase.input]: 20, policy }).accepted).to.equal(true);
      const refused = quality({ [testCase.input]: 20.01, policy });
      expect(refused.accepted).to.equal(false);
      expect(refused.reasons).to.include(testCase.above);

      const unreadable = quality({ [testCase.input]: null, policy });
      expect(unreadable.accepted).to.equal(false);
      expect(unreadable.reasons).to.include(testCase.unknown);
    });
  }

  it("admits the measured insider maximum under the 50% majority tripwire", function () {
    // The honest reading of "do the insiders hold the majority": at entry the curve still holds ~99.98% of
    // supply, so the largest insider share measured over 52 live launches was 40.4% and no launch has ever
    // come close to a majority. The default ceiling is therefore a tripwire that refuses nothing today.
    const worstMeasured = quality({ insiderSharePct: 40.4, policy: { ...qualityPolicy, maxInsiderSupplyPct: 50 } });
    expect(worstMeasured.accepted).to.equal(true);

    const majority = quality({ insiderSharePct: 55, policy: { ...qualityPolicy, maxInsiderSupplyPct: 50 } });
    expect(majority.accepted).to.equal(false);
    expect(majority.reasons).to.include(PONS_LAUNCH_GATE_REASONS.INSIDER_SUPPLY_ABOVE_CEILING);
  });

  it("reports the new concentration measures in the gate metrics", function () {
    const measured = quality({
      insiderSharePct: 12.5,
      sameBlockSharePct: 3.25,
      sequentialBlockSharePct: 7.5,
      peerTransferSharePct: 1.75,
      sellPath: "ok",
    });
    expect(measured.metrics.insiderSharePct).to.equal(12.5);
    expect(measured.metrics.sameBlockSharePct).to.equal(3.25);
    expect(measured.metrics.sequentialBlockSharePct).to.equal(7.5);
    expect(measured.metrics.peerTransferSharePct).to.equal(1.75);
    expect(measured.metrics.sellPath).to.equal("ok");
  });

  it("requires the sell path only when asked, and treats unmeasured as failing closed", function () {
    // Off by default: a token whose sell path was never probed is not refused.
    expect(quality({ sellPath: null }).accepted).to.equal(true);
    expect(quality({ sellPath: "blocked" }).accepted).to.equal(true);

    const policy = { ...qualityPolicy, requireSellPath: true };
    expect(quality({ sellPath: "ok", policy }).accepted).to.equal(true);

    const blocked = quality({ sellPath: "blocked", policy });
    expect(blocked.accepted).to.equal(false);
    expect(blocked.reasons).to.deep.equal([PONS_LAUNCH_GATE_REASONS.SELL_PATH_BLOCKED]);

    // A probe that could not run - no funded holder, an RPC that refuses the override - must never read as a
    // pass. This is the case the bytecode screen cannot distinguish, and the one that gates real funds.
    const unknown = quality({ sellPath: null, policy });
    expect(unknown.accepted).to.equal(false);
    expect(unknown.reasons).to.deep.equal([PONS_LAUNCH_GATE_REASONS.SELL_PATH_UNKNOWN]);
  });

  it("keeps the sell-path check independent of every supply ceiling", function () {
    const combined = quality({
      bundleSupplyPct: 45,
      sellPath: "blocked",
      policy: { ...qualityPolicy, maxBundleSupplyPct: 30, requireSellPath: true },
    });
    expect(combined.accepted).to.equal(false);
    expect(combined.reasons).to.deep.equal([
      PONS_LAUNCH_GATE_REASONS.BUNDLE_ABOVE_CEILING,
      PONS_LAUNCH_GATE_REASONS.SELL_PATH_BLOCKED,
    ]);
  });
});

describe("PONS V2 graduated lane gate", function () {
  const graduated = (overrides) => evaluatePonsGraduatedQuality({
    liquidityUsd: 10307.6,
    volumeUsd: 250000,
    policy: { graduatedMinLiquidityUsd: 0, graduatedMinVolumeUsd: 0 },
    ...overrides,
  });

  it("leaves both floors off by default", function () {
    const disabled = graduated({ liquidityUsd: 12, volumeUsd: 0 });
    expect(disabled.accepted).to.equal(true);
    expect(disabled.metrics.liquidityUsd).to.equal(12);
    expect(disabled.metrics.volumeUsd).to.equal(0);
  });

  it("refuses a graduated pool below the liquidity floor and treats the floor as inclusive", function () {
    const policy = { graduatedMinLiquidityUsd: 10000, graduatedMinVolumeUsd: 0 };
    expect(graduated({ liquidityUsd: 10000, policy }).accepted).to.equal(true);

    const thin = graduated({ liquidityUsd: 9999.99, policy });
    expect(thin.accepted).to.equal(false);
    expect(thin.reasons).to.deep.equal([PONS_LAUNCH_GATE_REASONS.GRADUATED_LIQUIDITY_BELOW_FLOOR]);
  });

  it("refuses a graduated pool below the volume floor and treats the floor as inclusive", function () {
    const policy = { graduatedMinLiquidityUsd: 0, graduatedMinVolumeUsd: 5000 };
    expect(graduated({ volumeUsd: 5000, policy }).accepted).to.equal(true);

    const dead = graduated({ volumeUsd: 4999.99, policy });
    expect(dead.accepted).to.equal(false);
    expect(dead.reasons).to.deep.equal([PONS_LAUNCH_GATE_REASONS.GRADUATED_VOLUME_BELOW_FLOOR]);
  });

  it("fails closed on an unvaluable or unreadable graduated market", function () {
    const liquidityUnknown = graduated({
      liquidityUsd: null,
      policy: { graduatedMinLiquidityUsd: 10000, graduatedMinVolumeUsd: 0 },
    });
    expect(liquidityUnknown.accepted).to.equal(false);
    expect(liquidityUnknown.reasons).to.include(PONS_LAUNCH_GATE_REASONS.GRADUATED_LIQUIDITY_UNKNOWN);

    const volumeUnknown = graduated({
      volumeUsd: null,
      policy: { graduatedMinLiquidityUsd: 0, graduatedMinVolumeUsd: 5000 },
    });
    expect(volumeUnknown.accepted).to.equal(false);
    expect(volumeUnknown.reasons).to.include(PONS_LAUNCH_GATE_REASONS.GRADUATED_VOLUME_UNKNOWN);
  });

  it("reports both reasons when both floors fail", function () {
    const both = graduated({
      liquidityUsd: 100,
      volumeUsd: 100,
      policy: { graduatedMinLiquidityUsd: 10000, graduatedMinVolumeUsd: 5000 },
    });
    expect(both.reasons).to.deep.equal([
      PONS_LAUNCH_GATE_REASONS.GRADUATED_LIQUIDITY_BELOW_FLOOR,
      PONS_LAUNCH_GATE_REASONS.GRADUATED_VOLUME_BELOW_FLOOR,
    ]);
  });

  it("values the swept graduation quote, and refuses to guess an unknown scale", function () {
    // Every native curve graduates at 4.2e18 wei, which is the quote that actually backs the V4 pool.
    expect(quoteValueToUsd(4200000000000000000n, { address: ethers.ZeroAddress, decimals: 18, native: true }, 2454.12)).to.be.closeTo(10307.3, 0.1);
    // USDG is 6 decimals and already a dollar.
    expect(quoteValueToUsd(8090000000n, { address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", decimals: 6, native: false }, 2454.12)).to.be.closeTo(8090, 0.001);
    // A scale that could not be read is not a scale to divide by.
    expect(quoteValueToUsd(8090000000n, { address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", decimals: -1, native: false }, 2454.12)).to.equal(null);
  });
});

describe("PONS V4 pool volume", function () {
  const nativeQuote = { address: ethers.ZeroAddress, decimals: 18, native: true };
  const iface = new ethers.Interface(PONS_V4_SWAP_ABI);
  const POOL_ID = "0x" + "11".repeat(32);

  const swapLog = (amount0, amount1) => {
    const encoded = iface.encodeEventLog(iface.getEvent("Swap"), [
      POOL_ID,
      "0x2222222222222222222222222222222222222222",
      amount0,
      amount1,
      0n,
      0n,
      0,
      0,
    ]);
    return { address: PONS_V2_POOL_MANAGER, topics: encoded.topics, data: encoded.data };
  };

  const providerWith = (logs) => ({ getLogs: async () => logs });

  it("sums the quote side of the pool whichever currency it is, treating sells as volume too", async function () {
    const logs = [
      swapLog(1000000000000000000n, -2000000000000000000n),
      swapLog(-500000000000000000n, 3000000000000000000n),
    ];

    const quoteIsCurrency0 = await measurePonsV4Volume(providerWith(logs), {
      poolId: POOL_ID,
      quoteAsset: nativeQuote,
      quoteIsCurrency0: true,
      fromBlock: 100,
      toBlock: 105,
      nativeUsdPrice: 2000,
    });
    // The native side is currency0: 1e18 in on the buy, 0.5e18 out on the sell.
    expect(quoteIsCurrency0.volumeQuote).to.equal(1500000000000000000n);
    expect(quoteIsCurrency0.volumeUsd).to.equal(3000);
    expect(quoteIsCurrency0.swaps).to.equal(2);
    expect(quoteIsCurrency0.truncated).to.equal(false);

    const quoteIsCurrency1 = await measurePonsV4Volume(providerWith(logs), {
      poolId: POOL_ID,
      quoteAsset: nativeQuote,
      quoteIsCurrency0: false,
      fromBlock: 100,
      toBlock: 105,
      nativeUsdPrice: 2000,
    });
    expect(quoteIsCurrency1.volumeQuote).to.equal(5000000000000000000n);
    expect(quoteIsCurrency1.volumeUsd).to.equal(10000);
  });

  it("reports a failed chunk as a floor rather than a total", async function () {
    const partial = await measurePonsV4Volume({ getLogs: async () => { throw new Error("RANGE_TOO_WIDE"); } }, {
      poolId: POOL_ID,
      quoteAsset: nativeQuote,
      quoteIsCurrency0: true,
      fromBlock: 100,
      toBlock: 105,
      nativeUsdPrice: 2000,
    });
    expect(partial.truncated).to.equal(true);
    expect(partial.volumeQuote).to.equal(0n);
    expect(partial.volumeUsd).to.equal(0);
  });

  it("returns the raw quote volume but no dollar figure when the quote asset cannot be valued", async function () {
    const logs = [swapLog(1000000000n, 0n)];
    const unknownScale = await measurePonsV4Volume(providerWith(logs), {
      poolId: POOL_ID,
      quoteAsset: { address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", decimals: -1, native: false },
      quoteIsCurrency0: true,
      fromBlock: 100,
      toBlock: 105,
      nativeUsdPrice: 2000,
    });
    expect(unknownScale.volumeQuote).to.equal(1000000000n);
    expect(unknownScale.volumeUsd).to.equal(null);
  });
});

describe("PONS V2 sell path probe", function () {
  const TOKEN = "0x1111111111111111111111111111111111111111";
  const CURVE = "0x2222222222222222222222222222222222222222";
  const HOLDER = "0x3333333333333333333333333333333333333333";
  const ONE = ethers.zeroPadValue("0x01", 32);
  const ZERO = ethers.zeroPadValue("0x00", 32);

  it("reports an unmeasurable probe rather than a pass when the provider cannot run overrides", async function () {
    const result = await probeSellPath({ call: async () => ONE }, { token: TOKEN, curve: CURVE, holder: HOLDER });
    expect(result.status).to.equal(null);
    expect(result.detail).to.equal("PROVIDER_HAS_NO_RAW_SEND");
  });

  it("reports a holder with nothing to sell as unmeasured, not as blocked", async function () {
    const result = await probeSellPath({ call: async () => ZERO, send: async () => { throw new Error("UNEXPECTED_CALL"); } }, {
      token: TOKEN,
      curve: CURVE,
      holder: HOLDER,
    });
    expect(result.status).to.equal(null);
    expect(result.detail).to.equal("HOLDER_HAS_NO_BALANCE");
  });

  it("proves the sell path when both legs execute", async function () {
    let sends = 0;
    const provider = {
      call: async () => ethers.zeroPadValue("0x64", 32),
      send: async () => { sends += 1; return ONE; },
    };
    const result = await probeSellPath(provider, { token: TOKEN, curve: CURVE, holder: HOLDER });
    expect(result.status).to.equal("ok");
    expect(result.transferOk).to.equal(true);
    expect(result.sellOk).to.equal(true);
    expect(result.allowanceSlot).to.equal(0);
    expect(sends).to.equal(2);
  });

  it("marks a token that cannot move to the curve as blocked on the allowance-free leg", async function () {
    const provider = {
      call: async () => ethers.zeroPadValue("0x64", 32),
      send: async () => { throw new Error("TRANSFER_REVERTED"); },
    };
    const result = await probeSellPath(provider, { token: TOKEN, curve: CURVE, holder: HOLDER });
    expect(result.status).to.equal("blocked");
    expect(result.transferOk).to.equal(false);
    expect(result.sellOk).to.equal(null);
    expect(result.detail).to.equal("TRANSFER_REVERTED");
  });

  it("marks a token that transfers but never pays out as blocked on the sell leg", async function () {
    let sends = 0;
    const provider = {
      call: async () => ethers.zeroPadValue("0x64", 32),
      send: async () => {
        sends += 1;
        if (sends === 1) return ONE;
        throw new Error("EXECUTION_REVERTED");
      },
    };
    const result = await probeSellPath(provider, { token: TOKEN, curve: CURVE, holder: HOLDER, maxAllowanceSlot: 1 });
    expect(result.status).to.equal("blocked");
    expect(result.transferOk).to.equal(true);
    expect(result.sellOk).to.equal(false);
    expect(result.detail).to.contain("SELL_REVERTED");
    expect(sends).to.equal(3);
  });
});

describe("PONS token screen", function () {
  const TOKEN = "0x1111111111111111111111111111111111111111";
  const NATIVE = ethers.ZeroAddress;
  const CLEAN = "0x6080604052348015600f57600080fd5b50";
  const BURN = asciiBytecode("revert burn(x)"); // matches burnRisk only
  const LIQUIDITY = asciiBytecode("revert feeontransfer"); // matches liquidityRisk only

  const screen = (runtimeBytecode, extra = {}) =>
    new PonsTokenScreen().screen({ token: TOKEN, pairToken: NATIVE, runtimeBytecode, approvedBaseTokenAddresses: [], ...extra });

  it("accepts clean bytecode", async function () {
    const result = await screen(CLEAN);
    expect(result.accepted).to.equal(true);
    expect(result.rejectionReasons).to.deep.equal([]);
    expect(result.pairTokenKind).to.equal("NATIVE");
  });

  it("rejects a pair token outside the approved set before any order is built", async function () {
    const result = await screen(CLEAN, { pairToken: "0x9999999999999999999999999999999999999999" });
    expect(result.accepted).to.equal(false);
    expect(result.rejectionReasons).to.include(PONS_SCREEN_REJECTIONS.PAIR_TOKEN_UNSUPPORTED);
  });

  it("still computes the burn and liquidity risks when the rejections are switched off", async function () {
    const result = await screen(BURN);
    expect(result.contractRisk.burnRisk).to.equal(true);
    expect(result.accepted).to.equal(true);
    expect(result.rejectionReasons).to.deep.equal([]);
  });

  it("rejects a burn-pattern token only when rejectBurnRisk is set", async function () {
    const result = await screen(BURN, { rejectBurnRisk: true });
    expect(result.accepted).to.equal(false);
    expect(result.rejectionReasons).to.deep.equal([PONS_SCREEN_REJECTIONS.BURN_AUTHORITY]);
  });

  it("rejects a liquidity-pattern token only when rejectLiquidityRisk is set", async function () {
    const off = await screen(LIQUIDITY);
    expect(off.contractRisk.liquidityRisk).to.equal(true);
    expect(off.accepted).to.equal(true);

    const on = await screen(LIQUIDITY, { rejectLiquidityRisk: true });
    expect(on.accepted).to.equal(false);
    expect(on.rejectionReasons).to.deep.equal([PONS_SCREEN_REJECTIONS.LIQUIDITY_RISK]);
  });

  it("keeps the burn and liquidity switch independent", async function () {
    expect((await screen(LIQUIDITY, { rejectBurnRisk: true })).accepted).to.equal(true);
    expect((await screen(BURN, { rejectLiquidityRisk: true })).accepted).to.equal(true);
  });

  it("ships with both rejections off", function () {
    expect(config.ponsRejectBurnRisk).to.equal(false);
    expect(config.ponsRejectLiquidityRisk).to.equal(false);
  });
});

describe("Analysis queue event de-duplication", function () {
  // Reproduces the 420s live run of 2026-09-18: the `Recovered log:` backfill re-emitted events that were
  // already delivered, and two launches (0x7b4c9b22, 0xf27b369f) each ran the whole pipeline twice, reaching
  // two terminal would-buy decisions. These are the exact token/hash/logIndex values from that log; block
  // 66214681 is recorded only for reference, because block number is deliberately not part of the identity.
  const WITNESS = {
    token: "0x7B4c9b220e4150271c40b701f641686936a0470f",
    blockNumber: 66214681,
    transactionHash: "0x93632a82e312",
    logIndex: 4,
  };
  const launchKey = (overrides = {}) => {
    const event = { ...WITNESS, ...overrides };
    return AnalysisDedupe.key("pons-v2-launch", event.token, event.transactionHash, event.logIndex);
  };

  it("admits an event once and refuses the re-delivery of the same event", function () {
    const dedupe = new AnalysisDedupe();
    expect(dedupe.claim(launchKey())).to.equal(true);
    expect(dedupe.claim(launchKey())).to.equal(false);
    expect(dedupe.size).to.equal(1);
  });

  it("recognises the same event when the address or hash casing differs", function () {
    const dedupe = new AnalysisDedupe();
    expect(dedupe.claim(launchKey())).to.equal(true);
    expect(dedupe.claim(launchKey({ token: WITNESS.token.toLowerCase() }))).to.equal(false);
    expect(dedupe.claim(launchKey({ transactionHash: WITNESS.transactionHash.toUpperCase() }))).to.equal(false);
  });

  it("identifies an event without its block number, as persistence does", function () {
    // `BlockEventStore.hasEvent` keys on transaction hash + log index and ignores blockNumber, so the queue must
    // not re-admit an event merely because a re-delivery reported it at a different height.
    const dedupe = new AnalysisDedupe();
    expect(dedupe.claim(launchKey())).to.equal(true);
    expect(dedupe.claim(launchKey({ blockNumber: WITNESS.blockNumber + 1 }))).to.equal(false);
    expect(dedupe.size).to.equal(1);
  });

  it("keeps a token's graduation separate from its launch", function () {
    const dedupe = new AnalysisDedupe();
    expect(dedupe.claim(launchKey())).to.equal(true);
    const graduation = AnalysisDedupe.key("pons-v2-graduated", WITNESS.token, WITNESS.transactionHash, WITNESS.logIndex);
    expect(graduation).to.not.equal(launchKey());
    expect(dedupe.claim(graduation)).to.equal(true);
  });

  it("admits distinct events for the same token and the same event for another token", function () {
    const dedupe = new AnalysisDedupe();
    expect(dedupe.claim(launchKey())).to.equal(true);
    expect(dedupe.claim(launchKey({ logIndex: WITNESS.logIndex + 1 }))).to.equal(true);
    expect(dedupe.claim(launchKey({ transactionHash: "0xdeadbeef" }))).to.equal(true);
    expect(dedupe.claim(launchKey({ token: "0x1111111111111111111111111111111111111111" }))).to.equal(true);
    expect(dedupe.size).to.equal(4);
  });

  it("does not let one token's rejection suppress another token's analysis", function () {
    const dedupe = new AnalysisDedupe();
    for (const token of [WITNESS.token, "0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222"]) {
      expect(dedupe.claim(launchKey({ token }))).to.equal(true);
    }
    expect(dedupe.size).to.equal(3);
  });
});

describe("Bounded concurrent launch analysis", function () {
  // The live run serialized every launch: flushAnalyses awaited each analysis inside a loop, so the hop from
  // `PONS V2 LAUNCH DISCOVERED` to that launch's first `PONS SECURITY SCREEN` measured p50 5.97s and max
  // 24.93s while every stage *inside* a launch stayed under 2.5s. These tests pin the replacement: launches
  // overlap up to a ceiling, and the launch that does not fit starts as soon as one slot frees instead of
  // waiting for the launches ahead of it to finish.
  const deferred = () => {
    let resolve;
    const promise = new Promise((settle) => { resolve = settle; });
    return { promise, resolve };
  };
  const waitFor = async (predicate) => {
    for (let turn = 0; turn < 5000; turn += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error("CONDITION_NEVER_MET_FOR_TEST");
  };
  // A launch whose duration the test controls. Overlap is proven by ordering — which launches are in flight
  // while others are still running — rather than by wall clock, so the assertion cannot pass on timing luck.
  const gatedLaunch = (state, gate, id) => async () => {
    state.started.push(id);
    state.running += 1;
    state.peak = Math.max(state.peak, state.running);
    await gate.promise;
    state.running -= 1;
    state.finished.push(id);
  };
  const emptyState = () => ({ started: [], finished: [], running: 0, peak: 0 });

  it("overlaps five simultaneous launches instead of chaining them one after another", async function () {
    const pool = new ConcurrencyPool(4);
    const state = emptyState();
    const gates = [0, 1, 2, 3, 4].map(() => deferred());
    const launches = gates.map((gate, id) => pool.run(gatedLaunch(state, gate, id)));

    await waitFor(() => state.started.length === 4);
    // Four launches are in flight, nothing has finished, and the fifth is held at the ceiling rather than lost.
    expect(state.started).to.deep.equal([0, 1, 2, 3]);
    expect(state.finished).to.deep.equal([]);
    expect(pool.running).to.equal(4);
    expect(pool.queued).to.equal(1);

    // Freeing one slot admits the fifth launch while launches 1-3 are still running. A serialized queue could
    // not have started launch 4 until launches 0-3 had all finished — the chain this test rules out.
    gates[0].resolve();
    await waitFor(() => state.started.length === 5);
    expect(state.finished).to.deep.equal([0]);
    expect(state.running).to.equal(4);
    expect(pool.queued).to.equal(0);

    for (const gate of gates.slice(1)) gate.resolve();
    await Promise.all(launches);
    await pool.drain();
    expect(state.finished).to.deep.equal([0, 1, 2, 3, 4]);
    expect(state.peak).to.equal(4);
    expect(pool.running).to.equal(0);
    expect(pool.queued).to.equal(0);
  });

  it("runs five launches in two waves where a serialized queue took five", async function () {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const work = () => delay(120);
    const timed = async (run) => {
      const startedAt = Date.now();
      await run();
      return Date.now() - startedAt;
    };

    // The same five launches, once as the old loop and once through the pool. Both are measured in this
    // process under the same load, so the comparison is between the two shapes, not against a constant.
    const serialized = await timed(async () => { for (let index = 0; index < 5; index += 1) await work(); });
    const pool = new ConcurrencyPool(4);
    const pooled = await timed(async () => {
      await Promise.all([0, 1, 2, 3, 4].map(() => pool.run(work)));
      await pool.drain();
    });

    // Five launches one at a time are five waves; with four in flight they are two, so the pool should land
    // near 40% of the serialized chain. The 60% bound leaves room for scheduler jitter and is still far below
    // the 100% a still-serialized caller would measure.
    expect(serialized).to.be.greaterThan(400);
    expect(pooled).to.be.lessThan(serialized * 0.6);
  });

  it("refuses a concurrency limit that is not a positive integer", function () {
    for (const limit of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      let error;
      try { new ConcurrencyPool(limit); } catch (caught) { error = caught; }
      expect(error && error.message).to.equal("CONCURRENCY_LIMIT_MUST_BE_POSITIVE_INTEGER");
    }
    expect(new ConcurrencyPool(1).concurrencyLimit).to.equal(1);
    expect(new ConcurrencyPool(4).concurrencyLimit).to.equal(4);
  });

  it("keeps a failed launch from wedging the pool or the drain", async function () {
    const pool = new ConcurrencyPool(2);
    let error;
    try { await pool.run(async () => { throw new Error("CANDIDATE_PROCESSING_FAILED"); }); } catch (caught) { error = caught; }
    expect(error && error.message).to.equal("CANDIDATE_PROCESSING_FAILED");
    // A rejection has to release its slot and leave nothing outstanding, or one bad launch stalls the queue.
    expect(pool.running).to.equal(0);
    expect(await pool.run(async () => "OK")).to.equal("OK");
    await pool.drain();
    expect(pool.running).to.equal(0);
    expect(pool.queued).to.equal(0);
  });

  it("writes five concurrent position snapshots as one intact file", async function () {
    // Several launches can now register positions at once, and a snapshot is written to a fixed temporary path
    // before being renamed into place, so overlapping callers could rename each other's half-written file.
    // This asserts what serializing persist() preserves: one complete, parseable snapshot and no temporary
    // file left behind.
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-exit-"));
    const filePath = path.join(directory, "positions.json");
    const manager = await LiveExitManager.open({
      provider: {},
      wallet: { address: "0x9999999999999999999999999999999999999999" },
      quoterAddress: "0x1111111111111111111111111111111111111111",
      routerAddress: "0x2222222222222222222222222222222222222222",
      permit2Address: "0x3333333333333333333333333333333333333333",
      chainId: 4663,
      filePath,
      tuning: { enabled: true, milestonePercent: 100, tranchePercent: 20, slippageBps: 500, pollIntervalMs: 30000, maxAttempts: 3, deadlineSeconds: 120 },
      ensureApprovals: async () => {},
    });
    const tokens = [1, 2, 3, 4, 5].map((index) => `0x${index.toString(16).padStart(40, "0")}`);
    for (const token of tokens) {
      manager.register({ token, pairToken: ethers.ZeroAddress, tokenAmount: 1000n, committedWei: 10n, entryTransaction: `0xentry-${token}` });
    }

    await Promise.all([manager.persist(), manager.persist(), manager.persist(), manager.persist(), manager.persist()]);

    const stored = JSON.parse(await fs.readFile(filePath, "utf8"));
    expect(stored).to.have.length(5);
    expect(stored.map((position) => position.token)).to.deep.equal(tokens);
    const temporaryLeftBehind = await fs.stat(`${filePath}.tmp`).then(() => true, () => false);
    expect(temporaryLeftBehind).to.equal(false);
  });
});
