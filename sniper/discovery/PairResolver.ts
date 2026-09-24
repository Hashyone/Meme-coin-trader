export interface KnownQuoteAsset {
  address?: string;
  symbol: string;
  decimals?: number;
  assetType?: string;
  verified?: boolean;
  enabled?: boolean;
}

export interface CandidatePairResolution {
  quoteAsset?: string;
  candidateToken?: string;
  quoteSymbol?: string;
  candidateSymbol?: string;
  pairClassification: "QUOTE_CANDIDATE" | "NO_SPECULATIVE_PAIR" | "UNKNOWN_PAIR";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  rejectionReason?: "NO_SPECULATIVE_PAIR" | "UNKNOWN_QUOTE";
}

export function resolveCandidatePair(token0: string, token1: string, knownQuoteAssets: KnownQuoteAsset[]): CandidatePairResolution {
  const normalized0 = token0.toLowerCase();
  const normalized1 = token1.toLowerCase();
  const matches = knownQuoteAssets
    .filter((asset) => asset.enabled !== false && asset.verified !== false)
    .map((asset) => ({ asset, matches0: asset.address?.toLowerCase() === normalized0, matches1: asset.address?.toLowerCase() === normalized1 }))
    .filter((match) => match.matches0 || match.matches1);

  if (matches.length === 0) return { pairClassification: "UNKNOWN_PAIR", confidence: "LOW", rejectionReason: "UNKNOWN_QUOTE" };
  const first = matches[0];
  if (matches.some((match) => match.matches0 && match.matches1)) {
    return { pairClassification: "NO_SPECULATIVE_PAIR", confidence: "HIGH", rejectionReason: "NO_SPECULATIVE_PAIR" };
  }

  return {
    quoteAsset: first.matches0 ? normalized0 : normalized1,
    candidateToken: first.matches0 ? normalized1 : normalized0,
    quoteSymbol: first.asset.symbol.toUpperCase(),
    pairClassification: "QUOTE_CANDIDATE",
    confidence: "HIGH",
  };
}