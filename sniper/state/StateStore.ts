import { Candidate, SecurityDecision, TokenMetrics, WalletMilestoneEvent, WalletProfile, WalletRelationship } from "../types";

export class StateStore {
  public lastProcessedBlock = 0;
  public candidates = new Map<string, Candidate>();
  public walletProfiles = new Map<string, WalletProfile>();
  public walletRelationships = new Map<string, WalletRelationship>();
  public tokenMetrics = new Map<string, TokenMetrics>();
  public milestones: WalletMilestoneEvent[] = [];
  public securityDecisions = new Map<string, SecurityDecision>();
  public seenEvents = new Set<string>();

  recordCandidate(candidate: Candidate): void {
    this.candidates.set(candidate.candidate_id, candidate);
    this.seenEvents.add(`${candidate.creation_tx}:${candidate.creation_block}:${candidate.pool}`);
  }

  getCandidate(candidateId: string): Candidate | undefined {
    return this.candidates.get(candidateId);
  }

  recordWalletProfile(profile: WalletProfile): void {
    this.walletProfiles.set(profile.wallet_address.toLowerCase(), profile);
  }

  getWalletProfile(address: string): WalletProfile | undefined {
    return this.walletProfiles.get(address.toLowerCase());
  }

  rememberRelationship(relationship: WalletRelationship): void {
    const key = `${relationship.source.toLowerCase()}::${relationship.target.toLowerCase()}::${relationship.relationship}`;
    const current = this.walletRelationships.get(key);

    if (current) {
      current.count += relationship.count;
      return;
    }

    this.walletRelationships.set(key, relationship);
  }

  recordTokenMetrics(metrics: TokenMetrics): void {
    this.tokenMetrics.set(metrics.token.toLowerCase(), metrics);
  }

  recordMilestone(event: WalletMilestoneEvent): void {
    this.milestones.push(event);
  }

  recordSecurityDecision(pool: string, decision: SecurityDecision): void {
    this.securityDecisions.set(pool.toLowerCase(), decision);
  }

  getSecurityDecision(pool: string): SecurityDecision | undefined {
    return this.securityDecisions.get(pool.toLowerCase());
  }
}
