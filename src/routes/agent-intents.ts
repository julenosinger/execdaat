// ============================================================
// AGENT INTENTS ROUTE v1 — ExecDaat
// POST   /api/agent/intents          — create intent
// GET    /api/agent/intents?wallet=  — list intents for wallet
// GET    /api/agent/intents/:id      — get single intent
// PATCH  /api/agent/intents/:id      — update status/result
// DELETE /api/agent/intents/:id      — delete intent
// GET    /api/agent/poll?wallet=     — SSE or short-poll for pending→done
// ============================================================

import { Hono } from 'hono';

// ─── Types ───────────────────────────────────────────────────────────────────
export type IntentStatus =
  | 'pending'
  | 'processing'
  | 'signing'
  | 'broadcast'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type IntentType =
  | 'transfer'
  | 'multisend'
  | 'swap'
  | 'contract_deploy'
  | 'contract_call'
  | 'automation';

export interface AgentIntent {
  id:           string;
  type:         IntentType;
  status:       IntentStatus;
  wallet:       string;       // user's wallet (checksummed lower)
  token:        string;       // 'USDC' | 'EURC'
  amount?:      string;       // human-readable (e.g. "10.5")
  to?:          string;       // single recipient
  receivers?:   Array<{ address: string; amount: string }>;  // multisend
  memo?:        string;       // optional note / label
  sessionHash?: string;       // links to arcpay session
  signature?:   string;       // EIP-191 session sig
  txHash?:      string;       // once broadcast
  blockNumber?: number;
  error?:       string;       // if failed
  retries:      number;
  createdAt:    string;       // ISO
  updatedAt:    string;       // ISO
  completedAt?: string;       // ISO
}

// ─── In-memory store (Cloudflare Workers — no persistent DB without bindings) ─
// Intents survive the lifetime of the Worker instance (minutes to hours).
// For production: swap this for D1 / KV persistence.
const _intents = new Map<string, AgentIntent>();

// Max intents kept per wallet to prevent memory bloat
const MAX_PER_WALLET = 200;
const MAX_TOTAL      = 2000;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function _nowISO() { return new Date().toISOString(); }
function _genId()  { return 'intent-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }

function _isAddr(a: unknown): a is string {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
}

function _purgeOldest() {
  if (_intents.size <= MAX_TOTAL) return;
  // Remove oldest entries
  const sorted = [..._intents.entries()].sort(
    (a, b) => a[1].createdAt.localeCompare(b[1].createdAt)
  );
  sorted.slice(0, _intents.size - MAX_TOTAL).forEach(([id]) => _intents.delete(id));
}

function _walletIntents(wallet: string): AgentIntent[] {
  const w = wallet.toLowerCase();
  return [..._intents.values()].filter(i => i.wallet === w);
}

// ─── Router ──────────────────────────────────────────────────────────────────
const agentIntentsRouter = new Hono();

// ── POST /api/agent/intents ── Create a new intent ───────────────────────────
agentIntentsRouter.post('/intents', async (c) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch {
    return c.json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  const { type, wallet, token, amount, to, receivers, memo, sessionHash, signature } = body as Record<string, unknown>;

  // ── Validations ──────────────────────────────────────────────────────────
  if (!type || typeof type !== 'string') {
    return c.json({ success: false, error: 'Field "type" is required' }, 400);
  }
  const validTypes: IntentType[] = ['transfer','multisend','swap','contract_deploy','contract_call','automation'];
  if (!validTypes.includes(type as IntentType)) {
    return c.json({ success: false, error: `Invalid type. Must be one of: ${validTypes.join(', ')}` }, 400);
  }
  if (!_isAddr(wallet)) {
    return c.json({ success: false, error: 'Field "wallet" must be a valid 0x address' }, 400);
  }
  if (!token || typeof token !== 'string') {
    return c.json({ success: false, error: 'Field "token" is required (USDC|EURC)' }, 400);
  }

  // Transfer: require amount + to
  if (type === 'transfer') {
    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      return c.json({ success: false, error: 'Transfer: "amount" must be > 0' }, 400);
    }
    if (!_isAddr(to)) {
      return c.json({ success: false, error: 'Transfer: "to" must be a valid 0x address' }, 400);
    }
  }

  // Multisend: require receivers[]
  if (type === 'multisend') {
    if (!Array.isArray(receivers) || receivers.length === 0) {
      return c.json({ success: false, error: 'Multisend: "receivers" array is required' }, 400);
    }
    for (const r of receivers as Array<Record<string, unknown>>) {
      if (!_isAddr(r.address) || !r.amount || isNaN(Number(r.amount)) || Number(r.amount) <= 0) {
        return c.json({ success: false, error: 'Multisend: each receiver must have valid address + amount > 0' }, 400);
      }
    }
  }

  // Per-wallet cap
  const existing = _walletIntents(wallet as string);
  if (existing.length >= MAX_PER_WALLET) {
    // Remove oldest completed/failed to make room
    const removable = existing
      .filter(i => ['completed','failed','cancelled'].includes(i.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (removable.length > 0) {
      _intents.delete(removable[0].id);
    } else {
      return c.json({ success: false, error: 'Too many pending intents. Please wait for current ones to complete.' }, 429);
    }
  }

  const intent: AgentIntent = {
    id:          _genId(),
    type:        type as IntentType,
    status:      'pending',
    wallet:      (wallet as string).toLowerCase(),
    token:       (token as string).toUpperCase(),
    amount:      amount ? String(amount) : undefined,
    to:          to ? (to as string).toLowerCase() : undefined,
    receivers:   receivers as AgentIntent['receivers'],
    memo:        memo ? String(memo).slice(0, 200) : undefined,
    sessionHash: sessionHash ? String(sessionHash).slice(0, 64) : undefined,
    signature:   signature   ? String(signature).slice(0, 256)  : undefined,
    retries:     0,
    createdAt:   _nowISO(),
    updatedAt:   _nowISO(),
  };

  _intents.set(intent.id, intent);
  _purgeOldest();

  console.log(`[AGENT INTENT] Created: ${intent.id} type=${intent.type} wallet=${intent.wallet.slice(0,10)}…`);

  return c.json({ success: true, intent }, 201);
});

// ── GET /api/agent/intents ── List intents for a wallet ──────────────────────
agentIntentsRouter.get('/intents', (c) => {
  const rawWallet = c.req.query('wallet');
  const statusFilter = c.req.query('status');
  const limitRaw = parseInt(c.req.query('limit') || '50', 10);
  const limit = Math.min(Math.max(1, limitRaw), 200);

  if (!rawWallet || !_isAddr(rawWallet)) {
    return c.json({ success: false, error: 'Query param "wallet" must be a valid 0x address' }, 400);
  }

  let results = _walletIntents(rawWallet);

  if (statusFilter) {
    const statuses = statusFilter.split(',').map(s => s.trim());
    results = results.filter(i => statuses.includes(i.status));
  }

  // Newest first
  results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  results = results.slice(0, limit);

  return c.json({ success: true, intents: results, total: results.length });
});

// ── GET /api/agent/intents/:id ── Get single intent ──────────────────────────
agentIntentsRouter.get('/intents/:id', (c) => {
  const id = c.req.param('id');
  const intent = _intents.get(id);
  if (!intent) return c.json({ success: false, error: 'Intent not found' }, 404);
  return c.json({ success: true, intent });
});

// ── PATCH /api/agent/intents/:id ── Update intent status/result ──────────────
agentIntentsRouter.patch('/intents/:id', async (c) => {
  const id = c.req.param('id');
  const intent = _intents.get(id);
  if (!intent) return c.json({ success: false, error: 'Intent not found' }, 404);

  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch {
    return c.json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  const allowedStatuses: IntentStatus[] = ['pending','processing','signing','broadcast','completed','failed','cancelled'];
  if (body.status && !allowedStatuses.includes(body.status as IntentStatus)) {
    return c.json({ success: false, error: `Invalid status. Must be one of: ${allowedStatuses.join(', ')}` }, 400);
  }

  // Apply updates
  if (body.status)      intent.status      = body.status as IntentStatus;
  if (body.txHash)      intent.txHash      = String(body.txHash).slice(0, 66);
  if (body.blockNumber) intent.blockNumber = Number(body.blockNumber);
  if (body.error)       intent.error       = String(body.error).slice(0, 500);
  if (body.retries !== undefined) intent.retries = Number(body.retries);
  if (body.status === 'completed' || body.status === 'failed') {
    intent.completedAt = _nowISO();
  }
  intent.updatedAt = _nowISO();

  _intents.set(id, intent);
  return c.json({ success: true, intent });
});

// ── DELETE /api/agent/intents/:id ── Cancel/delete intent ────────────────────
agentIntentsRouter.delete('/intents/:id', (c) => {
  const id = c.req.param('id');
  const intent = _intents.get(id);
  if (!intent) return c.json({ success: false, error: 'Intent not found' }, 404);

  // Only allow deleting terminal or pending intents
  if (intent.status === 'processing' || intent.status === 'broadcast') {
    return c.json({ success: false, error: 'Cannot delete intent while it is being processed' }, 409);
  }

  _intents.delete(id);
  return c.json({ success: true, message: 'Intent deleted' });
});

// ── GET /api/agent/poll ── Short-poll: returns only changed intents ──────────
// Frontend calls this every 2s with ?wallet=0x...&since=<ISO timestamp>
agentIntentsRouter.get('/poll', (c) => {
  const rawWallet = c.req.query('wallet');
  const since     = c.req.query('since');  // ISO timestamp

  if (!rawWallet || !_isAddr(rawWallet)) {
    return c.json({ success: false, error: 'Query param "wallet" must be a valid 0x address' }, 400);
  }

  let results = _walletIntents(rawWallet);

  if (since) {
    results = results.filter(i => i.updatedAt > since);
  } else {
    // First poll: return all non-terminal intents
    results = results.filter(i =>
      !['completed','failed','cancelled'].includes(i.status) ||
      // Also return recently completed (last 30s) so frontend can show final state
      (i.completedAt && Date.now() - new Date(i.completedAt).getTime() < 30_000)
    );
  }

  results.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

  return c.json({
    success:   true,
    intents:   results,
    total:     results.length,
    timestamp: _nowISO(),
  });
});

// ── GET /api/agent/stats ── Aggregate stats ───────────────────────────────────
agentIntentsRouter.get('/stats', (c) => {
  const rawWallet = c.req.query('wallet');
  const scope = rawWallet && _isAddr(rawWallet)
    ? _walletIntents(rawWallet)
    : [..._intents.values()];

  const stats = {
    total:      scope.length,
    pending:    scope.filter(i => i.status === 'pending').length,
    processing: scope.filter(i => ['processing','signing','broadcast'].includes(i.status)).length,
    completed:  scope.filter(i => i.status === 'completed').length,
    failed:     scope.filter(i => i.status === 'failed').length,
    cancelled:  scope.filter(i => i.status === 'cancelled').length,
  };
  return c.json({ success: true, stats });
});

export default agentIntentsRouter;
