import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type PositionStatus = "OPEN" | "PARTIALLY_EXITED" | "CLOSED" | "FAILED_EXIT" | "EMERGENCY_EXIT";

export interface PaperPosition {
  id: string;
  token: string;
  pool: string;
  entryBlock: number;
  entryAt: number;
  entryPriceWei: bigint;
  tokenAmount: bigint;
  remainingTokenAmount: bigint;
  committedWei: bigint;
  realizedPnlWei: bigint;
  highestProfitMilestone: number;
  status: PositionStatus;
}

export interface PaperSnapshot {
  ethBalanceWei: bigint;
  reservedWei: bigint;
  realizedPnlWei: bigint;
  peakEquityWei: bigint;
  currentEquityWei: bigint;
  drawdownWei: bigint;
  gasSpentWei: bigint;
  feesPaidWei: bigint;
}

interface StoredState {
  ethBalanceWei: string;
  startingBalanceWei: string;
  reservedWei: string;
  realizedPnlWei: string;
  peakEquityWei: string;
  gasSpentWei: string;
  feesPaidWei: string;
  positions: Array<Omit<PaperPosition, "entryPriceWei" | "tokenAmount" | "remainingTokenAmount" | "committedWei" | "realizedPnlWei"> & Record<string, string | number>>;
}

export class PaperExchange {
  private ethBalanceWei: bigint;
  private readonly startingBalanceWei: bigint;
  private reservedWei = 0n;
  private realizedPnlWei = 0n;
  private peakEquityWei: bigint;
  private gasSpentWei = 0n;
  private feesPaidWei = 0n;
  private positions = new Map<string, PaperPosition>();
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(private readonly filePath: string, startingBalanceWei: bigint, state?: StoredState) {
    this.startingBalanceWei = BigInt(state?.startingBalanceWei ?? startingBalanceWei);
    this.ethBalanceWei = BigInt(state?.ethBalanceWei ?? startingBalanceWei);
    this.peakEquityWei = BigInt(state?.peakEquityWei ?? startingBalanceWei);
    if (!state) return;
    this.reservedWei = BigInt(state.reservedWei);
    this.realizedPnlWei = BigInt(state.realizedPnlWei);
    this.gasSpentWei = BigInt(state.gasSpentWei);
    this.feesPaidWei = BigInt(state.feesPaidWei);
    for (const position of state.positions) {
      this.positions.set(position.id, {
        ...position,
        entryPriceWei: BigInt(position.entryPriceWei),
        tokenAmount: BigInt(position.tokenAmount),
        remainingTokenAmount: BigInt(position.remainingTokenAmount),
        committedWei: BigInt(position.committedWei),
        realizedPnlWei: BigInt(position.realizedPnlWei),
      } as PaperPosition);
    }
  }

  static async open(filePath: string, startingBalanceWei: bigint): Promise<PaperExchange> {
    try {
      const state = JSON.parse(await readFile(filePath, "utf8")) as StoredState;
      return new PaperExchange(filePath, startingBalanceWei, state);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return new PaperExchange(filePath, startingBalanceWei);
    }
  }

  async buy(input: { id: string; token: string; pool: string; amountInWei: bigint; tokenAmount: bigint; entryPriceWei: bigint; block: number; gasWei?: bigint; feeWei?: bigint }): Promise<PaperPosition> {
    if (this.positions.has(input.id)) throw new Error("POSITION_ALREADY_EXISTS");
    if (input.amountInWei <= 0n || input.tokenAmount <= 0n) throw new Error("INVALID_PAPER_BUY");
    if (input.amountInWei > this.ethBalanceWei) throw new Error("PAPER_BALANCE_TOO_LOW");
    this.ethBalanceWei -= input.amountInWei;
    this.reservedWei += input.amountInWei;
    this.gasSpentWei += input.gasWei ?? 0n;
    this.feesPaidWei += input.feeWei ?? 0n;
    const position: PaperPosition = {
      id: input.id,
      token: input.token.toLowerCase(),
      pool: input.pool.toLowerCase(),
      entryBlock: input.block,
      entryAt: Date.now(),
      entryPriceWei: input.entryPriceWei,
      tokenAmount: input.tokenAmount,
      remainingTokenAmount: input.tokenAmount,
      committedWei: input.amountInWei,
      realizedPnlWei: 0n,
      highestProfitMilestone: 0,
      status: "OPEN",
    };
    this.positions.set(position.id, position);
    await this.persist();
    return position;
  }

  async sell(id: string, amountToken: bigint, proceedsWei: bigint, gasWei = 0n, feeWei = 0n): Promise<PaperPosition> {
    const position = this.requirePosition(id);
    if (position.status === "CLOSED") throw new Error("POSITION_CLOSED");
    if (amountToken <= 0n || amountToken > position.remainingTokenAmount) throw new Error("INVALID_PAPER_SELL");
    const costBasis = position.committedWei * amountToken / position.tokenAmount;
    const pnl = proceedsWei - costBasis - gasWei - feeWei;
    position.remainingTokenAmount -= amountToken;
    position.realizedPnlWei += pnl;
    this.realizedPnlWei += pnl;
    this.reservedWei -= costBasis;
    this.ethBalanceWei += proceedsWei - gasWei - feeWei;
    this.gasSpentWei += gasWei;
    this.feesPaidWei += feeWei;
    position.status = position.remainingTokenAmount === 0n ? "CLOSED" : "PARTIALLY_EXITED";
    await this.persist();
    return position;
  }

  async applyProfitMilestones(id: string, currentValueWei: bigint): Promise<bigint[]> {
    const position = this.requirePosition(id);
    const basis = position.committedWei;
    if (basis <= 0n) return [];
    const profitPercent = Number((currentValueWei - basis) * 100n / basis);
    const exited: bigint[] = [];
    const nextMilestone = Math.floor(profitPercent / 100) * 100;
    while (position.highestProfitMilestone + 100 <= nextMilestone && position.remainingTokenAmount > 0n) {
      position.highestProfitMilestone += 100;
      const amount = position.remainingTokenAmount / 5n;
      if (amount > 0n) exited.push(amount);
    }
    await this.persist();
    return exited;
  }

  async markFailedExit(id: string): Promise<void> {
    const position = this.requirePosition(id);
    position.status = "FAILED_EXIT";
    await this.persist();
  }

  getPosition(id: string): PaperPosition | undefined { return this.positions.get(id); }
  get openPositions(): PaperPosition[] { return [...this.positions.values()].filter((position) => position.status !== "CLOSED"); }
  get snapshot(): PaperSnapshot {
    const currentEquityWei = this.ethBalanceWei + this.reservedWei;
    return {
      ethBalanceWei: this.ethBalanceWei,
      reservedWei: this.reservedWei,
      realizedPnlWei: this.realizedPnlWei,
      peakEquityWei: this.peakEquityWei,
      currentEquityWei,
      drawdownWei: this.peakEquityWei > currentEquityWei ? this.peakEquityWei - currentEquityWei : 0n,
      gasSpentWei: this.gasSpentWei,
      feesPaidWei: this.feesPaidWei,
    };
  }

  private requirePosition(id: string): PaperPosition {
    const position = this.positions.get(id);
    if (!position) throw new Error("POSITION_NOT_FOUND");
    return position;
  }

  private async persist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const state: StoredState = {
        ethBalanceWei: this.ethBalanceWei.toString(),
        startingBalanceWei: this.startingBalanceWei.toString(),
        reservedWei: this.reservedWei.toString(),
        realizedPnlWei: this.realizedPnlWei.toString(),
        peakEquityWei: this.peakEquityWei.toString(),
        gasSpentWei: this.gasSpentWei.toString(),
        feesPaidWei: this.feesPaidWei.toString(),
        positions: [...this.positions.values()].map((position) => ({ ...position, entryPriceWei: position.entryPriceWei.toString(), tokenAmount: position.tokenAmount.toString(), remainingTokenAmount: position.remainingTokenAmount.toString(), committedWei: position.committedWei.toString(), realizedPnlWei: position.realizedPnlWei.toString() })),
      };
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(state, null, 2), "utf8");
      await rename(temporaryPath, this.filePath);
    });
    return this.writeQueue;
  }
}
