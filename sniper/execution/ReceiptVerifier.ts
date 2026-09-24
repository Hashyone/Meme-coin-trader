import { ethers } from "ethers";

export interface BalanceTransition {
  address: string;
  before: bigint;
  after: bigint;
  minimumDelta?: bigint;
}

export interface VerifiedReceipt {
  txHash: string;
  nonce: number;
  blockNumber: number;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  gasCostWei: bigint;
  status: 1;
}

export class ReceiptVerifier {
  constructor(private readonly provider: ethers.Provider) {}

  async waitForSuccess(txHash: string, transitions: BalanceTransition[]): Promise<VerifiedReceipt> {
    const [receipt, transaction] = await Promise.all([
      this.provider.waitForTransaction(txHash),
      this.provider.getTransaction(txHash),
    ]);
    if (!receipt) throw new Error("RECEIPT_NOT_FOUND");
    if (!transaction) throw new Error("TRANSACTION_NOT_FOUND");
    if (receipt.status !== 1) throw new Error("TRANSACTION_REVERTED");
    for (const transition of transitions) {
      const delta = transition.after - transition.before;
      if (delta < (transition.minimumDelta ?? 1n)) throw new Error("BALANCE_TRANSITION_NOT_VERIFIED");
    }
    const effectiveGasPrice = receipt.gasPrice ?? 0n;
    return {
      txHash,
      nonce: transaction.nonce,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice,
      gasCostWei: receipt.gasUsed * effectiveGasPrice,
      status: 1,
    };
  }
}
