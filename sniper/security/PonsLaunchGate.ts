import { ethers } from "ethers";

export const PONS_LAUNCH_GATE_REASONS = {
  STALE_LAUNCH: "PONS_LAUNCH_STALE",
  LIQUIDITY_BELOW_THRESHOLD_PCT: "PONS_LAUNCH_LIQUIDITY_BELOW_THRESHOLD_PCT",
  TOLL_TOO_HIGH: "PONS_LAUNCH_TOLL_TOO_HIGH",
  CREATOR_BAG_UNSOLD: "PONS_LAUNCH_CREATOR_BAG_UNSOLD",
  CREATOR_HOLDING_UNKNOWN: "PONS_LAUNCH_CREATOR_HOLDING_UNKNOWN",
  BUNDLE_ABOVE_CEILING: "PONS_LAUNCH_BUNDLE_ABOVE_CEILING",
  BUNDLE_MEASUREMENT_UNKNOWN: "PONS_LAUNCH_BUNDLE_MEASUREMENT_UNKNOWN",
  LAUNCH_ALLOCATION_ABOVE_CEILING: "PONS_LAUNCH_ALLOCATION_ABOVE_CEILING",
  LAUNCH_ALLOCATION_UNKNOWN: "PONS_LAUNCH_ALLOCATION_UNKNOWN",
  BUYBACK_ENABLED: "PONS_LAUNCH_BUYBACK_ENABLED",
  INSIDER_SUPPLY_ABOVE_CEILING: "PONS_LAUNCH_INSIDER_SUPPLY_ABOVE_CEILING",
  INSIDER_SUPPLY_UNKNOWN: "PONS_LAUNCH_INSIDER_SUPPLY_UNKNOWN",
  SAME_BLOCK_SHARE_ABOVE_CEILING: "PONS_LAUNCH_SAME_BLOCK_SHARE_ABOVE_CEILING",
  SAME_BLOCK_SHARE_UNKNOWN: "PONS_LAUNCH_SAME_BLOCK_SHARE_UNKNOWN",
  SEQUENTIAL_BLOCK_SHARE_ABOVE_CEILING: "PONS_LAUNCH_SEQUENTIAL_BLOCK_SHARE_ABOVE_CEILING",
  SEQUENTIAL_BLOCK_SHARE_UNKNOWN: "PONS_LAUNCH_SEQUENTIAL_BLOCK_SHARE_UNKNOWN",
  PEER_TRANSFER_SHARE_ABOVE_CEILING: "PONS_LAUNCH_PEER_TRANSFER_SHARE_ABOVE_CEILING",
  PEER_TRANSFER_SHARE_UNKNOWN: "PONS_LAUNCH_PEER_TRANSFER_SHARE_UNKNOWN",
  SELL_PATH_BLOCKED: "PONS_LAUNCH_SELL_PATH_BLOCKED",
  SELL_PATH_UNKNOWN: "PONS_LAUNCH_SELL_PATH_UNKNOWN",
  GRADUATED_LIQUIDITY_BELOW_FLOOR: "PONS_GRADUATED_LIQUIDITY_BELOW_FLOOR",
  GRADUATED_LIQUIDITY_UNKNOWN: "PONS_GRADUATED_LIQUIDITY_UNKNOWN",
  GRADUATED_VOLUME_BELOW_FLOOR: "PONS_GRADUATED_VOLUME_BELOW_FLOOR",
  GRADUATED_VOLUME_UNKNOWN: "PONS_GRADUATED_VOLUME_UNKNOWN",
} as const;

export interface PonsLaunchGatePolicy {
  /** Quote reserve floor expressed as a percentage of the curve's own `graduationThreshold`. */
  minThresholdPct: number;
  /** Ceiling on `feeBps + creatorTaxBps + snipeTaxBps`; a round trip pays this twice. */
  maxTollBps: number;
  /** Reject a launch more than this many blocks old. At ~10 blocks/second this is the entry-latency budget. */
  maxEntryAgeBlocks: number;
  /**
   * Reject when the creator still holds MORE than this share of supply at entry. 0 disables the check (and
   * its two reads). This is a ceiling, not a floor: see the measured rationale on `evaluatePonsLaunchQuality`.
   */
  maxCreatorHoldingPct: number;
  /**
   * Reject when the supply bought inside the entry window is COORDINATED beyond this share - that is, when
   * wallets fed by one sender that fed at least two of them hold more than this percentage of supply. 0
   * disables the check (and its reads). Measured over 52 live launches: a 30% ceiling refuses 3 of them
   * (5.8%), and those three are exactly the launches with a 13-24 wallet operator fan-out. A funding-based
   * metric scores all three under 1%. See `EarlySupplyConcentration`.
   */
  maxBundleSupplyPct: number;
  /**
   * Reject when the LAUNCH TRANSACTION itself allocated more than this share of supply to addresses outside
   * the curve, i.e. a free allocation nobody bought. 0 disables the check. This is a separate signal from
   * `maxBundleSupplyPct` and near-disjoint from it: over 52 live launches each refuses 7 at a 15% ceiling but
   * they share only one launch, so the union is 13. Unlike the sender metric, which needs a window of buys
   * to develop, this is fully determined the moment the launch block is read.
   */
  maxLaunchAllocSharePct: number;
  /** Reject a launch whose curve already has buyback enabled - a creator-controlled dump switch. */
  rejectBuybackEnabled: boolean;
  /**
   * Reject when the insiders - every wallet that first received inside the window, every launch-transaction
   * allocation recipient, and the deployer - still hold more than this share of supply at entry. 0 disables
   * the check. This is the literal "do the insiders hold the majority" test, and by construction it is
   * largely inert on this launchpad: the curve mints 100% of supply to itself and still holds ~99.98% at
   * entry, so the insider share is capped by whatever the curve has released. Measured maximum over 52 live
   * launches was 40.4%. A 50% ceiling therefore refuses nothing today; it is a tripwire for the moment the
   * released share grows (a curve that graduates inside the entry window), not a rug filter.
   */
  maxInsiderSupplyPct: number;
  /**
   * Reject when more than this share of supply landed in wallets whose FIRST receipt came in a block that
   * delivered the token to at least two distinct wallets - a shared-block fan-out that needs no shared
   * sender. 0 disables the check. This is the "same block transactions between insider wallets" signal.
   */
  maxSameBlockSharePct: number;
  /**
   * Reject when more than this share of supply landed in wallets whose first-receipt block is adjacent to
   * another first-receipt block fed by a DIFFERENT sender - the "sequential block" coordination signal. One
   * sender spreading its own wallets across consecutive blocks is NOT flagged, by design: that is a single
   * operator, which `maxBundleSupplyPct` already measures. 0 disables the check.
   */
  maxSequentialBlockSharePct: number;
  /**
   * Reject when more than this share of supply moved between two in-window holders during the window - the
   * wash-trading signal ("same wallets interacting with one another to fake buy volume"). 0 disables.
   */
  maxPeerTransferSharePct: number;
  /**
   * Reject unless a simulated sell leg succeeds. This is the only honeypot test that cannot be faked: the
   * bytecode screen can only pattern-match, while this actually executes `transfer(curve)` and `sell(...)`
   * against a real holder's balance via `eth_call`. It costs two RPC calls and no gas. Fail-closed: once
   * enabled, an unmeasurable sell path rejects.
   */
  requireSellPath: boolean;
  /** Graduated-lane pool liquidity floor in USD. 0 disables the check. */
  graduatedMinLiquidityUsd: number;
  /** Graduated-lane quote-volume floor in USD. 0 disables the check. */
  graduatedMinVolumeUsd: number;
}

export interface LaunchFreshnessInput {
  launchBlock: number;
  headBlock: number;
  maxEntryAgeBlocks: number;
}

export interface LaunchFreshnessResult {
  ok: boolean;
  ageBlocks: number;
  reason?: string;
}

export type SellPathStatus = "ok" | "blocked" | null;

export interface PonsLaunchQualityInput {
  quoteReserve: bigint;
  graduationThreshold: bigint;
  feeBps: number;
  creatorTaxBps: number;
  snipeTaxBps: number;
  buybackEnabled: boolean;
  creatorHoldingPct: number | null;
  bundleSupplyPct: number | null;
  launchAllocSharePct: number | null;
  insiderSharePct: number | null;
  sameBlockSharePct: number | null;
  sequentialBlockSharePct: number | null;
  peerTransferSharePct: number | null;
  sellPath: SellPathStatus;
  policy: Pick<
    PonsLaunchGatePolicy,
    | "minThresholdPct"
    | "maxTollBps"
    | "maxCreatorHoldingPct"
    | "maxBundleSupplyPct"
    | "maxLaunchAllocSharePct"
    | "rejectBuybackEnabled"
    | "maxInsiderSupplyPct"
    | "maxSameBlockSharePct"
    | "maxSequentialBlockSharePct"
    | "maxPeerTransferSharePct"
    | "requireSellPath"
  >;
}

export interface PonsLaunchQualityResult {
  accepted: boolean;
  reasons: string[];
  metrics: {
    thresholdPct: number;
    tollBps: number;
    creatorHoldingPct: number | null;
    bundleSupplyPct: number | null;
    launchAllocSharePct: number | null;
    insiderSharePct: number | null;
    sameBlockSharePct: number | null;
    sequentialBlockSharePct: number | null;
    peerTransferSharePct: number | null;
    sellPath: SellPathStatus;
  };
}

/**
 * The 2026-09-17 fill executed 29,278 blocks (49 minutes) after its launch block: a pre-approved buy waited
 * for bridging funds to arrive and then fired, long after the launch it was priced against. Age is the only
 * signal that separates a snipe from a stale fill, and it is cheap enough to check before any other work.
 */
export function evaluateLaunchFreshness(input: LaunchFreshnessInput): LaunchFreshnessResult {
  const ageBlocks = input.headBlock - input.launchBlock;
  if (ageBlocks > input.maxEntryAgeBlocks) {
    return { ok: false, ageBlocks, reason: PONS_LAUNCH_GATE_REASONS.STALE_LAUNCH };
  }
  return { ok: true, ageBlocks };
}

/**
 * A launch-lane quality gate that reads only what the resolver and the curve already return.
 *
 * A literal dollar floor cannot work at entry. Every PONS V2 curve is seeded at exactly 40% of its own
 * `graduationThreshold`, and that threshold is a single constant per quote asset - 4.2e18 wei ($10,307) for
 * every native launch and 8.09e9 ($8,090) for every USDG launch, measured across 2,276 launches. The
 * threshold is the quote a curve must *accumulate* to graduate, so a $10,000 native liquidity floor is the
 * graduation event itself and rejects 100% of launch entries, and $10,000 of volume at t+3s is zero for
 * every token because the only trade that has happened is the launch's own seed buy. Expressing the launch
 * floor as a share of the curve's own threshold keeps the check meaningful on every quote asset instead of
 * being a constant that carries no market information.
 *
 * The creator check is a CEILING, and that direction was measured rather than assumed. Reading the creator's
 * balance at t+3s and again later gives opposite answers, because the bag only exists in the first seconds:
 * over 37 launches, 11 held something at t+3s but only 4 still did by the time the sample was read. Taking
 * the late reading - as the earlier 2,276-launch census did - makes the signal look like a constant zero and
 * hides it entirely. Re-reading at the launch block (this RPC does serve historical state) and comparing
 * each of those launches against its own curve's quote reserve at launch and now separates them cleanly:
 *
 *   creator held >= 1% at t+3s : 7 of 8 curves (88%) ended up net-drained
 *   creator held <  1% at t+3s : 1 of 29 curves (3%) ended up net-drained
 *
 * and the drained amount tracks the unsold bag almost exactly (5.98% held -> -5.98% of seed quote withdrawn,
 * 5.45% -> -5.16%, 4.44% -> -4.26%, 4.07% -> -4.01%, 3.96% -> -3.70%). A creator holding a bag at entry is
 * the rug signal; a creator holding nothing has nothing left to sell into the curve. Rejecting >= 1% would
 * have removed 7 of those 8 drained curves for the cost of 21.6% of launch flow.
 *
 * The bundle check is the second ceiling, and like the creator check it is a ceiling rather than a floor
 * because being bundled is not by itself disqualifying - a creator has every reason to seed activity in its
 * own launch. What must not be true is that the bundle controls the MAJORITY of supply. Over 52 live launches
 * the coordinated share (one in-window sender fanning the token to >= 2 wallets) stayed under 41% at its
 * worst, 13 launches crossed 10%, 4 crossed 20%, 3 crossed 30%, and none reached a majority. A 30% ceiling
 * therefore refuses 5.8% of live flow and every one of the three launches it refuses is a genuine operator
 * fan-out of 13-24 wallets. The stricter 40% ceiling refuses one launch in 52.
 *
 * The last group - insider share, same-block, sequential-block and peer-transfer ceilings - all read the same
 * concentration result as the bundle check. They answer the user's four remaining asks, and one of them has to
 * be stated honestly rather than dressed up: "do the insiders hold the majority of the supply" cannot be true
 * on this launchpad at entry, because the curve mints 100% of supply to itself and still holds ~99.98% of it,
 * so every non-curve wallet combined is bounded by the ~0.02% released plus whatever a buyer took. The
 * measured maximum insider share over 52 launches was 40.4% - and that figure counts a wallet as an insider
 * the moment it buys in the entry window, so it is mostly ordinary buyers. A 50% majority ceiling is
 * therefore a tripwire, not a filter, and is documented as such. The signals that DO discriminate are the
 * coordination ones: same-block fan-out (needs no shared sender, only a shared block), sequential-block
 * fan-out between DIFFERENT senders, and holder-to-holder transfers inside the window, which is the direct
 * "same wallets interacting with one another to fake buy volume" measure.
 */
export function evaluatePonsLaunchQuality(input: PonsLaunchQualityInput): PonsLaunchQualityResult {
  const reasons: string[] = [];
  const thresholdPct = percentOf(input.quoteReserve, input.graduationThreshold);
  const tollBps = input.feeBps + input.creatorTaxBps + input.snipeTaxBps;

  if (thresholdPct === null) {
    reasons.push(PONS_LAUNCH_GATE_REASONS.LIQUIDITY_BELOW_THRESHOLD_PCT);
  } else if (thresholdPct < input.policy.minThresholdPct) {
    reasons.push(PONS_LAUNCH_GATE_REASONS.LIQUIDITY_BELOW_THRESHOLD_PCT);
  }
  if (tollBps > input.policy.maxTollBps) reasons.push(PONS_LAUNCH_GATE_REASONS.TOLL_TOO_HIGH);
  if (input.policy.rejectBuybackEnabled && input.buybackEnabled) reasons.push(PONS_LAUNCH_GATE_REASONS.BUYBACK_ENABLED);

  if (input.policy.maxCreatorHoldingPct > 0) {
    if (input.creatorHoldingPct === null) reasons.push(PONS_LAUNCH_GATE_REASONS.CREATOR_HOLDING_UNKNOWN);
    else if (input.creatorHoldingPct > input.policy.maxCreatorHoldingPct) reasons.push(PONS_LAUNCH_GATE_REASONS.CREATOR_BAG_UNSOLD);
  }

  if (input.policy.maxBundleSupplyPct > 0) {
    if (input.bundleSupplyPct === null) reasons.push(PONS_LAUNCH_GATE_REASONS.BUNDLE_MEASUREMENT_UNKNOWN);
    else if (input.bundleSupplyPct > input.policy.maxBundleSupplyPct) reasons.push(PONS_LAUNCH_GATE_REASONS.BUNDLE_ABOVE_CEILING);
  }

  // A null here means the launch transaction was not identified, so the allocation could not be measured at
  // all. That is not the same as measuring zero: the measurement must fail closed rather than pass a launch
  // whose block-0 allocation was never looked at.
  if (input.policy.maxLaunchAllocSharePct > 0) {
    if (input.launchAllocSharePct === null) reasons.push(PONS_LAUNCH_GATE_REASONS.LAUNCH_ALLOCATION_UNKNOWN);
    else if (input.launchAllocSharePct > input.policy.maxLaunchAllocSharePct) {
      reasons.push(PONS_LAUNCH_GATE_REASONS.LAUNCH_ALLOCATION_ABOVE_CEILING);
    }
  }

  // The remaining four concentration ceilings. Each is off at 0 and fail-closed on a null for the same reason
  // the bundle check is: a signal that could not be read is not a signal that read clean.
  if (input.policy.maxInsiderSupplyPct > 0) {
    if (input.insiderSharePct === null) reasons.push(PONS_LAUNCH_GATE_REASONS.INSIDER_SUPPLY_UNKNOWN);
    else if (input.insiderSharePct > input.policy.maxInsiderSupplyPct) {
      reasons.push(PONS_LAUNCH_GATE_REASONS.INSIDER_SUPPLY_ABOVE_CEILING);
    }
  }
  if (input.policy.maxSameBlockSharePct > 0) {
    if (input.sameBlockSharePct === null) reasons.push(PONS_LAUNCH_GATE_REASONS.SAME_BLOCK_SHARE_UNKNOWN);
    else if (input.sameBlockSharePct > input.policy.maxSameBlockSharePct) {
      reasons.push(PONS_LAUNCH_GATE_REASONS.SAME_BLOCK_SHARE_ABOVE_CEILING);
    }
  }
  if (input.policy.maxSequentialBlockSharePct > 0) {
    if (input.sequentialBlockSharePct === null) reasons.push(PONS_LAUNCH_GATE_REASONS.SEQUENTIAL_BLOCK_SHARE_UNKNOWN);
    else if (input.sequentialBlockSharePct > input.policy.maxSequentialBlockSharePct) {
      reasons.push(PONS_LAUNCH_GATE_REASONS.SEQUENTIAL_BLOCK_SHARE_ABOVE_CEILING);
    }
  }
  if (input.policy.maxPeerTransferSharePct > 0) {
    if (input.peerTransferSharePct === null) reasons.push(PONS_LAUNCH_GATE_REASONS.PEER_TRANSFER_SHARE_UNKNOWN);
    else if (input.peerTransferSharePct > input.policy.maxPeerTransferSharePct) {
      reasons.push(PONS_LAUNCH_GATE_REASONS.PEER_TRANSFER_SHARE_ABOVE_CEILING);
    }
  }

  // The honeypot check. Unlike the bytecode screen this one executes the sell leg, so `blocked` is a proven
  // inability to exit rather than a pattern match. `null` means the probe could not be run at all (no funded
  // holder to simulate from, RPC refusing eth_call overrides), which is exactly the case that must not pass
  // silently once the check is switched on.
  if (input.policy.requireSellPath) {
    if (input.sellPath === null) reasons.push(PONS_LAUNCH_GATE_REASONS.SELL_PATH_UNKNOWN);
    else if (input.sellPath === "blocked") reasons.push(PONS_LAUNCH_GATE_REASONS.SELL_PATH_BLOCKED);
  }

  return {
    accepted: reasons.length === 0,
    reasons,
    metrics: {
      thresholdPct: thresholdPct ?? 0,
      tollBps,
      creatorHoldingPct: input.creatorHoldingPct,
      bundleSupplyPct: input.bundleSupplyPct,
      launchAllocSharePct: input.launchAllocSharePct,
      insiderSharePct: input.insiderSharePct,
      sameBlockSharePct: input.sameBlockSharePct,
      sequentialBlockSharePct: input.sequentialBlockSharePct,
      peerTransferSharePct: input.peerTransferSharePct,
      sellPath: input.sellPath,
    },
  };
}

export interface PonsGraduatedQualityInput {
  /** Pool liquidity in USD, or null when the pool reserves could not be read or dollar-valued. */
  liquidityUsd: number | null;
  /** Trailing quote volume in USD over the configured window, or null when it could not be measured. */
  volumeUsd: number | null;
  policy: Pick<PonsLaunchGatePolicy, "graduatedMinLiquidityUsd" | "graduatedMinVolumeUsd">;
}

export interface PonsGraduatedQualityResult {
  accepted: boolean;
  reasons: string[];
  metrics: {
    liquidityUsd: number | null;
    volumeUsd: number | null;
  };
}

/**
 * The graduated (Uniswap V4) lane gate. A graduated pool is a different asset from a curve: the token is
 * fully circulating, the curve no longer holds 99.98% of supply, and liquidity and volume are real measured
 * quantities rather than a fixed 40% of a constant. That is why the dollar floors the user asked for belong
 * HERE and not on the launch lane, where a $10,000 floor is the graduation event itself and rejects every
 * entry.
 *
 * Both checks are floors (reject on strictly below), matching the launch lane's `minThresholdPct`. Both are
 * disabled at 0, and both fail closed: a null floor value is a read that did not happen, and this lane trades
 * a token with no bonding-curve safety net under it, so an unmeasured market is not a market to enter. The
 * result is deliberately shaped like `evaluatePonsLaunchQuality` so a caller can log both lanes identically.
 */
export function evaluatePonsGraduatedQuality(input: PonsGraduatedQualityInput): PonsGraduatedQualityResult {
  const reasons: string[] = [];

  if (input.policy.graduatedMinLiquidityUsd > 0) {
    if (input.liquidityUsd === null) reasons.push(PONS_LAUNCH_GATE_REASONS.GRADUATED_LIQUIDITY_UNKNOWN);
    else if (input.liquidityUsd < input.policy.graduatedMinLiquidityUsd) {
      reasons.push(PONS_LAUNCH_GATE_REASONS.GRADUATED_LIQUIDITY_BELOW_FLOOR);
    }
  }
  if (input.policy.graduatedMinVolumeUsd > 0) {
    if (input.volumeUsd === null) reasons.push(PONS_LAUNCH_GATE_REASONS.GRADUATED_VOLUME_UNKNOWN);
    else if (input.volumeUsd < input.policy.graduatedMinVolumeUsd) {
      reasons.push(PONS_LAUNCH_GATE_REASONS.GRADUATED_VOLUME_BELOW_FLOOR);
    }
  }

  return {
    accepted: reasons.length === 0,
    reasons,
    metrics: {
      liquidityUsd: input.liquidityUsd,
      volumeUsd: input.volumeUsd,
    },
  };
}

const ERC20_SUPPLY_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
];

/**
 * How much of the supply the creator still holds, read at whatever block the caller is looking at. This is
 * the one rug signal on the launch lane that no bytecode inspection can see, because the deployer contract
 * is identical for a rug and a clean launch - only the creator's balance in the first seconds differs. A
 * null result means the read failed or the supply is zero, and the caller decides whether that is fatal.
 */
export async function readCreatorHoldingPct(
  provider: ethers.Provider,
  token: string,
  creatorFeeRecipient: string,
  blockTag?: number | "latest",
): Promise<number | null> {
  try {
    const contract = new ethers.Contract(token, ERC20_SUPPLY_ABI, provider);
    const overrides = blockTag === undefined || blockTag === "latest" ? {} : { blockTag };
    const [balance, supply] = await Promise.all([
      contract.balanceOf(creatorFeeRecipient, overrides),
      contract.totalSupply(overrides),
    ]);
    const total = BigInt(supply);
    if (total === 0n) return null;
    return Number((BigInt(balance) * 10000n) / total) / 100;
  } catch {
    return null;
  }
}

function percentOf(value: bigint, total: bigint): number | null {
  if (total <= 0n) return null;
  return Number((value * 10000n) / total) / 100;
}
