import { ethers } from "ethers";
import { config } from "../config";
import { V3MarketState } from "../market/V3MarketStateResolver";

const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
];

const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
];

export interface V3Quote {
  amountIn: bigint;
  amountOut: bigint;
  gasEstimate: bigint;
  quotedAtBlock: number;
}

export interface V3SwapTransaction {
  to: string;
  data: string;
  value: bigint;
  chainId: number;
}

export class V3TradeAdapter {
  private readonly quoter: ethers.Contract;
  private readonly routerInterface = new ethers.Interface(ROUTER_ABI);

  constructor(private readonly provider: ethers.Provider) {
    this.quoter = new ethers.Contract(config.quoterV2Address, QUOTER_ABI, provider);
  }

  async quoteBuy(state: V3MarketState, amountIn: bigint): Promise<V3Quote> {
    const base = this.requireWrappedNative();
    return this.quote(base, state.token0.address.toLowerCase() === base.toLowerCase() ? state.token1.address : state.token0.address, state.fee, amountIn);
  }

  async quoteSell(state: V3MarketState, amountIn: bigint): Promise<V3Quote> {
    const base = this.requireWrappedNative();
    const candidateToken = state.token0.address.toLowerCase() === base.toLowerCase() ? state.token1.address : state.token0.address;
    return this.quote(candidateToken, base, state.fee, amountIn);
  }

  buildBuyTransaction(state: V3MarketState, recipient: string, amountIn: bigint, amountOutMinimum: bigint): V3SwapTransaction {
    const base = this.requireWrappedNative();
    const tokenOut = state.token0.address.toLowerCase() === base.toLowerCase() ? state.token1.address : state.token0.address;
    return this.build(base, tokenOut, state.fee, recipient, amountIn, amountOutMinimum);
  }

  buildSellTransaction(state: V3MarketState, recipient: string, amountIn: bigint, amountOutMinimum: bigint): V3SwapTransaction {
    const base = this.requireWrappedNative();
    const tokenIn = state.token0.address.toLowerCase() === base.toLowerCase() ? state.token1.address : state.token0.address;
    return this.build(tokenIn, base, state.fee, recipient, amountIn, amountOutMinimum);
  }

  private async quote(tokenIn: string, tokenOut: string, fee: number, amountIn: bigint): Promise<V3Quote> {
    if (amountIn <= 0n) throw new Error("TRADE_AMOUNT_MUST_BE_POSITIVE");
    const result = await this.quoter.quoteExactInputSingle.staticCall({ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0 });
    return {
      amountIn,
      amountOut: BigInt(result.amountOut),
      gasEstimate: BigInt(result.gasEstimate),
      quotedAtBlock: await this.provider.getBlockNumber(),
    };
  }

  private build(tokenIn: string, tokenOut: string, fee: number, recipient: string, amountIn: bigint, amountOutMinimum: bigint): V3SwapTransaction {
    if (!ethers.isAddress(recipient)) throw new Error("INVALID_RECIPIENT");
    if (amountIn <= 0n || amountOutMinimum < 0n) throw new Error("INVALID_SWAP_AMOUNTS");
    return {
      to: config.swapRouter02Address,
      data: this.routerInterface.encodeFunctionData("exactInputSingle", [{
        tokenIn,
        tokenOut,
        fee,
        recipient,
        amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96: 0,
      }]),
      value: amountIn,
      chainId: config.chainId,
    };
  }

  private requireWrappedNative(): string {
    if (!config.wrappedNativeAddress) throw new Error("ROBINHOOD_WRAPPED_NATIVE_REQUIRED");
    if (!ethers.isAddress(config.wrappedNativeAddress)) throw new Error("INVALID_ROBINHOOD_WRAPPED_NATIVE");
    return config.wrappedNativeAddress;
  }
}
