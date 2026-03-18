import { Hono } from 'hono'
import { ethers } from 'ethers'
import { ARC_TESTNET } from '../types/arc'

const vaultsRouter = new Hono()
const provider = new ethers.JsonRpcProvider(ARC_TESTNET.rpcUrl)

const VAULT_ABI = [
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
]

const TOKEN_DECIMALS = 6

type VaultPosition = { balance: number; yieldEarned: number; strategy: string }

export const vaultStore: Record<string, { positions: Map<string, VaultPosition> }> = {
  usdc: { positions: new Map() },
  eurc: { positions: new Map() },
}

type VaultToken = 'usdc' | 'eurc'

const history: Record<VaultToken, Array<Record<string, unknown>>> = {
  usdc: [],
  eurc: [],
}

function getVaultAddress(token: VaultToken) {
  return token === 'usdc' ? process.env.ARC_USDC_VAULT_ADDRESS : process.env.ARC_EURC_VAULT_ADDRESS
}

function getDefaultApy(token: VaultToken) {
  return token === 'usdc' ? 4.2 : 4.6
}

function getDefaultPosition(): VaultPosition {
  return { balance: 0, yieldEarned: 0, strategy: 'manual' }
}

async function readVaultMetrics(token: VaultToken) {
  const vaultAddress = getVaultAddress(token)
  if (!vaultAddress) throw new Error(`Vault ${token.toUpperCase()} não configurado.`)

  const contract = new ethers.Contract(vaultAddress, VAULT_ABI, provider)
  const [totalAssets, totalSupply] = await Promise.all([contract.totalAssets(), contract.totalSupply()])

  return {
    vaultAddress,
    totalAssets: Number(ethers.formatUnits(totalAssets, TOKEN_DECIMALS)),
    totalSupply: Number(ethers.formatUnits(totalSupply, TOKEN_DECIMALS)),
  }
}

function buildVaultPayload(token: VaultToken, metrics: Awaited<ReturnType<typeof readVaultMetrics>>) {
  const symbol = token.toUpperCase()
  const totalDeposited = Number(metrics.totalAssets.toFixed(6))
  const participants = vaultStore[token].positions.size
  const accrued = Number((totalDeposited * (getDefaultApy(token) / 100 / 12)).toFixed(6))

  return {
    id: `${token}-vault`,
    token: symbol,
    name: `ARC ${symbol} Vault`,
    description: `Vault on-chain para depósitos em ${symbol} na Arc Testnet.`,
    contract: metrics.vaultAddress,
    contractAddress: metrics.vaultAddress,
    vaultAddress: metrics.vaultAddress,
    totalAssets: metrics.totalAssets,
    totalSupply: metrics.totalSupply,
    currentBalance: totalDeposited,
    totalDeposited,
    apy: getDefaultApy(token),
    accrued,
    participants,
  }
}

async function verifyAndStoreTx(token: VaultToken, txHash: string, walletAddress: string, amount: number, op: 'deposit' | 'withdraw') {
  const vaultAddress = getVaultAddress(token)
  if (!vaultAddress) throw new Error(`Vault ${token.toUpperCase()} não configurado.`)

  const tx = await provider.getTransaction(txHash)
  const receipt = await provider.getTransactionReceipt(txHash)

  if (!tx || !receipt || receipt.status !== 1) {
    throw new Error('Transação inválida ou não confirmada.')
  }

  if (tx.from.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error('walletAddress não corresponde ao txHash.')
  }

  if (tx.to?.toLowerCase() !== vaultAddress.toLowerCase()) {
    throw new Error('Transação não direcionada ao contrato do vault configurado.')
  }

  const key = walletAddress.toLowerCase()
  const existing = vaultStore[token].positions.get(key) || getDefaultPosition()
  const nextBalance = op === 'deposit' ? existing.balance + amount : Math.max(0, existing.balance - amount)

  vaultStore[token].positions.set(key, { ...existing, balance: Number(nextBalance.toFixed(6)) })

  const record = {
    id: `${token}-${op}-${Date.now()}`,
    txHash,
    walletAddress,
    amount,
    operation: op,
    blockNumber: receipt.blockNumber,
    timestamp: new Date().toISOString(),
    explorerUrl: `${ARC_TESTNET.explorerUrl}/tx/${txHash}`,
    source: 'on-chain-verified',
  }

  history[token].unshift(record)
  if (history[token].length > 200) history[token].pop()

  return record
}

vaultsRouter.get('/', async (c) => {
  try {
    const [usdc, eurc] = await Promise.all([readVaultMetrics('usdc'), readVaultMetrics('eurc')])
    return c.json({
      success: true,
      vaults: [
        buildVaultPayload('usdc', usdc),
        buildVaultPayload('eurc', eurc),
      ],
      network: { chainId: ARC_TESTNET.chainId, explorer: ARC_TESTNET.explorerUrl },
    })
  } catch (error) {
    return c.json({ success: false, error: (error as Error).message }, 503)
  }
})

vaultsRouter.get('/:token', async (c) => {
  try {
    const token = c.req.param('token') as VaultToken
    if (!['usdc', 'eurc'].includes(token)) {
      return c.json({ success: false, error: 'Token inválido.' }, 400)
    }

    const metrics = await readVaultMetrics(token)
    return c.json({ success: true, vault: buildVaultPayload(token, metrics) })
  } catch (error) {
    return c.json({ success: false, error: (error as Error).message }, 503)
  }
})

vaultsRouter.post('/:token/deposit', async (c) => {
  try {
    const token = c.req.param('token') as VaultToken
    const { walletAddress, amount, txHash } = await c.req.json()
    if (!['usdc', 'eurc'].includes(token) || !walletAddress || !amount || !txHash) {
      return c.json({ success: false, error: 'Parâmetros inválidos.' }, 400)
    }

    const record = await verifyAndStoreTx(token, txHash, walletAddress, Number(amount), 'deposit')
    return c.json({ success: true, deposit: record })
  } catch (error) {
    return c.json({ success: false, error: (error as Error).message }, 400)
  }
})

vaultsRouter.post('/:token/withdraw', async (c) => {
  try {
    const token = c.req.param('token') as VaultToken
    const { walletAddress, amount, txHash } = await c.req.json()
    if (!['usdc', 'eurc'].includes(token) || !walletAddress || !amount || !txHash) {
      return c.json({ success: false, error: 'Parâmetros inválidos.' }, 400)
    }

    const record = await verifyAndStoreTx(token, txHash, walletAddress, Number(amount), 'withdraw')
    return c.json({ success: true, withdraw: record })
  } catch (error) {
    return c.json({ success: false, error: (error as Error).message }, 400)
  }
})

vaultsRouter.get('/:token/history', (c) => {
  const token = c.req.param('token') as VaultToken
  if (!['usdc', 'eurc'].includes(token)) {
    return c.json({ success: false, error: 'Token inválido.' }, 400)
  }
  return c.json({ success: true, history: history[token] })
})

function positionResponse(token: VaultToken, walletAddress: string) {
  const wallet = walletAddress.toLowerCase()
  const position = vaultStore[token].positions.get(wallet) || getDefaultPosition()
  return { success: true, wallet, token, position }
}

vaultsRouter.get('/:token/position', (c) => {
  const token = c.req.param('token') as VaultToken
  const wallet = c.req.query('wallet')
  if (!['usdc', 'eurc'].includes(token)) {
    return c.json({ success: false, error: 'Token inválido.' }, 400)
  }
  if (!wallet) {
    return c.json({ success: false, error: 'Parâmetro wallet é obrigatório.' }, 400)
  }

  return c.json(positionResponse(token, wallet))
})

vaultsRouter.get('/:token/position/:wallet', (c) => {
  const token = c.req.param('token') as VaultToken
  const wallet = c.req.param('wallet')
  if (!['usdc', 'eurc'].includes(token)) {
    return c.json({ success: false, error: 'Token inválido.' }, 400)
  }

  return c.json(positionResponse(token, wallet))
})

export default vaultsRouter
