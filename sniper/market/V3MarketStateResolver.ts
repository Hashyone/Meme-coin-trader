import { ethers } from "ethers";
import { config } from "../config";
import { Candidate } from "../types";

const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
];

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function totalSupply() view returns (uint256)",
];

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
];

export interface TokenState {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  totalSupply: bigint;
  balance: bigint;
}

export interface V3MarketState {
  pool: string;
  token0: TokenState;
  token1: TokenState;
  fee: number;
  tickSpacing: number;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  baseLiquidityUsd: number;
  baseLiquiditySource: "ACTIVE_VIRTUAL_RESERVE";
  observedBlock: number;
  observedAt: number;
}

export interface MarketProvider {
  getBlockNumber(): Promise<number>;
  getBalance(address: string, blockTag?: number): Promise<bigint>;
  getTransaction(hash: string): Promise<{ from: string } | null>;
}

export class V3MarketStateResolver {
  private readonly factory: ethers.Contract;

  constructor(private readonly provider: ethers.Provider, factoryAddress: string) {
    this.factory = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);
  }

  async resolve(candidate: Candidate): Promise<V3MarketState> {
    const pool = new ethers.Contract(candidate.pool, POOL_ABI, this.provider);
    const [token0Address, token1Address, fee, tickSpacing, slot0, liquidity, blockNumber] = await Promise.all([
      pool.token0(),
      pool.token1(),
      pool.fee(),
      pool.tickSpacing(),
      pool.slot0(),
      pool.liquidity(),
      this.provider.getBlockNumber(),
    ]);

    const [token0, token1] = await Promise.all([
      this.resolveToken(token0Address, candidate.pool, blockNumber),
      this.resolveToken(token1Address, candidate.pool, blockNumber),
    ]);

    if (token0.address.toLowerCase() !== candidate.token0.toLowerCase() || token1.address.toLowerCase() !== candidate.token1.toLowerCase()) {
      throw new Error("POOL_TOKEN_MISMATCH");
    }
    if ((await this.factory.getPool(token0.address, token1.address, Number(fee))).toLowerCase() !== candidate.pool.toLowerCase()) {
      throw new Error("POOL_FACTORY_MISMATCH");
    }

    return {
      pool: candidate.pool.toLowerCase(),
      token0,
      token1,
      fee: Number(fee),
      tickSpacing: Number(tickSpacing),
      sqrtPriceX96: BigInt(slot0.sqrtPriceX96),
      tick: Number(slot0.tick),
      liquidity: BigInt(liquidity),
      baseLiquidityUsd: this.calculateBaseLiquidityUsd(token0, token1, BigInt(liquidity), BigInt(slot0.sqrtPriceX96)),
      baseLiquiditySource: "ACTIVE_VIRTUAL_RESERVE",
      observedBlock: blockNumber,
      observedAt: Date.now(),
    };
  }

  private calculateBaseLiquidityUsd(token0: TokenState, token1: TokenState, liquidity: bigint, sqrtPriceX96: bigint): number {
    const wrappedNative = config.wrappedNativeAddress?.toLowerCase();
    const base = [token0, token1].find((token) =>
      token.address.toLowerCase() === wrappedNative || ["ETH", "WETH", "USDC", "USDT"].includes(token.symbol.toUpperCase()),
    );
    if (!base) return 0;
    if (liquidity <= 0n || sqrtPriceX96 <= 0n) return 0;
    const q96 = 2n ** 96n;
    const token0VirtualRaw = (liquidity * q96) / sqrtPriceX96;
    const token1VirtualRaw = (liquidity * sqrtPriceX96) / q96;
    const virtualRaw = base.address.toLowerCase() === token0.address.toLowerCase() ? token0VirtualRaw : token1VirtualRaw;
    const units = Number(virtualRaw) / (10 ** base.decimals);
    const isStable = ["USDC", "USDT"].includes(base.symbol.toUpperCase());
    return units * (isStable ? 1 : config.nativeUsdPrice);
  }

  async resolveDeployer(transactionHash: string): Promise<string> {
    const transaction = await this.provider.getTransaction(transactionHash);
    if (!transaction?.from) throw new Error("POOL_CREATION_TRANSACTION_NOT_FOUND");
    return transaction.from.toLowerCase();
  }

  private async resolveToken(address: string, poolAddress: string, blockNumber: number): Promise<TokenState> {
    const token = new ethers.Contract(address, ERC20_ABI, this.provider);
    const [symbol, name, decimals, totalSupply, balance] = await Promise.all([
      this.optionalCall(() => token.symbol(), "UNKNOWN"),
      this.optionalCall(() => token.name(), "UNKNOWN"),
      this.optionalCall(() => token.decimals(), 0),
      this.optionalCall(() => token.totalSupply(), 0n),
      token.balanceOf(poolAddress, { blockTag: blockNumber }),
    ]);
    return { address: address.toLowerCase(), symbol, name, decimals: Number(decimals), totalSupply: BigInt(totalSupply), balance };
  }

  private async optionalCall<T>(call: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await call();
    } catch {
      return fallback;
    }
  }
}
