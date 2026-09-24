import { EventEmitter } from "node:events";
import { ethers } from "ethers";
import { config } from "../config";

export const V3_POOL_CREATED_TOPIC = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";
export const V4_INITIALIZE_TOPIC = "0x13406a2b11d127685ec643ecc9195b1c32de1448178c218618b818b108da1fd0";
export const PONS_TOKEN_DEPLOYED_TOPIC = "0x1461370115e1c2be79cb529f8cfcbd11316e789d9c6099fc83417b0b4c48c62a";

// PONS V1 mints the whole supply into a Uniswap V3 position straight away: no bonding curve, no migration,
// and the launch event carries the V3 pool plus a swap-restriction window.
export const PONS_TOKEN_LAUNCHED_TOPIC = "0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a";

// PONS V2 creates one bonding curve per token and only migrates to a Uniswap V4 pool on graduation, so the
// launch event is a *different* signature with a different topic. Subscribing the V2 factory with the V1
// topic silently discovers nothing.
export const PONS_V2_INTERFACE = new ethers.Interface([
  "event TokenLaunched(address indexed token,address indexed curve,address indexed deployer,address pairToken,uint256 launchConfigId,uint256 graduationThreshold)",
]);
// Graduation (`createGraduatedPool`) is what turns a bonding-curve launch into a tradeable Uniswap V4 pool.
export const PONS_V2_POOL_GRADUATED_TOPIC = "0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259";
export const PONS_V2_TOKEN_LAUNCHED_TOPIC = PONS_V2_INTERFACE.getEvent("TokenLaunched")?.topicHash ?? "";

const V3_INTERFACE = new ethers.Interface([
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
]);
export const PONS_INTERFACE = new ethers.Interface([
  "event TokenDeployed(address indexed token,address indexed deployer,address indexed dexFactory,address pairToken,uint256 dexId,uint256 launchConfigId)",
  "event TokenLaunched(address indexed token,address indexed deployer,address indexed dexFactory,address pairToken,address pool,uint256 dexId,uint256 launchConfigId,uint256 positionId,uint256 restrictionsEndBlock,uint256 initialBuyAmount)",
]);

export const POOL_SOURCE_TOPICS = {
  PoolCreated: V3_POOL_CREATED_TOPIC,
  Initialize: V4_INITIALIZE_TOPIC,
  TokenDeployed: PONS_TOKEN_DEPLOYED_TOPIC,
  TokenLaunched: PONS_TOKEN_LAUNCHED_TOPIC,
  TokenLaunchedV2: PONS_V2_TOKEN_LAUNCHED_TOPIC,
  PoolGraduated: PONS_V2_POOL_GRADUATED_TOPIC,
} as const;

export function topicForSourceEvent(event: string): string {
  const topic = (POOL_SOURCE_TOPICS as Record<string, string | undefined>)[event];
  if (!topic) throw new Error(`UNSUPPORTED_POOL_SOURCE_EVENT:${event}`);
  return topic;
}

export interface WebSocketConnectionStatus {
  connected: boolean;
  url: string;
  fallback: boolean;
  lastError?: string;
}

export class RobinhoodWebSocketListener extends EventEmitter {
  private socket: WebSocket | null = null;
  private readonly primaryUrl: string;
  private readonly fallbackUrl: string;
  private readonly shouldReconnect: boolean;
  private usingFallback = false;
  private failoverInProgress = false;
  private intentionallyClosed = false;

  constructor(primaryUrl?: string, fallbackUrl?: string, shouldReconnect = true) {
    super();
    this.primaryUrl = primaryUrl ?? config.wsRpc ?? "";
    this.fallbackUrl = fallbackUrl ?? config.fallbackWsRpc ?? "";
    this.shouldReconnect = shouldReconnect;
  }

  connect(): void {
    this.intentionallyClosed = false;
    const targetUrl = this.primaryUrl || this.fallbackUrl;
    if (!targetUrl) {
      this.emit("error", new Error("No Robinhood WebSocket RPC URL configured in environment"));
      return;
    }

    try {
      this.usingFallback = !this.primaryUrl;
      // WebSocket is available in Node 20+ and the runtime environment is expected to provide it.
      const WsCtor = globalThis.WebSocket ?? (globalThis as typeof globalThis & { WebSocket?: new (url: string) => WebSocket }).WebSocket;
      if (!WsCtor) {
        throw new Error("WebSocket is not available in this runtime");
      }

      this.socket = new WsCtor(targetUrl);
      this.socket.onopen = () => {
        this.emit("connected", { connected: true, url: targetUrl, fallback: this.usingFallback });
      };

      this.socket.onmessage = (event: MessageEvent) => {
        const msg = typeof event.data === "string" ? event.data : JSON.stringify(event.data ?? {});
        this.emit("message", msg);
        this.decodeLogMessage(msg);
      };

      this.socket.onerror = (error: Event) => {
        const details = error instanceof Error ? error.message : "websocket error";
        this.emit("error", new Error(details));
        this.failoverOrReconnect(targetUrl);
      };

      this.socket.onclose = () => {
        this.emit("closed", { connected: false, url: targetUrl, fallback: this.usingFallback });
        if (this.intentionallyClosed) return;
        this.failoverOrReconnect(targetUrl);
        this.usingFallback = false;
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown websocket error";
      this.emit("error", new Error(message));
      if (this.fallbackUrl && this.fallbackUrl !== targetUrl) {
        this.connectFallback();
      }
    }
  }

  private connectFallback(): void {
    if (!this.fallbackUrl || this.failoverInProgress) {
      return;
    }

    try {
      this.failoverInProgress = true;
      const WsCtor = globalThis.WebSocket ?? (globalThis as typeof globalThis & { WebSocket?: new (url: string) => WebSocket }).WebSocket;
      if (!WsCtor) {
        return;
      }

      this.socket = new WsCtor(this.fallbackUrl);
      this.socket.onopen = () => {
        this.usingFallback = true;
        this.emit("connected", { connected: true, url: this.fallbackUrl, fallback: true });
      };
      this.socket.onmessage = (event: MessageEvent) => {
        const msg = typeof event.data === "string" ? event.data : JSON.stringify(event.data ?? {});
        this.emit("message", msg);
        this.decodeLogMessage(msg);
      };
      this.socket.onclose = () => {
        this.emit("closed", { connected: false, url: this.fallbackUrl, fallback: true });
        if (this.intentionallyClosed) return;
        this.failoverInProgress = false;
        this.usingFallback = false;
        if (this.shouldReconnect) this.reconnect();
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown websocket error";
      this.emit("error", new Error(message));
    }
  }

  private decodeLogMessage(message: string): void {
    let payload: { params?: { result?: { address?: string; topics?: string[]; data?: string; transactionHash?: string; blockNumber?: string; logIndex?: string } } };
    try {
      payload = JSON.parse(message) as typeof payload;
    } catch {
      return;
    }

    const log = payload.params?.result;
    if (!log?.topics?.[0]) return;

    this.emit("detectionLog", {
      address: log.address ?? "",
      topics: log.topics,
      data: log.data ?? "0x",
      blockNumber: Number(BigInt(log.blockNumber ?? "0x0")),
      transactionHash: log.transactionHash ?? "",
      logIndex: Number(BigInt(log.logIndex ?? "0x0")),
    });

    if (log.topics[0].toLowerCase() === V3_POOL_CREATED_TOPIC) {
      try {
        const parsed = V3_INTERFACE.parseLog({ topics: log.topics, data: log.data ?? "0x" });
        if (!parsed) return;
        this.emit("poolCreated", {
          factory: log.address,
          token0: parsed.args.token0,
          token1: parsed.args.token1,
          fee: Number(parsed.args.fee),
          tickSpacing: Number(parsed.args.tickSpacing),
          pool: parsed.args.pool,
          transactionHash: log.transactionHash,
          blockNumber: Number(BigInt(log.blockNumber ?? "0x0")),
          logIndex: Number(BigInt(log.logIndex ?? "0x0")),
        });
      } catch (error) {
        this.emit("error", error instanceof Error ? error : new Error("Unable to decode PoolCreated log"));
      }
      return;
    }

    if (log.topics[0].toLowerCase() === V4_INITIALIZE_TOPIC) {
      this.emit("poolInitialized", {
        poolManager: log.address,
        poolId: log.topics[1],
        transactionHash: log.transactionHash,
        blockNumber: Number(BigInt(log.blockNumber ?? "0x0")),
        logIndex: Number(BigInt(log.logIndex ?? "0x0")),
      });
      return;
    }

    if (log.topics[0].toLowerCase() === PONS_V2_TOKEN_LAUNCHED_TOPIC) {
      try {
        const parsed = PONS_V2_INTERFACE.parseLog({ topics: log.topics, data: log.data ?? "0x" });
        if (!parsed) return;
        const args = parsed.args;
        this.emit("ponsV2TokenLaunched", {
          factory: log.address,
          token: args.token,
          curve: args.curve,
          deployer: args.deployer,
          pairToken: args.pairToken,
          launchConfigId: Number(args.launchConfigId),
          graduationThreshold: BigInt(args.graduationThreshold),
          transactionHash: log.transactionHash,
          blockNumber: Number(BigInt(log.blockNumber ?? "0x0")),
          logIndex: Number(BigInt(log.logIndex ?? "0x0")),
        });
      } catch (error) {
        this.emit("error", error instanceof Error ? error : new Error("Unable to decode PONS V2 launch log"));
      }
      return;
    }

    if (log.topics[0].toLowerCase() === PONS_V2_POOL_GRADUATED_TOPIC) {
      // The graduation event's numeric fields are not needed for routing, and its token is indexed, so read the
      // topic directly instead of decoding against a guessed signature.
      if (!log.topics[1]) return;
      this.emit("ponsPoolGraduated", {
        factory: log.address,
        token: ethers.getAddress(`0x${log.topics[1].slice(-40)}`),
        transactionHash: log.transactionHash,
        blockNumber: Number(BigInt(log.blockNumber ?? "0x0")),
        logIndex: Number(BigInt(log.logIndex ?? "0x0")),
      });
      return;
    }

    if (log.topics[0].toLowerCase() === PONS_TOKEN_DEPLOYED_TOPIC || log.topics[0].toLowerCase() === PONS_TOKEN_LAUNCHED_TOPIC) {
      try {
        const parsed = PONS_INTERFACE.parseLog({ topics: log.topics, data: log.data ?? "0x" });
        if (!parsed) return;
        const args = parsed.args;
        this.emit(parsed.name === "TokenLaunched" ? "ponsTokenLaunched" : "ponsTokenDeployed", {
          factory: log.address,
          token: args.token,
          deployer: args.deployer,
          dexFactory: args.dexFactory,
          pairToken: args.pairToken,
          pool: parsed.name === "TokenLaunched" ? args.pool : undefined,
          dexId: Number(args.dexId),
          launchConfigId: Number(args.launchConfigId),
          positionId: parsed.name === "TokenLaunched" ? Number(args.positionId) : undefined,
          restrictionsEndBlock: parsed.name === "TokenLaunched" ? Number(args.restrictionsEndBlock) : undefined,
          initialBuyAmount: parsed.name === "TokenLaunched" ? BigInt(args.initialBuyAmount) : undefined,
          transactionHash: log.transactionHash,
          blockNumber: Number(BigInt(log.blockNumber ?? "0x0")),
          logIndex: Number(BigInt(log.logIndex ?? "0x0")),
        });
      } catch (error) {
        this.emit("error", error instanceof Error ? error : new Error("Unable to decode PONS launch log"));
      }
    }
  }

  private reconnect(): void {
    setTimeout(() => {
      this.connect();
    }, 1000);
  }

  private failoverOrReconnect(targetUrl: string): void {
    if (this.fallbackUrl && targetUrl !== this.fallbackUrl && !this.usingFallback && !this.failoverInProgress) {
      this.connectFallback();
      return;
    }
    if (this.shouldReconnect) this.reconnect();
  }

  subscribeToPoolFactory(factory: string): void {
    this.subscribeToSources([{ address: factory, topic: V3_POOL_CREATED_TOPIC }]);
  }

  subscribeToSources(sources: Array<{ address: string; topic: string | string[] }>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.once("connected", () => {
        this.subscribeToSources(sources);
      });
      return;
    }

    // One subscription per address: a log filter carries a single `address` value, so several topics for the
    // same contract (e.g. the PONS V2 factory's launch and graduation events) must share one request.
    const grouped = new Map<string, Set<string>>();
    for (const source of sources) {
      const address = source.address.toLowerCase();
      const topics = grouped.get(address) ?? new Set<string>();
      for (const topic of Array.isArray(source.topic) ? source.topic : [source.topic]) {
        topics.add(topic.toLowerCase());
      }
      grouped.set(address, topics);
    }

    let requestId = 1;
    for (const [address, topics] of grouped) {
      const request = JSON.stringify({
        jsonrpc: "2.0",
        id: requestId++,
        method: "eth_subscribe",
        params: ["logs", { address, topics: [[...topics]] }],
      });

      this.socket.send(request);
      this.emit("subscribed", { address, topics: [...topics], method: "eth_subscribe" });
    }
  }

  close(): void {
    this.intentionallyClosed = true;
    this.socket?.close();
  }
}
