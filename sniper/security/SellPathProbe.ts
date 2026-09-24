import { ethers } from "ethers";
import type { SellPathStatus } from "./PonsLaunchGate";

const ERC20_PROBE_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const CURVE_PROBE_ABI = ["function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256)"];

/** Slots trialled for the `allowance(owner, curve)` mapping. Solidly-ordered storage puts it near the top. */
const DEFAULT_MAX_ALLOWANCE_SLOT = 5;

export interface SellPathProbeInput {
  token: string;
  curve: string;
  /**
   * A wallet that ACTUALLY holds the token. Using a real holder as `from` means the balance needs no
   * override, which matters because this RPC rejects a non-zero `eth_call.value` and will not let an override
   * satisfy an up-front funds check.
   */
  holder: string;
  maxAllowanceSlot?: number;
}

export interface SellPathProbeResult {
  /** "ok" = a sell leg executed, "blocked" = one provably reverted, null = the probe could not be run. */
  status: SellPathStatus;
  /** The allowance-free leg: can the holder move tokens to the curve at all? */
  transferOk: boolean | null;
  /** The payout leg: does `sell` return quote once the curve is allowed to pull? */
  sellOk: boolean | null;
  allowanceSlot: number | null;
  detail: string;
}

interface ProbeRpc {
  send(method: string, params: unknown[]): Promise<unknown>;
}

/**
 * Prove the sell path by executing it, not by pattern-matching bytecode. `transfer(curve)` is allowance-free,
 * so a revert there is a definitive "this token cannot leave the wallet"; `sell(...)` additionally needs the
 * curve to be allowed to pull the tokens, and the allowance is injected as a `stateDiff` on the nested
 * mapping slot (a handful of candidate slots is cheaper and more portable than deriving it from verified
 * source). Both legs run through `eth_call` against a real holder at `latest`, so they cost no gas and cannot
 * be faked by a bytecode fingerprint.
 *
 * The honest failure mode is `null`, not `"ok"`: a probe that never ran - no holder with a balance, an RPC
 * that refuses `eth_call` with overrides, a token whose `sell` ABI differs - must not be readable as a pass.
 * The caller's `requireSellPath` gate turns `null` into `SELL_PATH_UNKNOWN` and rejects.
 */
export async function probeSellPath(
  provider: ethers.Provider,
  input: SellPathProbeInput,
): Promise<SellPathProbeResult> {
  const rpc = provider as unknown as ProbeRpc;
  if (typeof rpc.send !== "function") {
    return { status: null, transferOk: null, sellOk: null, allowanceSlot: null, detail: "PROVIDER_HAS_NO_RAW_SEND" };
  }

  let holder: string;
  let curve: string;
  try {
    holder = ethers.getAddress(input.holder);
    curve = ethers.getAddress(input.curve);
  } catch {
    return { status: null, transferOk: null, sellOk: null, allowanceSlot: null, detail: "BAD_ADDRESS" };
  }

  let balance: bigint;
  try {
    const token = new ethers.Contract(input.token, ERC20_PROBE_ABI, provider);
    balance = BigInt(await token.balanceOf(holder));
  } catch (error) {
    return { status: null, transferOk: null, sellOk: null, allowanceSlot: null, detail: `BALANCE_UNREADABLE: ${message(error)}` };
  }
  if (balance <= 0n) {
    return { status: null, transferOk: null, sellOk: null, allowanceSlot: null, detail: "HOLDER_HAS_NO_BALANCE" };
  }
  // Half the bag: large enough to be a real sell, small enough to leave the holder solvent for the second leg.
  const amount = balance / 2n;

  const tokenIface = new ethers.Interface(ERC20_PROBE_ABI);
  const curveIface = new ethers.Interface(CURVE_PROBE_ABI);

  const call = async (to: string, data: string, override?: Record<string, unknown>): Promise<string> =>
    String(await rpc.send("eth_call", override ? [{ from: holder, to, data }, "latest", override] : [{ from: holder, to, data }, "latest"]));

  // Leg 1 - allowance-free. A revert here is conclusive: the token itself will not move.
  let transferOk: boolean | null = null;
  try {
    const raw = await call(input.token, tokenIface.encodeFunctionData("transfer", [curve, amount]));
    transferOk = raw === "0x" || BigInt(raw) === 1n;
  } catch {
    transferOk = false;
  }
  if (transferOk === false) {
    return { status: "blocked", transferOk, sellOk: null, allowanceSlot: null, detail: "TRANSFER_REVERTED" };
  }

  // Leg 2 - the payout. Needs the curve allowed to pull the tokens, so the allowance slot is injected by trial.
  const maxSlot = input.maxAllowanceSlot ?? DEFAULT_MAX_ALLOWANCE_SLOT;
  let lastError = "";
  for (let allowanceSlot = 0; allowanceSlot <= maxSlot; allowanceSlot += 1) {
    try {
      const override = {
        [ethers.getAddress(input.token)]: {
          stateDiff: { [nestedAllowanceSlotHash(holder, curve, allowanceSlot)]: word(2n ** 255n) },
        },
      };
      await call(curve, curveIface.encodeFunctionData("sell", [amount, 0n, holder]), override);
      return { status: "ok", transferOk, sellOk: true, allowanceSlot, detail: "SELL_SIMULATED" };
    } catch (error) {
      lastError = message(error);
    }
  }

  // The transfer leg passed, so the token can move; the curve's own sell leg never produced quote. That is
  // either a blocked exit or a `sell` signature this probe does not know, and the ABI is pinned by the
  // production adapter, so it is reported as blocked.
  return {
    status: "blocked",
    transferOk,
    sellOk: false,
    allowanceSlot: null,
    detail: `SELL_REVERTED: ${lastError.slice(0, 160)}`,
  };
}

function nestedAllowanceSlotHash(owner: string, spender: string, allowanceSlot: number): string {
  return ethers.keccak256(
    ethers.concat([
      ethers.zeroPadValue(ethers.getAddress(spender), 32),
      ethers.keccak256(ethers.concat([ethers.zeroPadValue(ethers.getAddress(owner), 32), word(BigInt(allowanceSlot))])),
    ]),
  );
}

function word(value: bigint): string {
  return ethers.zeroPadValue(ethers.toBeHex(value), 32);
}

function message(error: unknown): string {
  if (error && typeof error === "object") {
    const candidate = error as { shortMessage?: string; message?: string };
    return candidate.shortMessage ?? candidate.message ?? String(error);
  }
  return String(error);
}
