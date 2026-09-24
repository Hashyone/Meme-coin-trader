import { ethers } from "ethers";
import { PonsV2PoolKey, PonsV2LaunchRecord, buildPonsV2PoolKey } from "../discovery/PonsV2Resolver";

const STATE_VIEW_ABI = [
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
  "function getPoolKey(bytes32 poolId) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks))",
];

export interface PonsV4PoolState {
  poolId: string;
  poolKey: PonsV2PoolKey;
  sqrtPriceX96: bigint;
  tick: number;
  protocolFee: number;
  lpFee: number;
  liquidity: bigint;
  initialized: boolean;
}

export type PonsV4StateResult =
  | { ok: true; state: PonsV4PoolState }
  | { ok: false; reason: "PONS_NOT_GRADUATED" | "PONS_V4_POOL_KEY_INVALID" | "PONS_V4_POOL_NOT_INITIALIZED" | "PONS_V4_STATE_UNREADABLE" | "PONS_V4_POOL_STATE_MISMATCH"; details: string };

export class PonsV4StateView {
  private readonly stateView: ethers.Contract;

  constructor(private readonly provider: ethers.Provider, stateViewAddress: string) {
    this.stateView = new ethers.Contract(stateViewAddress, STATE_VIEW_ABI, provider);
  }

  async verify(launch: PonsV2LaunchRecord): Promise<PonsV4StateResult> {
    const derived = buildPonsV2PoolKey(launch);
    if (!derived.ok) return derived;
    const { poolKey } = derived;
    try {
      const [slot0, liquidity] = await Promise.all([
        this.stateView.getSlot0(poolKey.poolId),
        this.stateView.getLiquidity(poolKey.poolId),
      ]);
      const sqrtPriceX96 = BigInt(slot0.sqrtPriceX96);
      const tick = Number(slot0.tick);
      const protocolFee = Number(slot0.protocolFee);
      const lpFee = Number(slot0.lpFee);
      const poolLiquidity = BigInt(liquidity);
      if (sqrtPriceX96 === 0n) return { ok: false, reason: "PONS_V4_POOL_NOT_INITIALIZED", details: poolKey.poolId };
      // `liquidity` is uint128, so it can never be negative; an empty pool reports zero and must not pass.
      if (poolLiquidity === 0n) return { ok: false, reason: "PONS_V4_POOL_STATE_MISMATCH", details: "ZERO_LIQUIDITY" };
      return {
        ok: true,
        state: {
          poolId: poolKey.poolId,
          poolKey,
          sqrtPriceX96,
          tick,
          protocolFee,
          lpFee,
          liquidity: poolLiquidity,
          initialized: true,
        },
      };
    } catch (error) {
      return { ok: false, reason: "PONS_V4_STATE_UNREADABLE", details: error instanceof Error ? error.message : String(error) };
    }
  }
}