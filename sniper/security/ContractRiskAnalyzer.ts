import { ethers } from "ethers";

export interface ContractRiskReport {
  tokenAddress: string;
  honeypotRisk: boolean;
  rugpullRisk: boolean;
  mintRisk: boolean;
  burnRisk: boolean;
  freezeRisk: boolean;
  liquidityRisk: boolean;
  maliciousContract: boolean;
  reasons: string[];
}

type AuthorityKind = "mint" | "freeze" | "honeypot";

// Runtime bytecode stores four-byte function *selectors*, never function *names*, so matching words such as
// "mint" or "pause" against a `0x…` hex string can never succeed and the analyzer used to report every token
// as risk-free. These signatures are hashed here rather than hardcoded, so a selector can never drift from the
// signature it claims to represent. A signature that does not exist on the token simply never matches.
const AUTHORITY_SELECTORS: Array<{ signature: string; kind: AuthorityKind; label: string }> = [
  { signature: "mint(address,uint256)", kind: "mint", label: "mint(address,uint256)" },
  { signature: "mint(uint256)", kind: "mint", label: "mint(uint256)" },
  { signature: "mintTo(address,uint256)", kind: "mint", label: "mintTo(address,uint256)" },
  { signature: "ownerMint(uint256)", kind: "mint", label: "ownerMint(uint256)" },
  { signature: "freeze(address)", kind: "freeze", label: "freeze(address)" },
  { signature: "unfreeze(address)", kind: "freeze", label: "unfreeze(address)" },
  { signature: "blacklist(address)", kind: "freeze", label: "blacklist(address)" },
  { signature: "addBlackList(address)", kind: "freeze", label: "addBlackList(address)" },
  { signature: "setBlackList(address,bool)", kind: "freeze", label: "setBlackList(address,bool)" },
  { signature: "isBlacklisted(address)", kind: "freeze", label: "isBlacklisted(address)" },
  { signature: "pause()", kind: "freeze", label: "pause()" },
  { signature: "unpause()", kind: "freeze", label: "unpause()" },
  { signature: "enableTrading()", kind: "honeypot", label: "enableTrading()" },
  { signature: "setTradingEnabled(bool)", kind: "honeypot", label: "setTradingEnabled(bool)" },
  { signature: "setMaxTxAmount(uint256)", kind: "honeypot", label: "setMaxTxAmount(uint256)" },
  { signature: "setMaxWalletAmount(uint256)", kind: "honeypot", label: "setMaxWalletAmount(uint256)" },
  { signature: "setTaxes(uint256,uint256)", kind: "honeypot", label: "setTaxes(uint256,uint256)" },
  { signature: "setTaxFee(uint256)", kind: "honeypot", label: "setTaxFee(uint256)" },
  { signature: "setFees(uint256,uint256)", kind: "honeypot", label: "setFees(uint256,uint256)" },
  { signature: "excludeFromFee(address)", kind: "honeypot", label: "excludeFromFee(address)" },
  { signature: "setCooldown(uint256)", kind: "honeypot", label: "setCooldown(uint256)" },
];

function selectorFor(signature: string): string {
  return ethers.id(signature).slice(2, 10);
}

/**
 * Turns `0x…` runtime bytecode into its embedded printable strings. Function names live only in string
 * literals (revert reasons and the like), so this is what makes the word-based patterns below meaningful.
 */
function readableBytecodeText(runtimeBytecode: string): string {
  const trimmed = runtimeBytecode.trim();
  const hex = trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return trimmed.toLowerCase();
  const bytes = ethers.getBytes(`0x${hex}`);
  let text = "";
  for (const byte of bytes) {
    text += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : "\n";
  }
  return text.toLowerCase();
}

export class ContractRiskAnalyzer {
  async analyzeContract(tokenAddress: string, runtimeBytecode: string, metadata: Record<string, unknown> = {}): Promise<ContractRiskReport> {
    const lower = tokenAddress.toLowerCase();
    const code = readableBytecodeText(runtimeBytecode);
    const runtimeHex = runtimeBytecode.trim().toLowerCase();
    const reasons: string[] = [];

    const authorityHits = (kind: AuthorityKind): string[] =>
      AUTHORITY_SELECTORS.filter((entry) => entry.kind === kind && runtimeHex.includes(selectorFor(entry.signature))).map((entry) => entry.label);

    const mintSelectors = authorityHits("mint");
    const freezeSelectors = authorityHits("freeze");
    const honeypotSelectors = authorityHits("honeypot");

    const mintRisk = this.hasMintFunction(code) || this.hasSupplyManipulation(code) || mintSelectors.length > 0;
    const freezeRisk = this.hasFreezeAuthority(code) || this.hasTransferRestriction(code) || freezeSelectors.length > 0;
    const burnRisk = this.hasBurnOrLiquidityRisk(code);
    const honeypotRisk = this.hasHoneypotPattern(code) || this.hasCanBlacklist(code) || this.hasMaxTx(code) || honeypotSelectors.length > 0;
    const liquidityRisk = this.hasLiquidityLockBypass(code) || this.hasUnsupportedLiquidityPattern(code);
    const maliciousContract = this.hasMaliciousPattern(code) || (metadata as { suspicious?: boolean }).suspicious === true;

    if (mintRisk) reasons.push(`mint or supply-manipulation authority detected${mintSelectors.length > 0 ? ` (${mintSelectors.join(", ")})` : ""}`);
    if (freezeRisk) reasons.push(`freeze / transfer restriction authority detected${freezeSelectors.length > 0 ? ` (${freezeSelectors.join(", ")})` : ""}`);
    if (burnRisk) reasons.push("burn or liquidity withdrawal path detected");
    if (honeypotRisk) reasons.push(`honeypot or anti-seller pattern likely present${honeypotSelectors.length > 0 ? ` (${honeypotSelectors.join(", ")})` : ""}`);
    if (liquidityRisk) reasons.push("liquidity structure or lock-check risk detected");
    if (maliciousContract) reasons.push("malicious / suspicious contract pattern detected");

    const rugpullRisk = false;

    return {
      tokenAddress: lower,
      honeypotRisk,
      rugpullRisk,
      mintRisk,
      burnRisk,
      freezeRisk,
      liquidityRisk,
      maliciousContract,
      reasons,
    };
  }

  private hasMintFunction(code: string): boolean {
    return /mint\s*\(|_mint\s*\(|minting\s*\(|mint\s*\w+/.test(code) || /\bmint\b/.test(code);
  }

  private hasSupplyManipulation(code: string): boolean {
    return /increasebalance|burnfrom|mintto|ownerMint|setMint/.test(code);
  }

  private hasFreezeAuthority(code: string): boolean {
    return /(freeze|frozen|blacklist|pause|unpause|transferdelay|maxwallet|maxTx|whitelist)/.test(code);
  }

  private hasTransferRestriction(code: string): boolean {
    return /(blacklist\s*\(|isblacklisted|excludefromfees|transfer\s*\(|_beforetokentransfer)/.test(code);
  }

  private hasBurnOrLiquidityRisk(code: string): boolean {
    return /(removeLiquidity|burn\s*\(|_burn\s*\(|liquidity\s*\+|withdrawliquidity)/.test(code);
  }

  private hasHoneypotPattern(code: string): boolean {
    return /(selltax|buystax|tradingenabled|onlyowner|locktransfer|antiwhale|maxtx|cooldown)/.test(code);
  }

  private hasLiquidityLockBypass(code: string): boolean {
    return /(unlock|setliquidity|withdrawliquidity|removeallliquidity|liquiditylock\s*=\s*false)/.test(code);
  }

  private hasUnsupportedLiquidityPattern(code: string): boolean {
    return /(feeontransfer|transferfee|liquidityfee|deadaddress)/.test(code);
  }

  private hasMaliciousPattern(code: string): boolean {
    return /(selfdestruct|delegatecall\s*\(|call\s*\(|extcodecopy|create2|create\s*\()/ .test(code) && /(owner\s*=|approve\s*\(|transfer\s*\()/ .test(code);
  }

  private hasCanBlacklist(code: string): boolean {
    return /blacklist|setblacklist|isblacklisted/.test(code);
  }

  private hasMaxTx(code: string): boolean {
    return /maxTx|maxwallet|maxwallets|maxtransfer|maxtx/.test(code);
  }

}
