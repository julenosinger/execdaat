// ─── EscrowWallet API Routes ──────────────────────────────────────────────────
// Mirrors on-chain EscrowWallet.sol logic (ARC Testnet, Chain ID 5042002)
// In-memory store simulates blockchain state; real deployment via Foundry/forge
//
// Endpoints:
//   POST   /api/escrow/create              — createEscrow()
//   POST   /api/escrow/:id/deposit         — depositUSDC()
//   POST   /api/escrow/:id/request/:mId    — requestMilestoneVerification()
//   POST   /api/escrow/:id/verify/:mId     — verifyMilestone()
//   POST   /api/escrow/:id/release/:mId    — releaseMilestonePayment()
//   POST   /api/escrow/:id/dispute         — raiseDispute()
//   POST   /api/escrow/:id/refund          — refundClient()
//   GET    /api/escrow                     — list all escrows
//   GET    /api/escrow/:id                 — get escrow detail
//   GET    /api/escrow/:id/milestones      — get milestones
//   GET    /api/escrow/wallet/:address     — escrows by wallet
//   GET    /api/escrow/network             — network info + contract ABI ref

import { Hono } from 'hono';

const escrowRouter = new Hono();

// ─── ARC Testnet Constants ────────────────────────────────────────────────────
const USDC_ADDRESS    = '0x3600000000000000000000000000000000000000';
const CHAIN_ID        = 5042002;
const NETWORK_NAME    = 'Arc Testnet';
const EXPLORER_URL    = 'https://testnet.arcscan.app';
const RPC_URL         = 'https://rpc.testnet.arc.network';
// Simulated factory address (replace with deployed address after `forge create`)
// NOTE: EscrowRegistry is awaiting deployment — EscrowWallet logic is used via ContractFactory
const FACTORY_ADDRESS = '0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A'; // ContractFactory (deployed)
// EscrowRegistry address (from EscrowRegistry.sol — deploy separately)
// TODO: Deploy EscrowRegistry.sol and update this address
const REGISTRY_ADDRESS = '0x0000000000000000000000000000000000000000'; // Not yet deployed

// ─── Types ────────────────────────────────────────────────────────────────────
type EscrowState = 'Created' | 'Active' | 'Disputed' | 'Completed' | 'Refunded';
type MilestoneState = 'Pending' | 'RequestedByContractor' | 'Verified' | 'Released';

interface Milestone {
  id: number;
  amount: number;            // USDC (6 decimals, human-readable float)
  description: string;
  state: MilestoneState;
  completed: boolean;
  released: boolean;
  requestedAt: number | null;
  verifiedAt: number | null;
  releasedAt: number | null;
}

interface EscrowWallet {
  id: number;
  escrowAddress: string;     // simulated contract address
  client: string;
  contractor: string;
  totalAmount: number;       // USDC
  depositedAmount: number;   // USDC
  releasedAmount: number;    // USDC
  state: EscrowState;
  milestones: Milestone[];
  createdAt: number;
  updatedAt: number;
  txHash: string;
  blockNumber: number;
  network: string;
  chainId: number;
  explorerUrl: string;
  // Optional: link back to contracts module
  contractId?: number;
  title?: string;
  source?: 'manual' | 'contract_creation';
}

interface EscrowEvent {
  escrowId: number;
  event: string;
  txHash: string;
  blockNumber: number;
  timestamp: number;
  data: Record<string, unknown>;
  explorerUrl: string;
}

// ─── In-Memory Store (mirrors on-chain state) ─────────────────────────────────
// Exported so contracts.ts can push escrows directly (shared singleton)
export const escrowStore: Map<number, EscrowWallet> = new Map();
export const escrowEvents: EscrowEvent[] = [];
export let escrowCounter = 0;
export function incrementEscrowCounter() { escrowCounter++; return escrowCounter; }

// ── Helper: create an escrow from a contract creation call ────────────────────
export function createEscrowFromContract(params: {
  title: string;
  client: string;
  contractor: string;
  totalAmount: number;          // human-readable USDC
  milestones?: Array<{ description: string; amount: number }>;
  contractId: number;
  contractTxHash?: string;
}): EscrowWallet {
  const id = incrementEscrowCounter();
  const txHash = params.contractTxHash || genTxHash();
  const blockNumber = genBlockNumber();

  // Build milestones — if none provided, create one milestone for the full amount
  const rawMilestones = params.milestones && params.milestones.length > 0
    ? params.milestones
    : [{ description: params.title, amount: params.totalAmount }];

  const milestones: Milestone[] = rawMilestones.map((m, i) => ({
    id: i,
    amount: parseFloat(m.amount.toString()),
    description: m.description || `Milestone ${i + 1}`,
    state: 'Pending' as MilestoneState,
    completed: false,
    released: false,
    requestedAt: null,
    verifiedAt: null,
    releasedAt: null,
  }));

  const escrow: EscrowWallet = {
    id,
    escrowAddress: genAddress(),
    client: params.client,
    contractor: params.contractor,
    totalAmount: parseFloat(params.totalAmount.toString()),
    depositedAmount: 0,
    releasedAmount: 0,
    state: 'Created',
    milestones,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    txHash,
    blockNumber,
    network: NETWORK_NAME,
    chainId: CHAIN_ID,
    explorerUrl: `${EXPLORER_URL}/tx/${txHash}`,
    // Extra metadata linking back to Contract
    contractId: params.contractId,
    title: params.title,
  } as EscrowWallet & { contractId: number; title: string };

  escrowStore.set(id, escrow);

  // Emit EscrowCreated event (mirrors on-chain)
  const ev: EscrowEvent = {
    escrowId: id,
    event: 'EscrowCreated',
    txHash,
    blockNumber,
    timestamp: Date.now(),
    data: {
      title: params.title,
      client: params.client,
      contractor: params.contractor,
      totalAmount: params.totalAmount,
      milestoneCount: milestones.length,
      contractId: params.contractId,
      source: 'contract_creation',
    },
    explorerUrl: `${EXPLORER_URL}/tx/${txHash}`,
  };
  escrowEvents.unshift(ev);

  return escrow;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function genTxHash(): string {
  return '0x' + Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  ).join('');
}

function genAddress(): string {
  return '0x' + Array.from({ length: 20 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  ).join('');
}

function genBlockNumber(): number {
  return Math.floor(Date.now() / 12000) + Math.floor(Math.random() * 100);
}

function emitEvent(
  escrowId: number,
  eventName: string,
  data: Record<string, unknown>
): EscrowEvent {
  const txHash = genTxHash();
  const blockNumber = genBlockNumber();
  const ev: EscrowEvent = {
    escrowId,
    event: eventName,
    txHash,
    blockNumber,
    timestamp: Date.now(),
    data,
    explorerUrl: `${EXPLORER_URL}/tx/${txHash}`,
  };
  escrowEvents.unshift(ev);
  return ev;
}

function getEscrowOrFail(id: number): EscrowWallet | null {
  return escrowStore.get(id) ?? null;
}

function usdcBalance(esc: EscrowWallet): number {
  return parseFloat((esc.depositedAmount - esc.releasedAmount).toFixed(6));
}

// ─── Seed data (demo escrow) ──────────────────────────────────────────────────
function seedDemoEscrow() {
  escrowCounter = 1;
  const milestones: Milestone[] = [
    { id: 0, amount: 500, description: 'UI Design & Wireframes', state: 'Verified', completed: true, released: false, requestedAt: Date.now() - 86400000, verifiedAt: Date.now() - 3600000, releasedAt: null },
    { id: 1, amount: 750, description: 'Backend API Development', state: 'RequestedByContractor', completed: false, released: false, requestedAt: Date.now() - 1800000, verifiedAt: null, releasedAt: null },
    { id: 2, amount: 750, description: 'Frontend Integration', state: 'Pending', completed: false, released: false, requestedAt: null, verifiedAt: null, releasedAt: null },
  ];
  const txHash = genTxHash();
  const escrow: EscrowWallet = {
    id: 1,
    escrowAddress: '0xEsc001a2b3c4d5e6f7890abcdef1234567890ab',
    client: '0xDemoClient1111111111111111111111111111',
    contractor: '0xDemoContractor2222222222222222222222',
    totalAmount: 2000,
    depositedAmount: 2000,
    releasedAmount: 0,
    state: 'Active',
    milestones,
    createdAt: Date.now() - 172800000,
    updatedAt: Date.now() - 3600000,
    txHash,
    blockNumber: genBlockNumber(),
    network: NETWORK_NAME,
    chainId: CHAIN_ID,
    explorerUrl: `${EXPLORER_URL}/tx/${txHash}`,
  };
  escrowStore.set(1, escrow);

  // Seed event
  emitEvent(1, 'EscrowCreated', {
    client: escrow.client,
    contractor: escrow.contractor,
    totalAmount: escrow.totalAmount,
    milestoneCount: milestones.length,
  });
  emitEvent(1, 'DepositReceived', {
    depositor: escrow.client,
    amount: 2000,
    newBalance: 2000,
  });
}

seedDemoEscrow();

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /api/escrow/network ────────────────────────────────────────────────────
escrowRouter.get('/network', (c) => {
  return c.json({
    network: NETWORK_NAME,
    chainId: CHAIN_ID,
    rpcUrl: RPC_URL,
    explorerUrl: EXPLORER_URL,
    usdcToken: USDC_ADDRESS,
    factoryAddress: FACTORY_ADDRESS,
    deployGuide: 'https://docs.arc.network/arc/tutorials/deploy-on-arc',
    contractFile: 'contracts/EscrowWallet.sol',
    note: 'In-memory simulation — deploy via: forge create contracts/EscrowWallet.sol --rpc-url https://rpc.testnet.arc.network',
    abi: {
      createEscrow: 'constructor(uint256 id, address client, address contractor, address usdc, uint256 total, uint256[] milestones, string[] descriptions)',
      depositUSDC: 'function depositUSDC(uint256 amount)',
      requestMilestoneVerification: 'function requestMilestoneVerification(uint256 milestoneId)',
      verifyMilestone: 'function verifyMilestone(uint256 milestoneId)',
      releaseMilestonePayment: 'function releaseMilestonePayment(uint256 milestoneId)',
      raiseDispute: 'function raiseDispute()',
      refundClient: 'function refundClient()',
    },
  });
});

// ── GET /api/escrow ────────────────────────────────────────────────────────────
escrowRouter.get('/', (c) => {
  const list = Array.from(escrowStore.values()).sort((a, b) => b.createdAt - a.createdAt);
  return c.json({
    escrows: list.map(e => ({
      ...e,
      balance: usdcBalance(e),
      progress: e.totalAmount > 0 ? parseFloat(((e.releasedAmount / e.totalAmount) * 100).toFixed(1)) : 0,
      completedMilestones: e.milestones.filter(m => m.completed).length,
      releasedMilestones: e.milestones.filter(m => m.released).length,
    })),
    total: escrowStore.size,
    stats: {
      active: Array.from(escrowStore.values()).filter(e => e.state === 'Active').length,
      disputed: Array.from(escrowStore.values()).filter(e => e.state === 'Disputed').length,
      completed: Array.from(escrowStore.values()).filter(e => e.state === 'Completed').length,
      totalLockedUsdc: Array.from(escrowStore.values()).reduce((s, e) => s + usdcBalance(e), 0),
    },
  });
});

// ── GET /api/escrow/events ─────────────────────────────────────────────────────
escrowRouter.get('/events', (c) => {
  return c.json({ events: escrowEvents.slice(0, 50), total: escrowEvents.length });
});

// ── GET /api/escrow/wallet/:address ───────────────────────────────────────────
escrowRouter.get('/wallet/:address', (c) => {
  const addr = c.req.param('address').toLowerCase();
  const found = Array.from(escrowStore.values()).filter(e =>
    e.client.toLowerCase() === addr || e.contractor.toLowerCase() === addr
  );
  return c.json({
    address: addr,
    asClient: found.filter(e => e.client.toLowerCase() === addr).map(e => ({ ...e, balance: usdcBalance(e), role: 'client' })),
    asContractor: found.filter(e => e.contractor.toLowerCase() === addr).map(e => ({ ...e, balance: usdcBalance(e), role: 'contractor' })),
    total: found.length,
  });
});

// ── GET /api/escrow/:id ────────────────────────────────────────────────────────
escrowRouter.get('/:id', (c) => {
  const id = parseInt(c.req.param('id'));
  const esc = getEscrowOrFail(id);
  if (!esc) return c.json({ error: 'Escrow not found' }, 404);

  const events = escrowEvents.filter(e => e.escrowId === id);
  return c.json({
    ...esc,
    balance: usdcBalance(esc),
    progress: esc.totalAmount > 0 ? parseFloat(((esc.releasedAmount / esc.totalAmount) * 100).toFixed(1)) : 0,
    completedMilestones: esc.milestones.filter(m => m.completed).length,
    releasedMilestones: esc.milestones.filter(m => m.released).length,
    events,
  });
});

// ── GET /api/escrow/:id/milestones ────────────────────────────────────────────
escrowRouter.get('/:id/milestones', (c) => {
  const id = parseInt(c.req.param('id'));
  const esc = getEscrowOrFail(id);
  if (!esc) return c.json({ error: 'Escrow not found' }, 404);

  return c.json({
    escrowId: id,
    milestones: esc.milestones,
    summary: {
      total: esc.milestones.length,
      pending: esc.milestones.filter(m => m.state === 'Pending').length,
      requested: esc.milestones.filter(m => m.state === 'RequestedByContractor').length,
      verified: esc.milestones.filter(m => m.state === 'Verified').length,
      released: esc.milestones.filter(m => m.released).length,
      totalAmount: esc.totalAmount,
      releasedAmount: esc.releasedAmount,
      pendingAmount: esc.totalAmount - esc.releasedAmount,
    },
  });
});

// ── POST /api/escrow/create ────────────────────────────────────────────────────
escrowRouter.post('/create', async (c) => {
  try {
    const body = await c.req.json();
    const {
      client, contractor, totalAmount,
      milestones: milestoneInput,
      txHash: userTxHash,
      title: bodyTitle,
      source: bodySource,
      blockNumber: bodyBlockNumber,
    } = body;

    // Validation
    if (!client || !contractor) return c.json({ error: 'client and contractor are required' }, 400);
    if (!totalAmount || totalAmount <= 0) return c.json({ error: 'totalAmount must be > 0' }, 400);
    if (!milestoneInput || !Array.isArray(milestoneInput) || milestoneInput.length === 0)
      return c.json({ error: 'milestones array is required' }, 400);

    // Validate milestone sum
    const sum = milestoneInput.reduce((s: number, m: { amount: number }) => s + (m.amount || 0), 0);
    if (Math.abs(sum - totalAmount) > 0.01)
      return c.json({ error: `Milestone amounts (${sum}) must sum to totalAmount (${totalAmount})` }, 400);

    escrowCounter++;
    const id = escrowCounter;
    const txHash = userTxHash || genTxHash();
    const blockNumber = genBlockNumber();

    const milestones: Milestone[] = milestoneInput.map((m: { amount: number; description?: string }, i: number) => ({
      id: i,
      amount: parseFloat(m.amount.toString()),
      description: m.description || `Milestone ${i + 1}`,
      state: 'Pending' as MilestoneState,
      completed: false,
      released: false,
      requestedAt: null,
      verifiedAt: null,
      releasedAt: null,
    }));

    const escrow: EscrowWallet = {
      id,
      escrowAddress: genAddress(),
      client,
      contractor,
      totalAmount: parseFloat(totalAmount.toString()),
      depositedAmount: 0,
      releasedAmount: 0,
      state: 'Created',
      milestones,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      txHash,
      blockNumber: bodyBlockNumber || blockNumber,
      network: NETWORK_NAME,
      chainId: CHAIN_ID,
      explorerUrl: `${EXPLORER_URL}/tx/${txHash}`,
      // Optional metadata from frontend
      title: bodyTitle,
      source: (bodySource as 'manual' | 'contract_creation' | undefined) || 'manual',
    };

    escrowStore.set(id, escrow);
    const ev = emitEvent(id, 'EscrowCreated', {
      title: bodyTitle, client, contractor, totalAmount, milestoneCount: milestones.length,
      source: bodySource,
    });

    return c.json({
      success: true,
      message: 'Escrow created — event: EscrowCreated',
      escrowId: id,
      escrowAddress: escrow.escrowAddress,
      txHash,
      blockNumber: bodyBlockNumber || blockNumber,
      explorerUrl: ev.explorerUrl,
      escrow: { ...escrow, balance: 0, progress: 0 },
      // Mirror on-chain EscrowCreated event
      event: {
        name: 'EscrowCreated',
        escrowId: id,
        title: bodyTitle,
        client,
        contractor,
        amount: parseFloat(totalAmount.toString()),
        milestoneCount: milestones.length,
        txHash,
        explorerUrl: ev.explorerUrl,
        network: NETWORK_NAME,
        chainId: CHAIN_ID,
        timestamp: escrow.createdAt,
      },
    }, 201);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to create escrow', details: msg }, 500);
  }
});

// ── POST /api/escrow/:id/deposit ──────────────────────────────────────────────
escrowRouter.post('/:id/deposit', async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    const esc = getEscrowOrFail(id);
    if (!esc) return c.json({ error: 'Escrow not found' }, 404);
    if (esc.state === 'Completed' || esc.state === 'Refunded')
      return c.json({ error: `Cannot deposit: escrow state is ${esc.state}` }, 400);

    const body = await c.req.json();
    const { amount, depositor, txHash: userTxHash } = body;

    if (!amount || amount <= 0) return c.json({ error: 'amount must be > 0' }, 400);

    // Security: prevent over-deposit
    const remaining = esc.totalAmount - esc.depositedAmount;
    if (amount > remaining + 0.001)
      return c.json({ error: `Deposit (${amount}) exceeds remaining needed (${remaining})` }, 400);

    esc.depositedAmount = parseFloat((esc.depositedAmount + parseFloat(amount.toString())).toFixed(6));
    esc.updatedAt = Date.now();

    // Activate when fully funded
    if (esc.depositedAmount >= esc.totalAmount && esc.state === 'Created') {
      esc.state = 'Active';
    } else if (esc.state === 'Created' && esc.depositedAmount > 0) {
      // partial deposit — keep Created but note deposit
    }

    const txHash = userTxHash || genTxHash();
    const blockNumber = genBlockNumber();
    const ev = emitEvent(id, 'DepositReceived', {
      depositor: depositor || esc.client,
      amount,
      newBalance: usdcBalance(esc),
    });

    return c.json({
      success: true,
      message: `Deposit received — event: DepositReceived. State: ${esc.state}`,
      escrowId: id,
      depositAmount: amount,
      totalDeposited: esc.depositedAmount,
      balance: usdcBalance(esc),
      state: esc.state,
      txHash,
      blockNumber: ev.blockNumber,
      explorerUrl: ev.explorerUrl,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to process deposit', details: msg }, 500);
  }
});

// ── POST /api/escrow/:id/request/:mId ─────────────────────────────────────────
// Contractor requests milestone verification
escrowRouter.post('/:id/request/:mId', async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    const mId = parseInt(c.req.param('mId'));
    const esc = getEscrowOrFail(id);
    if (!esc) return c.json({ error: 'Escrow not found' }, 404);
    if (esc.state !== 'Active') return c.json({ error: `Escrow is ${esc.state}, not Active` }, 400);

    const body = await c.req.json();
    const { caller } = body; // contractor wallet address

    if (mId < 0 || mId >= esc.milestones.length)
      return c.json({ error: `Invalid milestone ID ${mId}` }, 400);

    const m = esc.milestones[mId];
    if (m.state !== 'Pending')
      return c.json({ error: `Milestone ${mId} is ${m.state}, not Pending` }, 400);

    m.state = 'RequestedByContractor';
    m.requestedAt = Date.now();
    esc.updatedAt = Date.now();

    const ev = emitEvent(id, 'MilestoneRequested', {
      milestoneId: mId,
      contractor: caller || esc.contractor,
      amount: m.amount,
    });

    return c.json({
      success: true,
      message: `Milestone ${mId} request submitted — event: MilestoneRequested`,
      escrowId: id,
      milestoneId: mId,
      milestone: m,
      txHash: ev.txHash,
      explorerUrl: ev.explorerUrl,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to request milestone', details: msg }, 500);
  }
});

// ── POST /api/escrow/:id/verify/:mId ──────────────────────────────────────────
// Client verifies milestone (approves payment)
escrowRouter.post('/:id/verify/:mId', async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    const mId = parseInt(c.req.param('mId'));
    const esc = getEscrowOrFail(id);
    if (!esc) return c.json({ error: 'Escrow not found' }, 404);
    if (esc.state !== 'Active') return c.json({ error: `Escrow is ${esc.state}, not Active` }, 400);
    if (esc.state as string === 'Disputed') return c.json({ error: 'Escrow is disputed' }, 400);

    if (mId < 0 || mId >= esc.milestones.length)
      return c.json({ error: `Invalid milestone ID ${mId}` }, 400);

    const m = esc.milestones[mId];
    if (m.state !== 'RequestedByContractor')
      return c.json({ error: `Milestone ${mId} is ${m.state}, not RequestedByContractor` }, 400);
    if (m.completed)
      return c.json({ error: `Milestone ${mId} already completed` }, 400);

    m.state = 'Verified';
    m.completed = true;
    m.verifiedAt = Date.now();
    esc.updatedAt = Date.now();

    const ev = emitEvent(id, 'MilestoneVerified', {
      milestoneId: mId,
      client: esc.client,
      amount: m.amount,
    });

    return c.json({
      success: true,
      message: `Milestone ${mId} verified — event: MilestoneVerified`,
      escrowId: id,
      milestoneId: mId,
      milestone: m,
      txHash: ev.txHash,
      explorerUrl: ev.explorerUrl,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to verify milestone', details: msg }, 500);
  }
});

// ── POST /api/escrow/:id/release/:mId ─────────────────────────────────────────
// Contractor releases payment for verified milestone
escrowRouter.post('/:id/release/:mId', async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    const mId = parseInt(c.req.param('mId'));
    const esc = getEscrowOrFail(id);
    if (!esc) return c.json({ error: 'Escrow not found' }, 404);
    if (esc.state !== 'Active') return c.json({ error: `Escrow is ${esc.state}, not Active` }, 400);

    if (mId < 0 || mId >= esc.milestones.length)
      return c.json({ error: `Invalid milestone ID ${mId}` }, 400);

    const m = esc.milestones[mId];
    if (!m.completed) return c.json({ error: `Milestone ${mId} not verified by client` }, 400);
    if (m.released) return c.json({ error: `Milestone ${mId} payment already released` }, 400);

    // Security: check sufficient balance
    const bal = usdcBalance(esc);
    if (bal < m.amount)
      return c.json({ error: `Insufficient escrow balance (${bal} < ${m.amount})` }, 400);

    m.released = true;
    m.state = 'Released';
    m.releasedAt = Date.now();
    esc.releasedAmount = parseFloat((esc.releasedAmount + m.amount).toFixed(6));
    esc.updatedAt = Date.now();

    // Complete escrow if all milestones released
    const allReleased = esc.milestones.every(ms => ms.released);
    if (allReleased) esc.state = 'Completed';

    const ev = emitEvent(id, 'PaymentReleased', {
      milestoneId: mId,
      contractor: esc.contractor,
      amount: m.amount,
    });

    return c.json({
      success: true,
      message: `Payment released — event: PaymentReleased. ${allReleased ? 'Escrow COMPLETED.' : ''}`,
      escrowId: id,
      milestoneId: mId,
      amountReleased: m.amount,
      totalReleased: esc.releasedAmount,
      remainingBalance: usdcBalance(esc),
      escrowState: esc.state,
      milestone: m,
      txHash: ev.txHash,
      explorerUrl: ev.explorerUrl,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to release payment', details: msg }, 500);
  }
});

// ── POST /api/escrow/:id/dispute ──────────────────────────────────────────────
escrowRouter.post('/:id/dispute', async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    const esc = getEscrowOrFail(id);
    if (!esc) return c.json({ error: 'Escrow not found' }, 404);
    if (esc.state !== 'Active') return c.json({ error: `Cannot dispute: escrow is ${esc.state}` }, 400);

    const body = await c.req.json();
    const { raisedBy, reason } = body;

    esc.state = 'Disputed';
    esc.updatedAt = Date.now();

    const ev = emitEvent(id, 'DisputeRaised', {
      raisedBy: raisedBy || 'unknown',
      reason: reason || 'No reason provided',
    });

    return c.json({
      success: true,
      message: 'Dispute raised — event: DisputeRaised. Escrow frozen.',
      escrowId: id,
      state: esc.state,
      balance: usdcBalance(esc),
      txHash: ev.txHash,
      explorerUrl: ev.explorerUrl,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to raise dispute', details: msg }, 500);
  }
});

// ── POST /api/escrow/:id/refund ───────────────────────────────────────────────
escrowRouter.post('/:id/refund', async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    const esc = getEscrowOrFail(id);
    if (!esc) return c.json({ error: 'Escrow not found' }, 404);
    if (esc.state !== 'Disputed') return c.json({ error: `Cannot refund: escrow is ${esc.state} (must be Disputed)` }, 400);

    const refundAmount = usdcBalance(esc);
    if (refundAmount <= 0) return c.json({ error: 'Nothing to refund' }, 400);

    esc.depositedAmount = esc.releasedAmount; // balance -> 0
    esc.state = 'Refunded';
    esc.updatedAt = Date.now();

    const ev = emitEvent(id, 'RefundIssued', {
      client: esc.client,
      amount: refundAmount,
    });

    return c.json({
      success: true,
      message: `Refund issued — event: RefundIssued. ${refundAmount} USDC returned to client.`,
      escrowId: id,
      refundAmount,
      client: esc.client,
      state: esc.state,
      txHash: ev.txHash,
      explorerUrl: ev.explorerUrl,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to process refund', details: msg }, 500);
  }
});

// ── POST /api/escrow/from-contract ────────────────────────────────────────────
// Called by contracts.ts when a new contract is created.
// Automatically creates an escrow entry linked to the contract.
// Mirrors: EscrowRegistry.createEscrow(title, client, contractor, totalAmount)
escrowRouter.post('/from-contract', async (c) => {
  try {
    const body = await c.req.json();
    const {
      title,
      client,
      contractor,
      totalAmount,      // human-readable USDC (float)
      milestones,       // optional: [{description, amount}]
      contractId,
      txHash: contractTxHash,
    } = body;

    if (!title || !client || !contractor || !totalAmount || !contractId) {
      return c.json({ error: 'title, client, contractor, totalAmount and contractId are required' }, 400);
    }

    // Validate addresses
    if (!/^0x[0-9a-fA-F]{40}$/.test(client))
      return c.json({ error: 'Invalid client address' }, 400);
    if (!/^0x[0-9a-fA-F]{40}$/.test(contractor))
      return c.json({ error: 'Invalid contractor address' }, 400);
    if (client.toLowerCase() === contractor.toLowerCase())
      return c.json({ error: 'Client and contractor must be different' }, 400);

    const amount = parseFloat(totalAmount.toString());
    if (isNaN(amount) || amount <= 0)
      return c.json({ error: 'totalAmount must be > 0' }, 400);

    // Prevent duplicate: check if a linked escrow already exists for this contractId
    const existing = Array.from(escrowStore.values()).find(
      e => (e as EscrowWallet & { contractId?: number }).contractId === contractId
    );
    if (existing) {
      return c.json({
        success: true,
        alreadyExists: true,
        escrowId: existing.id,
        escrow: { ...existing, balance: usdcBalance(existing) },
        message: `Escrow #${existing.id} already linked to contract #${contractId}`,
      });
    }

    // Build milestone list from contract milestones or single milestone
    const milestoneList = milestones && Array.isArray(milestones) && milestones.length > 0
      ? milestones
      : [{ description: title, amount }];

    const escrow = createEscrowFromContract({
      title,
      client,
      contractor,
      totalAmount: amount,
      milestones: milestoneList,
      contractId,
      contractTxHash,
    });

    // Set source metadata
    (escrow as EscrowWallet & { source: string }).source = 'contract_creation';

    return c.json({
      success: true,
      message: `Escrow #${escrow.id} created from contract #${contractId} — event: EscrowCreated`,
      escrowId: escrow.id,
      contractId,
      escrowAddress: escrow.escrowAddress,
      txHash: escrow.txHash,
      blockNumber: escrow.blockNumber,
      explorerUrl: escrow.explorerUrl,
      escrow: { ...escrow, balance: usdcBalance(escrow), progress: 0 },
      // Mirrors on-chain EscrowCreated event
      event: {
        name: 'EscrowCreated',
        escrowId: escrow.id,
        title,
        client,
        contractor,
        amount,
        contractId,
        txHash: escrow.txHash,
        explorerUrl: escrow.explorerUrl,
        network: NETWORK_NAME,
        chainId: CHAIN_ID,
        registryAddress: REGISTRY_ADDRESS,
        timestamp: escrow.createdAt,
      },
    }, 201);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to create escrow from contract', details: msg }, 500);
  }
});

// ── GET /api/escrow/by-contract/:contractId ───────────────────────────────────
// Find escrow linked to a specific contract
escrowRouter.get('/by-contract/:contractId', (c) => {
  const contractId = parseInt(c.req.param('contractId'));
  const found = Array.from(escrowStore.values()).find(
    e => (e as EscrowWallet & { contractId?: number }).contractId === contractId
  );
  if (!found) {
    return c.json({ found: false, contractId, escrow: null });
  }
  const events = escrowEvents.filter(e => e.escrowId === found.id);
  return c.json({
    found: true,
    contractId,
    escrowId: found.id,
    escrow: {
      ...found,
      balance: usdcBalance(found),
      progress: found.totalAmount > 0
        ? parseFloat(((found.releasedAmount / found.totalAmount) * 100).toFixed(1))
        : 0,
    },
    events,
  });
});

export default escrowRouter;
