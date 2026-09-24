import { ethers } from "ethers";
import { nonceManagerFor } from "./NonceManager";

// Every numeric view is declared `uint256` even where the contract stores a narrower type: decoding is a
// no-op widening for the smaller integers, while guessing a width wrong would make the read revert.
const CURVE_ABI = [
  "function buy(uint256 quoteIn,uint256 minTokensOut,address recipient) payable returns (uint256)",
  "function sell(uint256 tokensIn,uint256 minQuoteOut,address recipient) returns (uint256)",
  "function token() view returns (address)",
  "function pairToken() view returns (address)",
  "function deployer() view returns (address)",
  "function factory() view returns (address)",
  "function isNativeQuote() view returns (bool)",
  "function graduated() view returns (bool)",
  "function readyToGraduate() view returns (bool)",
  "function buybackEnabled() view returns (bool)",
  "function getReserves() view returns (uint256 quoteReserve,uint256 tokenReserve)",
  "function quoteReserve() view returns (uint256)",
  "function realQuoteReserve() view returns (uint256)",
  "function tokenReserve() view returns (uint256)",
  "function sellableTokens() view returns (uint256)",
  "function reservedTokens() view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "function creatorTaxBps() view returns (uint256)",
  "function currentSnipeTaxBps(address recipient) view returns (uint256)",
  "function graduationThreshold() view returns (uint256)",
  "function trackedQuote() view returns (uint256)",
  "function trackedTokens() view returns (uint256)",
];
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
];

const BPS = 10000n;

export interface PonsV2CurveState {
  curve: string;
  token: string;
  pairToken: string;
  native: boolean;
  graduated: boolean;
  readyToGraduate: boolean;
  buybackEnabled: boolean;
  quoteReserve: bigint;
  tokenReserve: bigint;
  sellableTokens: bigint;
  reservedTokens: bigint;
  trackedQuote: bigint;
  trackedTokens: bigint;
  feeBps: number;
  creatorTaxBps: number;
  snipeTaxBps: number;
  graduationThreshold: bigint;
}

export interface PonsV2CurveBuyQuote {
  spent: bigint;
  tokensOut: bigint;
  refund: bigint;
  fee: bigint;
  tax: bigint;
  snipeTax: bigint;
  net: bigint;
  partialFill: boolean;
}

export interface PonsV2CurveSellQuote {
  gross: bigint;
  quoteOut: bigint;
  fee: bigint;
  tax: bigint;
}

export interface PonsV2CurveTransaction {
  to: string;
  data: string;
  value: bigint;
  venue: "PONS_V2_CURVE";
}

export interface PonsV2CurveInputReadiness {
  native: boolean;
  token: string;
  curve: string;
  balance: bigint;
  allowanceToCurve: bigint;
  requiredAmountIn: bigint;
  ready: boolean;
  reason?: "PONS_CURVE_INPUT_BALANCE_TOO_LOW" | "PONS_CURVE_ALLOWANCE_MISSING";
  details: Record<string, string | number | boolean>;
}

function amountOut(inAmount: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (inAmount <= 0n || reserveIn <= 0n) return 0n;
  return (inAmount * reserveOut) / (reserveIn + inAmount);
}

function amountInFor(outAmount: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (outAmount <= 0n || outAmount >= reserveOut) throw new Error("PONS_CURVE_UNQUOTABLE_TRADE");
  return (outAmount * reserveIn) / (reserveOut - outAmount) + 1n;
}

function bpsAmount(amount: bigint, bps: bigint): bigint {
  return (amount * bps) / BPS;
}

function mulDivCeil(value: bigint, numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("PONS_CURVE_FEE_POLICY_INVALID");
  return (value * numerator + denominator - 1n) / denominator;
}

/**
 * Mirrors the bonding curve's own buy quote. The fee, creator tax and anti-snipe tax are all taken out of the
 * quote input before it touches the reserves, and the curve refuses to spend more than `quoteIn` when the
 * requested size exceeds what is still sellable, so a partial fill returns a refund rather than reverting.
 */
export function quoteCurveBuyFromState(state: PonsV2CurveState, quoteIn: bigint): PonsV2CurveBuyQuote {
  if (state.graduated || state.readyToGraduate) throw new Error("PONS_CURVE_CLOSED");
  if (quoteIn <= 0n) throw new Error("PONS_CURVE_QUOTE_INPUT_ZERO");
  if (state.sellableTokens <= 0n || state.sellableTokens >= state.tokenReserve) throw new Error("PONS_CURVE_NOT_SELLABLE");
  const feeBps = BigInt(state.feeBps);
  const creatorTaxBps = BigInt(state.creatorTaxBps);
  if (feeBps + creatorTaxBps >= BPS) throw new Error("PONS_CURVE_FEE_POLICY_INVALID");
  let snipeBps = BigInt(state.snipeTaxBps);
  if (snipeBps > 0n) {
    const maxSnipeBps = BPS - feeBps - creatorTaxBps - 100n;
    snipeBps = snipeBps > maxSnipeBps ? maxSnipeBps : snipeBps;
    if (snipeBps < 0n) snipeBps = 0n;
  }

  let spent = quoteIn;
  let fee = bpsAmount(spent, feeBps);
  let tax = bpsAmount(spent, creatorTaxBps);
  let snipeTax = bpsAmount(spent, snipeBps);
  const net = spent - fee - tax - snipeTax;
  if (net <= 0n) throw new Error("PONS_CURVE_UNQUOTABLE_TRADE");

  const quoted = amountOut(net, state.quoteReserve, state.tokenReserve);
  if (quoted <= 0n) throw new Error("PONS_CURVE_UNQUOTABLE_TRADE");

  let tokensOut = quoted;
  let partialFill = false;
  if (quoted > state.sellableTokens) {
    partialFill = true;
    tokensOut = state.sellableTokens;
    const netNeeded = amountInFor(tokensOut, state.quoteReserve, state.tokenReserve);
    const totalFeeBps = feeBps + creatorTaxBps + snipeBps;
    const grossed = mulDivCeil(netNeeded, BPS, BPS - totalFeeBps);
    spent = grossed < quoteIn ? grossed : quoteIn;
    fee = bpsAmount(spent, feeBps);
    tax = bpsAmount(spent, creatorTaxBps);
    snipeTax = bpsAmount(spent, snipeBps);
  }

  return { spent, tokensOut, refund: quoteIn > spent ? quoteIn - spent : 0n, fee, tax, snipeTax, net: spent - fee - tax - snipeTax, partialFill };
}

/**
 * The curve checks `spent * minTokensOut <= quoteIn * tokensOut`, so the minimum has to be scaled by the
 * *spent* portion of the input rather than the whole `quoteIn` — a partial fill would otherwise reject.
 */
export function minTokensOutForBuy(quoteIn: bigint, quote: PonsV2CurveBuyQuote, slippageBps: number): bigint {
  if (slippageBps >= 10000) return 0n;
  if (quote.spent <= 0n || quote.tokensOut <= 0n) throw new Error("PONS_CURVE_UNQUOTABLE_TRADE");
  return (quoteIn * quote.tokensOut * BigInt(10000 - slippageBps)) / (quote.spent * BPS);
}

export function quoteCurveSellFromState(state: PonsV2CurveState, tokensIn: bigint): PonsV2CurveSellQuote {
  if (state.graduated || state.readyToGraduate) throw new Error("PONS_CURVE_CLOSED");
  if (tokensIn <= 0n) throw new Error("PONS_CURVE_QUOTE_INPUT_ZERO");
  const gross = amountOut(tokensIn, state.tokenReserve, state.quoteReserve);
  if (gross <= 0n) throw new Error("PONS_CURVE_UNQUOTABLE_TRADE");
  const fee = bpsAmount(gross, BigInt(state.feeBps));
  const tax = bpsAmount(gross, BigInt(state.creatorTaxBps));
  const quoteOut = gross - fee - tax;
  if (quoteOut <= 0n) throw new Error("PONS_CURVE_UNQUOTABLE_TRADE");
  return { gross, quoteOut, fee, tax };
}

export class PonsV2CurveAdapter {
  private readonly contract: ethers.Contract;

  constructor(private readonly provider: ethers.Provider, private readonly curveAddress: string, private readonly chainId: number) {
    this.contract = new ethers.Contract(curveAddress, CURVE_ABI, provider);
  }

  /**
   * Reads the whole curve in one round trip. Optional views (buyback bookkeeping, tracked totals) are allowed
   * to fail so a curve on a slightly different factory version still prices instead of dropping the launch.
   */
  async readState(recipient: string): Promise<PonsV2CurveState> {
    const read = async <T>(call: Promise<T>): Promise<T | undefined> => {
      try {
        return await call;
      } catch {
        return undefined;
      }
    };
    const [token, pairToken, graduated, readyToGraduate, buybackEnabled, reserves, sellableTokens, reservedTokens, feeBps, creatorTaxBps, snipeTaxBps, graduationThreshold, trackedQuote, trackedTokens] = await Promise.all([
      read(this.contract.token()),
      read(this.contract.pairToken()),
      read(this.contract.graduated()),
      read(this.contract.readyToGraduate()),
      read(this.contract.buybackEnabled()),
      read(this.contract.getReserves()),
      read(this.contract.sellableTokens()),
      read(this.contract.reservedTokens()),
      read(this.contract.feeBps()),
      read(this.contract.creatorTaxBps()),
      read(this.contract.currentSnipeTaxBps(recipient)),
      read(this.contract.graduationThreshold()),
      read(this.contract.trackedQuote()),
      read(this.contract.trackedTokens()),
    ]);
    if (!token || !pairToken || !reserves || sellableTokens === undefined || feeBps === undefined || creatorTaxBps === undefined) {
      throw new Error("PONS_CURVE_STATE_UNAVAILABLE");
    }
    const pairTokenAddress = ethers.getAddress(String(pairToken));
    return {
      curve: ethers.getAddress(this.curveAddress),
      token: ethers.getAddress(String(token)),
      pairToken: pairTokenAddress,
      native: pairTokenAddress === ethers.ZeroAddress,
      graduated: Boolean(graduated),
      readyToGraduate: Boolean(readyToGraduate),
      buybackEnabled: Boolean(buybackEnabled),
      quoteReserve: BigInt(reserves[0]),
      tokenReserve: BigInt(reserves[1]),
      sellableTokens: BigInt(sellableTokens),
      reservedTokens: reservedTokens === undefined ? 0n : BigInt(reservedTokens),
      trackedQuote: trackedQuote === undefined ? 0n : BigInt(trackedQuote),
      trackedTokens: trackedTokens === undefined ? 0n : BigInt(trackedTokens),
      feeBps: Number(feeBps),
      creatorTaxBps: Number(creatorTaxBps),
      snipeTaxBps: snipeTaxBps === undefined ? 0 : Number(snipeTaxBps),
      graduationThreshold: graduationThreshold === undefined ? 0n : BigInt(graduationThreshold),
    };
  }

  /**
   * A native quote is paid in `msg.value`, so the balance is checked before approvals or simulation can spend
   * gas: an unfundable trade must report itself blocked without paying for the attempt.
   */
  async inspectInputReadiness(token: string, owner: string, amountIn: bigint): Promise<PonsV2CurveInputReadiness> {
    if (token === ethers.ZeroAddress) {
      const balance = BigInt(await this.provider.getBalance(owner));
      const ready = balance >= amountIn;
      return {
        native: true,
        token,
        curve: ethers.getAddress(this.curveAddress),
        balance,
        allowanceToCurve: 0n,
        requiredAmountIn: amountIn,
        ready,
        reason: ready ? undefined : "PONS_CURVE_INPUT_BALANCE_TOO_LOW",
        details: { owner, balance: balance.toString(), requiredAmountIn: amountIn.toString(), hasSufficientBalance: ready },
      };
    }
    const erc20 = new ethers.Contract(token, ERC20_ABI, this.provider);
    const [balance, allowance] = await Promise.all([erc20.balanceOf(owner), erc20.allowance(owner, this.curveAddress)]);
    const balanceValue = BigInt(balance);
    const allowanceValue = BigInt(allowance);
    const hasBalance = balanceValue >= amountIn;
    const ready = hasBalance && allowanceValue >= amountIn;
    return {
      native: false,
      token,
      curve: ethers.getAddress(this.curveAddress),
      balance: balanceValue,
      allowanceToCurve: allowanceValue,
      requiredAmountIn: amountIn,
      ready,
      reason: hasBalance ? "PONS_CURVE_ALLOWANCE_MISSING" : "PONS_CURVE_INPUT_BALANCE_TOO_LOW",
      details: {
        owner,
        balance: balanceValue.toString(),
        allowanceToCurve: allowanceValue.toString(),
        requiredAmountIn: amountIn.toString(),
        hasSufficientBalance: hasBalance,
        hasCurveAllowance: allowanceValue >= amountIn,
      },
    };
  }

  /**
   * The curve pulls its input with `transferFrom`, so the input token approves the curve directly — Permit2 is
   * only part of the Uniswap V4 router path.
   */
  async ensureAllowance(wallet: ethers.Wallet, token: string, amount: bigint): Promise<void> {
    if (token === ethers.ZeroAddress) return;
    const erc20 = new ethers.Contract(token, ERC20_ABI, this.provider);
    const current = BigInt(await erc20.allowance(wallet.address, this.curveAddress));
    if (current >= amount) return;
    const nonceManager = nonceManagerFor(this.provider, wallet.address);
    const nonce = await nonceManager.reserve();
    const feeData = await this.provider.getFeeData();
    const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
    const response = await wallet.sendTransaction({
      ...(await erc20.approve.populateTransaction(this.curveAddress, ethers.MaxUint256)),
      chainId: this.chainId,
      nonce,
      ...(maxFeePerGas ? { maxFeePerGas, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? maxFeePerGas } : {}),
    });
    const receipt = await response.wait();
    if (!receipt || receipt.status !== 1) throw new Error("PONS_CURVE_APPROVAL_FAILED");
    console.log("PONS CURVE APPROVAL CONFIRMED:", { curve: ethers.getAddress(this.curveAddress), token, spender: ethers.getAddress(this.curveAddress), transactionHash: response.hash });
  }

  buildBuy(quoteIn: bigint, minTokensOut: bigint, recipient: string, pairToken: string): PonsV2CurveTransaction {
    if (!ethers.isAddress(recipient)) throw new Error("INVALID_RECIPIENT");
    if (quoteIn <= 0n || minTokensOut < 0n) throw new Error("INVALID_SWAP_AMOUNTS");
    const native = pairToken === ethers.ZeroAddress;
    return {
      to: ethers.getAddress(this.curveAddress),
      data: this.contract.interface.encodeFunctionData("buy", [quoteIn, minTokensOut, recipient]),
      value: native ? quoteIn : 0n,
      venue: "PONS_V2_CURVE",
    };
  }

  buildSell(tokensIn: bigint, minQuoteOut: bigint, recipient: string): PonsV2CurveTransaction {
    if (!ethers.isAddress(recipient)) throw new Error("INVALID_RECIPIENT");
    if (tokensIn <= 0n || minQuoteOut < 0n) throw new Error("INVALID_SWAP_AMOUNTS");
    return {
      to: ethers.getAddress(this.curveAddress),
      data: this.contract.interface.encodeFunctionData("sell", [tokensIn, minQuoteOut, recipient]),
      value: 0n,
      venue: "PONS_V2_CURVE",
    };
  }

  async simulate(transaction: PonsV2CurveTransaction, from: string): Promise<bigint> {
    return this.provider.estimateGas({ from, to: transaction.to, data: transaction.data, value: transaction.value });
  }
}
