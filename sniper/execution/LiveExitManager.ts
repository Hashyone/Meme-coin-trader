import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ethers } from "ethers";
import { PonsV2PoolKey, PonsV2Resolver, buildPonsV2PoolKey } from "../discovery/PonsV2Resolver";
import { nonceManagerFor } from "./NonceManager";
import { PonsV2CurveAdapter, PonsV2CurveState, quoteCurveSellFromState } from "./PonsV2CurveAdapter";
import { PonsV4Quoter } from "./PonsV4Quoter";
import { PonsV4Router } from "./PonsV4Router";

export type LivePositionStatus = "OPEN" | "CLOSED" | "FAILED_EXIT";
export type LiveExitVenue = "PONS_V2_CURVE" | "UNISWAP_V4";

export interface LivePosition {
  id: string;
  token: string;
  pairToken: string;
  // A position is opened on exactly one venue: a bonding-curve launch carries `curve`, a graduated token
  // carries the Uniswap V4 `poolKey`. `poolKey` may also be filled in later, when a curve position graduates.
  curve?: string;
  poolKey?: PonsV2PoolKey;
  tokenAmount: bigint;
  remainingTokenAmount: bigint;
  committedWei: bigint;
  highestMilestone: number;
  consecutiveFailures: number;
  status: LivePositionStatus;
  openedAt: string;
  entryTransaction: string;
  exits: LiveExitEvent[];
}

export interface LiveExitEvent {
  milestone: number;
  amount: bigint;
  amountOut: bigint;
  amountOutMinimum: bigint;
  venue: LiveExitVenue;
  transactionHash: string;
  blockNumber: number;
  at: string;
}

// The venue has to be resolved per valuation pass, not per position: graduation closes the curve mid-flight
// and the same position must continue selling into the Uniswap V4 pool it migrated to.
type ResolvedExitVenue =
  | { kind: "curve"; adapter: PonsV2CurveAdapter; state: PonsV2CurveState }
  | { kind: "v4"; poolKey: PonsV2PoolKey };

export interface LiveExitTuning {
  enabled: boolean;
  milestonePercent: number;
  tranchePercent: number;
  slippageBps: number;
  pollIntervalMs: number;
  maxAttempts: number;
  deadlineSeconds: number;
}

export interface LiveExitOptions {
  provider: ethers.Provider;
  wallet: ethers.Wallet;
  quoterAddress: string;
  routerAddress: string;
  permit2Address: string;
  chainId: number;
  filePath: string;
  tuning: LiveExitTuning;
  ensureApprovals: (token: string, amount: bigint) => Promise<void>;
}

export interface LivePositionInput {
  token: string;
  pairToken: string;
  curve?: string;
  poolKey?: PonsV2PoolKey;
  tokenAmount: bigint;
  committedWei: bigint;
  entryTransaction: string;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function liveExitTuningFromEnv(defaultSlippageBps: number): LiveExitTuning {
  const milestonePercent = Math.max(1, Math.floor(positiveNumber(process.env.PONS_EXIT_MILESTONE_PERCENT, 100)));
  const tranchePercent = Math.min(100, Math.max(1, Math.floor(positiveNumber(process.env.PONS_EXIT_TRANCHE_PERCENT, 20))));
  return {
    enabled: (process.env.PONS_EXIT_ENABLED ?? "true").toLowerCase() !== "false",
    milestonePercent,
    tranchePercent,
    slippageBps: Math.max(1, Math.floor(positiveNumber(process.env.PONS_EXIT_SLIPPAGE_BPS, defaultSlippageBps))),
    pollIntervalMs: Math.max(5000, Math.floor(positiveNumber(process.env.PONS_EXIT_POLL_MS, 30000))),
    maxAttempts: Math.max(1, Math.floor(positiveNumber(process.env.PONS_EXIT_MAX_ATTEMPTS, 3))),
    deadlineSeconds: Math.max(30, Math.floor(positiveNumber(process.env.PONS_EXIT_DEADLINE_SECONDS, 120))),
  };
}

// JSON has no bigint, so positions round-trip through an explicitly widened shape rather than a replacer.
// `venue` is optional here only so positions written before curve trading was wired in still decode.
interface StoredPosition extends Omit<LivePosition, "tokenAmount" | "remainingTokenAmount" | "committedWei" | "exits"> {
  tokenAmount: string;
  remainingTokenAmount: string;
  committedWei: string;
  exits: Array<
    Omit<LiveExitEvent, "amount" | "amountOut" | "amountOutMinimum" | "venue"> & {
      venue?: LiveExitVenue;
      amount: string;
      amountOut: string;
      amountOutMinimum: string;
    }
  >;
}

const encodePosition = (position: LivePosition): StoredPosition => ({
  ...position,
  tokenAmount: position.tokenAmount.toString(),
  remainingTokenAmount: position.remainingTokenAmount.toString(),
  committedWei: position.committedWei.toString(),
  exits: position.exits.map((exit) => ({
    ...exit,
    amount: exit.amount.toString(),
    amountOut: exit.amountOut.toString(),
    amountOutMinimum: exit.amountOutMinimum.toString(),
  })),
});

const decodePosition = (stored: StoredPosition): LivePosition => ({
  ...stored,
  tokenAmount: BigInt(stored.tokenAmount),
  remainingTokenAmount: BigInt(stored.remainingTokenAmount),
  committedWei: BigInt(stored.committedWei),
  consecutiveFailures: stored.consecutiveFailures ?? 0,
  exits: (stored.exits ?? []).map((exit) => ({
    ...exit,
    venue: exit.venue ?? "UNISWAP_V4",
    amount: BigInt(exit.amount),
    amountOut: BigInt(exit.amountOut),
    amountOutMinimum: BigInt(exit.amountOutMinimum),
  })),
});

/**
 * Owns the live take-profit side of the trade: it records what a confirmed buy actually filled, values the
 * remaining tokens on the venue that currently holds them (the bonding curve before graduation, the Uniswap V4
 * pool afterwards), and sells a tranche every time the position's value clears another profit milestone. A
 * healthy position here means the sniper no longer buys and holds forever.
 *
 * The milestone signal is deliberately computed from the *original* size (`tokenAmount`) re-priced at the
 * current price, not from the shrinking remainder: after a 20% tranche the remainder is worth less, so a
 * remainder-based percentage would stall and never reach the next milestone.
 */
export class LiveExitManager {
  private readonly positions = new Map<string, LivePosition>();
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private persistChain: Promise<void> = Promise.resolve();

  private constructor(private readonly options: LiveExitOptions, positions: LivePosition[]) {
    for (const position of positions) this.positions.set(position.id, position);
  }

  static async open(options: LiveExitOptions): Promise<LiveExitManager> {
    try {
      const stored = JSON.parse(await readFile(options.filePath, "utf8")) as StoredPosition[];
      const positions = stored.map(decodePosition).filter((position) => position.status === "OPEN");
      return new LiveExitManager(options, positions);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return new LiveExitManager(options, []);
    }
  }

  get tuning(): LiveExitTuning {
    return this.options.tuning;
  }

  positionsOf(): LivePosition[] {
    return [...this.positions.values()];
  }

  openPositions(): LivePosition[] {
    return this.positionsOf().filter((position) => position.status === "OPEN" && position.remainingTokenAmount > 0n);
  }

  snapshot(): Array<Record<string, string | number>> {
    return this.positionsOf().map((position) => ({
      id: position.id,
      token: position.token,
      status: position.status,
      tokenAmount: position.tokenAmount.toString(),
      remainingTokenAmount: position.remainingTokenAmount.toString(),
      committedWei: position.committedWei.toString(),
      highestMilestone: position.highestMilestone,
      exits: position.exits.length,
    }));
  }

  register(input: LivePositionInput): LivePosition | undefined {
    if (input.tokenAmount <= 0n) {
      console.log("PONS EXIT POSITION SKIPPED:", { token: input.token, reason: "ZERO_TOKEN_AMOUNT", transactionHash: input.entryTransaction });
      return undefined;
    }
    const position: LivePosition = {
      id: `${input.token.toLowerCase()}-${Date.now().toString(36)}`,
      token: input.token,
      pairToken: input.pairToken,
      curve: input.curve,
      poolKey: input.poolKey,
      tokenAmount: input.tokenAmount,
      remainingTokenAmount: input.tokenAmount,
      committedWei: input.committedWei,
      highestMilestone: 0,
      consecutiveFailures: 0,
      status: "OPEN",
      openedAt: new Date().toISOString(),
      entryTransaction: input.entryTransaction,
      exits: [],
    };
    this.positions.set(position.id, position);
    console.log("PONS EXIT POSITION OPENED:", {
      id: position.id,
      token: position.token,
      venue: position.curve ? "PONS_V2_CURVE" : "UNISWAP_V4",
      curve: position.curve,
      poolId: position.poolKey?.poolId,
      tokenAmount: position.tokenAmount.toString(),
      committedWei: position.committedWei.toString(),
      milestonePercent: this.options.tuning.milestonePercent,
      tranchePercent: this.options.tuning.tranchePercent,
      entryTransaction: position.entryTransaction,
    });
    return position;
  }

  /**
   * A snapshot is written as "write the whole file to a fixed temporary path, then rename it into place". Two
   * callers running that pair concurrently interleave: one renames the other's half-written temporary file, or
   * finds it already gone and fails with ENOENT. The entry path can now register positions concurrently, so the
   * writes are chained — each snapshot finishes writing and renaming before the next one starts. The chain
   * absorbs a failure so one bad snapshot does not reject every later persist, while the caller that asked for
   * that snapshot still receives the rejection.
   */
  persist(): Promise<void> {
    const write = this.persistChain.then(() => this.writeSnapshot());
    this.persistChain = write.catch(() => undefined);
    return write;
  }

  private async writeSnapshot(): Promise<void> {
    await mkdir(dirname(this.options.filePath), { recursive: true });
    const temporaryPath = `${this.options.filePath}.tmp`;
    const payload = this.positionsOf().map(encodePosition);
    await writeFile(temporaryPath, JSON.stringify(payload, null, 2), "utf8");
    await rename(temporaryPath, this.options.filePath);
  }

  start(): void {
    if (!this.options.tuning.enabled) {
      console.log("PONS EXIT SCHEDULER DISABLED:", { reason: "PONS_EXIT_ENABLED_FALSE" });
      return;
    }
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.tuning.pollIntervalMs);
    this.timer.unref();
    console.log("PONS EXIT SCHEDULER STARTED:", {
      positions: this.openPositions().length,
      pollIntervalMs: this.options.tuning.pollIntervalMs,
      milestonePercent: this.options.tuning.milestonePercent,
      tranchePercent: this.options.tuning.tranchePercent,
      slippageBps: this.options.tuning.slippageBps,
    });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.evaluateOnce();
    } catch (error) {
      console.error("PONS EXIT EVALUATION FAILED:", { reason: error instanceof Error ? error.message : String(error) });
    } finally {
      this.ticking = false;
    }
  }

  /**
   * One valuation pass over every open position. Public so a caller can drive the schedule from the block
   * stream instead of a timer without changing the sell path.
   */
  async evaluateOnce(): Promise<LiveExitEvent[]> {
    const emitted: LiveExitEvent[] = [];
    for (const position of this.openPositions()) {
      try {
        emitted.push(...(await this.evaluatePosition(position)));
      } catch (error) {
        console.error("PONS EXIT POSITION EVALUATION FAILED:", {
          id: position.id,
          token: position.token,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return emitted;
  }

  private async evaluatePosition(position: LivePosition): Promise<LiveExitEvent[]> {
    const { tuning } = this.options;
    const venue = await this.resolveVenue(position);
    // Re-price the original size at the current price so the milestone ladder measures the trade, not the remainder.
    const currentValueWei = await this.valueOnVenue(position, venue);
    if (currentValueWei <= 0n) return [];
    if (currentValueWei <= position.committedWei) return [];
    const profitPercent = Number((currentValueWei - position.committedWei) * 100n / position.committedWei);
    const targetMilestone = Math.floor(profitPercent / tuning.milestonePercent) * tuning.milestonePercent;
    if (targetMilestone < position.highestMilestone + tuning.milestonePercent) return [];

    // Plan the ladder against a virtual remainder so a single large jump takes 20% then 20%-of-80%, and so a
    // failed tranche cannot advance the ratchet: nothing is committed until a receipt confirms.
    const steps: Array<{ milestone: number; amount: bigint }> = [];
    let virtualRemaining = position.remainingTokenAmount;
    let milestone = position.highestMilestone;
    while (milestone + tuning.milestonePercent <= targetMilestone && virtualRemaining > 0n) {
      milestone += tuning.milestonePercent;
      const amount = virtualRemaining * BigInt(tuning.tranchePercent) / 100n;
      if (amount <= 0n) break;
      virtualRemaining -= amount;
      steps.push({ milestone, amount });
    }

    const emitted: LiveExitEvent[] = [];
    for (const step of steps) {
      if (position.remainingTokenAmount < step.amount) break;
      try {
        const event = await this.sellTranche(position, step.amount, step.milestone, venue);
        position.remainingTokenAmount -= step.amount;
        position.highestMilestone = step.milestone;
        position.consecutiveFailures = 0;
        position.exits.push(event);
        emitted.push(event);
        if (position.remainingTokenAmount <= 0n) {
          position.status = "CLOSED";
          break;
        }
      } catch (error) {
        position.consecutiveFailures += 1;
        if (position.consecutiveFailures >= tuning.maxAttempts) position.status = "FAILED_EXIT";
        console.error("PONS EXIT TRANCHE FAILED:", {
          id: position.id,
          token: position.token,
          milestone: step.milestone,
          amount: step.amount.toString(),
          consecutiveFailures: position.consecutiveFailures,
          status: position.status,
          reason: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }
    await this.persist();
    return emitted;
  }

  /**
   * A curve position stays on the curve until graduation; once the curve reports closed the same position is
   * re-homed onto the Uniswap V4 pool the token migrated to. A V4 position resolves its pool key lazily so a
   * position recorded before graduation still finds its pool.
   */
  private async resolveVenue(position: LivePosition): Promise<ResolvedExitVenue> {
    const { provider, chainId, wallet } = this.options;
    if (position.curve) {
      const adapter = new PonsV2CurveAdapter(provider, position.curve, chainId);
      const state = await adapter.readState(wallet.address);
      if (!state.graduated && !state.readyToGraduate) return { kind: "curve", adapter, state };
      console.log("PONS EXIT VENUE MIGRATED:", {
        id: position.id,
        token: position.token,
        curve: position.curve,
        reason: "PONS_CURVE_CLOSED",
        graduated: state.graduated,
        readyToGraduate: state.readyToGraduate,
      });
    }
    if (position.poolKey) return { kind: "v4", poolKey: position.poolKey };
    const launch = await new PonsV2Resolver(provider).resolve(position.token, true);
    const key = buildPonsV2PoolKey(launch);
    if (!key.ok) throw new Error(key.reason);
    position.poolKey = key.poolKey;
    return { kind: "v4", poolKey: key.poolKey };
  }

  /**
   * Values the original position size at the current venue price by quoting the remainder and scaling up. Both
   * venues are quoted this way so the milestone ladder stays comparable across a mid-flight venue change.
   */
  private async valueOnVenue(position: LivePosition, venue: ResolvedExitVenue): Promise<bigint> {
    if (venue.kind === "curve") {
      const quote = quoteCurveSellFromState(venue.state, position.remainingTokenAmount);
      if (quote.quoteOut <= 0n) return 0n;
      return quote.quoteOut * position.tokenAmount / position.remainingTokenAmount;
    }
    const probe = await new PonsV4Quoter(this.options.provider, this.options.quoterAddress).quoteExactInput(venue.poolKey, position.token, position.remainingTokenAmount);
    if (probe.amountOut <= 0n) return 0n;
    return probe.amountOut * position.tokenAmount / position.remainingTokenAmount;
  }

  private async sellTranche(position: LivePosition, amount: bigint, milestone: number, venue: ResolvedExitVenue): Promise<LiveExitEvent> {
    return venue.kind === "curve"
      ? this.sellTrancheOnCurve(position, amount, milestone, venue)
      : this.sellTrancheOnV4(position, amount, milestone, venue.poolKey);
  }

  /**
   * Sells a tranche back into the bonding curve. The curve pays out the pair token (native ETH for a native
   * quote) to `recipient`, so the proceeds land in the same wallet that signed the buy.
   */
  private async sellTrancheOnCurve(
    position: LivePosition,
    amount: bigint,
    milestone: number,
    venue: Extract<ResolvedExitVenue, { kind: "curve" }>,
  ): Promise<LiveExitEvent> {
    const { provider, wallet, chainId, tuning } = this.options;
    const quote = quoteCurveSellFromState(venue.state, amount);
    if (quote.quoteOut <= 0n) throw new Error("PONS_EXIT_QUOTE_ZERO");
    const amountOutMinimum = quote.quoteOut * BigInt(10000 - tuning.slippageBps) / 10000n;
    if (amountOutMinimum <= 0n) throw new Error("PONS_EXIT_MINIMUM_ZERO");

    // Selling the launch token makes it the swap input, and the curve pulls it with transferFrom, so the token
    // approves the curve itself. Approvals cost gas, so the wallet's token balance is checked first: an exit for
    // a position the wallet no longer holds must not pay to approve it.
    const funding = await venue.adapter.inspectInputReadiness(position.token, wallet.address, amount);
    if (!funding.ready && funding.balance < amount) throw new Error("PONS_CURVE_INPUT_BALANCE_TOO_LOW");
    await venue.adapter.ensureAllowance(wallet, position.token, amount);
    const readiness = await venue.adapter.inspectInputReadiness(position.token, wallet.address, amount);
    if (!readiness.ready) throw new Error(readiness.reason ?? "PONS_CURVE_ALLOWANCE_MISSING");
    const transaction = venue.adapter.buildSell(amount, amountOutMinimum, wallet.address);
    // Same headroom as the buy side: estimateGas returns the minimum that succeeded in simulation, and the first
    // live curve buy sent at its bare estimate reverted having burned gasUsed == gasLimit. This path is the only
    // one that returns the trade's proceeds, so it keeps room for state drift between simulation and inclusion.
    const gasLimit = ((await venue.adapter.simulate(transaction, wallet.address)) * 13000n) / 10000n;
    const nonceManager = nonceManagerFor(provider, wallet.address);
    const nonce = await nonceManager.reserve();
    const feeData = await provider.getFeeData();
    const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
    if (!maxFeePerGas) throw new Error("PONS_EXIT_FEE_DATA_UNAVAILABLE");
    console.log("PONS EXIT TRANCHE BROADCAST:", {
      id: position.id,
      venue: "PONS_V2_CURVE",
      token: position.token,
      curve: transaction.to,
      milestone,
      amount: amount.toString(),
      amountOut: quote.quoteOut.toString(),
      amountOutMinimum: amountOutMinimum.toString(),
      nonce,
    });
    const response = await wallet.sendTransaction({
      to: transaction.to,
      data: transaction.data,
      value: transaction.value,
      chainId,
      gasLimit,
      nonce,
      maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? maxFeePerGas,
    });
    const receipt = await response.wait();
    if (!receipt || receipt.status !== 1) throw new Error("PONS_EXIT_RECEIPT_FAILED");
    const event: LiveExitEvent = {
      milestone,
      amount,
      amountOut: quote.quoteOut,
      amountOutMinimum,
      venue: "PONS_V2_CURVE",
      transactionHash: response.hash,
      blockNumber: receipt.blockNumber,
      at: new Date().toISOString(),
    };
    console.log("PONS EXIT TRANCHE CONFIRMED:", {
      id: position.id,
      venue: "PONS_V2_CURVE",
      token: position.token,
      milestone,
      amount: amount.toString(),
      amountOut: quote.quoteOut.toString(),
      transactionHash: response.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      remainingTokenAmount: (position.remainingTokenAmount - amount).toString(),
      proceedsTo: wallet.address,
    });
    return event;
  }

  private async sellTrancheOnV4(position: LivePosition, amount: bigint, milestone: number, poolKey: PonsV2PoolKey): Promise<LiveExitEvent> {
    const { provider, wallet, quoterAddress, routerAddress, permit2Address, chainId, tuning, ensureApprovals } = this.options;
    const quoter = new PonsV4Quoter(provider, quoterAddress);
    const quote = await quoter.quoteExactInput(poolKey, position.token, amount);
    if (quote.amountOut <= 0n) throw new Error("PONS_EXIT_QUOTE_ZERO");
    const amountOutMinimum = quote.amountOut * BigInt(10000 - tuning.slippageBps) / 10000n;
    if (amountOutMinimum <= 0n) throw new Error("PONS_EXIT_MINIMUM_ZERO");

    // Selling the launch token makes it the swap input, so the token itself needs the ERC20 -> Permit2 ->
    // router hop that the buy path only ever established for the pair token. The approvals are real
    // transactions, so the wallet's token balance is checked first: an exit for a position the wallet no
    // longer holds must not pay gas to approve it.
    const router = new PonsV4Router(provider, routerAddress, chainId);
    const funding = await router.inspectInputReadiness(position.token, wallet.address, amount, permit2Address);
    if (funding.balance < amount) throw new Error("PONS_V4_INPUT_BALANCE_TOO_LOW");
    await ensureApprovals(position.token, amount);
    const readiness = await router.inspectInputReadiness(position.token, wallet.address, amount, permit2Address);
    if (!readiness.ready) throw new Error(readiness.reason ?? "PONS_EXIT_INPUT_NOT_READY");
    const transaction = router.buildExactInputSingle(
      poolKey,
      position.token,
      amount,
      amountOutMinimum,
      BigInt(Math.floor(Date.now() / 1000) + tuning.deadlineSeconds),
      wallet.address,
    );
    const gasLimit = await router.simulate(transaction, wallet.address);
    const nonceManager = nonceManagerFor(provider, wallet.address);
    const nonce = await nonceManager.reserve();
    const feeData = await provider.getFeeData();
    const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
    if (!maxFeePerGas) throw new Error("PONS_EXIT_FEE_DATA_UNAVAILABLE");
    console.log("PONS EXIT TRANCHE BROADCAST:", {
      id: position.id,
      token: position.token,
      milestone,
      amount: amount.toString(),
      amountOut: quote.amountOut.toString(),
      amountOutMinimum: amountOutMinimum.toString(),
      zeroForOne: quote.zeroForOne,
      nonce,
    });
    const response = await wallet.sendTransaction({
      ...transaction,
      gasLimit,
      nonce,
      maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? maxFeePerGas,
    });
    const receipt = await response.wait();
    if (!receipt || receipt.status !== 1) throw new Error("PONS_EXIT_RECEIPT_FAILED");
    const event: LiveExitEvent = {
      milestone,
      amount,
      amountOut: quote.amountOut,
      amountOutMinimum,
      venue: "UNISWAP_V4",
      transactionHash: response.hash,
      blockNumber: receipt.blockNumber,
      at: new Date().toISOString(),
    };
    console.log("PONS EXIT TRANCHE CONFIRMED:", {
      id: position.id,
      venue: "UNISWAP_V4",
      token: position.token,
      milestone,
      amount: amount.toString(),
      amountOut: quote.amountOut.toString(),
      transactionHash: response.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      remainingTokenAmount: (position.remainingTokenAmount - amount).toString(),
      proceedsTo: wallet.address,
    });
    return event;
  }
}
