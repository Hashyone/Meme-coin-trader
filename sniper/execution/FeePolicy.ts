import { ethers } from "ethers";
import { config } from "../config";

export interface FeeData { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; }

export async function getFeeData(provider: ethers.Provider): Promise<FeeData> {
  const fee = await provider.getFeeData();
  const priority = fee.maxPriorityFeePerGas ?? fee.gasPrice ?? 0n;
  const maxFee = fee.maxFeePerGas ?? fee.gasPrice ?? priority;
  const configuredPriority = process.env.MAX_PRIORITY_FEE_WEI ? BigInt(process.env.MAX_PRIORITY_FEE_WEI) : priority;
  const configuredMax = process.env.MAX_FEE_PER_GAS_WEI ? BigInt(process.env.MAX_FEE_PER_GAS_WEI) : maxFee;
  if (configuredMax < configuredPriority) throw new Error("MAX_FEE_BELOW_PRIORITY_FEE");
  return { maxFeePerGas: configuredMax, maxPriorityFeePerGas: configuredPriority };
}

export function gasCostWei(gasLimit: bigint, effectiveGasPrice: bigint): bigint {
  return gasLimit * effectiveGasPrice;
}

export function gasCostWithinLimit(gasLimit: bigint, effectiveGasPrice: bigint): boolean {
  return gasCostWei(gasLimit, effectiveGasPrice) <= BigInt(Math.floor(config.maxGasEth * 1e18));
}
