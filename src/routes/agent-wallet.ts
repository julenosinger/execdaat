// ============================================================
//  ARC ERC-8004 Agent Wallet — Backend API
//  Arc Testnet · ChainId 5042002
//
//  Features:
//   • Agent identity registration (ERC-8004 metadata)
//   • Permission management (limits, scopes, durations)
//   • Treasury tracking and allocations
//   • Reputation scoring
//   • Session management
//   • Audit logging
//   • Capability registration
//   • Registry integration
//   • Vault allocation
//   • Scheduler integration hooks
//
//  SECURITY: DO NOT replace user wallet. Agent wallet is a
//  secondary execution layer. All operations require explicit
//  user permissions.
// ============================================================

import { Hono } from 'hono'
import { ethers } from 'ethers'

const agentWalletRouter = new Hono()

const ARC_RPC       = 'https://rpc.testnet.arc.network'
const ARC_RPC_ALT   = 'https://rpc.blockdaemon.testnet.arc.network'
const CHAIN_ID      = 5042002
const EXPLORER      = 'https://testnet.arcscan.app'
const USDC_ADDRESS  = '0x3600000000000000000000000000000000000000'
const EURC_ADDRESS  = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a'

// ─── ABI selectors ────────────────────────────────────────────
const SEL = {
  balanceOf:    '0x70a08231',
  transfer:     '0xa9059cbb',
  totalSupply:  '0x18160ddd',
}

// ─── In-memory stores ─────────────────────────────────────────
interface AgentRecord {
  id: string
  owner: string
  agentWalletAddress: string
  name: string
  description: string
  agentType: string
  version: string
  capabilities: string[]
  erc8004Status: 'registered' | 'pending' | 'not_registered'
  metadataURI: string
  createdAt: string
  updatedAt: string
}

interface AgentPermission {
  id: string
  agentId: string
  owner: string
  capability: string
  dailyLimit: string
  perTxLimit: string
  monthlyLimit: string
  durationDays: number
  allowedTokens: string[]
  allowedOperations: string[]
  grantedAt: string
  expiresAt: string
  active: boolean
  revokedAt: string | null
}

interface AgentTreasuryAllocation {
  id: string
  agentId: string
  allocationType: 'operational' | 'treasury' | 'gas_reserve' | 'automation' | 'locked_funds'
  token: string
  allocated: string
  used: string
  updatedAt: string
}

interface AgentSession {
  id: string
  agentId: string
  owner: string
  authorizedAt: string
  expiresAt: string
  active: boolean
  revokedAt: string | null
  permissions: string[]
}

interface AgentAuditEntry {
  id: string
  agentId: string
  action: string
  status: 'success' | 'failed' | 'pending'
  txHash: string | null
  amount: string | null
  token: string | null
  from: string | null
  to: string | null
  network: string
  timestamp: string
  details: string | null
}

interface AgentReputation {
  agentId: string
  totalTransactions: number
  successfulExecutions: number
  failedExecutions: number
  autonomousActions: number
  treasuryManaged: string
  swapOperations: number
  bridgeOperations: number
  paymentOperations: number
  schedulerExecutions: number
  successRate: number
  riskScore: number
  reputationScore: number
  updatedAt: string
}

const agents      = new Map<string, AgentRecord>()
const permissions = new Map<string, AgentPermission[]>()
const allocations = new Map<string, AgentTreasuryAllocation[]>()
const sessions    = new Map<string, AgentSession[]>()
const auditLogs   = new Map<string, AgentAuditEntry[]>()
const reputations = new Map<string, AgentReputation>()

function generateId(): string {
  return 'aw-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

function isValidAddr(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s)
}

function encAddr(addr: string): string {
  return addr.replace('0x', '').toLowerCase().padStart(64, '0')
}

function decUint(hex: string): bigint {
  if (!hex || hex === '0x') return 0n
  return BigInt(hex.startsWith('0x') ? hex : '0x' + hex)
}

// ─── RPC helpers ──────────────────────────────────────────────
async function rpcCall(method: string, params: any[]): Promise<any> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
  let res: Response
  try {
    res = await fetch(ARC_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
  } catch {
    res = await fetch(ARC_RPC_ALT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
  }
  const json = await res.json() as any
  if (json.error) throw new Error(`RPC error: ${json.error.message}`)
  return json.result
}

async function getTokenBalance(tokenAddr: string, wallet: string): Promise<bigint> {
  const data = SEL.balanceOf + encAddr(wallet)
  const res  = await rpcCall('eth_call', [{ to: tokenAddr, data }, 'latest'])
  return decUint(res)
}

function fmtAmount(raw: bigint, decimals: number = 6): string {
  const str = raw.toString()
  if (str.length <= decimals) {
    return '0.' + str.padStart(decimals, '0')
  }
  const intPart = str.slice(0, str.length - decimals)
  const fracPart = str.slice(str.length - decimals)
  return intPart + '.' + fracPart
}

function addAuditLog(agentId: string, entry: Omit<AgentAuditEntry, 'id' | 'agentId' | 'timestamp'>): AgentAuditEntry {
  const log: AgentAuditEntry = {
    id: generateId(),
    agentId,
    timestamp: new Date().toISOString(),
    ...entry,
  }
  const logs = auditLogs.get(agentId) || []
  logs.unshift(log)
  if (logs.length > 1000) logs.length = 1000
  auditLogs.set(agentId, logs)
  return log
}

function calculateReputation(agentId: string): AgentReputation {
  const logs = auditLogs.get(agentId) || []
  const total = logs.length
  const success = logs.filter(l => l.status === 'success').length
  const failed = logs.filter(l => l.status === 'failed').length
  const autonomous = logs.filter(l => l.action.startsWith('autonomous_')).length
  const swapOps = logs.filter(l => l.action.includes('swap')).length
  const bridgeOps = logs.filter(l => l.action.includes('bridge')).length
  const paymentOps = logs.filter(l => l.action.includes('payment')).length
  const schedulerOps = logs.filter(l => l.action.includes('schedule')).length

  const successRate = total > 0 ? Math.round((success / total) * 100) : 100
  // Risk score: higher failed ratio = higher risk
  const riskScore = total > 0 ? Math.min(100, Math.round((failed / Math.max(total, 1)) * 100)) + (autonomous * 2) : 0
  // Reputation: success rate minus risk penalty
  const repScore = Math.max(0, Math.min(100, successRate - Math.floor(riskScore / 3)))

  const totalManaged = logs.reduce((sum, l) => {
    if (l.amount && l.token === 'USDC') return sum + parseFloat(l.amount)
    return sum
  }, 0)

  const rep: AgentReputation = {
    agentId,
    totalTransactions: total,
    successfulExecutions: success,
    failedExecutions: failed,
    autonomousActions: autonomous,
    treasuryManaged: totalManaged.toFixed(2),
    swapOperations: swapOps,
    bridgeOperations: bridgeOps,
    paymentOperations: paymentOps,
    schedulerExecutions: schedulerOps,
    successRate,
    riskScore: Math.max(0, Math.min(100, riskScore)),
    reputationScore: repScore,
    updatedAt: new Date().toISOString(),
  }
  reputations.set(agentId, rep)
  return rep
}

// ═══════════════════════════════════════════════════════════════
//  AGENT REGISTRATION
// ═══════════════════════════════════════════════════════════════

agentWalletRouter.post('/register', async (c) => {
  try {
    const body = await c.req.json()
    const { owner, agentWalletAddress, name, description, agentType, capabilities } = body

    if (!owner || !isValidAddr(owner)) return c.json({ success: false, error: 'Valid owner address required' }, 400)
    if (!agentWalletAddress || !isValidAddr(agentWalletAddress)) return c.json({ success: false, error: 'Valid agent wallet address required' }, 400)
    if (!name || typeof name !== 'string') return c.json({ success: false, error: 'Agent name required' }, 400)

    const id = generateId()
    const agent: AgentRecord = {
      id,
      owner: owner.toLowerCase(),
      agentWalletAddress: agentWalletAddress.toLowerCase(),
      name,
      description: description || '',
      agentType: agentType || 'financial',
      version: '1.0.0',
      capabilities: Array.isArray(capabilities) ? capabilities : [],
      erc8004Status: 'pending',
      metadataURI: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    agents.set(id, agent)

    // Initialize empty reputation
    reputations.set(id, {
      agentId: id,
      totalTransactions: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      autonomousActions: 0,
      treasuryManaged: '0.00',
      swapOperations: 0,
      bridgeOperations: 0,
      paymentOperations: 0,
      schedulerExecutions: 0,
      successRate: 100,
      riskScore: 0,
      reputationScore: 100,
      updatedAt: new Date().toISOString(),
    })

    addAuditLog(id, {
      action: 'agent_registered',
      status: 'success',
      txHash: null,
      amount: null,
      token: null,
      from: owner,
      to: agentWalletAddress,
      network: 'arc-testnet',
      details: JSON.stringify({ name, agentType }),
    })

    return c.json({ success: true, agent }, 201)
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

agentWalletRouter.get('/agent/:id', (c) => {
  const id = c.req.param('id')
  const agent = agents.get(id)
  if (!agent) return c.json({ success: false, error: 'Agent not found' }, 404)
  const rep = reputations.get(id)
  return c.json({ success: true, agent, reputation: rep || null })
})

agentWalletRouter.get('/agents/:owner', (c) => {
  const owner = c.req.param('owner').toLowerCase()
  const list: AgentRecord[] = []
  agents.forEach(a => { if (a.owner === owner) list.push(a) })
  return c.json({ success: true, agents: list })
})

agentWalletRouter.put('/agent/:id/status', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json()
    const agent = agents.get(id)
    if (!agent) return c.json({ success: false, error: 'Agent not found' }, 404)
    if (body.erc8004Status && ['registered', 'pending', 'not_registered'].includes(body.erc8004Status)) {
      agent.erc8004Status = body.erc8004Status
    }
    if (body.metadataURI) agent.metadataURI = body.metadataURI
    agent.updatedAt = new Date().toISOString()
    agents.set(id, agent)
    return c.json({ success: true, agent })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

// ═══════════════════════════════════════════════════════════════
//  PERMISSIONS
// ═══════════════════════════════════════════════════════════════

agentWalletRouter.post('/permissions', async (c) => {
  try {
    const body = await c.req.json()
    const { agentId, owner, capability, dailyLimit, perTxLimit, monthlyLimit, durationDays, allowedTokens, allowedOperations } = body

    if (!agentId) return c.json({ success: false, error: 'agentId required' }, 400)
    const agent = agents.get(agentId)
    if (!agent) return c.json({ success: false, error: 'Agent not found' }, 404)

    const permittedCaps = ['payments', 'treasury', 'swap', 'bridge', 'scheduler', 'contracts', 'vault', 'multisend']
    if (capability && !permittedCaps.includes(capability)) return c.json({ success: false, error: 'Invalid capability' }, 400)

    const permission: AgentPermission = {
      id: generateId(),
      agentId,
      owner: (owner || agent.owner).toLowerCase(),
      capability: capability || 'payments',
      dailyLimit: dailyLimit || '500',
      perTxLimit: perTxLimit || '50',
      monthlyLimit: monthlyLimit || '5000',
      durationDays: durationDays || 30,
      allowedTokens: Array.isArray(allowedTokens) ? allowedTokens : ['USDC'],
      allowedOperations: Array.isArray(allowedOperations) ? allowedOperations : ['transfer'],
      grantedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + (durationDays || 30) * 86400000).toISOString(),
      active: true,
      revokedAt: null,
    }

    const perms = permissions.get(agentId) || []
    perms.push(permission)
    permissions.set(agentId, perms)

    addAuditLog(agentId, {
      action: 'permission_granted',
      status: 'success',
      txHash: null,
      amount: null,
      token: null,
      from: permission.owner,
      to: agent.agentWalletAddress,
      network: 'arc-testnet',
      details: JSON.stringify({ capability, dailyLimit, perTxLimit, durationDays }),
    })

    return c.json({ success: true, permission }, 201)
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

agentWalletRouter.get('/permissions/:agentId', (c) => {
  const agentId = c.req.param('agentId')
  const perms = permissions.get(agentId) || []
  const active = perms.filter(p => p.active && new Date(p.expiresAt) > new Date())
  return c.json({ success: true, permissions: perms, activePermissions: active })
})

agentWalletRouter.put('/permissions/:permissionId/revoke', (c) => {
  const permissionId = c.req.param('permissionId')
  let found = false
  permissions.forEach((perms, agentId) => {
    const idx = perms.findIndex(p => p.id === permissionId)
    if (idx >= 0) {
      perms[idx].active = false
      perms[idx].revokedAt = new Date().toISOString()
      permissions.set(agentId, perms)
      found = true

      const agent = agents.get(agentId)
      addAuditLog(agentId, {
        action: 'permission_revoked',
        status: 'success',
        txHash: null,
        amount: null,
        token: null,
        from: perms[idx].owner,
        to: agent?.agentWalletAddress || '',
        network: 'arc-testnet',
        details: JSON.stringify({ capability: perms[idx].capability, reason: 'user_revoked' }),
      })
    }
  })
  if (!found) return c.json({ success: false, error: 'Permission not found' }, 404)
  return c.json({ success: true, message: 'Permission revoked' })
})

// ═══════════════════════════════════════════════════════════════
//  TREASURY
// ═══════════════════════════════════════════════════════════════

agentWalletRouter.get('/treasury/:agentId', async (c) => {
  const agentId = c.req.param('agentId')
  const agent = agents.get(agentId)
  if (!agent) return c.json({ success: false, error: 'Agent not found' }, 404)

  try {
    const [usdcRaw, eurcRaw] = await Promise.all([
      getTokenBalance(USDC_ADDRESS, agent.agentWalletAddress).catch(() => 0n),
      getTokenBalance(EURC_ADDRESS, agent.agentWalletAddress).catch(() => 0n),
    ])
    const allocs = allocations.get(agentId) || []
    const totalUSDC = parseFloat(fmtAmount(usdcRaw))

    return c.json({
      success: true,
      treasury: {
        balances: {
          USDC: { raw: usdcRaw.toString(), human: fmtAmount(usdcRaw) },
          EURC: { raw: eurcRaw.toString(), human: fmtAmount(eurcRaw, 6) },
        },
        totalUSD: totalUSDC.toFixed(2),
        allocations: allocs,
        explorerUrl: `${EXPLORER}/address/${agent.agentWalletAddress}`,
      },
    })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

agentWalletRouter.post('/treasury/allocate', async (c) => {
  try {
    const body = await c.req.json()
    const { agentId, allocationType, token, amount } = body

    if (!agentId) return c.json({ success: false, error: 'agentId required' }, 400)
    const agent = agents.get(agentId)
    if (!agent) return c.json({ success: false, error: 'Agent not found' }, 404)

    const validTypes = ['operational', 'treasury', 'gas_reserve', 'automation', 'locked_funds']
    if (!allocationType || !validTypes.includes(allocationType)) return c.json({ success: false, error: 'Invalid allocation type' }, 400)

    const allocation: AgentTreasuryAllocation = {
      id: generateId(),
      agentId,
      allocationType,
      token: token || 'USDC',
      allocated: amount || '0',
      used: '0',
      updatedAt: new Date().toISOString(),
    }

    const allocs = allocations.get(agentId) || []
    const existingIdx = allocs.findIndex(a => a.allocationType === allocationType && a.token === (token || 'USDC'))
    if (existingIdx >= 0) allocs[existingIdx] = allocation
    else allocs.push(allocation)
    allocations.set(agentId, allocs)

    addAuditLog(agentId, {
      action: 'treasury_allocation',
      status: 'success',
      txHash: null,
      amount,
      token: token || 'USDC',
      from: agent.owner,
      to: agent.agentWalletAddress,
      network: 'arc-testnet',
      details: JSON.stringify({ allocationType }),
    })

    return c.json({ success: true, allocation }, 201)
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

// ═══════════════════════════════════════════════════════════════
//  SESSIONS
// ═══════════════════════════════════════════════════════════════

agentWalletRouter.post('/sessions', async (c) => {
  try {
    const body = await c.req.json()
    const { agentId, owner, durationHours } = body

    if (!agentId) return c.json({ success: false, error: 'agentId required' }, 400)
    const agent = agents.get(agentId)
    if (!agent) return c.json({ success: false, error: 'Agent not found' }, 404)

    const session: AgentSession = {
      id: generateId(),
      agentId,
      owner: (owner || agent.owner).toLowerCase(),
      authorizedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + (durationHours || 24) * 3600000).toISOString(),
      active: true,
      revokedAt: null,
      permissions: ['read', 'execute'],
    }
    const sess = sessions.get(agentId) || []
    sess.push(session)
    sessions.set(agentId, sess)

    addAuditLog(agentId, {
      action: 'session_created',
      status: 'success',
      txHash: null,
      amount: null,
      token: null,
      from: session.owner,
      to: agent.agentWalletAddress,
      network: 'arc-testnet',
      details: JSON.stringify({ durationHours }),
    })

    return c.json({ success: true, session }, 201)
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

agentWalletRouter.get('/sessions/:agentId', (c) => {
  const agentId = c.req.param('agentId')
  const sess = sessions.get(agentId) || []
  // Auto-expire old sessions
  const now = new Date()
  const active = sess.filter(s => s.active && new Date(s.expiresAt) > now)
  return c.json({ success: true, sessions: sess, activeSessions: active })
})

agentWalletRouter.put('/sessions/:sessionId/revoke', (c) => {
  const sessionId = c.req.param('sessionId')
  let found = false
  sessions.forEach((sess, agentId) => {
    const idx = sess.findIndex(s => s.id === sessionId)
    if (idx >= 0) {
      sess[idx].active = false
      sess[idx].revokedAt = new Date().toISOString()
      sessions.set(agentId, sess)
      found = true

      const agent = agents.get(agentId)
      addAuditLog(agentId, {
        action: 'session_revoked',
        status: 'success',
        txHash: null,
        amount: null,
        token: null,
        from: sess[idx].owner,
        to: agent?.agentWalletAddress || '',
        network: 'arc-testnet',
        details: null,
      })
    }
  })
  if (!found) return c.json({ success: false, error: 'Session not found' }, 404)
  return c.json({ success: true, message: 'Session revoked' })
})

// ═══════════════════════════════════════════════════════════════
//  AUDIT
// ═══════════════════════════════════════════════════════════════

agentWalletRouter.get('/audit/:agentId', (c) => {
  const agentId = c.req.param('agentId')
  const limit = parseInt(c.req.query('limit') || '50')
  const logs = auditLogs.get(agentId) || []
  return c.json({ success: true, logs: logs.slice(0, limit), total: logs.length })
})

agentWalletRouter.post('/audit/log', async (c) => {
  try {
    const body = await c.req.json()
    const { agentId, action, status, txHash, amount, token, from, to, network, details } = body

    if (!agentId || !action) return c.json({ success: false, error: 'agentId and action required' }, 400)

    const entry = addAuditLog(agentId, {
      action,
      status: (status as any) || 'success',
      txHash: txHash || null,
      amount: amount || null,
      token: token || null,
      from: from || null,
      to: to || null,
      network: network || 'arc-testnet',
      details: details || null,
    })

    calculateReputation(agentId)

    return c.json({ success: true, entry }, 201)
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

// ═══════════════════════════════════════════════════════════════
//  REPUTATION
// ═══════════════════════════════════════════════════════════════

agentWalletRouter.get('/reputation/:agentId', (c) => {
  const agentId = c.req.param('agentId')
  let rep = reputations.get(agentId)
  if (!rep) rep = calculateReputation(agentId)
  return c.json({ success: true, reputation: rep })
})

// ═══════════════════════════════════════════════════════════════
//  CAPABILITIES
// ═══════════════════════════════════════════════════════════════

agentWalletRouter.get('/capabilities', (c) => {
  return c.json({
    success: true,
    capabilities: [
      { id: 'treasury',   name: 'Treasury',    icon: 'fa-vault',          description: 'Manage treasury funds and allocations' },
      { id: 'payments',   name: 'Payments',    icon: 'fa-paper-plane',    description: 'Send USDC/EURC payments' },
      { id: 'swap',       name: 'Swap',        icon: 'fa-exchange-alt',   description: 'Swap tokens via AMM' },
      { id: 'bridge',     name: 'Bridge',      icon: 'fa-bridge',         description: 'Cross-chain bridging via CCTP' },
      { id: 'scheduler',  name: 'Scheduler',   icon: 'fa-clock',          description: 'Schedule recurring transactions' },
      { id: 'contracts',  name: 'Contracts',   icon: 'fa-file-contract',  description: 'Deploy and interact with contracts' },
      { id: 'vault',      name: 'Vault',       icon: 'fa-lock',           description: 'Vault deposit and withdrawal' },
      { id: 'multisend',  name: 'Multisend',   icon: 'fa-layer-group',    description: 'Batch payments to multiple addresses' },
    ],
  })
})

// ═══════════════════════════════════════════════════════════════
//  SCHEDULER HOOKS
// ═══════════════════════════════════════════════════════════════

interface AgentSchedule {
  id: string
  agentId: string
  name: string
  action: string
  params: Record<string, string>
  cronExpression: string
  nextExecution: string
  active: boolean
  createdAt: string
}

const schedules = new Map<string, AgentSchedule[]>()

agentWalletRouter.post('/schedules', async (c) => {
  try {
    const body = await c.req.json()
    const { agentId, name, action, params, cronExpression } = body

    if (!agentId || !name || !action) return c.json({ success: false, error: 'agentId, name, action required' }, 400)

    const schedule: AgentSchedule = {
      id: generateId(),
      agentId,
      name,
      action,
      params: params || {},
      cronExpression: cronExpression || '0 0 * * *',
      nextExecution: new Date(Date.now() + 86400000).toISOString(),
      active: true,
      createdAt: new Date().toISOString(),
    }

    const schedulesForAgent = schedules.get(agentId) || []
    schedulesForAgent.push(schedule)
    schedules.set(agentId, schedulesForAgent)

    addAuditLog(agentId, {
      action: 'schedule_created',
      status: 'success',
      txHash: null,
      amount: params?.amount || null,
      token: params?.token || null,
      from: null,
      to: null,
      network: 'arc-testnet',
      details: JSON.stringify({ name, action, cronExpression }),
    })

    return c.json({ success: true, schedule }, 201)
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

agentWalletRouter.get('/schedules/:agentId', (c) => {
  const agentId = c.req.param('agentId')
  const list = schedules.get(agentId) || []
  // Calculate next execution for each schedule
  const now = new Date()
  const updated = list.map(s => ({ ...s, isDue: new Date(s.nextExecution) <= now, isExpired: !s.active }))
  return c.json({ success: true, schedules: updated })
})

agentWalletRouter.put('/schedules/:scheduleId/toggle', (c) => {
  const scheduleId = c.req.param('scheduleId')
  let found = false
  schedules.forEach((list, agentId) => {
    const idx = list.findIndex(s => s.id === scheduleId)
    if (idx >= 0) {
      list[idx].active = !list[idx].active
      schedules.set(agentId, list)
      found = true
      addAuditLog(agentId, {
        action: list[idx].active ? 'schedule_activated' : 'schedule_paused',
        status: 'success',
        txHash: null, amount: null, token: null, from: null, to: null, network: 'arc-testnet',
        details: JSON.stringify({ scheduleId: scheduleId, name: list[idx].name }),
      })
    }
  })
  if (!found) return c.json({ success: false, error: 'Schedule not found' }, 404)
  return c.json({ success: true, message: 'Schedule toggled' })
})

agentWalletRouter.delete('/schedules/:scheduleId', (c) => {
  const scheduleId = c.req.param('scheduleId')
  let found = false
  schedules.forEach((list, agentId) => {
    const idx = list.findIndex(s => s.id === scheduleId)
    if (idx >= 0) {
      const [removed] = list.splice(idx, 1)
      schedules.set(agentId, list)
      found = true
      addAuditLog(agentId, {
        action: 'schedule_deleted',
        status: 'success',
        txHash: null, amount: null, token: null, from: null, to: null, network: 'arc-testnet',
        details: JSON.stringify({ name: removed.name }),
      })
    }
  })
  if (!found) return c.json({ success: false, error: 'Schedule not found' }, 404)
  return c.json({ success: true, message: 'Schedule deleted' })
})

// ═══════════════════════════════════════════════════════════════
//  VAULT ALLOCATION
// ═══════════════════════════════════════════════════════════════

agentWalletRouter.get('/vault/:agentId', (c) => {
  const agentId = c.req.param('agentId')
  const agent = agents.get(agentId)
  if (!agent) return c.json({ success: false, error: 'Agent not found' }, 404)
  const allocs = allocations.get(agentId) || []
  return c.json({ success: true, agentId, agentWallet: agent.agentWalletAddress, allocations: allocs })
})

agentWalletRouter.post('/vault/allocate', async (c) => {
  try {
    const body = await c.req.json()
    const { agentId, token, usdAmount } = body

    if (!agentId || !usdAmount) return c.json({ success: false, error: 'agentId and usdAmount required' }, 400)
    const agent = agents.get(agentId)
    if (!agent) return c.json({ success: false, error: 'Agent not found' }, 404)

    const allocation: AgentTreasuryAllocation = {
      id: generateId(),
      agentId,
      allocationType: 'vault',
      token: token || 'USDC',
      allocated: String(usdAmount),
      used: '0',
      updatedAt: new Date().toISOString(),
    }

    const allocs = allocations.get(agentId) || []
    allocs.push(allocation)
    allocations.set(agentId, allocs)

    addAuditLog(agentId, {
      action: 'vault_allocation',
      status: 'success',
      txHash: null,
      amount: String(usdAmount),
      token: token || 'USDC',
      from: agent.owner,
      to: agent.agentWalletAddress,
      network: 'arc-testnet',
      details: JSON.stringify({ type: 'agent_treasury_allocation' }),
    })

    return c.json({ success: true, allocation }, 201)
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

// ═══════════════════════════════════════════════════════════════
//  EXECUTION (validation hook)
// ═══════════════════════════════════════════════════════════════

agentWalletRouter.post('/execute/validate', async (c) => {
  try {
    const body = await c.req.json()
    const { agentId, action, amount, token, operation } = body

    if (!agentId || !action) return c.json({ success: false, error: 'agentId and action required' }, 400)

    const agent = agents.get(agentId)
    if (!agent) return c.json({ success: false, error: 'Agent not found' }, 404)

    const agentPerms = permissions.get(agentId) || []
    const now = new Date()

    // Check if agent has permission for this capability
    const capabilityMap: Record<string, string> = {
      transfer: 'payments',
      payment: 'payments',
      swap: 'swap',
      bridge: 'bridge',
      schedule: 'scheduler',
      contract: 'contracts',
      vault: 'vault',
      multisend: 'multisend',
    }

    const neededCap = capabilityMap[action] || capabilityMap[operation] || action
    const activePerm = agentPerms.find(p =>
      p.active &&
      p.capability === neededCap &&
      new Date(p.expiresAt) > now
    )

    if (!activePerm) {
      return c.json({
        success: false,
        valid: false,
        reason: `No active permission for ${neededCap}. Grant permission first.`,
      })
    }

    // Check amount against limits
    if (amount && parseFloat(amount) > parseFloat(activePerm.perTxLimit)) {
      return c.json({
        success: false,
        valid: false,
        reason: `Amount ${amount} exceeds per-tx limit of ${activePerm.perTxLimit}`,
      })
    }

    // Check token whitelist
    if (token && !activePerm.allowedTokens.includes(token.toUpperCase())) {
      return c.json({
        success: false,
        valid: false,
        reason: `Token ${token} not in allowed list: ${activePerm.allowedTokens.join(', ')}`,
      })
    }

    return c.json({ success: true, valid: true, permission: activePerm.id })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

// ═══════════════════════════════════════════════════════════════
//  METADATA PERSISTENCE — Pinata IPFS
//  Pins agent metadata to IPFS via Pinata API for durable storage.
//  Set PINATA_JWT env var on Cloudflare Dashboard.
//  Falls back to in-memory storage with stable URL if not configured.
// ═══════════════════════════════════════════════════════════════

interface StoredMetadata {
  id: string
  ipfsHash: string
  ipfsUri: string
  data: Record<string, any>
  createdAt: string
}

const metadataStore = new Map<string, StoredMetadata>()

async function pinToIPFS(json: Record<string, any>): Promise<{ success: boolean; ipfsHash?: string; ipfsUri?: string; error?: string }> {
  const jwt = (c as any)?.env?.PINATA_JWT || process?.env?.PINATA_JWT
  if (!jwt) return { success: false, error: 'PINATA_JWT not configured' }

  try {
    const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        pinataContent: json,
        pinataMetadata: { name: `execdaat-agent-${Date.now()}` },
      }),
    })
    if (!res.ok) throw new Error(`Pinata API error: ${res.status}`)
    const data = await res.json() as any
    const hash = data.IpfsHash
    return { success: true, ipfsHash: hash, ipfsUri: `ipfs://${hash}` }
  } catch (e: any) {
    return { success: false, error: e.message }
  }
}

const METADATA_FALLBACK_HOST = 'https://execdaatapp-v2.pages.dev'

agentWalletRouter.post('/metadata/pin', async (c) => {
  try {
    const body = await c.req.json()
    if (!body || typeof body !== 'object') {
      return c.json({ success: false, error: 'Invalid metadata' }, 400)
    }

    // Try Pinata first
    const pinResult = await pinToIPFS(body)
    if (pinResult.success) {
      metadataStore.set(pinResult.ipfsHash!, {
        id: pinResult.ipfsHash!,
        ipfsHash: pinResult.ipfsHash!,
        ipfsUri: pinResult.ipfsUri!,
        data: body,
        createdAt: new Date().toISOString(),
      })
      return c.json({ success: true, ipfsHash: pinResult.ipfsHash, ipfsUri: pinResult.ipfsUri, persisted: 'ipfs' })
    }

    // Fallback: store in memory with stable URL
    const id = 'meta-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
    const uri = `${METADATA_FALLBACK_HOST}/api/agent-wallet/metadata/${id}`
    metadataStore.set(id, { id, ipfsHash: '', ipfsUri: uri, data: body, createdAt: new Date().toISOString() })
    return c.json({ success: true, id, ipfsUri: uri, persisted: 'backend', warning: 'Set PINATA_JWT for durable IPFS storage' })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

agentWalletRouter.post('/metadata/upload', async (c) => {
  // Legacy alias — delegates to /metadata/pin
  return agentWalletRouter.fetch(c.req.raw)
})

agentWalletRouter.get('/metadata/:id', (c) => {
  const id = c.req.param('id')
  const meta = metadataStore.get(id)
  if (!meta) return c.json({ success: false, error: 'Metadata not found' }, 404)
  return c.json(meta.data, 200, {
    'Cache-Control': 'public, max-age=86400',
    'Access-Control-Allow-Origin': '*',
  })
})

// ═══════════════════════════════════════════════════════════════
//  RELAYER WALLET — Server-side signing for reputation & validation
//  Set RELAYER_PRIVATE_KEY env var on Cloudflare Dashboard.
//  Funds the wallet with ~1 USDC for gas (each tx ~$0.006).
// ═══════════════════════════════════════════════════════════════

const REPUTATION_REGISTRY = '0x8004B663056A597Dffe9eCcC1965A193B7388713'
const VALIDATION_REGISTRY = '0x8004Cb1BF31DAf7788923b405b754f57acEB4272'

// Minimal ABI fragments for backend contract calls
const REPUTATION_IFACE = new ethers.Interface([
  'function giveFeedback(uint256 agentId, int128 score, uint8 confidence, string tag, string metadataURI, string proofURI, string context, bytes32 feedbackHash) external',
  'function getFeedback(uint256 agentId, address validatorAddress) external view returns (int128 score, uint8 confidence, string tag, uint256 timestamp)',
])
const VALIDATION_IFACE = new ethers.Interface([
  'function validationResponse(bytes32 requestHash, uint8 response, string metadataURI, bytes32 proofHash, string tag) external',
  'function getValidationStatus(bytes32 requestHash) external view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate)',
])

function getRelayerWallet(): ethers.Wallet | null {
  const pk = (c as any)?.env?.RELAYER_PRIVATE_KEY || process?.env?.RELAYER_PRIVATE_KEY || ''
  if (!pk || pk.length < 64) return null
  try {
    return new ethers.Wallet(pk, new ethers.JsonRpcProvider(ARC_RPC, CHAIN_ID))
  } catch { return null }
}

async function submitRelayerTx(tx: ethers.TransactionRequest): Promise<{ success: boolean; txHash?: string; blockNumber?: number; error?: string }> {
  const wallet = getRelayerWallet()
  if (!wallet) return { success: false, error: 'RELAYER_PRIVATE_KEY not configured' }
  try {
    const response = await wallet.sendTransaction(tx)
    const receipt = await response.wait()
    return { success: true, txHash: receipt!.hash, blockNumber: receipt!.blockNumber }
  } catch (e: any) {
    return { success: false, error: e.message }
  }
}

// ═══════════════════════════════════════════════════════════════
//  REPUTATION RECORDING (backend relayer)
// ═══════════════════════════════════════════════════════════════

interface ReputationRecord {
  id: string
  agentId: string
  score: number
  tag: string
  txHash: string | null
  blockNumber: number | null
  recordedAt: string
  onChain: boolean
}

const reputationRecords: ReputationRecord[] = []

agentWalletRouter.post('/reputation/record', async (c) => {
  try {
    const body = await c.req.json()
    const { agentId, score, tag } = body

    if (!agentId) return c.json({ success: false, error: 'agentId required' }, 400)
    if (typeof score !== 'number' || score < -128 || score > 127) {
      return c.json({ success: false, error: 'Score must be between -128 and 127' }, 400)
    }
    if (!tag) return c.json({ success: false, error: 'Tag required' }, 400)

    const recordId = 'rep-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
    let txHash: string | null = null
    let blockNumber: number | null = null
    let onChain = false

    // Attempt on-chain reputation recording via relayer
    const relayer = getRelayerWallet()
    if (relayer) {
      try {
        const feedbackHash = ethers.keccak256(
          ethers.toUtf8Bytes(tag + '_' + agentId + '_' + Date.now())
        )
        const data = REPUTATION_IFACE.encodeFunctionData('giveFeedback', [
          agentId, score, 0, tag, '', '', '', feedbackHash,
        ])
        const result = await submitRelayerTx({
          to: REPUTATION_REGISTRY,
          data,
          gasLimit: 200000,
        })
        if (result.success) {
          txHash = result.txHash!
          blockNumber = result.blockNumber!
          onChain = true
        }
      } catch (e: any) { /* on-chain attempt failed; fall through to local record */ }
    }

    const record: ReputationRecord = { id: recordId, agentId, score, tag, txHash, blockNumber, recordedAt: new Date().toISOString(), onChain }
    reputationRecords.push(record)

    addAuditLog(agentId, {
      action: 'reputation_recorded',
      status: onChain ? 'success' : 'pending',
      txHash,
      amount: null, token: null, from: relayer ? await relayer.getAddress() : null, to: null, network: 'arc-testnet',
      details: JSON.stringify({ score, tag, recordId, onChain }),
    })
    calculateReputation(agentId)

    return c.json({ success: true, record, relayed: onChain }, 201)
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

agentWalletRouter.get('/reputation/relayer-status', (c) => {
  const relayer = getRelayerWallet()
  return c.json({ configured: !!relayer, address: relayer ? relayer.address : null })
})

// ═══════════════════════════════════════════════════════════════
//  VALIDATION RESPONSE (backend relayer)
// ═══════════════════════════════════════════════════════════════

interface ValidationRecord {
  id: string
  requestHash: string
  response: number
  tag: string
  txHash: string | null
  blockNumber: number | null
  respondedAt: string
  onChain: boolean
}

const validationRecords: ValidationRecord[] = []

agentWalletRouter.post('/validation/respond', async (c) => {
  try {
    const body = await c.req.json()
    const { requestHash, response, tag } = body

    if (!requestHash) return c.json({ success: false, error: 'requestHash required' }, 400)
    if (typeof response !== 'number' || response < 0 || response > 100) {
      return c.json({ success: false, error: 'Response must be 0-100' }, 400)
    }

    const recordId = 'val-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
    let txHash: string | null = null
    let blockNumber: number | null = null
    let onChain = false

    const relayer = getRelayerWallet()
    if (relayer) {
      try {
        const data = VALIDATION_IFACE.encodeFunctionData('validationResponse', [
          requestHash,
          response,
          '',
          '0x0000000000000000000000000000000000000000000000000000000000000000',
          tag || '',
        ])
        const result = await submitRelayerTx({
          to: VALIDATION_REGISTRY,
          data,
          gasLimit: 200000,
        })
        if (result.success) {
          txHash = result.txHash!
          blockNumber = result.blockNumber!
          onChain = true
        }
      } catch (e: any) { /* fallback to local */ }
    }

    const record: ValidationRecord = { id: recordId, requestHash, response, tag: tag || '', txHash, blockNumber, respondedAt: new Date().toISOString(), onChain }
    validationRecords.push(record)

    return c.json({ success: true, record, relayed: onChain }, 201)
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

agentWalletRouter.get('/validation/status/:requestHash', (c) => {
  const requestHash = c.req.param('requestHash')
  const local = validationRecords.filter(r => r.requestHash === requestHash)
  return c.json({
    success: true,
    requestHash,
    localResponses: local,
    message: 'Check ArcScan for on-chain validation status',
  })
})

agentWalletRouter.get('/validation/relayer-status', (c) => {
  const relayer = getRelayerWallet()
  return c.json({ configured: !!relayer, address: relayer ? relayer.address : null })
})

// ═══════════════════════════════════════════════════════════════
//  AGENT IDENTITY (backend-side read)
//  Reads ERC-8004 agent identity from on-chain events.
//  Uses eth_call + eth_getLogs via ARC RPC.
// ═══════════════════════════════════════════════════════════════

const IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e'

// ERC-721 ownerOf(address,uint256) selector
const OWNER_OF_SEL = '0x6352211e'
// ERC-721 tokenURI(uint256) selector
const TOKEN_URI_SEL = '0xc87b56dd'

function encUint256(n: string | number): string {
  const bn = BigInt(n)
  return bn.toString(16).padStart(64, '0')
}

agentWalletRouter.get('/agent-onchain/:owner', async (c) => {
  try {
    const owner = c.req.param('owner').toLowerCase()
    if (!isValidAddr(owner)) return c.json({ success: false, error: 'Invalid address' }, 400)

    // Query Transfer events from IdentityRegistry where to = owner
    const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
    const ZERO_TOPIC    = '0x0000000000000000000000000000000000000000000000000000000000000000'
    const paddedOwner   = '0x' + owner.replace('0x', '').padStart(64, '0')

    const logs = await rpcCall('eth_getLogs', [{
      address: IDENTITY_REGISTRY,
      topics: [TRANSFER_TOPIC, ZERO_TOPIC, paddedOwner],
      fromBlock: '0x0',
      toBlock: 'latest',
    }])

    if (!Array.isArray(logs) || logs.length === 0) {
      return c.json({ success: true, agentId: null, agents: [] })
    }

    const agents = await Promise.all(
      logs.map(async (log: any) => {
        const tokenId = BigInt(log.topics[3] || '0x0').toString()
        try {
          const [ownerCall, uriCall] = await Promise.all([
            rpcCall('eth_call', [{ to: IDENTITY_REGISTRY, data: OWNER_OF_SEL + encUint256(tokenId) }, 'latest']),
            rpcCall('eth_call', [{ to: IDENTITY_REGISTRY, data: TOKEN_URI_SEL + encUint256(tokenId) }, 'latest']),
          ])
          return {
            agentId: tokenId,
            owner: '0x' + (ownerCall || '').replace('0x', '').slice(24).toLowerCase(),
            tokenURI: interpretStringResult(uriCall),
          }
        } catch {
          return { agentId: tokenId, owner: null, tokenURI: null }
        }
      })
    )

    return c.json({ success: true, agentId: agents[0]?.agentId || null, agents })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

function interpretStringResult(hex: string): string {
  if (!hex || hex === '0x') return ''
  try {
    const data = hex.startsWith('0x') ? hex.slice(2) : hex
    if (data.length < 128) {
      const bytes = Buffer.from(data, 'hex').toString('utf8').replace(/\0/g, '')
      return bytes || hex
    }
    const offset = parseInt(data.slice(0, 64), 16) * 2
    const length = parseInt(data.slice(offset, offset + 64), 16) * 2
    const strData = data.slice(offset + 64, offset + 64 + length)
    return Buffer.from(strData, 'hex').toString('utf8')
  } catch {
    return hex
  }
}

// ═══════════════════════════════════════════════════════════════
//  AGENT WALLET — Deterministic derivation from Cloudflare Secret
//
//  The agent wallet is derived via HMAC-SHA256(AGENT_WALLET_SEED, ownerAddress).
//  Same owner ALWAYS gets the same wallet — survives cold starts,
//  deployments, Worker restarts, and browser refreshes.
//
//  No private keys stored in localStorage, Maps, or any cache.
//  The seed is a Cloudflare Secret — never exposed to clients.
//
//  One connected owner address → ONE Agent Wallet (by construction).
// ═══════════════════════════════════════════════════════════════

interface AgentWalletRecord {
  walletId: string
  address: string
  ownerAddress: string
  agentId: string | null
  label: string
  createdAt: string
  chainId: number
}

// In-memory cache ONLY — authoritative source is deterministic derivation.
// Keyed by ownerAddress. Repopulated on demand from derivation.
const walletCacheByOwner = new Map<string, AgentWalletRecord>()
const walletCacheById   = new Map<string, AgentWalletRecord>()

function getSeed(): string {
  return (globalThis as any).__AGENT_WALLET_SEED__ || ''
}

function setSeedRuntime(seed: string) {
  (globalThis as any).__AGENT_WALLET_SEED__ = seed
}

// Helper to read seed from Hono context
function readSeedFromEnv(c: any): string {
  return c?.env?.AGENT_WALLET_SEED || process?.env?.AGENT_WALLET_SEED || ''
}

async function deriveWallet(ownerAddress: string): Promise<ethers.HDNodeWallet> {
  const seed = getSeed()
  if (!seed) throw new Error('AGENT_WALLET_SEED not configured on Cloudflare')

  const encoder = new TextEncoder()
  const keyData = encoder.encode(seed)
  const msgData = encoder.encode('agent-wallet:' + ownerAddress.toLowerCase())

  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, msgData)
  const privateKeyHex = Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

  return new ethers.Wallet('0x' + privateKeyHex,
    new ethers.JsonRpcProvider(ARC_RPC, CHAIN_ID))
}

function resolveWalletByOwner(owner: string): AgentWalletRecord | null {
  return walletCacheByOwner.get(owner.toLowerCase()) || null
}

function cacheWallet(owner: string, record: AgentWalletRecord) {
  const key = owner.toLowerCase()
  walletCacheByOwner.set(key, record)
  walletCacheById.set(record.walletId, record)
}

// ─── POST /create — Idempotent. Deterministic derivation. ──────────────────

agentWalletRouter.post('/create', async (c) => {
  try {
    // Initialize seed from Cloudflare environment (first call on each isolate)
    const envSeed = c.env?.AGENT_WALLET_SEED || process?.env?.AGENT_WALLET_SEED || ''
    if (envSeed && envSeed.length >= 64) setSeedRuntime(envSeed)

    const body = await c.req.json()
    const { ownerAddress, label } = body

    if (!ownerAddress || !isValidAddr(ownerAddress)) {
      return c.json({ success: false, error: 'Valid ownerAddress (user wallet) required' }, 400)
    }

    const owner = ownerAddress.toLowerCase()

    // Check cache first (same-worker reuse)
    const cached = resolveWalletByOwner(owner)
    if (cached) {
      console.log('[AgentWallet] existing wallet found (cached):', cached.address)
      return c.json({
        success: true,
        existing: true,
        wallet: {
          walletId: cached.walletId,
          address: cached.address,
          label: cached.label,
          createdAt: cached.createdAt,
          agentId: cached.agentId,
          chainId: cached.chainId,
        },
      })
    }

    // Deterministically derive wallet from seed + owner
    const wallet = await deriveWallet(owner)
    const address = wallet.address

    const walletId = 'aw-' + owner.slice(2, 10) + '-' + address.slice(2, 10).toLowerCase()

    const record: AgentWalletRecord = {
      walletId,
      address,
      ownerAddress: owner,
      agentId: null,
      label: label || 'Agent Wallet',
      createdAt: new Date().toISOString(),
      chainId: CHAIN_ID,
    }
    cacheWallet(owner, record)

    console.log('[AgentWallet] create:', address, 'owner:', owner)

    return c.json({
      success: true,
      wallet: { walletId, address, label: record.label, createdAt: record.createdAt, chainId: CHAIN_ID },
    }, 201)
  } catch (e: any) {
    console.error('[AgentWallet] create error:', e.message)
    return c.json({ success: false, error: e.message }, 500)
  }
})

// ─── GET /wallet/:owner — Canonical recovery endpoint ──────────────────────

agentWalletRouter.get('/wallet/:owner', async (c) => {
  try {
    const envSeed = c.env?.AGENT_WALLET_SEED || process?.env?.AGENT_WALLET_SEED || ''
    if (envSeed && envSeed.length >= 64) setSeedRuntime(envSeed)

    const owner = c.req.param('owner').toLowerCase()
    if (!isValidAddr(owner)) return c.json({ success: false, error: 'Invalid address' }, 400)

    // Check cache
    const cached = resolveWalletByOwner(owner)
    if (cached) {
      return c.json({
        success: true,
        wallet: { walletId: cached.walletId, address: cached.address, label: cached.label, createdAt: cached.createdAt, agentId: cached.agentId },
      })
    }

    // Derive from seed
    const wallet = await deriveWallet(owner)
    const walletId = 'aw-' + owner.slice(2, 10) + '-' + wallet.address.slice(2, 10).toLowerCase()
    const record: AgentWalletRecord = {
      walletId,
      address: wallet.address,
      ownerAddress: owner,
      agentId: null,
      label: 'Agent Wallet',
      createdAt: new Date().toISOString(),
      chainId: CHAIN_ID,
    }
    cacheWallet(owner, record)

    console.log('[AgentWallet] owner recovery:', record.address)

    return c.json({
      success: true,
      wallet: { walletId, address: record.address, label: record.label, createdAt: record.createdAt, agentId: null },
    })
  } catch (e: any) {
    console.error('[AgentWallet] wallet lookup error:', e.message)
    return c.json({ success: true, wallet: null })
  }
})

// ─── POST /restore — Restore by walletId + ownerAddress ────────────────────

agentWalletRouter.post('/restore', async (c) => {
  try {
    const envSeed = c.env?.AGENT_WALLET_SEED || process?.env?.AGENT_WALLET_SEED || ''
    if (envSeed && envSeed.length >= 64) setSeedRuntime(envSeed)

    const body = await c.req.json()
    const { walletId, ownerAddress } = body

    // Primary: restore by walletId (fast cache lookup)
    if (walletId) {
      const cached = walletCacheById.get(walletId)
      if (cached) {
        console.log('[AgentWallet] restored by walletId:', cached.address)
        return c.json({
          success: true,
          wallet: { walletId: cached.walletId, address: cached.address, label: cached.label, createdAt: cached.createdAt, agentId: cached.agentId, chainId: cached.chainId },
        })
      }
    }

    // Secondary: owner-based recovery (cold start / first invocation)
    if (ownerAddress && isValidAddr(ownerAddress)) {
      const owner = ownerAddress.toLowerCase()

      const cached = resolveWalletByOwner(owner)
      if (cached) {
        console.log('[AgentWallet] restored by owner:', cached.address)
        return c.json({
          success: true,
          wallet: { walletId: cached.walletId, address: cached.address, label: cached.label, createdAt: cached.createdAt, agentId: cached.agentId, chainId: cached.chainId },
        })
      }

      // Derive from seed — cold-start recovery
      const wallet = await deriveWallet(owner)
      const newId = 'aw-' + owner.slice(2, 10) + '-' + wallet.address.slice(2, 10).toLowerCase()
      const record: AgentWalletRecord = {
        walletId: newId,
        address: wallet.address,
        ownerAddress: owner,
        agentId: null,
        label: 'Agent Wallet',
        createdAt: new Date().toISOString(),
        chainId: CHAIN_ID,
      }
      cacheWallet(owner, record)

      console.log('[AgentWallet] owner recovery (cold start):', record.address)
      return c.json({
        success: true,
        wallet: { walletId: record.walletId, address: record.address, label: record.label, createdAt: record.createdAt, agentId: null, chainId: CHAIN_ID },
      })
    }

    return c.json({ success: false, wallet: null, message: 'Wallet not found — provide ownerAddress for recovery' })
  } catch (e: any) {
    console.error('[AgentWallet] restore error:', e.message)
    return c.json({ success: false, error: 'Temporary backend error — retry' }, 500)
  }
})

agentWalletRouter.get('/wallet-info/:address', async (c) => {
  const address = c.req.param('address')
  if (!isValidAddr(address)) return c.json({ success: false, error: 'Invalid address' }, 400)

  try {
    const [usdcRaw, eurcRaw] = await Promise.all([
      getTokenBalance(USDC_ADDRESS, address).catch(() => 0n),
      getTokenBalance(EURC_ADDRESS, address).catch(() => 0n),
    ])
    return c.json({
      success: true,
      wallet: {
        address,
        balances: {
          USDC: { raw: usdcRaw.toString(), human: fmtAmount(usdcRaw) },
          EURC: { raw: eurcRaw.toString(), human: fmtAmount(eurcRaw, 6) },
        },
        explorerUrl: `${EXPLORER}/address/${address}`,
      },
    })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

// Link agent wallet to ERC-8004 agent after registration
agentWalletRouter.post('/link-agent', async (c) => {
  try {
    const body = await c.req.json()
    const { ownerAddress, agentId } = body
    if (!ownerAddress || !agentId) return c.json({ success: false, error: 'ownerAddress and agentId required' }, 400)

    const owner = ownerAddress.toLowerCase()
    let w = resolveWalletByOwner(owner)
    if (!w) {
      // Derive wallet if not yet cached
      const wallet = await deriveWallet(owner)
    const walletId = 'aw-' + owner.slice(2, 10) + '-' + address.slice(2, 10).toLowerCase()
      w = {
        walletId,
        address: wallet.address,
        ownerAddress: owner,
        agentId: null,
        label: 'Agent Wallet',
        createdAt: new Date().toISOString(),
        chainId: CHAIN_ID,
      }
      cacheWallet(owner, w)
    }
    w.agentId = agentId
    cacheWallet(owner, w)

    return c.json({ success: true, wallet: { address: w.address, agentId, linked: true } })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

// ═══════════════════════════════════════════════════════════════
//  AGENT TRANSACTIONS — Real on-chain via Arc RPC eth_getLogs
// ═══════════════════════════════════════════════════════════════

const USDC_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

interface AgentTransaction {
  txHash: string
  status: string
  from: string
  to: string
  token: string
  amount: string
  blockNumber: number
  timestamp: string | null
  intentId: string | null
  operation: string
}

agentWalletRouter.get('/transactions/:agentAddress', async (c) => {
  try {
    const agentAddress = c.req.param('agentAddress').toLowerCase()
    if (!isValidAddr(agentAddress)) return c.json({ success: false, error: 'Invalid address' }, 400)
    const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50)
    const cursor = c.req.query('cursor') || '0x0'

    // Query Transfer events where agent wallet is sender OR receiver
    const logs = await Promise.all([
      // Outgoing: agentAddress is 'from' (indexed topic 1)
      rpcCall('eth_getLogs', [{
        address: USDC_ADDRESS,
        topics: [USDC_TOPIC, '0x' + encAddr(agentAddress), null],
        fromBlock: cursor,
        toBlock: 'latest',
      }]).catch(() => []),
      // Incoming: agentAddress is 'to' (indexed topic 2)
      rpcCall('eth_getLogs', [{
        address: USDC_ADDRESS,
        topics: [USDC_TOPIC, null, '0x' + encAddr(agentAddress)],
        fromBlock: cursor,
        toBlock: 'latest',
      }]).catch(() => []),
      // EURC outgoing
      rpcCall('eth_getLogs', [{
        address: EURC_ADDRESS,
        topics: [USDC_TOPIC, '0x' + encAddr(agentAddress), null],
        fromBlock: cursor,
        toBlock: 'latest',
      }]).catch(() => []),
      // EURC incoming
      rpcCall('eth_getLogs', [{
        address: EURC_ADDRESS,
        topics: [USDC_TOPIC, null, '0x' + encAddr(agentAddress)],
        fromBlock: cursor,
        toBlock: 'latest',
      }]).catch(() => []),
    ])

    // Flatten and deduplicate by txHash
    const txMap = new Map<string, any>()
    for (const logArray of logs) {
      if (!Array.isArray(logArray)) continue
      for (const log of logArray) {
        const txHash = log.transactionHash
        if (!txMap.has(txHash)) {
          txMap.set(txHash, log)
        }
      }
    }

    // Decode and sort
    const transactions: AgentTransaction[] = []
    for (const [, log] of txMap) {
      const fromAddr = '0x' + (log.topics[1] || '').slice(26).toLowerCase()
      const toAddr   = '0x' + (log.topics[2] || '').slice(26).toLowerCase()
      const rawAmt   = BigInt(log.data || '0x0')
      const token    = log.address.toLowerCase() === USDC_ADDRESS.toLowerCase() ? 'USDC' : 'EURC'
      const decimals = 6n
      const amount   = (Number(rawAmt) / 1e6).toString()
      transactions.push({
        txHash,
        status: 'confirmed',
        from: fromAddr,
        to: toAddr,
        token,
        amount,
        blockNumber: parseInt(log.blockNumber || '0', 16),
        timestamp: null, // would need eth_getBlockByNumber for real timestamp
        intentId: null,
        operation: fromAddr === agentAddress ? 'send' : 'receive',
      })
    }

    // Sort by blockNumber descending (most recent first)
    transactions.sort((a, b) => b.blockNumber - a.blockNumber)

    return c.json({
      success: true,
      agentAddress,
      chainId: CHAIN_ID,
      transactions: transactions.slice(0, limit),
      total: transactions.length,
    })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

// ═══════════════════════════════════════════════════════════════
//  AGENT INTENTS — Durable persistence via Cloudflare Cache API
// ═══════════════════════════════════════════════════════════════

interface PersistedIntent {
  id: string
  agentAddress: string
  walletId: string
  ownerAddress: string
  type: string
  status: string
  params: Record<string, any>
  execution: { txHash: string; blockNumber: number; error: string }
  createdAt: string
  updatedAt: string
  source: string
}

const INTENT_CACHE_PREFIX = 'agent-intent:'

async function cacheGet(key: string): Promise<any> {
  try {
    const cache = caches.default
    const url = `https://execdaat-worker.local/${key}`
    const match = await cache.match(url)
    if (match) {
      const text = await match.text()
      return JSON.parse(text)
    }
    return null
  } catch { return null }
}

async function cachePut(key: string, data: any, ttlSeconds: number = 86400) {
  try {
    const cache = caches.default
    const url = `https://execdaat-worker.local/${key}`
    const res = new Response(JSON.stringify(data), {
      headers: { 'Cache-Control': `max-age=${ttlSeconds}` }
    })
    await cache.put(url, res)
  } catch { /* cache write failure — non-critical */ }
}

// GET /intents/:agentAddress
agentWalletRouter.get('/intents/:agentAddress', async (c) => {
  try {
    const agentAddress = c.req.param('agentAddress').toLowerCase()
    if (!isValidAddr(agentAddress)) return c.json({ success: false, error: 'Invalid address' }, 400)
    const status = c.req.query('status') || ''
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100)

    // Load intents for this agent from cache
    const key = `${INTENT_CACHE_PREFIX}${agentAddress}`
    let intents: PersistedIntent[] = (await cacheGet(key)) || []

    if (status) {
      intents = intents.filter(i => i.status === status)
    }

    return c.json({
      success: true,
      agentAddress,
      intents: intents.slice(0, limit),
      total: intents.length,
    })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

// POST /intents — Create or update an intent
agentWalletRouter.post('/intents', async (c) => {
  try {
    const body = await c.req.json()
    const { id, agentAddress, walletId, ownerAddress, type, status, params, execution, source } = body
    if (!agentAddress || !id) return c.json({ success: false, error: 'agentAddress and id required' }, 400)

    const key = `${INTENT_CACHE_PREFIX}${agentAddress.toLowerCase()}`
    let intents: PersistedIntent[] = (await cacheGet(key)) || []

    const existingIdx = intents.findIndex(i => i.id === id)
    const intent: PersistedIntent = {
      id,
      agentAddress: agentAddress.toLowerCase(),
      walletId: walletId || '',
      ownerAddress: (ownerAddress || '').toLowerCase(),
      type: type || 'unknown',
      status: status || 'draft',
      params: params || {},
      execution: execution || { txHash: '', blockNumber: 0, error: '' },
      createdAt: body.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: source || 'api',
    }

    if (existingIdx >= 0) {
      intents[existingIdx] = intent
    } else {
      intents.unshift(intent)
      if (intents.length > 200) intents.length = 200
    }

    await cachePut(key, intents)
    return c.json({ success: true, intent }, 201)
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

// PATCH /intents/:intentId — Update intent status
agentWalletRouter.patch('/intents/:intentId', async (c) => {
  try {
    const intentId = c.req.param('intentId')
    const body = await c.req.json()
    const { agentAddress, status, execution } = body
    if (!agentAddress) return c.json({ success: false, error: 'agentAddress required' }, 400)

    const key = `${INTENT_CACHE_PREFIX}${agentAddress.toLowerCase()}`
    let intents: PersistedIntent[] = (await cacheGet(key)) || []
    const idx = intents.findIndex(i => i.id === intentId)
    if (idx < 0) return c.json({ success: false, error: 'Intent not found' }, 404)

    if (status) intents[idx].status = status
    if (execution) Object.assign(intents[idx].execution, execution)
    intents[idx].updatedAt = new Date().toISOString()

    await cachePut(key, intents)
    return c.json({ success: true, intent: intents[idx] })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

// ═══════════════════════════════════════════════════════════════
//  AGENT AUDIT/OPERATIONS — Durable persistence via Cache API
// ═══════════════════════════════════════════════════════════════

const AUDIT_CACHE_PREFIX = 'agent-audit:'

// GET /audit-ops/:agentAddress
agentWalletRouter.get('/audit-ops/:agentAddress', async (c) => {
  try {
    const agentAddress = c.req.param('agentAddress').toLowerCase()
    if (!isValidAddr(agentAddress)) return c.json({ success: false, error: 'Invalid address' }, 400)
    const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50)

    const key = `${AUDIT_CACHE_PREFIX}${agentAddress}`
    let entries = (await cacheGet(key)) || []

    return c.json({
      success: true,
      agentAddress,
      operations: entries.slice(0, limit),
      total: entries.length,
    })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

// POST /audit-ops — Record an operation
agentWalletRouter.post('/audit-ops', async (c) => {
  try {
    const body = await c.req.json()
    const { agentAddress, operation, intentId, status, txHash, amount, token, details } = body
    if (!agentAddress || !operation) return c.json({ success: false, error: 'agentAddress and operation required' }, 400)

    const key = `${AUDIT_CACHE_PREFIX}${agentAddress.toLowerCase()}`
    let entries = (await cacheGet(key)) || []

    const entry = {
      id: 'op-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      agentAddress: agentAddress.toLowerCase(),
      operation,
      intentId: intentId || null,
      status: status || 'completed',
      txHash: txHash || null,
      amount: amount || null,
      token: token || null,
      details: details || null,
      timestamp: new Date().toISOString(),
    }

    entries.unshift(entry)
    if (entries.length > 500) entries.length = 500

    await cachePut(key, entries)
    return c.json({ success: true, entry }, 201)
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

// Decrypt and get signer for agent wallet (internal use)
async function getAgentWalletSigner(ownerAddress: string): Promise<ethers.Wallet | null> {
  try {
    const owner = ownerAddress.toLowerCase()
    return await deriveWallet(owner)
  } catch { return null }
}

export default agentWalletRouter
