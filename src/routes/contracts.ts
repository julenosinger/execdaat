// ============================================================
// ARC Contracts Router — Thin on-chain proxy
// ContractFactory: 0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A
// Arc Testnet (chainId 5042002)
//
// ⚠️  Zero mock data. All reads proxied to Arc Testnet RPC.
//     All writes are done client-side (wallet).
//     This backend only exposes network/contract metadata
//     and serves as a read helper when ethers is not available.
// ============================================================

import { Hono } from 'hono';

const contractsRouter = new Hono();

// ─── Constants ────────────────────────────────────────────────────────────────
const FACTORY_ADDRESS = '0xbbC9d9d6Dd1eA066c922897e4952b4639BBbaF2A';
const USDC_ADDRESS    = '0x3600000000000000000000000000000000000000';
const EURC_ADDRESS    = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const NETWORK_NAME    = 'Arc Testnet';
const CHAIN_ID        = 5042002;
const EXPLORER_URL    = 'https://testnet.arcscan.app';
const RPC_URL         = 'https://rpc.testnet.arc.network';

// ContractFactory ABI selectors (for eth_call proxying)
const SEL = {
  contractCount:    '0x8736381a',  // contractCount()
  getContract:      '0x6ebc8c86',  // getContract(uint256)
  getMilestones:    '0x42c549c0',  // getMilestones(uint256)
  getByClient:      '0x8018b98c',  // getByClient(address)
  getByContractor:  '0x32db19d6',  // getByContractor(address)
  getByParticipant: '0x800379f0',  // getByParticipant(address)
};

// ─── RPC helper ───────────────────────────────────────────────────────────────
async function rpcCall(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json() as { result?: unknown; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.result;
}

async function ethCall(to: string, data: string): Promise<string> {
  return rpcCall('eth_call', [{ to, data }, 'latest']) as Promise<string>;
}

async function ethGetLogs(filter: object): Promise<unknown[]> {
  return rpcCall('eth_getLogs', [filter]) as Promise<unknown[]>;
}

// ─── ABI encode helpers ────────────────────────────────────────────────────────
function pad(hex: string, bytes = 32): string {
  return hex.replace(/^0x/, '').padStart(bytes * 2, '0');
}
function encAddr(addr: string): string { return pad(addr.replace(/^0x/, ''), 32); }
function encUint(n: number | bigint): string { return pad(BigInt(n).toString(16), 32); }

// ─── ABI decode helpers ────────────────────────────────────────────────────────
function decUint(hex: string, offset = 0): bigint {
  const s = hex.replace(/^0x/, '');
  return BigInt('0x' + s.slice(offset * 64, offset * 64 + 64));
}
function decAddr(hex: string, offset = 0): string {
  const s = hex.replace(/^0x/, '');
  return '0x' + s.slice(offset * 64 + 24, offset * 64 + 64);
}
function decString(hex: string, wordOffset: number): string {
  const s    = hex.replace(/^0x/, '');
  const ptr  = Number(BigInt('0x' + s.slice(wordOffset * 64, wordOffset * 64 + 64)));
  const off  = ptr * 2;
  const len  = Number(BigInt('0x' + s.slice(off, off + 64)));
  const raw  = s.slice(off + 64, off + 64 + len * 2);
  // hex → UTF-8
  let str = '';
  for (let i = 0; i < raw.length; i += 2) {
    str += String.fromCharCode(parseInt(raw.slice(i, i + 2), 16));
  }
  return decodeURIComponent(escape(str));
}

function decUintArray(hex: string): bigint[] {
  if (!hex || hex === '0x') return [];
  const s   = hex.replace(/^0x/, '');
  const len = Number(BigInt('0x' + s.slice(64, 128)));
  const arr: bigint[] = [];
  for (let i = 0; i < len; i++) {
    arr.push(BigInt('0x' + s.slice(128 + i * 64, 128 + (i + 1) * 64)));
  }
  return arr;
}

// Decode WorkContract struct
function decodeWorkContract(hex: string) {
  if (!hex || hex === '0x') return null;
  const s = hex.replace(/^0x/, '');
  try {
    const id                  = Number(BigInt('0x' + s.slice(0,   64)));
    const client              = '0x' + s.slice(64 + 24,  128);
    const contractor          = '0x' + s.slice(128 + 24, 192);
    const totalValue          = BigInt('0x' + s.slice(256, 320));
    const depositedValue      = BigInt('0x' + s.slice(320, 384));
    const statusCode          = Number(BigInt('0x' + s.slice(384, 448)));
    const contractorSigned    = BigInt('0x' + s.slice(448, 512)) !== 0n;
    const createdAt           = Number(BigInt('0x' + s.slice(512, 576)));
    const startedAt           = Number(BigInt('0x' + s.slice(576, 640)));
    const completedAt         = Number(BigInt('0x' + s.slice(640, 704)));
    const milestoneCount      = Number(BigInt('0x' + s.slice(704, 768)));
    const completedMilestones = Number(BigInt('0x' + s.slice(768, 832)));

    let title = '';
    try { title = decString(hex, 3); } catch { title = ''; }

    const statusLabels = ['Draft', 'Active', 'Completed', 'Cancelled'];

    return {
      id, client, contractor, title,
      totalValue:           Number(totalValue),
      depositedValue:       Number(depositedValue),
      totalValueFormatted:  `$${(Number(totalValue) / 1e6).toFixed(2)} USDC`,
      status:               statusLabels[statusCode] ?? 'Unknown',
      statusCode,
      contractorSigned,
      createdAt,  startedAt,  completedAt,
      milestoneCount, completedMilestones,
      progressPct: milestoneCount > 0 ? Math.round(completedMilestones / milestoneCount * 100) : 0,
    };
  } catch (e) {
    return null;
  }
}

// Decode Milestone[]
function decodeMilestones(hex: string) {
  if (!hex || hex === '0x') return [];
  const s = hex.replace(/^0x/, '');
  const milestones = [];
  try {
    const arrOffset = Number(BigInt('0x' + s.slice(0, 64)));
    const arrStart  = arrOffset * 2;
    const len       = Number(BigInt('0x' + s.slice(arrStart, arrStart + 64)));

    for (let i = 0; i < len; i++) {
      const elemPtrOffset = arrStart + 64 + i * 64;
      const elemOffset    = Number(BigInt('0x' + s.slice(elemPtrOffset, elemPtrOffset + 64)));
      const elemStart     = (arrOffset + elemOffset) * 2;

      const msId       = Number(BigInt('0x' + s.slice(elemStart, elemStart + 64)));
      const descRelOff = Number(BigInt('0x' + s.slice(elemStart + 64, elemStart + 128)));
      const amount     = BigInt('0x' + s.slice(elemStart + 128, elemStart + 192));
      const msStatus   = Number(BigInt('0x' + s.slice(elemStart + 192, elemStart + 256)));
      const releasedAt = Number(BigInt('0x' + s.slice(elemStart + 256, elemStart + 320)));

      let desc = '';
      try {
        const descAbsOff = (arrOffset + elemOffset + descRelOff) * 2;
        const descLen    = Number(BigInt('0x' + s.slice(descAbsOff, descAbsOff + 64)));
        const descHex    = s.slice(descAbsOff + 64, descAbsOff + 64 + descLen * 2);
        let raw = '';
        for (let j = 0; j < descHex.length; j += 2) raw += String.fromCharCode(parseInt(descHex.slice(j, j+2), 16));
        desc = decodeURIComponent(escape(raw));
      } catch { desc = ''; }

      milestones.push({
        id: msId,
        description: desc,
        amount: Number(amount),
        amountFormatted: `$${(Number(amount) / 1e6).toFixed(2)} USDC`,
        status: msStatus === 0 ? 'Pending' : 'Released',
        releasedAt,
      });
    }
  } catch { /* return what we have */ }
  return milestones;
}

// ─── GET /api/contracts/agent ─────────────────────────────────────────────────
// Compatibility endpoint for dashboard/agents tab
contractsRouter.get('/agent', async (c) => {
  // Try to get live count from chain
  let contractCount = 0;
  try {
    const hex = await ethCall(FACTORY_ADDRESS, SEL.contractCount) as string;
    contractCount = Number(BigInt(hex));
  } catch { /* ignore */ }

  return c.json({
    success: true,
    agent: {
      id:         'contract-factory-01',
      name:       'ContractFactory v1.0',
      status:     'active',
      lastAction: `${contractCount} contracts on-chain`,
    },
    stats: {
      totalContracts:     contractCount,
      activeContracts:    0,   // live data only via by-wallet endpoint
      completedContracts: 0,
      disputedContracts:  0,
      pendingTasks:       0,
    },
    factory: {
      address:   FACTORY_ADDRESS,
      usdc:      USDC_ADDRESS,
      network:   NETWORK_NAME,
      chainId:   CHAIN_ID,
      explorerUrl: EXPLORER_URL,
      arcScanUrl: `${EXPLORER_URL}/address/${FACTORY_ADDRESS}`,
    },
    note: 'All contract data is sourced directly from ContractFactory on Arc Testnet. No mock data.',
  });
});

// Returns static metadata about the ContractFactory
contractsRouter.get('/info', (c) => {
  return c.json({
    success: true,
    factory: {
      address:      FACTORY_ADDRESS,
      usdc:         USDC_ADDRESS,
      eurc:         EURC_ADDRESS,
      network:      NETWORK_NAME,
      chainId:      CHAIN_ID,
      explorerUrl:  EXPLORER_URL,
      arcScanUrl:   `${EXPLORER_URL}/address/${FACTORY_ADDRESS}`,
    },
  });
});

// ─── GET /api/contracts/count ─────────────────────────────────────────────────
contractsRouter.get('/count', async (c) => {
  try {
    const hex   = await ethCall(FACTORY_ADDRESS, SEL.contractCount) as string;
    const count = Number(BigInt(hex));
    return c.json({ success: true, count });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ─── GET /api/contracts/by-wallet/:address ────────────────────────────────────
// Returns all contract IDs for a wallet (as client + contractor), then fetches each
contractsRouter.get('/by-wallet/:address', async (c) => {
  const addr = c.req.param('address');
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    return c.json({ success: false, error: 'Invalid address' }, 400);
  }
  try {
    const addrEnc = encAddr(addr);
    const [hexC, hexCt] = await Promise.all([
      ethCall(FACTORY_ADDRESS, SEL.getByClient + addrEnc) as Promise<string>,
      ethCall(FACTORY_ADDRESS, SEL.getByContractor + addrEnc) as Promise<string>,
    ]);
    const asClient     = decUintArray(hexC);
    const asContractor = decUintArray(hexCt);
    const seen = new Set<string>();
    const ids: number[] = [...asClient, ...asContractor]
      .filter(id => { const k = id.toString(); if (seen.has(k)) return false; seen.add(k); return true; })
      .map(id => Number(id));

    // Fetch contract data for each id
    const contracts = (await Promise.all(ids.map(async id => {
      try {
        const hex = await ethCall(FACTORY_ADDRESS, SEL.getContract + encUint(id)) as string;
        const c2  = decodeWorkContract(hex);
        if (!c2) return null;
        const msHex = await ethCall(FACTORY_ADDRESS, SEL.getMilestones + encUint(id)) as string;
        const ms    = decodeMilestones(msHex);
        return { ...c2, milestones: ms };
      } catch { return null; }
    }))).filter(Boolean);

    return c.json({
      success: true,
      address: addr,
      total:   contracts.length,
      contracts,
      network: { name: NETWORK_NAME, chainId: CHAIN_ID },
      factory: FACTORY_ADDRESS,
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ─── GET /api/contracts/:id ───────────────────────────────────────────────────
contractsRouter.get('/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  if (isNaN(id) || id < 1) return c.json({ success: false, error: 'Invalid contract id' }, 400);

  try {
    const hex = await ethCall(FACTORY_ADDRESS, SEL.getContract + encUint(id)) as string;
    const contract = decodeWorkContract(hex);
    if (!contract || contract.id === 0) {
      return c.json({ success: false, error: 'Contract not found' }, 404);
    }
    const msHex    = await ethCall(FACTORY_ADDRESS, SEL.getMilestones + encUint(id)) as string;
    const milestones = decodeMilestones(msHex);

    return c.json({
      success: true,
      contract: { ...contract, milestones },
      factory:  FACTORY_ADDRESS,
      network:  { name: NETWORK_NAME, chainId: CHAIN_ID, explorerUrl: EXPLORER_URL },
      arcScan:  `${EXPLORER_URL}/address/${FACTORY_ADDRESS}`,
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// ─── GET /api/contracts ───────────────────────────────────────────────────────
// Returns all contracts (up to first 50) — use by-wallet for filtered view
contractsRouter.get('/', async (c) => {
  try {
    const hex   = await ethCall(FACTORY_ADDRESS, SEL.contractCount) as string;
    const total = Number(BigInt(hex));
    const limit = Math.min(total, 50);

    const contracts = (await Promise.all(
      Array.from({ length: limit }, (_, i) => i + 1).map(async id => {
        try {
          const cHex = await ethCall(FACTORY_ADDRESS, SEL.getContract + encUint(id)) as string;
          const ct   = decodeWorkContract(cHex);
          if (!ct) return null;
          const mHex = await ethCall(FACTORY_ADDRESS, SEL.getMilestones + encUint(id)) as string;
          return { ...ct, milestones: decodeMilestones(mHex) };
        } catch { return null; }
      })
    )).filter(Boolean);

    return c.json({
      success:        true,
      total,
      returned:       contracts.length,
      contracts,
      factory:        FACTORY_ADDRESS,
      network:        { name: NETWORK_NAME, chainId: CHAIN_ID, explorerUrl: EXPLORER_URL },
    });
  } catch (err) {
    return c.json({ success: false, error: String(err) }, 500);
  }
});

export default contractsRouter;
