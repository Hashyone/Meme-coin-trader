import { ethers } from "ethers";
import { PonsV2PoolKey } from "../discovery/PonsV2Resolver";
import { v4SwapDirection } from "./PonsV4Quoter";

const ROUTER_ABI = [
  "function execute(bytes commands,bytes[] inputs,uint256 deadline) payable",
];
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
];
const PERMIT2_ABI = [
  "function allowance(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)",
];

const COMMAND_V4_SWAP = "10";
const ACTION_SWAP_EXACT_IN_SINGLE = "06";
const ACTION_SETTLE_ALL = "0c";
const ACTION_TAKE_ALL = "0f";
const ACTIONS = `0x${ACTION_SWAP_EXACT_IN_SINGLE}${ACTION_SETTLE_ALL}${ACTION_TAKE_ALL}`;
const V4_SWAP_SINGLE_STRUCT = "tuple(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)";

const ACTION_ABI = ethers.AbiCoder.defaultAbiCoder();

export interface PonsV4SwapTransaction {
  to: string;
  data: string;
  value: bigint;
  chainId: number;
  deadline: bigint;
  zeroForOne: boolean;
}

export interface PonsV4InputReadiness {
  native: boolean;
  balance: bigint;
  erc20AllowanceToPermit2: bigint;
  permit2AllowanceToRouter: bigint;
  permit2Expiration: number;
  ready: boolean;
  reason?: "PONS_V4_INPUT_BALANCE_TOO_LOW" | "PONS_V4_PERMIT2_ALLOWANCE_MISSING";
  details: Record<string, string | number | boolean>;
}

export class PonsV4Router {
  private readonly routerInterface = new ethers.Interface(ROUTER_ABI);

  constructor(private readonly provider: ethers.Provider, private readonly routerAddress: string, private readonly chainId: number) {}

  buildExactInputSingle(
    poolKey: PonsV2PoolKey,
    inputCurrency: string,
    amountIn: bigint,
    amountOutMinimum: bigint,
    deadline: bigint,
    recipient: string,
    hookData = "0x",
  ): PonsV4SwapTransaction {
    if (!ethers.isAddress(recipient)) throw new Error("INVALID_RECIPIENT");
    if (amountIn <= 0n || amountOutMinimum < 0n) throw new Error("INVALID_SWAP_AMOUNTS");
    if (deadline <= 0n) throw new Error("INVALID_DEADLINE");
    const zeroForOne = v4SwapDirection(poolKey, inputCurrency);
    const outputCurrency = zeroForOne ? poolKey.currency1 : poolKey.currency0;
    const swapParams = ACTION_ABI.encode(
      [V4_SWAP_SINGLE_STRUCT],
      [[{ currency0: poolKey.currency0, currency1: poolKey.currency1, fee: poolKey.fee, tickSpacing: poolKey.tickSpacing, hooks: poolKey.hooks }, zeroForOne, amountIn, amountOutMinimum, 0n, hookData]],
    );
    const settleParams = ACTION_ABI.encode(["address", "uint256"], [inputCurrency, ethers.MaxUint256]);
    const takeParams = ACTION_ABI.encode(["address", "uint256"], [outputCurrency, 0n]);
    const v4Input = ACTION_ABI.encode(["bytes", "bytes[]"], [ACTIONS, [swapParams, settleParams, takeParams]]);
    const data = this.routerInterface.encodeFunctionData("execute", [`0x${COMMAND_V4_SWAP}`, [v4Input], deadline]);
    return {
      to: this.routerAddress,
      data,
      value: inputCurrency === ethers.ZeroAddress ? amountIn : 0n,
      chainId: this.chainId,
      deadline,
      zeroForOne,
    };
  }

  async simulate(transaction: PonsV4SwapTransaction, from: string): Promise<bigint> {
    return this.provider.estimateGas({ from, to: transaction.to, data: transaction.data, value: transaction.value });
  }

  async inspectInputReadiness(inputCurrency: string, owner: string, amountIn: bigint, permit2Address: string): Promise<PonsV4InputReadiness> {
    if (inputCurrency === ethers.ZeroAddress) {
      const balance = await this.provider.getBalance(owner);
      const balanceValue = BigInt(balance);
      const ready = balanceValue >= amountIn;
      return {
        native: true,
        balance: balanceValue,
        erc20AllowanceToPermit2: 0n,
        permit2AllowanceToRouter: 0n,
        permit2Expiration: 0,
        ready,
        reason: ready ? undefined : "PONS_V4_INPUT_BALANCE_TOO_LOW",
        details: {
          balance: balanceValue.toString(),
          requiredAmountIn: amountIn.toString(),
          hasSufficientBalance: ready,
          owner,
        },
      };
    }
    const token = new ethers.Contract(inputCurrency, ERC20_ABI, this.provider);
    const permit2 = new ethers.Contract(permit2Address, PERMIT2_ABI, this.provider);
    const [balance, erc20Allowance, permit2Allowance] = await Promise.all([
      token.balanceOf(owner),
      token.allowance(owner, permit2Address),
      permit2.allowance(owner, inputCurrency, this.routerAddress),
    ]);
    const balanceValue = BigInt(balance);
    const erc20AllowanceValue = BigInt(erc20Allowance);
    const permit2AllowanceValue = BigInt(permit2Allowance.amount);
    const permit2Expiration = Number(permit2Allowance.expiration);
    const ready = balanceValue >= amountIn && erc20AllowanceValue >= amountIn && permit2AllowanceValue >= amountIn && permit2Expiration >= Math.floor(Date.now() / 1000);
    return {
      native: false,
      balance: balanceValue,
      erc20AllowanceToPermit2: erc20AllowanceValue,
      permit2AllowanceToRouter: permit2AllowanceValue,
      permit2Expiration,
      ready,
      reason: balanceValue < amountIn ? "PONS_V4_INPUT_BALANCE_TOO_LOW" : ready ? undefined : "PONS_V4_PERMIT2_ALLOWANCE_MISSING",
      details: {
        balance: balanceValue.toString(),
        requiredAmountIn: amountIn.toString(),
        erc20AllowanceToPermit2: erc20AllowanceValue.toString(),
        permit2AllowanceToRouter: permit2AllowanceValue.toString(),
        permit2Expiration,
        hasSufficientBalance: balanceValue >= amountIn,
        hasErc20Approval: erc20AllowanceValue >= amountIn,
        hasPermit2Approval: permit2AllowanceValue >= amountIn,
        hasValidPermit2Expiration: permit2Expiration >= Math.floor(Date.now() / 1000),
      },
    };
  }
}