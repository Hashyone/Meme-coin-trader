import { Candidate, TokenMetrics, WalletMilestoneEvent } from "../types";

export class MarketIntelligence {
  calculateMarketCap(token: string, price: number, supply: number): TokenMetrics {
    const marketCap = Number((price * supply).toFixed(6));
    return {
      token: token.toLowerCase(),
      price,
      liquidity: 0,
      volume: 0,
      supply,
      market_cap: marketCap,
      measurement_method: "exact",
      block: 0,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  evaluateMilestone(wallet: string, token: string, metrics: TokenMetrics): WalletMilestoneEvent | null {
    if (metrics.market_cap >= 20_000_000) {
      return {
        wallet: wallet.toLowerCase(),
        token: token.toLowerCase(),
        timestamp: metrics.timestamp,
        block: metrics.block,
        market_cap: metrics.market_cap,
        price: metrics.price,
        liquidity: metrics.liquidity,
        volume: metrics.volume,
        supply: metrics.supply,
        measurement_method: metrics.measurement_method,
      };
    }

    return null;
  }
}
