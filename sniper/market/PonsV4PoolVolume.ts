import { ethers } from "ethers";
import { PONS_V2_POOL_MANAGER } from "../discovery/PonsV2Resolver";

/** The Alchemy tier rejects `eth_getLogs` ranges wider than this, so every reader chunks at 10. */
const LOG_CHUNK = 10;

/**
 * Uniswap V4 PoolManager `Swap`. `id` and `sender` are indexed, so the pool is selected by topic and the
 * amounts arrive in the data as two int128s - signed, because a swap can move either side in either
 * direction. Only the quote side of the pool is counted.
 */
export const PONS_V4_SWAP_TOPIC = ethers.id("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");

export const PONS_V4_SWAP_ABI = [
  "event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)",
];

export interface PonsV4QuoteAsset {
  address: string;
  /** ERC20 decimals, or 18 for the native currency. */
  decimals: number;
  /** True when this is the chain's native currency, whose USD value needs the price feed. */
  native: boolean;
}

export interface PonsV4VolumeInput {
  poolId: string;
  /** The pool's quote side, used to pick the amount word and to value it. */
  quoteAsset: PonsV4QuoteAsset;
  /** Whether the quote asset is `currency0` of the pool key; the other amount word is then the token side. */
  quoteIsCurrency0: boolean;
  fromBlock: number;
  toBlock: number;
  nativeUsdPrice: number;
}

export interface PonsV4VolumeResult {
  /** Absolute quote-side volume over the window, in USD. null when the quote asset could not be valued. */
  volumeUsd: number | null;
  /** Absolute quote-side volume in quote units, before conversion. */
  volumeQuote: bigint;
  swaps: number;
  /** True when at least one chunk read failed, so the volume is a floor rather than a total. */
  truncated: boolean;
}

/**
 * The pool's quote-side trading volume over a trailing window, summed from the PoolManager's own `Swap` logs
 * for this pool id. This is the only volume figure on this chain that can be measured without an indexer, and
 * the Alchemy 10-block `eth_getLogs` cap is why a 300-block window costs 30 requests: a graduated-lane volume
 * floor is therefore a poll, not a per-event read, and the caller owns the cost.
 *
 * Either amount is signed and a swap moves exactly one side in and the other out, so the quote side is taken
 * as an absolute value: a buy and a sell of the same size count the same, which is what a "does this pool
 * trade" floor wants. A quote asset whose decimals are unknown yields `volumeUsd: null` rather than a number
 * scaled by a guessed exponent - the raw `volumeQuote` is still returned so the caller can see the read
 * happened and only the valuation failed.
 */
export async function measurePonsV4Volume(
  provider: ethers.Provider,
  input: PonsV4VolumeInput,
): Promise<PonsV4VolumeResult | null> {
  if (input.toBlock < input.fromBlock) return null;
  const manager = ethers.getAddress(PONS_V2_POOL_MANAGER);
  const iface = new ethers.Interface(PONS_V4_SWAP_ABI);
  const amountIndex = input.quoteIsCurrency0 ? 2 : 3;

  let volumeQuote = 0n;
  let swaps = 0;
  let truncated = false;

  for (let start = input.fromBlock; start <= input.toBlock; start += LOG_CHUNK) {
    const end = Math.min(start + LOG_CHUNK - 1, input.toBlock);
    try {
      const logs = await provider.getLogs({
        address: manager,
        topics: [PONS_V4_SWAP_TOPIC, input.poolId],
        fromBlock: start,
        toBlock: end,
      });
      for (const log of logs) {
        const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
        if (!parsed) continue;
        const amount = BigInt(parsed.args[amountIndex]);
        volumeQuote += amount < 0n ? -amount : amount;
        swaps += 1;
      }
    } catch {
      truncated = true;
    }
  }

  return {
    volumeUsd: quoteValueToUsd(volumeQuote, input.quoteAsset, input.nativeUsdPrice),
    volumeQuote,
    swaps,
    truncated,
  };
}

/**
 * Value a raw quote-asset amount in USD. `null` when the decimals are unknown, because dividing by a guessed
 * exponent produces a number that looks measured and is not.
 */
export function quoteValueToUsd(value: bigint, asset: PonsV4QuoteAsset, nativeUsdPrice: number): number | null {
  if (!Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 36) return null;
  const amount = Number(value) / 10 ** asset.decimals;
  if (!Number.isFinite(amount)) return null;
  return asset.native ? amount * nativeUsdPrice : amount;
}
