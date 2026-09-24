import { ethers } from "ethers";

export interface SimulationInput {
  chainId: number;
  from: string;
  to: string;
  value: string;
  data: string;
  gasLimit: number;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
}

export interface SimulationResult {
  mode: "simulation" | "execution";
  safe: boolean;
  signedTx: string;
  txHash: string;
  gasEstimate: bigint;
  broadcasted: boolean;
  reason?: string;
}

export function canSubmitLiveTransaction(options: {
  allowLiveBroadcast?: boolean;
  executionMode?: string;
  hasWalletPrivateKey?: boolean;
  hasExecutionTarget?: boolean;
  hasTradeValue?: boolean;
} = {}): boolean {
  const allowLiveBroadcast = options.allowLiveBroadcast ?? ((process.env.ALLOW_LIVE_BROADCAST ?? "false").toLowerCase() === "true");
  const mode = (options.executionMode ?? process.env.EXECUTION_MODE ?? "PAPER").toUpperCase();
  const hasWalletPrivateKey = options.hasWalletPrivateKey ?? !!process.env.WALLET_PRIVATE_KEY;
  const hasExecutionTarget = options.hasExecutionTarget ?? !!process.env.EXECUTION_TARGET;
  const hasTradeValue = options.hasTradeValue ?? !!process.env.TRADE_VALUE_WEI;
  return allowLiveBroadcast && (mode === "LIVE" || mode === "CANARY") && hasWalletPrivateKey && hasExecutionTarget && hasTradeValue;
}

function getEnvironmentExecutionMode(): string {
  return (process.env.EXECUTION_MODE ?? "PAPER").toUpperCase();
}

function liveExecutionAllowed(): boolean {
  return canSubmitLiveTransaction({
    allowLiveBroadcast: (process.env.ALLOW_LIVE_BROADCAST ?? "false").toLowerCase() === "true",
    executionMode: getEnvironmentExecutionMode(),
    hasWalletPrivateKey: !!process.env.WALLET_PRIVATE_KEY,
    hasExecutionTarget: !!process.env.EXECUTION_TARGET,
    hasTradeValue: !!process.env.TRADE_VALUE_WEI,
  });
}

export class SimulationEngine {
  async simulate(input: SimulationInput, wallet: { privateKey: string }, providerOverride?: {
    getTransactionCount: (address: string, blockTag: "latest" | "pending") => Promise<number>;
    estimateGas: (tx: { from: string; to: string; value: bigint; data: string }) => Promise<bigint>;
    call: (tx: { from: string; to: string; value: bigint; data: string; gasLimit: bigint }) => Promise<string>;
    broadcastTransaction: (signedTx: string) => Promise<{ hash: string }>;
  }): Promise<SimulationResult> {
    const key = wallet.privateKey.startsWith("0x") ? wallet.privateKey : `0x${wallet.privateKey}`;
    const signer = new ethers.Wallet(key);
    const from = input.from && input.from !== "0x0000000000000000000000000000000000000000" ? input.from : signer.address;
    const rpcUrl = process.env.ROBINHOOD_HTTP_RPC_URL || process.env.ROBINHOOD_HTTP_RPC || process.env.ROBINHOOD_FALLBACK_HTTP_RPC_URL || process.env.ROBINHOOD_FALLBACK_HTTP_RPC;
    const provider = providerOverride ?? (rpcUrl ? new ethers.JsonRpcProvider(rpcUrl) : null);

    const txRequest = {
      chainId: input.chainId,
      from,
      to: input.to,
      value: BigInt(input.value || "0x0"),
      data: input.data || "0x",
      nonce: provider ? await provider.getTransactionCount(from, "latest") : 0,
      gasLimit: provider ? await provider.estimateGas({ from, to: input.to, value: BigInt(input.value || "0x0"), data: input.data || "0x" }) : BigInt(input.gasLimit || 210000),
      maxFeePerGas: BigInt(input.maxFeePerGas || "0x3b9aca00"),
      maxPriorityFeePerGas: BigInt(input.maxPriorityFeePerGas || "0x3b9aca00"),
    };

    const signedTx = await signer.signTransaction(txRequest);
    const txHash = ethers.keccak256(signedTx);
    const simulatedResult = provider ? await provider.call({
      from,
      to: input.to,
      value: BigInt(input.value || "0x0"),
      data: input.data || "0x",
      gasLimit: txRequest.gasLimit,
    }) : "0x";

    if (!liveExecutionAllowed()) {
      return {
        mode: "simulation",
        safe: Boolean(simulatedResult),
        signedTx,
        txHash,
        gasEstimate: txRequest.gasLimit,
        broadcasted: false,
        reason: "LIVE_EXECUTION_BLOCKED",
      };
    }

    if (!provider) {
      return {
        mode: "simulation",
        safe: false,
        signedTx,
        txHash,
        gasEstimate: txRequest.gasLimit,
        broadcasted: false,
        reason: "LIVE_EXECUTION_BLOCKED_NO_PROVIDER",
      };
    }

    const broadcast = await provider.broadcastTransaction(signedTx);
    return {
      mode: "execution",
      safe: true,
      signedTx,
      txHash: broadcast.hash,
      gasEstimate: txRequest.gasLimit,
      broadcasted: true,
    };
  }
}
