import { ethers } from "ethers";
import { ContractRiskAnalyzer, ContractRiskReport } from "./ContractRiskAnalyzer";

export type PonsPairTokenKind = "NATIVE" | "APPROVED_BASE" | "UNSUPPORTED";

export interface PonsTokenScreenInput {
  token: string;
  pairToken: string;
  runtimeBytecode: string;
  approvedBaseTokenAddresses: string[];
  wrappedNativeAddress?: string;
  /**
   * Reject when the analyzer's burn / liquidity-withdrawal pattern fires. Off by default because the pattern
   * matches printable bytecode words, and "burn" and "removeLiquidity" appear in ordinary revert strings, so a
   * token can trip it without ever being able to burn or pull its own liquidity. Switch on per deployment.
   */
  rejectBurnRisk?: boolean;
  /** Reject when the analyzer's liquidity-structure pattern fires. Same caveat as `rejectBurnRisk`. */
  rejectLiquidityRisk?: boolean;
}

export interface PonsTokenScreenResult {
  accepted: boolean;
  rejectionReasons: string[];
  pairTokenKind: PonsPairTokenKind;
  contractRisk: ContractRiskReport;
}

export const PONS_SCREEN_REJECTIONS = {
  NOT_DEPLOYED: "PONS_TOKEN_NOT_DEPLOYED",
  PAIR_TOKEN_UNSUPPORTED: "PONS_UNSUPPORTED_PAIR_TOKEN",
  MINT_AUTHORITY: "PONS_MINT_AUTHORITY",
  FREEZE_AUTHORITY: "PONS_FREEZE_AUTHORITY",
  HONEYPOT_PATTERN: "PONS_HONEYPOT_PATTERN",
  MALICIOUS_CONTRACT: "PONS_MALICIOUS_CONTRACT",
  BURN_AUTHORITY: "PONS_BURN_AUTHORITY",
  LIQUIDITY_RISK: "PONS_LIQUIDITY_RISK",
} as const;

/**
 * Screens a PONS token before any order is built for it.
 *
 * `PoolAnalysisPipeline` cannot be reused here: its `SecurityEngine` rejects any pool whose `fee` is not
 * strictly positive, and every graduated PONS pool reports `fee = 0` because its swap fee is taken by the
 * V4 hook instead, so that path would reject every V4 candidate for the wrong reason.
 */
export class PonsTokenScreen {
  private readonly analyzer: ContractRiskAnalyzer;

  constructor(analyzer = new ContractRiskAnalyzer()) {
    this.analyzer = analyzer;
  }

  async screen(input: PonsTokenScreenInput): Promise<PonsTokenScreenResult> {
    const rejectionReasons: string[] = [];
    const pairTokenKind = this.classifyPairToken(input);
    if (pairTokenKind === "UNSUPPORTED") rejectionReasons.push(PONS_SCREEN_REJECTIONS.PAIR_TOKEN_UNSUPPORTED);

    if (!input.runtimeBytecode || input.runtimeBytecode === "0x") {
      rejectionReasons.push(PONS_SCREEN_REJECTIONS.NOT_DEPLOYED);
    }

    const contractRisk = await this.analyzer.analyzeContract(input.token, input.runtimeBytecode);
    if (contractRisk.mintRisk) rejectionReasons.push(PONS_SCREEN_REJECTIONS.MINT_AUTHORITY);
    if (contractRisk.freezeRisk) rejectionReasons.push(PONS_SCREEN_REJECTIONS.FREEZE_AUTHORITY);
    if (contractRisk.honeypotRisk) rejectionReasons.push(PONS_SCREEN_REJECTIONS.HONEYPOT_PATTERN);
    if (contractRisk.maliciousContract) rejectionReasons.push(PONS_SCREEN_REJECTIONS.MALICIOUS_CONTRACT);
    if (input.rejectBurnRisk && contractRisk.burnRisk) rejectionReasons.push(PONS_SCREEN_REJECTIONS.BURN_AUTHORITY);
    if (input.rejectLiquidityRisk && contractRisk.liquidityRisk) rejectionReasons.push(PONS_SCREEN_REJECTIONS.LIQUIDITY_RISK);

    return {
      accepted: rejectionReasons.length === 0,
      rejectionReasons,
      pairTokenKind,
      contractRisk,
    };
  }

  private classifyPairToken(input: PonsTokenScreenInput): PonsPairTokenKind {
    if (!ethers.isAddress(input.pairToken)) return "UNSUPPORTED";
    if (input.pairToken.toLowerCase() === ethers.ZeroAddress.toLowerCase()) return "NATIVE";
    const allowed = [input.wrappedNativeAddress, ...input.approvedBaseTokenAddresses]
      .filter((address): address is string => Boolean(address))
      .map((address) => address.toLowerCase());
    return allowed.includes(input.pairToken.toLowerCase()) ? "APPROVED_BASE" : "UNSUPPORTED";
  }
}
