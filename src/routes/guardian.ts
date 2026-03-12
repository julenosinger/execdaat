// Rotas API para o Guardian Agent (Compliance & KYC)

import { Hono } from 'hono';
import { GuardianAgent } from '../agents/GuardianAgent';

const guardianRouter = new Hono();
let agent: GuardianAgent | null = null;

function getAgent(): GuardianAgent {
  if (!agent) agent = new GuardianAgent();
  return agent;
}

// ─── Status do agente ──────────────────────────────────────────────────────
guardianRouter.get('/status', (c) => {
  const a = getAgent();
  return c.json({
    success: true,
    agent: {
      id: 'guardian-agent-01',
      name: 'ARC Guardian Agent v1.0',
      capabilities: ['aml_check', 'kyc_verification', 'sanction_screening', 'jurisdiction_check', 'structuring_detection'],
      status: 'active',
    },
    stats: a.getStats(),
    network: { name: 'Arc Testnet', chainId: 5042002, usdcAddress: '0x3600000000000000000000000000000000000000' },
  });
});

// ─── Check de compliance para qualquer operação ──────────────────────────
guardianRouter.post('/check', async (c) => {
  try {
    const body = await c.req.json();
    const { txType, fromAddress, toAddress, amount, token = 'USDC' } = body;

    if (!txType || !fromAddress || !amount) {
      return c.json({ success: false, error: 'Required: txType, fromAddress, amount' }, 400);
    }

    const validTypes = ['payment', 'swap', 'vault_deposit', 'vault_withdraw', 'contract'];
    if (!validTypes.includes(txType)) {
      return c.json({ success: false, error: `txType must be one of: ${validTypes.join(', ')}` }, 400);
    }

    const a = getAgent();
    const check = await a.runCheck({
      txType,
      fromAddress,
      toAddress,
      amount: parseFloat(amount) * 1e6,
      token: (token === 'EURC' ? 'EURC' : 'USDC'),
    });

    return c.json({
      success: true,
      check,
      approved: check.result.approved,
      riskLevel: check.result.riskLevel,
      summary: check.result.approved
        ? `✅ Compliance passed (risk: ${check.result.riskLevel}, score: ${check.result.score}/100)`
        : `🚫 Compliance FAILED: ${check.result.reasons[0]}`,
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ─── Submit KYC ────────────────────────────────────────────────────────────
guardianRouter.post('/kyc/submit', async (c) => {
  try {
    const body = await c.req.json();
    const { address, tier = 1, country, documentType, name: fullName } = body;

    if (!address) {
      return c.json({ success: false, error: 'address is required' }, 400);
    }
    if (![1, 2, 3].includes(tier)) {
      return c.json({ success: false, error: 'tier must be 1, 2, or 3' }, 400);
    }

    const a = getAgent();
    const record = a.submitKYC(address, { tier, country, documentType, name: fullName });

    // Simulate fast auto-approval for tier 1 (< 2 min in testnet)
    setTimeout(() => {
      const updated = a.approveKYC(address, tier);
      if (updated) console.log(`[Guardian] Auto-approved KYC for ${address} tier ${tier}`);
    }, 5000 + Math.random() * 10000); // 5-15 sec for demo

    return c.json({
      success: true,
      record,
      message: `KYC submitted for ${address}. Status: pending. Auto-verification in progress.`,
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ─── Verify KYC (admin simulate) ──────────────────────────────────────────
guardianRouter.post('/kyc/verify', async (c) => {
  try {
    const body = await c.req.json();
    const { address, tier } = body;
    if (!address) return c.json({ success: false, error: 'address required' }, 400);

    const a = getAgent();
    const record = a.approveKYC(address, tier);
    if (!record) return c.json({ success: false, error: 'KYC record not found. Submit KYC first.' }, 404);

    return c.json({ success: true, record, message: `KYC approved for ${address} at tier ${record.tier}` });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ─── Get KYC for address ───────────────────────────────────────────────────
guardianRouter.get('/kyc/:address', (c) => {
  const address = c.req.param('address');
  const a = getAgent();
  const record = a.getKYC(address);

  if (!record) {
    return c.json({
      success: true,
      record: null,
      status: 'not_submitted',
      message: `No KYC record found for ${address}. Tier 0 limits apply.`,
    });
  }

  const tierLabels = ['No KYC', 'Basic KYC', 'Standard KYC', 'Full KYC'];
  return c.json({
    success: true,
    record,
    tierLabel: tierLabels[record.tier] || 'Unknown',
    limitsUSDC: {
      maxTransaction: record.maxTxUSDC / 1e6,
      maxDaily: record.maxDailyUSDC / 1e6,
      dailyUsed: record.dailyUsed / 1e6,
      dailyRemaining: (record.maxDailyUSDC - record.dailyUsed) / 1e6,
    },
  });
});

// ─── List all KYC records ──────────────────────────────────────────────────
guardianRouter.get('/kyc', (c) => {
  const a = getAgent();
  const list = a.getKYCList();
  return c.json({
    success: true,
    records: list,
    total: list.length,
    verified: list.filter(r => r.status === 'verified').length,
    pending: list.filter(r => r.status === 'pending').length,
  });
});

// ─── Compliance log ────────────────────────────────────────────────────────
guardianRouter.get('/log', (c) => {
  const limit = parseInt(c.req.query('limit') || '20');
  const a = getAgent();
  return c.json({
    success: true,
    checks: a.getComplianceLog(limit),
    stats: a.getStats(),
  });
});

// ─── Quick scan (batch addresses) ─────────────────────────────────────────
guardianRouter.post('/scan', async (c) => {
  try {
    const body = await c.req.json();
    const { addresses } = body;
    if (!Array.isArray(addresses) || addresses.length === 0) {
      return c.json({ success: false, error: 'addresses array required' }, 400);
    }
    if (addresses.length > 50) {
      return c.json({ success: false, error: 'Max 50 addresses per scan' }, 400);
    }

    const a = getAgent();
    const results = [];
    for (const addr of addresses) {
      const kyc = a.getKYC(addr);
      // Fast scan without full compliance check
      const isSanctioned = ['0x7f268357a8c2552623316e2562d90e642bb538e5',
        '0xd882cfc20f52f2599d84b8e8d58c7fb62cfe344b',
        '0x901bb9583b24d97e995513c6778dc6888ab6870e'].includes(addr.toLowerCase());

      results.push({
        address: addr,
        sanctioned: isSanctioned,
        kycStatus: kyc?.status ?? 'not_submitted',
        kycTier: kyc?.tier ?? 0,
        flags: kyc?.flags ?? [],
        riskLevel: isSanctioned ? 'blocked' : (kyc?.status === 'failed' ? 'critical' : 'unknown'),
      });
    }

    return c.json({ success: true, results, scanned: results.length });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

export default guardianRouter;
