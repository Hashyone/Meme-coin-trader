export type WalletClassification =
  | "UNKNOWN"
  | "NEW_DEPLOYER"
  | "NORMAL"
  | "PROMISING"
  | "HIGH_VALUE_DEPLOYER"
  | "HIGH_RISK_DEPLOYER"
  | "KNOWN_MALICIOUS"
  | "WATCHLIST";

export type RiskDirection = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface Candidate {
  candidate_id: string;
  chain_id: number;
  factory: string;
  pool: string;
  token0: string;
  token1: string;
  fee: number;
  tick_spacing: number;
  creation_block: number;
  creation_timestamp: number;
  creation_tx: string;
  deployer: string;
  owner: string;
  base_token: string;
  candidate_token: string;
}

export interface WalletProfile {
  wallet_address: string;
  first_seen: number;
  last_seen: number;
  tokens_created: number;
  tokens_controlled: number;
  tokens_launched: number;
  successful_launches: number;
  failed_launches: number;
  rugged_launches: number;
  max_market_cap: number;
  median_market_cap: number;
  maximum_liquidity: number;
  average_initial_liquidity: number;
  average_peak_return: number;
  successful_20m_launches: number;
  current_risk_score: number;
  success_score: number;
  wallet_class: WalletClassification;
  watch_status: boolean;
  historical_20m_launches: number;
}

export interface WalletRelationship {
  source: string;
  target: string;
  relationship: "DEPLOYED" | "OWNS" | "CONTROLS" | "RECEIVES_FEES" | "CONTROLS_LIQUIDITY";
  count: number;
}

export interface TokenMetrics {
  token: string;
  price: number;
  liquidity: number;
  volume: number;
  supply: number;
  market_cap: number;
  estimated_market_cap?: number;
  measurement_method: "exact" | "estimated";
  block: number;
  timestamp: number;
}

export interface WalletMilestoneEvent {
  wallet: string;
  token: string;
  timestamp: number;
  block: number;
  market_cap: number;
  price: number;
  liquidity: number;
  volume: number;
  supply: number;
  measurement_method: "exact" | "estimated";
}

export interface SecurityDecision {
  safe: boolean;
  risk: RiskDirection;
  reasons: string[];
  score: number;
  approvedBasePair: boolean;
}

export interface TradeDecision {
  approved: boolean;
  reason: string;
  strategy: "HOLD" | "BUY" | "SELL" | "REJECT";
  confidence: number;
  risk: RiskDirection;
}

export interface TelemetryEvent {
  event: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

export interface DetectionEvent {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}
