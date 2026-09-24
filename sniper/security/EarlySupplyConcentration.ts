import { ethers } from "ethers";

/**
 * How much of a launch's supply the coordinated early buyers control, measured only from the token's own
 * ERC20 `Transfer` history in the first seconds after its launch block.
 *
 * The principle this measures: bundling a launch is normal - a creator funds wallets that buy early so the
 * token shows activity - but the bundlers must not control the MAJORITY of the supply. A majority stake taken
 * at launch is a single decision away from being sold into everyone else, so the question is not "is this
 * bundled" but "how much of the supply does the bundle hold".
 *
 * Measured over 52 live launches (120 sampled, stride 18 across the 2,276-launch census, 40-block window):
 *
 *   early share      the ceiling, not the measurement: 23/52 above 5%, 13 above 10%, 4 above 20%,
 *                    3 above 30%, 1 above 40%, and 0/52 above a 45% majority.
 *   sender bundle    the measurement: 20/52 above 5%, 13 above 10%, 4 above 20%, 3 above 30%, 1 above 40%.
 *   same block       the free cross-check: identical to within 0.06pp of the sender number at the top.
 *
 * The `senderOperators` field is what made this instrument work. Three separate launches in that sample each
 * had 22-24 early wallets fed by ONE wallet inside the window (0x2694aeb3: 24 wallets / 25 distinct txs,
 * 0xb0c9b13f: 22, 0xffe2e5af: 13 through a private relay), and each read under 1% on every funding-based
 * metric, because the operator does not fund the wallets - it sends them the token. The same 22 recipient
 * addresses recurred across all four launches from four different operators.
 *
 * The same window also carries a second, separate concentration that no other metric on chain can see: the
 * LAUNCH TRANSACTION ITSELF hands supply to addresses that never bought any. Every PONS V2 launch tx mints
 * 100% of supply to the curve and then the curve sends some of it out inside the same transaction. Measured
 * over the same 52 launches, 12 carry such an allocation and 10 carry more than 1%. They are bimodal, not
 * spread: 42 launches allocate nothing at all, while the other 10 allocate 5.79%, 9.52%, 11.00%, 15.22%,
 * 17.96%, 18.35%, 18.72%, 25.18%, 25.21% and 27.25% to a handful of wallets - one of them to the launch
 * transaction's own sender, which is a different wallet from the deployer in most cases. Those recipients
 * sell into the curve: 0 of the 24 recipients across those 10 launches still held anything when re-read
 * later, and the curve was back to 99.98% of supply, i.e. the allocation was fully recycled at the expense
 * of whoever bought it.
 *
 * The two signals are near-disjoint, which is why both are measured. At a 15% ceiling the coordinated-sender
 * metric refuses 7 of 52 launches and the block-0 allocation refuses 7, but they share only ONE launch: the
 * union is 13 of 52 (25.0%), with 6 launches that only the sender metric sees and 6 that only the allocation
 * metric sees. The allocation is also a reusable fingerprint - across the 12 allocating launches there were
 * 12 distinct deployers but only 21 distinct recipients, and 5 recipients each appeared in two launches
 * behind two DIFFERENT deployers. Four of those five recurred as a single set, in two launches, receiving
 * the same percentages to the basis point (10.1/6.07/4.59/4.43 and 10.08/6.07/4.59/4.43). The deployer is
 * disposable; the recipient set is the operator's identity.
 *
 * Two reads, both accepted by the same public RPC the bot already uses, no vendor, no indexer, no API key:
 *   1. `alchemy_getAssetTransfers` for the token in [launchBlock, launchBlock + windowBlocks], one call.
 *      Fallback when that method is unavailable: 10-block-chunked `eth_getLogs` (Alchemy free tier rejects
 *      wider `eth_getLogs` ranges with a 400). Every concentration below - the in-window sender fan-out, the
 *      block-0 allocation, the same-block/adjacent-block clustering and the wallet-to-wallet traffic - comes
 *      out of this one call, so adding them costs no extra RPC.
 *   2. `totalSupply()`.
 *
 * Same and sequential blocks, and wallet-to-wallet traffic, are the coordination signals a share-of-supply
 * ceiling alone cannot see. An operator that spreads one coordinated entry over the launch's first three
 * blocks, or that recycles tokens between its own wallets to print volume, holds the same supply as one that
 * fires a single block - so the share metrics read clean while the behaviour is identical. These three
 * measures look at WHEN the first receipts landed and WHO traded with WHOM instead of how much was held:
 *
 *   sameBlockSharePct       wallets whose first receipt is in a block that delivered to >= 2 distinct wallets
 *   sequentialBlockSharePct wallets whose first receipt is in a block adjacent to another first-receipt block
 *                           from a DIFFERENT sender (one sender spreading its own fan-out across consecutive
 *                           blocks is deliberately not flagged)
 *   peerTransferSharePct    supply moved wallet-to-wallet between in-window holders, and
 *                           reciprocalPairCount, the pairs that moved tokens BOTH ways - the round trip that
 *                           exists to print volume and to make one wallet look like many
 *
 * Returns null when the history cannot be read at all, so the caller can decide whether that is fatal.
 */
export const DEFAULT_RELAY_ADDRESSES = ["0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc"];

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const LOG_CHUNK = 10;
const MAX_TRANSFERS = 1000;

export interface EarlySupplyConcentrationPolicy {
  /** Blocks after the launch block that count as "the bundle window". 40 blocks is ~4.0s at ~0.1s/block. */
  windowBlocks: number;
  /** Token forwarders that sit between an operator and its wallets; senders are resolved one hop through them. */
  relayAddresses: string[];
}

export interface EarlySupplyConcentrationInput {
  token: string;
  launchBlock: number;
  /** The launch transaction itself, whose legs (curve inventory, any creator allocation) are not buys. */
  launchTx?: string | null;
  /** Curve, deployer, token and factory addresses: infrastructure, never counted as buyers. */
  exclude: string[];
  /** The deployer, whose own bag counts as insider supply even though it is infrastructure to the bundle read. */
  deployer?: string | null;
  policy: EarlySupplyConcentrationPolicy;
}

export interface EarlySupplyConcentration {
  launchBlock: number;
  windowEndBlock: number;
  source: "transfers" | "logs";
  transfersRead: number;
  truncated: boolean;
  holders: number;
  earlyCount: number;
  /** Upper bound: every wallet that first received the token in the window. */
  earlySharePct: number;
  /** Coordinated share: wallets fed inside the window by one sender that fed at least two of them. */
  senderBundleSharePct: number;
  senderOperators: SenderOperator[];
  /**
   * Supply the launch transaction itself handed to addresses outside the curve/deployer/token/factory, i.e.
   * a free allocation nobody bought. null when the launch transaction hash was not supplied, because then
   * the legs cannot be identified at all and a 0 would read as "clean" when it means "unmeasured".
   */
  launchAllocSharePct: number | null;
  launchAllocRecipients: LaunchAllocRecipient[];
  /**
   * Supply held by wallets whose FIRST receipt landed in a block that delivered the token to at least two
   * distinct wallets - the same-block half of the "same or sequential block" coordination signal. Distinct
   * from `senderBundleSharePct`: this one needs no shared sender, only a shared block.
   */
  sameBlockSharePct: number;
  sameBlockClusters: SameBlockCluster[];
  /**
   * Supply held by wallets whose first receipt is in a block adjacent to another first-receipt block whose
   * sender is DIFFERENT. One sender fanning its own wallets across consecutive blocks is not flagged, so this
   * separates a coordinated multi-operator entry from a single operator's own spread.
   */
  sequentialBlockSharePct: number;
  /** Supply moved between two in-window holders inside the window: wallets trading with each other. */
  peerTransferSharePct: number;
  peerTransferPairs: PeerTransferPair[];
  /** Pairs of holders that moved tokens to each other in BOTH directions inside the window. */
  reciprocalPairCount: number;
  /** The largest holders at window end, largest first. */
  topHolders: HolderTier[];
  top1Pct: number;
  top5Pct: number;
  top10Pct: number;
  /**
   * Supply the insiders control at window end: every wallet that first received inside the window, every
   * launch-transaction allocation recipient, and the deployer. This is the literal "do the insiders hold the
   * majority of the supply" measure, and it is bounded by what the curve has actually released - the curve
   * itself holds the remainder until graduation.
   */
  insiderSharePct: number;
}

export interface SameBlockCluster {
  block: number;
  recipients: number;
  /** Distinct senders that fed the cluster. 1 means a single fan-out; >1 means separate operators. */
  senders: number;
  sharePct: number;
}

export interface PeerTransferPair {
  from: string;
  to: string;
  transfers: number;
  sharePct: number;
}

export interface HolderTier {
  address: string;
  sharePct: number;
}

export interface SenderOperator {
  sender: string;
  recipients: number;
  /** Share of supply held by the wallets this sender fed in the window. */
  sharePct: number;
  /** The sender's own retained bag in the same window. */
  ownSharePct: number;
}

export interface LaunchAllocRecipient {
  address: string;
  sharePct: number;
}

interface Leg {
  block: number;
  tx: string;
  from: string;
  to: string;
  value: bigint;
}

interface EnhancedRpc {
  send(method: string, params: unknown[]): Promise<unknown>;
}

const SUPPLY_ABI = ["function totalSupply() view returns (uint256)"];

export async function measureEarlySupplyConcentration(
  provider: ethers.Provider,
  input: EarlySupplyConcentrationInput,
): Promise<EarlySupplyConcentration | null> {
  const token = input.token.toLowerCase();
  const launchBlock = input.launchBlock;
  const windowEndBlock = launchBlock + Math.max(0, input.policy.windowBlocks);
  const launchTx = (input.launchTx ?? "").toLowerCase();
  const exclude = new Set(input.exclude.filter(Boolean).map((a) => a.toLowerCase()));
  exclude.add(token);
  const relays = new Set(input.policy.relayAddresses.filter(Boolean).map((a) => a.toLowerCase()));

  const supply = await readTotalSupply(provider, input.token);
  if (supply === null || supply <= 0n) return null;

  let source: "transfers" | "logs" = "transfers";
  let read = await readTransfers(provider, input.token, launchBlock, windowEndBlock);
  if (read === null) {
    source = "logs";
    read = await readLogs(provider, input.token, launchBlock, windowEndBlock);
  }
  if (read === null) return null;
  const { rows, truncated } = read;

  const balance = new Map<string, bigint>();
  const firstSeen = new Map<string, number>();
  const firstTx = new Map<string, string>();
  const firstFrom = new Map<string, string>();
  const relayedFrom = new Map<string, Map<string, number>>();
  // Net balance per address over the launch transaction's own legs. The curve is the SENDER of every
  // allocation leg (it mints 100% to itself, then sends a slice out), so a leg can only be judged by its
  // recipient - filtering on the sender would discard every allocation there is.
  const launchBalance = new Map<string, bigint>();
  for (const leg of rows) {
    if (leg.from !== ZERO_ADDRESS) balance.set(leg.from, (balance.get(leg.from) ?? 0n) - leg.value);
    balance.set(leg.to, (balance.get(leg.to) ?? 0n) + leg.value);
    if (launchTx && leg.tx === launchTx) {
      if (leg.from !== ZERO_ADDRESS) launchBalance.set(leg.from, (launchBalance.get(leg.from) ?? 0n) - leg.value);
      launchBalance.set(leg.to, (launchBalance.get(leg.to) ?? 0n) + leg.value);
    }
    if (!firstSeen.has(leg.to)) {
      firstSeen.set(leg.to, leg.block);
      firstTx.set(leg.to, leg.tx);
      firstFrom.set(leg.to, leg.from);
    }
    if (relays.has(leg.to)) {
      const senders = relayedFrom.get(leg.to) ?? new Map<string, number>();
      senders.set(leg.from, (senders.get(leg.from) ?? 0) + 1);
      relayedFrom.set(leg.to, senders);
    }
  }

  // A relay hides the operator: 0xa9ce124a sends 13 wallets their tokens through 0x65050a9b, so the wallet
  // that actually paid for the bundle is the relay's own feeder, not the relay.
  const resolveSender = (recipient: string): string | null => {
    const sender = firstFrom.get(recipient);
    if (!sender || sender === ZERO_ADDRESS) return null;
    if (!relays.has(sender)) return sender;
    const senders = relayedFrom.get(sender);
    if (!senders || senders.size === 0) return null;
    const ranked = [...senders.entries()]
      .filter(([a]) => a !== ZERO_ADDRESS && a !== recipient)
      .sort((a, b) => b[1] - a[1]);
    return ranked.length ? ranked[0][0] : null;
  };

  const holders = [...balance.entries()]
    .filter(([address, amount]) => amount > 0n && address !== ZERO_ADDRESS && !exclude.has(address))
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
  // Early = first receipt inside the window, excluding legs the launch transaction itself made. The launch tx
  // mints the curve's inventory and any creator allocation; counting those would score every launch as bundled.
  const early = holders.filter(([address]) => {
    const block = firstSeen.get(address);
    return block !== undefined && block >= launchBlock && block <= windowEndBlock && firstTx.get(address) !== launchTx;
  });

  const bySender = new Map<string, string[]>();
  for (const [address] of early) {
    const sender = resolveSender(address);
    if (!sender) continue;
    const group = bySender.get(sender) ?? [];
    group.push(address);
    bySender.set(sender, group);
  }
  const groups = [...bySender.entries()].filter(([, group]) => group.length >= 2);
  const fed = new Set<string>();
  for (const [, group] of groups) for (const address of group) fed.add(address);

  const balanceOf = new Map(holders);
  // The launch tx's own allocation. The mint to the curve nets the curve to +100% of supply and everything
  // the curve sends out nets the recipients positive, so the recipients are exactly the wallets that were
  // given supply without buying it - the curve, the deployer, the token and the factory are excluded.
  const launchAllocEntries: [string, bigint][] = launchTx
    ? [...launchBalance.entries()]
        .filter(([address, amount]) => amount > 0n && address !== ZERO_ADDRESS && !exclude.has(address))
        .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
    : [];

  const earlyBlock = new Map<string, number>();
  for (const [address] of early) {
    const block = firstSeen.get(address);
    if (block !== undefined) earlyBlock.set(address, block);
  }
  const byBlock = new Map<number, string[]>();
  for (const [address, block] of earlyBlock) {
    const members = byBlock.get(block) ?? [];
    members.push(address);
    byBlock.set(block, members);
  }
  const sameBlockClusters: SameBlockCluster[] = [...byBlock.entries()]
    .filter(([, members]) => members.length >= 2)
    .sort((a, b) => a[0] - b[0])
    .map(([block, members]) => {
      const cluster = new Set(members);
      return {
        block,
        recipients: members.length,
        senders: new Set(members.map((address) => firstFrom.get(address) ?? ZERO_ADDRESS)).size,
        sharePct: share(early, ([address]) => cluster.has(address), supply),
      };
    });
  const sameBlockMembers = new Set(sameBlockClusters.flatMap((cluster) => byBlock.get(cluster.block) ?? []));

  // A wallet counts as sequential when a NEIGHBOURING first-receipt block was fed by a different sender. A
  // single operator that spreads its own fan-out over consecutive blocks therefore stays invisible here - it
  // shares one sender across the blocks - while two operators landing adjacent clusters do not.
  const blockSenders = new Map<number, Set<string>>();
  for (const [address, block] of earlyBlock) {
    const senders = blockSenders.get(block) ?? new Set<string>();
    senders.add(firstFrom.get(address) ?? ZERO_ADDRESS);
    blockSenders.set(block, senders);
  }
  const sequentialMembers = new Set<string>();
  for (const [address, block] of earlyBlock) {
    const own = firstFrom.get(address) ?? ZERO_ADDRESS;
    for (const neighbour of [block - 1, block + 1]) {
      const senders = blockSenders.get(neighbour);
      if (senders && [...senders].some((sender) => sender !== own)) {
        sequentialMembers.add(address);
        break;
      }
    }
  }

  // Wallet-to-wallet traffic among in-window holders. Both endpoints must have survived the window with a
  // positive balance, so the curve's own inventory legs and the launch transaction never count: a curve sale
  // has the curve as an endpoint, and the curve is not a holder.
  const holderSet = new Set(holders.map(([address]) => address));
  const peerValueByPair = new Map<string, { from: string; to: string; transfers: number; value: bigint }>();
  let peerValue = 0n;
  for (const leg of rows) {
    if (leg.tx === launchTx || leg.from === leg.to) continue;
    if (!holderSet.has(leg.from) || !holderSet.has(leg.to)) continue;
    peerValue += leg.value;
    const key = `${leg.from}>${leg.to}`;
    const entry = peerValueByPair.get(key) ?? { from: leg.from, to: leg.to, transfers: 0, value: 0n };
    entry.transfers += 1;
    entry.value += leg.value;
    peerValueByPair.set(key, entry);
  }
  const peerTransferPairs: PeerTransferPair[] = [...peerValueByPair.values()]
    .sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0))
    .slice(0, 20)
    .map(({ from, to, transfers, value }) => ({ from, to, transfers, sharePct: pct(value, supply) }));
  const reciprocalPairs = new Set<string>();
  for (const key of peerValueByPair.keys()) {
    const [from, to] = key.split(">");
    if (peerValueByPair.has(`${to}>${from}`)) reciprocalPairs.add([from, to].sort().join("|"));
  }

  const tierShare = (count: number): number => pct(holders.slice(0, count).reduce((sum, [, amount]) => sum + amount, 0n), supply);
  const insiderAddresses = new Set<string>();
  for (const [address] of early) insiderAddresses.add(address);
  for (const [address] of launchAllocEntries) insiderAddresses.add(address);
  const deployer = (input.deployer ?? "").toLowerCase();
  if (deployer && !exclude.has(deployer)) insiderAddresses.add(deployer);
  const insiderValue = [...insiderAddresses].reduce((sum, address) => {
    const amount = balance.get(address) ?? 0n;
    return sum + (amount > 0n ? amount : 0n);
  }, 0n);
  return {
    launchBlock,
    windowEndBlock,
    source,
    transfersRead: rows.length,
    truncated,
    holders: holders.length,
    earlyCount: early.length,
    earlySharePct: share(early, () => true, supply),
    senderBundleSharePct: share(early, ([address]) => fed.has(address), supply),
    senderOperators: groups.map(([sender, group]) => {
      const members = new Set(group);
      return {
        sender,
        recipients: group.length,
        sharePct: share(early, ([address]) => members.has(address), supply),
        ownSharePct: pct(balanceOf.get(sender) ?? 0n, supply),
      };
    }),
    launchAllocSharePct: launchTx
      ? pct(
          launchAllocEntries.reduce((sum, [, amount]) => sum + amount, 0n),
          supply,
        )
      : null,
    launchAllocRecipients: launchAllocEntries.map(([address, amount]) => ({ address, sharePct: pct(amount, supply) })),
    sameBlockSharePct: share(early, ([address]) => sameBlockMembers.has(address), supply),
    sameBlockClusters,
    sequentialBlockSharePct: share(early, ([address]) => sequentialMembers.has(address), supply),
    peerTransferSharePct: pct(peerValue, supply),
    peerTransferPairs,
    reciprocalPairCount: reciprocalPairs.size,
    topHolders: holders.slice(0, 10).map(([address, amount]) => ({ address, sharePct: pct(amount, supply) })),
    top1Pct: tierShare(1),
    top5Pct: tierShare(5),
    top10Pct: tierShare(10),
    insiderSharePct: pct(insiderValue, supply),
  };
}

function share(entries: [string, bigint][], keep: (entry: [string, bigint]) => boolean, supply: bigint): number {
  return pct(
    entries.filter(keep).reduce((sum, [, amount]) => sum + amount, 0n),
    supply,
  );
}

function pct(value: bigint, supply: bigint): number {
  if (supply <= 0n) return 0;
  return Math.round(Number((value * 10000n) / supply)) / 100;
}

async function readTotalSupply(provider: ethers.Provider, token: string): Promise<bigint | null> {
  try {
    const contract = new ethers.Contract(token, SUPPLY_ABI, provider);
    return BigInt(await contract.totalSupply());
  } catch {
    return null;
  }
}

async function readTransfers(
  provider: ethers.Provider,
  token: string,
  fromBlock: number,
  toBlock: number,
): Promise<{ rows: Leg[]; truncated: boolean } | null> {
  const rpc = provider as unknown as EnhancedRpc;
  if (typeof rpc.send !== "function") return null;
  try {
    const response = (await rpc.send("alchemy_getAssetTransfers", [
      {
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: `0x${toBlock.toString(16)}`,
        contractAddresses: [token],
        category: ["erc20"],
        order: "asc",
        maxCount: `0x${MAX_TRANSFERS.toString(16)}`,
        excludeZeroValue: false,
      },
    ])) as { transfers?: unknown[]; pageKey?: string } | null;
    const transfers = response?.transfers ?? [];
    const rows: Leg[] = [];
    for (const raw of transfers) {
      const leg = normalizeTransfer(raw);
      if (leg) rows.push(leg);
    }
    return { rows, truncated: Boolean(response?.pageKey) || transfers.length >= MAX_TRANSFERS };
  } catch {
    return null;
  }
}

function normalizeTransfer(raw: unknown): Leg | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, any>;
  const rawValue = value.rawContract?.value ?? value.value;
  if (value.to === undefined || value.from === undefined || rawValue === undefined || rawValue === null) return null;
  try {
    return {
      block: Number.parseInt(String(value.blockNum), 16),
      tx: String(value.hash ?? "").toLowerCase(),
      from: String(value.from).toLowerCase(),
      to: String(value.to).toLowerCase(),
      value: BigInt(rawValue),
    };
  } catch {
    return null;
  }
}

async function readLogs(
  provider: ethers.Provider,
  token: string,
  fromBlock: number,
  toBlock: number,
): Promise<{ rows: Leg[]; truncated: boolean } | null> {
  const rows: Leg[] = [];
  try {
    for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK) {
      const end = Math.min(start + LOG_CHUNK - 1, toBlock);
      const logs = await provider.getLogs({
        address: token,
        topics: [TRANSFER_TOPIC],
        fromBlock: start,
        toBlock: end,
      });
      for (const log of logs) {
        if (log.topics.length < 3) continue;
        rows.push({
          block: log.blockNumber,
          tx: log.transactionHash.toLowerCase(),
          from: ethers.getAddress(`0x${log.topics[1].slice(26)}`).toLowerCase(),
          to: ethers.getAddress(`0x${log.topics[2].slice(26)}`).toLowerCase(),
          value: BigInt(log.data),
        });
      }
    }
    return { rows, truncated: false };
  } catch {
    return null;
  }
}
