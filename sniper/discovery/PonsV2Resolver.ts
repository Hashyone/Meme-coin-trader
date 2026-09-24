import { ethers } from "ethers";
import { config } from "../config";

export const PONS_V2_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
export const PONS_V2_HOOK = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";
export const PONS_V2_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";

export const PONS_V2_REJECTION_REASONS = {
  LAUNCH_NOT_FOUND: "PONS_LAUNCH_NOT_FOUND",
  PHASE_UNKNOWN: "PONS_PHASE_UNKNOWN",
  CURVE_UNAVAILABLE: "PONS_CURVE_UNAVAILABLE",
  CURVE_NOT_ROUTABLE: "PONS_CURVE_NOT_ROUTABLE",
  CURVE_QUOTE_FAILED: "PONS_CURVE_QUOTE_FAILED",
  CURVE_CLOSED: "PONS_CURVE_CLOSED",
  CURVE_INPUT_BALANCE_TOO_LOW: "PONS_CURVE_INPUT_BALANCE_TOO_LOW",
  CURVE_ALLOWANCE_MISSING: "PONS_CURVE_ALLOWANCE_MISSING",
  CURVE_SIMULATION_FAILED: "PONS_CURVE_SIMULATION_FAILED",
  NOT_GRADUATED: "PONS_NOT_GRADUATED",
  V4_POOL_UNVERIFIED: "PONS_V4_POOL_UNVERIFIED",
  V4_POOL_KEY_INVALID: "PONS_V4_POOL_KEY_INVALID",
  V4_QUOTE_FAILED: "PONS_V4_QUOTE_FAILED",
  V4_SIMULATION_FAILED: "PONS_V4_SIMULATION_FAILED",
  PHASE_CHANGED: "PONS_PHASE_CHANGED",
} as const;

export type PonsV2Phase = "PONS_V2_CURVE" | "PONS_V2_SWEPT" | "UNISWAP_V4" | "PONS_V2_RESCUED" | "UNKNOWN";

export interface PonsV2LaunchRecord {
  exists: boolean;
  token: string;
  curve: string;
  deployer: string;
  creatorFeeRecipient: string;
  pairToken: string;
  graduationThreshold: bigint;
  poolFee: number;
  tickSpacing: number;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  phase: number;
  sweptQuote: bigint;
  sweptTokens: bigint;
  sweptAt: bigint;
}

export interface PonsV2PoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
  poolId: string;
}

export type PonsV2PoolKeyResult =
  | { ok: true; poolKey: PonsV2PoolKey }
  | { ok: false; reason: "PONS_V4_POOL_KEY_INVALID" | "PONS_NOT_GRADUATED"; details: string };

export interface PonsV2Route {
  phase: PonsV2Phase;
  executable: boolean;
  reason?: string;
}

const LAUNCH_ABI = [
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))",
];

function normalizeRecord(value: any): PonsV2LaunchRecord {
  return {
    exists: Boolean(value.exists),
    token: ethers.getAddress(value.token),
    curve: ethers.getAddress(value.curve),
    deployer: ethers.getAddress(value.deployer),
    creatorFeeRecipient: ethers.getAddress(value.creatorFeeRecipient),
    pairToken: ethers.getAddress(value.pairToken),
    graduationThreshold: BigInt(value.graduationThreshold),
    poolFee: Number(value.poolFee),
    tickSpacing: Number(value.tickSpacing),
    creatorTaxBps: Number(value.creatorTaxBps),
    buybackEnabled: Boolean(value.buybackEnabled),
    phase: Number(value.phase),
    sweptQuote: BigInt(value.sweptQuote),
    sweptTokens: BigInt(value.sweptTokens),
    sweptAt: BigInt(value.sweptAt),
  };
}

export function routePonsV2Phase(phase: number): PonsV2Route {
  // Phase 0 is the bonding curve itself, which trades directly against the curve contract: no Uniswap pool
  // exists yet, `PonsV2CurveAdapter` carries the curve's own buy/sell path. Phase 2 is the Uniswap V4 pool
  // that graduation creates, so the token stays tradeable across the migration by switching venue.
  if (phase === 0) return { phase: "PONS_V2_CURVE", executable: true };
  if (phase === 1) return { phase: "PONS_V2_SWEPT", executable: false, reason: "PONS_NOT_GRADUATED" };
  if (phase === 2) return { phase: "UNISWAP_V4", executable: true };
  if (phase === 3) return { phase: "PONS_V2_RESCUED", executable: false, reason: "PONS_NOT_GRADUATED" };
  return { phase: "UNKNOWN", executable: false, reason: "PONS_PHASE_UNKNOWN" };
}

export function buildPonsV2PoolKey(launch: PonsV2LaunchRecord): PonsV2PoolKeyResult {
  if (!launch.exists) return { ok: false, reason: "PONS_V4_POOL_KEY_INVALID", details: "PONS_LAUNCH_NOT_FOUND" };
  if (launch.phase !== 2) return { ok: false, reason: "PONS_NOT_GRADUATED", details: `PHASE_${launch.phase}` };
  if (!ethers.isAddress(launch.token) || !ethers.isAddress(launch.pairToken) || launch.token.toLowerCase() === launch.pairToken.toLowerCase()) {
    return { ok: false, reason: "PONS_V4_POOL_KEY_INVALID", details: "TOKEN_PAIR_INVALID" };
  }
  if (!Number.isInteger(launch.poolFee) || launch.poolFee < 0 || launch.poolFee > 0xffffff) {
    return { ok: false, reason: "PONS_V4_POOL_KEY_INVALID", details: "POOL_FEE_INVALID" };
  }
  if (!Number.isInteger(launch.tickSpacing) || launch.tickSpacing <= 0 || launch.tickSpacing > 0x7fffffff) {
    return { ok: false, reason: "PONS_V4_POOL_KEY_INVALID", details: "TICK_SPACING_INVALID" };
  }
  if (config.chainId !== 4663) return { ok: false, reason: "PONS_V4_POOL_KEY_INVALID", details: "UNEXPECTED_CHAIN" };

  const [currency0, currency1] = [launch.token, launch.pairToken].sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
  const hooks = config.ponsV2Hook;
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "uint24", "int24", "address"],
    [currency0, currency1, launch.poolFee, launch.tickSpacing, hooks],
  );
  return {
    ok: true,
    poolKey: { currency0, currency1, fee: launch.poolFee, tickSpacing: launch.tickSpacing, hooks, poolId: ethers.keccak256(encoded) },
  };
}

export class PonsV2Resolver {
  private readonly factory: ethers.Contract;
  private readonly cache = new Map<string, { block: number; record: PonsV2LaunchRecord }>();

  constructor(private readonly provider: ethers.Provider, factoryAddress = config.ponsV2Factory) {
    this.factory = new ethers.Contract(factoryAddress, LAUNCH_ABI, provider);
  }

  async resolve(candidateToken: string, forceRefresh = false): Promise<PonsV2LaunchRecord> {
    if (!ethers.isAddress(candidateToken)) throw new Error("PONS_LAUNCH_NOT_FOUND");
    const key = candidateToken.toLowerCase();
    const block = await this.provider.getBlockNumber();
    const cached = this.cache.get(key);
    if (!forceRefresh && cached && cached.block === block) return cached.record;
    try {
      const value = await this.factory.getLaunchedToken(candidateToken);
      const record = normalizeRecord(value);
      if (!record.exists) throw new Error("PONS_LAUNCH_NOT_FOUND");
      this.cache.set(key, { block, record });
      return record;
    } catch (error) {
      if (error instanceof Error && error.message === "PONS_LAUNCH_NOT_FOUND") throw error;
      throw new Error("PONS_LAUNCH_NOT_FOUND");
    }
  }
}