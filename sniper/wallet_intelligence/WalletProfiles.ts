import { Candidate, WalletClassification, WalletMilestoneEvent, WalletProfile, WalletRelationship } from "../types";

export class WalletProfileStore {
  private readonly profiles = new Map<string, WalletProfile>();

  upsert(address: string, update?: Partial<WalletProfile>): WalletProfile {
    const key = address.toLowerCase();
    const existing = this.profiles.get(key) ?? this.newEmptyProfile(address);
    const next: WalletProfile = { ...existing, ...update, wallet_address: address.toLowerCase() };
    this.profiles.set(key, next);
    return next;
  }

  registerCandidate(address: string, candidate: Candidate): WalletProfile {
    const profile = this.upsert(address, {
      first_seen: Math.min(this.get(address)?.first_seen ?? candidate.creation_timestamp, candidate.creation_timestamp),
      last_seen: candidate.creation_timestamp,
      tokens_created: (this.get(address)?.tokens_created ?? 0) + (address === candidate.deployer ? 1 : 0),
      tokens_controlled: (this.get(address)?.tokens_controlled ?? 0) + (address === candidate.owner ? 1 : 0),
      tokens_launched: (this.get(address)?.tokens_launched ?? 0) + (address === candidate.deployer ? 1 : 0),
      wallet_class: this.classifyWallet(this.get(address)?.current_risk_score ?? 0),
      watch_status: (this.get(address)?.watch_status ?? false)
    });

    if (candidate.owner && candidate.owner !== candidate.deployer) {
      this.upsert(candidate.owner, {
        first_seen: Math.min(this.get(candidate.owner)?.first_seen ?? candidate.creation_timestamp, candidate.creation_timestamp),
        last_seen: candidate.creation_timestamp,
        tokens_controlled: (this.get(candidate.owner)?.tokens_controlled ?? 0) + 1,
      });
    }

    return profile;
  }

  registerRelationship(source: string, target: string, relationship: WalletRelationship["relationship"]): void {
    const record: WalletRelationship = {
      source: source.toLowerCase(),
      target: target.toLowerCase(),
      relationship,
      count: 1
    };

    const key = `${record.source}::${record.target}::${record.relationship}`;
    const prior = this.profiles.get(key);
    if (prior) {
      return;
    }
  }

  get(address: string): WalletProfile | undefined {
    return this.profiles.get(address.toLowerCase());
  }

  recordMilestone(event: WalletMilestoneEvent): WalletProfile {
    const current = this.get(event.wallet) ?? this.newEmptyProfile(event.wallet);
    const updated: WalletProfile = {
      ...current,
      historical_20m_launches: current.historical_20m_launches + 1,
      successful_20m_launches: current.successful_20m_launches + 1,
      successful_launches: current.successful_launches + 1,
      last_seen: event.timestamp,
      max_market_cap: Math.max(current.max_market_cap, event.market_cap),
      current_risk_score: Math.max(0, current.current_risk_score - 5),
      wallet_class: "HIGH_VALUE_DEPLOYER",
      watch_status: true
    };

    this.profiles.set(event.wallet.toLowerCase(), updated);
    return updated;
  }

  private newEmptyProfile(address: string): WalletProfile {
    return {
      wallet_address: address.toLowerCase(),
      first_seen: Date.now() / 1000,
      last_seen: Date.now() / 1000,
      tokens_created: 0,
      tokens_controlled: 0,
      tokens_launched: 0,
      successful_launches: 0,
      failed_launches: 0,
      rugged_launches: 0,
      max_market_cap: 0,
      median_market_cap: 0,
      maximum_liquidity: 0,
      average_initial_liquidity: 0,
      average_peak_return: 0,
      successful_20m_launches: 0,
      current_risk_score: 0,
      success_score: 0,
      wallet_class: "UNKNOWN",
      watch_status: false,
      historical_20m_launches: 0,
    };
  }

  private classifyWallet(score: number): WalletClassification {
    if (score >= 85) return "KNOWN_MALICIOUS";
    if (score >= 70) return "HIGH_RISK_DEPLOYER";
    if (score >= 50) return "PROMISING";
    if (score >= 30) return "NEW_DEPLOYER";
    return "NORMAL";
  }
}
