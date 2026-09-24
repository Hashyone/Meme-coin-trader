import { Candidate, SecurityDecision } from "../types";
import { SecurityEngine } from "../security/SecurityEngine";
import { ContractRiskAnalyzer } from "../security/ContractRiskAnalyzer";

export interface AnalysisResult {
  candidate: Candidate;
  security: SecurityDecision;
  contractRisk: Awaited<ReturnType<ContractRiskAnalyzer["analyzeContract"]>>;
  accepted: boolean;
  rejectionReason?: string;
  details: Record<string, string | number | boolean | null>;
}

export class PoolAnalysisPipeline {
  constructor(
    private readonly securityEngine = new SecurityEngine(),
    private readonly contractRiskAnalyzer = new ContractRiskAnalyzer()
  ) {}

  async analyze(candidate: Candidate, runtimeBytecode: string): Promise<AnalysisResult> {
    const security = this.securityEngine.evaluate(candidate);
    const contractRisk = await this.contractRiskAnalyzer.analyzeContract(candidate.candidate_token, runtimeBytecode);

    const rejectionReasons: string[] = [];
    if (!security.safe) rejectionReasons.push("failed deterministic security checks");
    if (contractRisk.honeypotRisk) rejectionReasons.push("honeypot pattern detected");
    if (contractRisk.mintRisk) rejectionReasons.push("mint authority risk");
    if (contractRisk.freezeRisk) rejectionReasons.push("freeze authority risk");
    if (contractRisk.maliciousContract) rejectionReasons.push("suspicious malicious contract");

    const accepted = security.safe && !contractRisk.honeypotRisk && !contractRisk.rugpullRisk && !contractRisk.mintRisk && !contractRisk.freezeRisk && !contractRisk.maliciousContract;
    const details = {
      securitySafe: security.safe,
      securityScore: security.score,
      approvedBasePair: security.approvedBasePair,
      honeypotRisk: contractRisk.honeypotRisk,
      rugpullRisk: contractRisk.rugpullRisk,
      mintRisk: contractRisk.mintRisk,
      freezeRisk: contractRisk.freezeRisk,
      maliciousContract: contractRisk.maliciousContract,
      rejectionReasons: rejectionReasons.join("; "),
      accepted,
    };

    return {
      candidate,
      security,
      contractRisk,
      accepted,
      rejectionReason: accepted ? undefined : rejectionReasons.join("; "),
      details,
    };
  }
}
