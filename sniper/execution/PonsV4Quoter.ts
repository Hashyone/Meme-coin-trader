import { ethers } from "ethers";
import { PonsV2PoolKey } from "../discovery/PonsV2Resolver";

const QUOTER_ABI = [
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)",
];

export interface PonsV4Quote {
  amountIn: bigint;
  amountOut: bigint;
  gasEstimate: bigint;
  zeroForOne: boolean;
  quotedAtBlock: number;
  hookData: string;
}

export function v4SwapDirection(poolKey: PonsV2PoolKey, inputCurrency: string): boolean {
  if (inputCurrency.toLowerCase() === poolKey.currency0.toLowerCase()) return true;
  if (inputCurrency.toLowerCase() === poolKey.currency1.toLowerCase()) return false;
  throw new Error("PONS_V4_INPUT_CURRENCY_NOT_IN_POOL");
}

export class PonsV4Quoter {
  private readonly quoter: ethers.Contract;

  constructor(private readonly provider: ethers.Provider, quoterAddress: string) {
    this.quoter = new ethers.Contract(quoterAddress, QUOTER_ABI, provider);
  }

  async quoteExactInput(poolKey: PonsV2PoolKey, inputCurrency: string, amountIn: bigint, hookData = "0x"): Promise<PonsV4Quote> {
    if (amountIn <= 0n || amountIn > ((1n << 128n) - 1n)) throw new Error("PONS_V4_INVALID_EXACT_AMOUNT");
    const zeroForOne = v4SwapDirection(poolKey, inputCurrency);
    const result = await this.quoter.quoteExactInputSingle.staticCall({
      poolKey: { currency0: poolKey.currency0, currency1: poolKey.currency1, fee: poolKey.fee, tickSpacing: poolKey.tickSpacing, hooks: poolKey.hooks },
      zeroForOne,
      exactAmount: amountIn,
      hookData,
    });
    return {
      amountIn,
      amountOut: BigInt(result.amountOut),
      gasEstimate: BigInt(result.gasEstimate),
      zeroForOne,
      quotedAtBlock: await this.provider.getBlockNumber(),
      hookData,
    };
  }
}