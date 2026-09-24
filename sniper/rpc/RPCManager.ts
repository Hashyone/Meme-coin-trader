export const RpcRequestType = {
  REALTIME: "REALTIME",
  HISTORICAL: "HISTORICAL",
  STATE: "STATE",
  QUOTE: "QUOTE",
  EXECUTION: "EXECUTION",
} as const;

export type RpcRequestType = typeof RpcRequestType[keyof typeof RpcRequestType];

export interface RpcRequestPolicy {
  timeoutMs: number;
  retries: number;
  backoffMs: number;
  jitterMs: number;
  requestType: RpcRequestType;
  maxRange?: number;
  providerPriority?: string[];
}

export interface RpcMetrics {
  requests: number;
  failures: number;
  rateLimits: number;
  providerSwitches: number;
  averageLatencyMs: number;
}

export interface RpcProviderLike {
  name: string;
  httpUrl?: string;
  wsUrl?: string;
  call<T>(method: string, params?: unknown[]): Promise<T>;
  getLogs?(filter: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
}

export class RPCManager {
  private readonly providers: RpcProviderLike[];
  private readonly cooldownUntil = new Map<string, number>();
  private activeIndex = 0;
  private readonly requestMetrics = new Map<string, RpcMetrics>();

  constructor(providers: RpcProviderLike[]) {
    this.providers = providers.filter(Boolean);
    if (this.providers.length === 0) throw new Error("RPC_MANAGER_REQUIRES_PROVIDER");
  }

  getProviderNames(): string[] {
    return this.providers.map((provider) => provider.name);
  }

  async execute<T>(requestType: RpcRequestType, method: string, params: unknown[] = [], policy: Partial<RpcRequestPolicy> = {}): Promise<T> {
    const effectivePolicy: RpcRequestPolicy = {
      timeoutMs: policy.timeoutMs ?? 15000,
      retries: policy.retries ?? 2,
      backoffMs: policy.backoffMs ?? 250,
      jitterMs: policy.jitterMs ?? 100,
      requestType,
      maxRange: policy.maxRange ?? 100,
      providerPriority: policy.providerPriority ?? this.providers.map((provider) => provider.name),
    };
    const metricsKey = `${requestType}:${method}`;
    const metrics = this.requestMetrics.get(metricsKey) ?? { requests: 0, failures: 0, rateLimits: 0, providerSwitches: 0, averageLatencyMs: 0 };
    this.requestMetrics.set(metricsKey, metrics);

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= effectivePolicy.retries; attempt += 1) {
      let providers = this.getOrderedProviders(effectivePolicy.providerPriority ?? []).filter((provider) => !this.isCoolingDown(provider));
      if (providers.length === 0) {
        await this.wait(this.cooldownWaitMs());
        providers = this.getOrderedProviders(effectivePolicy.providerPriority ?? []);
      }
      for (const provider of providers) {
        const start = Date.now();
        try {
          metrics.requests += 1;
          const result = await this.withTimeout(() => provider.call<T>(method, params), effectivePolicy.timeoutMs);
          const latency = Date.now() - start;
          metrics.averageLatencyMs = metrics.averageLatencyMs === 0 ? latency : Math.round((metrics.averageLatencyMs + latency) / 2);
          return result;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          metrics.failures += 1;
          if (this.isRateLimitError(lastError)) {
            metrics.rateLimits += 1;
            this.cooldownUntil.set(provider.name, Date.now() + this.retryAfterMs(lastError));
          }
          if (this.shouldFailover(lastError, attempt, effectivePolicy)) {
            this.activeIndex = (this.activeIndex + 1) % this.providers.length;
            metrics.providerSwitches += 1;
            continue;
          }
          if (this.isTransientError(lastError)) {
            await this.wait(this.backoffMs(attempt, effectivePolicy));
            continue;
          }
          break;
        }
      }
      if (lastError) {
        await this.wait(this.backoffMs(attempt, effectivePolicy));
      }
    }

    throw lastError ?? new Error(`RPC_REQUEST_FAILED_${method}`);
  }

  getMetrics(): Record<string, RpcMetrics> {
    return Object.fromEntries(this.requestMetrics.entries());
  }

  private getOrderedProviders(priority: string[]): RpcProviderLike[] {
    if (!priority.length) return [...this.providers];
    const ordered = priority
      .map((name) => this.providers.find((provider) => provider.name === name))
      .filter((provider): provider is RpcProviderLike => Boolean(provider));
    return [...ordered, ...this.providers.filter((provider) => !priority.includes(provider.name))];
  }

  private isCoolingDown(provider: RpcProviderLike): boolean {
    return (this.cooldownUntil.get(provider.name) ?? 0) > Date.now();
  }

  private cooldownWaitMs(): number {
    const remaining = [...this.cooldownUntil.values()]
      .map((until) => until - Date.now())
      .filter((value) => value > 0);
    return remaining.length > 0 ? Math.min(...remaining) : 0;
  }

  private async withTimeout<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("RPC_TIMEOUT")), timeoutMs);
    });
    try {
      return await Promise.race([work(), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private shouldFailover(error: Error, attempt: number, policy: RpcRequestPolicy): boolean {
    if (attempt >= policy.retries) return false;
    return this.isRateLimitError(error) || this.isNetworkError(error) || error.message.includes("429") || error.message.includes("5xx");
  }

  private isTransientError(error: Error): boolean {
    return this.isRateLimitError(error) || this.isNetworkError(error) || error.message.includes("-32005") || error.message.includes("-32000");
  }

  private isRateLimitError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return message.includes("429") || message.includes("rate limit") || message.includes("too many requests") || message.includes("-32005") || message.includes("-32029");
  }

  private retryAfterMs(error: Error): number {
    const match = error.message.match(/retry_after_ms\s*[:=]\s*(\d+)/i);
    const retryAfter = match ? Number(match[1]) : 0;
    return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1000;
  }

  private isNetworkError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return message.includes("timeout") || message.includes("reset by peer") || message.includes("connection reset") || message.includes("fetch failed") || message.includes("5xx") || message.includes("-32000");
  }

  private backoffMs(attempt: number, policy: RpcRequestPolicy): number {
    const base = policy.backoffMs * (2 ** attempt);
    const jitter = Math.floor(Math.random() * (policy.jitterMs + 1));
    return base + jitter;
  }

  private async wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function createDefaultRpcManager(): RPCManager {
  const providers = [
    { name: "primary-http", httpUrl: process.env.ROBINHOOD_HTTP_RPC_URL || process.env.ROBINHOOD_HTTP_RPC || "https://public.robinhood.io", call: async <T>(method: string, params: unknown[] = []) => {
        const response = await fetch(process.env.ROBINHOOD_HTTP_RPC_URL || process.env.ROBINHOOD_HTTP_RPC || "https://public.robinhood.io", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        if (!response.ok) throw new Error(`HTTP_${response.status}`);
        const body = await response.json() as { error?: { message?: string; code?: number; retry_after_ms?: number }; result?: T };
        if (body.error) throw new Error(`${body.error.message ?? `RPC_${method}_ERROR`} code=${body.error.code ?? "unknown"}${body.error.retry_after_ms ? ` retry_after_ms=${body.error.retry_after_ms}` : ""}`);
        return body.result as T;
      } },
    { name: "fallback-http", httpUrl: process.env.ROBINHOOD_FALLBACK_HTTP_RPC_URL || process.env.ROBINHOOD_FALLBACK_HTTP_RPC || "https://public.robinhood.io", call: async <T>(method: string, params: unknown[] = []) => {
        const response = await fetch(process.env.ROBINHOOD_FALLBACK_HTTP_RPC_URL || process.env.ROBINHOOD_FALLBACK_HTTP_RPC || "https://public.robinhood.io", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        if (!response.ok) throw new Error(`HTTP_${response.status}`);
        const body = await response.json() as { error?: { message?: string; code?: number; retry_after_ms?: number }; result?: T };
        if (body.error) throw new Error(`${body.error.message ?? `RPC_${method}_ERROR`} code=${body.error.code ?? "unknown"}${body.error.retry_after_ms ? ` retry_after_ms=${body.error.retry_after_ms}` : ""}`);
        return body.result as T;
      } },
  ];

  return new RPCManager(providers);
}
