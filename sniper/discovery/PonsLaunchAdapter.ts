import { ethers } from "ethers";
import { config } from "../config";

const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
];

export interface PonsLaunchEvent {
  factory: string;
  token: string;
  deployer: string;
  dexFactory: string;
  pairToken: string;
  pool: string;
  dexId: number;
  launchConfigId: number;
  positionId: number;
  restrictionsEndBlock: number;
  initialBuyAmount: bigint;
  transactionHash: string;
  blockNumber: number;
  logIndex: number;
}

export interface PonsCandidateInput {
  factory: string;
  token0: string;
  token1: string;
  fee: number;
  tickSpacing: number;
  pool: string;
  transactionHash: string;
  blockNumber: number;
  logIndex: number;
  deployer: string;
  owner: string;
  baseToken: string;
  baseTokenAddress: string;
  restrictionsEndBlock: number;
  initialBuyAmount: bigint;
}

export function assertPonsRestrictionsExpired(currentBlock: number, restrictionsEndBlock: number): void {
  if (currentBlock < restrictionsEndBlock) throw new Error(`TRADING_RESTRICTED_UNTIL_${restrictionsEndBlock}`);
}

export class PonsLaunchAdapter {
  constructor(private readonly provider: ethers.Provider) {}

  async toCandidateInput(event: PonsLaunchEvent): Promise<PonsCandidateInput> {
    const configuredPonFactories = config.poolSources
      .filter((source) => source.protocol === "pons" && source.event === "TokenLaunched")
      .map((source) => source.address.toLowerCase());
    if (!configuredPonFactories.includes(event.factory.toLowerCase())) {
      throw new Error(`PONS_FACTORY_MISMATCH:${event.factory.toLowerCase()}; configured=${configuredPonFactories.join(",")}`);
    }
    if (event.dexFactory.toLowerCase() !== config.factoryAddress.toLowerCase()) {
      throw new Error(`PONS_DEX_FACTORY_MISMATCH:${event.dexFactory.toLowerCase()} expected=${config.factoryAddress.toLowerCase()}`);
    }
    if (event.pool === ethers.ZeroAddress) throw new Error("PONS_POOL_ZERO_ADDRESS");
    const pool = new ethers.Contract(event.pool, POOL_ABI, this.provider);
    const [token0, token1, fee, tickSpacing] = await Promise.all([
      pool.token0(), pool.token1(), pool.fee(), pool.tickSpacing(),
    ]);
    const currentBlock = await this.provider.getBlockNumber();
    try {
      assertPonsRestrictionsExpired(currentBlock, event.restrictionsEndBlock);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : "TRADING_RESTRICTED"}; currentBlock=${currentBlock}; restrictionsEndBlock=${event.restrictionsEndBlock}; token=${event.token}; pool=${event.pool}`);
    }
    if (![token0, token1].some((token: string) => token.toLowerCase() === event.token.toLowerCase())) {
      throw new Error(`PONS_TOKEN_NOT_IN_POOL: token=${event.token}; poolTokens=${[token0, token1].join(",")}; pool=${event.pool}`);
    }
    if (![token0, token1].some((token: string) => token.toLowerCase() === event.pairToken.toLowerCase())) {
      throw new Error(`PONS_PAIR_NOT_IN_POOL: pairToken=${event.pairToken}; poolTokens=${[token0, token1].join(",")}; pool=${event.pool}`);
    }
    return {
      factory: config.factoryAddress,
      token0,
      token1,
      fee: Number(fee),
      tickSpacing: Number(tickSpacing),
      pool: event.pool,
      transactionHash: event.transactionHash,
      blockNumber: event.blockNumber,
      logIndex: event.logIndex,
      deployer: event.deployer,
      owner: "UNKNOWN",
      baseToken: event.pairToken,
      baseTokenAddress: event.pairToken,
      restrictionsEndBlock: event.restrictionsEndBlock,
      initialBuyAmount: event.initialBuyAmount,
    };
  }
}
