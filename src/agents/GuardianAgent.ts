// GuardianAgent — Compliance & KYC Agent
// Verifica conformidade regulatória, sancionar endereços, análise AML/KYC
// para todas as operações na Arc Testnet

import { ARC_TESTNET } from '../types/arc';

// ─── Risk Level Enum ─────────────────────────────────────────────────────────
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical' | 'blocked';
export type KYCStatus = 'verified' | 'pending' | 'failed' | 'not_submitted';

// ─── Interfaces ───────────────────────────────────────────────────────────────
export interface KYCRecord {
  address: string;
  status: KYCStatus;
  tier: 0 | 1 | 2 | 3;           // 0=none, 1=basic, 2=standard, 3=full
  maxTxUSDC: number;               // max por transação
  maxDailyUSDC: number;            // max diário
  dailyUsed: number;               // usado hoje
  lastResetDate: string;
  submittedAt?: string;
  verifiedAt?: string;
  country?: string;
  flags: string[];                 // ['pep', 'sanctioned', 'high_risk_jurisdiction']
}

export interface ComplianceCheck {
  id: string;
  txType: 'payment' | 'swap' | 'vault_deposit' | 'vault_withdraw' | 'contract';
  fromAddress: string;
  toAddress?: string;
  amount: number;                  // USDC raw (6 decimals)
  token: 'USDC' | 'EURC';
  timestamp: string;
  result: ComplianceResult;
  guardianSignature?: string;      // hash de aprovação do agente
}

export interface ComplianceResult {
  approved: boolean;
  riskLevel: RiskLevel;
  score: number;                   // 0–100 (100 = highest risk)
  reasons: string[];
  recommendations: string[];
  requiresKYC: boolean;
  requiresManualReview: boolean;
  amlFlags: string[];
  jurisdictionOk: boolean;
  sanctionHit: boolean;
  txHash?: string;                 // hash de registro on-chain (simulado)
}

export interface GuardianStats {
  totalChecks: number;
  approved: number;
  blocked: number;
  flagged: number;
  kycVerified: number;
  kycPending: number;
  averageRiskScore: number;
  lastActivity: string;
}

// ─── Sanctioned/High-Risk address list (simulado) ─────────────────────────────
const SANCTIONED_ADDRESSES = new Set([
  '0x7f268357a8c2552623316e2562d90e642bb538e5',
  '0xd882cfc20f52f2599d84b8e8d58c7fb62cfe344b',
  '0x901bb9583b24d97e995513c6778dc6888ab6870e',
]);

const HIGH_RISK_PATTERNS = [
  /^0x0{10,}/i,      // muitos zeros (mixing addresses)
  /^0xdead/i,        // endereços burn
  /^0x00000000/i,
];

// ─── Country risk tiers (ISO-3166-1 alpha-2) ──────────────────────────────────
const HIGH_RISK_JURISDICTIONS = new Set(['KP', 'IR', 'SY', 'CU', 'VE', 'MM', 'RU']);
const MEDIUM_RISK_JURISDICTIONS = new Set(['CN', 'NG', 'PK', 'AF', 'YE', 'SO']);

// ─── Agent Class ──────────────────────────────────────────────────────────────
export class GuardianAgent {
  private kycRegistry: Map<string, KYCRecord> = new Map();
  private complianceLog: ComplianceCheck[] = [];
  private stats: GuardianStats = {
    totalChecks: 0,
    approved: 0,
    blocked: 0,
    flagged: 0,
    kycVerified: 0,
    kycPending: 0,
    averageRiskScore: 0,
    lastActivity: new Date().toISOString(),
  };

  // Limits by KYC tier
  private readonly TIER_LIMITS: Record<number, { maxTx: number; maxDaily: number; label: string }> = {
    0: { maxTx: 100 * 1e6,    maxDaily: 200 * 1e6,     label: 'No KYC'       },
    1: { maxTx: 1_000 * 1e6,  maxDaily: 5_000 * 1e6,   label: 'Basic KYC'   },
    2: { maxTx: 10_000 * 1e6, maxDaily: 50_000 * 1e6,  label: 'Standard KYC'},
    3: { maxTx: 500_000 * 1e6,maxDaily: 1_000_000 * 1e6,label: 'Full KYC'   },
  };

  constructor() {
    // Seed some demo KYC records
    this._seedDemoKYC();
  }

  private _seedDemoKYC() {
    const demos: KYCRecord[] = [
      {
        address: '0xB815A0c4bC23930119324d4359dB65e27A846A2d',
        status: 'verified', tier: 2, maxTxUSDC: 10_000 * 1e6, maxDailyUSDC: 50_000 * 1e6,
        dailyUsed: 1_200 * 1e6, lastResetDate: new Date().toISOString().slice(0, 10),
        verifiedAt: new Date(Date.now() - 30 * 86400000).toISOString(), country: 'US', flags: [],
        submittedAt: new Date(Date.now() - 32 * 86400000).toISOString(),
      },
      {
        address: '0x411c60F8e61B5Cbe32F9a873b16D21CA85e9A634',
        status: 'verified', tier: 1, maxTxUSDC: 1_000 * 1e6, maxDailyUSDC: 5_000 * 1e6,
        dailyUsed: 0, lastResetDate: new Date().toISOString().slice(0, 10),
        verifiedAt: new Date(Date.now() - 10 * 86400000).toISOString(), country: 'BR', flags: [],
        submittedAt: new Date(Date.now() - 12 * 86400000).toISOString(),
      },
      {
        address: '0xC927B1d3fE6e12B1b72E3E5F3e3c5A7B9d4F2E1A',
        status: 'pending', tier: 0, maxTxUSDC: 100 * 1e6, maxDailyUSDC: 200 * 1e6,
        dailyUsed: 0, lastResetDate: new Date().toISOString().slice(0, 10), flags: [],
        submittedAt: new Date(Date.now() - 1 * 86400000).toISOString(),
      },
    ];
    demos.forEach(r => this.kycRegistry.set(r.address.toLowerCase(), r));
  }

  // ─── Public: Run compliance check ────────────────────────────────────────────
  async runCheck(params: {
    txType: ComplianceCheck['txType'];
    fromAddress: string;
    toAddress?: string;
    amount: number;
    token: 'USDC' | 'EURC';
  }): Promise<ComplianceCheck> {

    const checkId = `gc-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    const reasons: string[] = [];
    const recommendations: string[] = [];
    const amlFlags: string[] = [];
    let score = 0;
    let approved = true;
    let riskLevel: RiskLevel = 'low';
    let sanctionHit = false;
    let requiresKYC = false;
    let requiresManualReview = false;

    const fromLower = params.fromAddress.toLowerCase();
    const toLower = params.toAddress?.toLowerCase();
    const amtUSD = params.amount / 1e6;

    // ── 1. Sanction check ─────────────────────────────────────────────────────
    if (SANCTIONED_ADDRESSES.has(fromLower)) {
      sanctionHit = true;
      approved = false;
      riskLevel = 'blocked';
      score = 100;
      reasons.push(`OFAC/Sanctions hit: sender address ${params.fromAddress.slice(0, 10)}... is on the blocked list`);
      amlFlags.push('SANCTION_HIT_SENDER');
    }
    if (toLower && SANCTIONED_ADDRESSES.has(toLower)) {
      sanctionHit = true;
      approved = false;
      riskLevel = 'blocked';
      score = 100;
      reasons.push(`OFAC/Sanctions hit: recipient address is on the blocked list`);
      amlFlags.push('SANCTION_HIT_RECIPIENT');
    }

    // ── 2. High-risk address patterns ─────────────────────────────────────────
    const isHighRiskPattern = HIGH_RISK_PATTERNS.some(p => p.test(fromLower));
    if (isHighRiskPattern) {
      score += 40;
      amlFlags.push('SUSPICIOUS_ADDRESS_PATTERN');
      reasons.push('Sender address matches a suspicious pattern (potential mixer/burn address)');
    }

    // ── 3. KYC verification ───────────────────────────────────────────────────
    const kyc = this.kycRegistry.get(fromLower);
    const tier = kyc?.tier ?? 0;
    const tierLimits = this.TIER_LIMITS[tier];

    if (!kyc || kyc.status === 'not_submitted') {
      requiresKYC = true;
      score += 25;
      reasons.push(`No KYC record found for ${params.fromAddress.slice(0, 10)}...`);
      recommendations.push('Submit KYC to unlock higher transaction limits');
    } else if (kyc.status === 'pending') {
      score += 15;
      reasons.push('KYC verification is pending');
      recommendations.push('KYC review in progress — limits apply until verified');
    } else if (kyc.status === 'failed') {
      approved = false;
      score += 60;
      reasons.push('KYC verification failed — transactions blocked');
      amlFlags.push('KYC_FAILED');
    }

    // ── 4. Transaction limit checks ───────────────────────────────────────────
    if (params.amount > tierLimits.maxTx) {
      approved = false;
      score += 30;
      reasons.push(`Transaction amount $${amtUSD.toLocaleString()} exceeds tier ${tier} limit ($${(tierLimits.maxTx / 1e6).toLocaleString()})`);
      recommendations.push(`Upgrade KYC to tier ${Math.min(tier + 1, 3)} to allow larger transactions`);
    }

    const today = new Date().toISOString().slice(0, 10);
    if (kyc && kyc.lastResetDate !== today) {
      kyc.dailyUsed = 0;
      kyc.lastResetDate = today;
    }
    const projectedDaily = (kyc?.dailyUsed ?? 0) + params.amount;
    if (projectedDaily > tierLimits.maxDaily) {
      approved = false;
      score += 25;
      reasons.push(`Daily limit exceeded: projected $${(projectedDaily / 1e6).toFixed(2)} > limit $${(tierLimits.maxDaily / 1e6).toLocaleString()}`);
      recommendations.push('Wait for daily limit reset or upgrade KYC tier');
    }

    // ── 5. Amount-based risk scoring ──────────────────────────────────────────
    if (amtUSD >= 10_000) { score += 20; amlFlags.push('LARGE_VALUE_TX'); reasons.push('Large value transaction (>$10k) — enhanced monitoring'); }
    else if (amtUSD >= 1_000) { score += 10; reasons.push('High value transaction (>$1k)'); }
    else if (amtUSD >= 100) { score += 5; }

    // ── 6. Country / Jurisdiction check ──────────────────────────────────────
    const country = kyc?.country;
    let jurisdictionOk = true;
    if (country && HIGH_RISK_JURISDICTIONS.has(country)) {
      approved = false;
      score += 50;
      jurisdictionOk = false;
      amlFlags.push('HIGH_RISK_JURISDICTION');
      reasons.push(`Jurisdiction ${country} is high-risk/sanctioned`);
    } else if (country && MEDIUM_RISK_JURISDICTIONS.has(country)) {
      score += 20;
      jurisdictionOk = false; // not blocked, just flagged
      amlFlags.push('MEDIUM_RISK_JURISDICTION');
      reasons.push(`Jurisdiction ${country} requires enhanced due diligence`);
      recommendations.push('Additional documentation may be required');
    }

    // ── 7. Unusual patterns ───────────────────────────────────────────────────
    const recentTxSameAddr = this.complianceLog
      .filter(c => c.fromAddress.toLowerCase() === fromLower &&
        Date.now() - new Date(c.timestamp).getTime() < 3600000) // last 1h
      .length;
    if (recentTxSameAddr >= 5) {
      score += 15;
      amlFlags.push('HIGH_FREQUENCY');
      reasons.push(`High transaction frequency: ${recentTxSameAddr} transactions in the last hour`);
    }

    // ── 8. Structuring detection (smurfing) ───────────────────────────────────
    const recentSmall = this.complianceLog
      .filter(c => c.fromAddress.toLowerCase() === fromLower &&
        c.result.approved &&
        c.amount / 1e6 < 1000 && c.amount / 1e6 > 900 &&
        Date.now() - new Date(c.timestamp).getTime() < 86400000) // last 24h
      .length;
    if (recentSmall >= 3) {
      score += 30;
      amlFlags.push('POTENTIAL_STRUCTURING');
      reasons.push(`Potential structuring detected: multiple transactions just below $1,000`);
      requiresManualReview = true;
    }

    // ── 9. Final risk classification ──────────────────────────────────────────
    if (!sanctionHit) {
      score = Math.min(score, 99);
      if (score >= 70) { riskLevel = 'critical'; approved = false; requiresManualReview = true; }
      else if (score >= 50) { riskLevel = 'high'; requiresManualReview = true; }
      else if (score >= 25) { riskLevel = 'medium'; }
      else { riskLevel = 'low'; }
    }

    // ── 10. Default reasons if clean ─────────────────────────────────────────
    if (reasons.length === 0) {
      reasons.push('All compliance checks passed');
      recommendations.push('Transaction approved — proceed normally');
    }

    // ── Build result ──────────────────────────────────────────────────────────
    const result: ComplianceResult = {
      approved,
      riskLevel,
      score,
      reasons,
      recommendations,
      requiresKYC,
      requiresManualReview,
      amlFlags,
      jurisdictionOk,
      sanctionHit,
      txHash: approved
        ? '0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
        : undefined,
    };

    const check: ComplianceCheck = {
      id: checkId,
      txType: params.txType,
      fromAddress: params.fromAddress,
      toAddress: params.toAddress,
      amount: params.amount,
      token: params.token,
      timestamp: new Date().toISOString(),
      result,
      guardianSignature: this._signCheck(checkId, result),
    };

    // ── Update stats ──────────────────────────────────────────────────────────
    this.complianceLog.unshift(check);
    if (this.complianceLog.length > 500) this.complianceLog.pop();

    this.stats.totalChecks++;
    if (approved) {
      this.stats.approved++;
      // Update daily usage
      if (kyc) {
        kyc.dailyUsed += params.amount;
      }
    } else {
      this.stats.blocked++;
    }
    if (amlFlags.length > 0) this.stats.flagged++;
    this.stats.averageRiskScore = Math.round(
      (this.stats.averageRiskScore * (this.stats.totalChecks - 1) + score) / this.stats.totalChecks
    );
    this.stats.lastActivity = new Date().toISOString();

    return check;
  }

  // ─── KYC Operations ───────────────────────────────────────────────────────
  submitKYC(address: string, data: {
    tier?: 1 | 2 | 3;
    country?: string;
    documentType?: string;
    name?: string;
  }): KYCRecord {
    const lowerAddr = address.toLowerCase();
    const existing = this.kycRegistry.get(lowerAddr);
    const tier = data.tier ?? 1;
    const limits = this.TIER_LIMITS[tier];

    const record: KYCRecord = {
      address: address,
      status: 'pending',
      tier,
      maxTxUSDC: limits.maxTx,
      maxDailyUSDC: limits.maxDaily,
      dailyUsed: existing?.dailyUsed ?? 0,
      lastResetDate: new Date().toISOString().slice(0, 10),
      submittedAt: new Date().toISOString(),
      country: data.country,
      flags: existing?.flags ?? [],
    };

    this.kycRegistry.set(lowerAddr, record);
    this.stats.kycPending++;
    return record;
  }

  // Simulate auto-verify after submission (1-5 min delay in real)
  approveKYC(address: string, tier?: 0 | 1 | 2 | 3): KYCRecord | null {
    const lowerAddr = address.toLowerCase();
    const record = this.kycRegistry.get(lowerAddr);
    if (!record) return null;

    const newTier = tier ?? record.tier;
    const limits = this.TIER_LIMITS[newTier];

    record.status = 'verified';
    record.tier = newTier;
    record.maxTxUSDC = limits.maxTx;
    record.maxDailyUSDC = limits.maxDaily;
    record.verifiedAt = new Date().toISOString();

    if (this.stats.kycPending > 0) this.stats.kycPending--;
    this.stats.kycVerified++;

    return record;
  }

  getKYC(address: string): KYCRecord | null {
    return this.kycRegistry.get(address.toLowerCase()) ?? null;
  }

  getKYCList(): KYCRecord[] {
    return Array.from(this.kycRegistry.values());
  }

  getStats(): GuardianStats {
    return { ...this.stats };
  }

  getComplianceLog(limit = 20): ComplianceCheck[] {
    return this.complianceLog.slice(0, limit);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────
  private _signCheck(checkId: string, result: ComplianceResult): string {
    const payload = `${checkId}:${result.approved}:${result.score}:${result.riskLevel}`;
    // Deterministic pseudo-signature (no real crypto in Workers)
    let hash = 0;
    for (const c of payload) hash = ((hash << 5) - hash + c.charCodeAt(0)) | 0;
    return '0xguardian' + Math.abs(hash).toString(16).padStart(56, '0');
  }
}
