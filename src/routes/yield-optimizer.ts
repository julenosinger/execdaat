import { Hono } from 'hono'
import { ARC_TESTNET } from '../types/arc'
import { ethers } from 'ethers'

const yieldRouter = new Hono()
const provider = new ethers.JsonRpcProvider(ARC_TESTNET.rpcUrl)

type YieldPool = { id: string; token: 'USDC' | 'EURC'; contract: string; label: string }

const positions: Array<Record<string, unknown>> = []

function configuredPools(): YieldPool[] {
  const pools: YieldPool[] = []
  if (process.env.ARC_USDC_VAULT_ADDRESS) {
    pools.push({ id: 'usdc-vault', token: 'USDC', contract: process.env.ARC_USDC_VAULT_ADDRESS, label: 'ARC USDC Vault' })
  }
  if (process.env.ARC_EURC_VAULT_ADDRESS) {
    pools.push({ id: 'eurc-vault', token: 'EURC', contract: process.env.ARC_EURC_VAULT_ADDRESS, label: 'ARC EURC Vault' })
  }
  return pools
}

yieldRouter.get('/status', (c) => {
  const pools = configuredPools()
  return c.json({
    success: true,
    configured: pools.length > 0,
    poolCount: pools.length,
    mode: 'on-chain-only',
    message: pools.length > 0 ? 'Pools on-chain configurados.' : 'Configure ARC_USDC_VAULT_ADDRESS / ARC_EURC_VAULT_ADDRESS.',
  })
})

yieldRouter.get('/pools', (c) => {
  const pools = configuredPools()
  return c.json({ success: true, pools })
})

yieldRouter.get('/pools/best', (c) => {
  const token = (c.req.query('token') || 'USDC').toUpperCase()
  const pool = configuredPools().find((p) => p.token === token)
  if (!pool) return c.json({ success: false, error: 'Nenhum pool configurado para este token.' }, 404)
  return c.json({ success: true, pool })
})

yieldRouter.post('/positions/open', async (c) => {
  try {
    const { walletAddress, txHash, poolId, amount } = await c.req.json()
    if (!walletAddress || !txHash || !poolId || !amount) {
      return c.json({ success: false, error: 'Parâmetros obrigatórios ausentes.' }, 400)
    }

    const pool = configuredPools().find((p) => p.id === poolId)
    if (!pool) return c.json({ success: false, error: 'Pool não configurado.' }, 400)

    const tx = await provider.getTransaction(txHash)
    const receipt = await provider.getTransactionReceipt(txHash)
    if (!tx || !receipt || receipt.status !== 1) {
      return c.json({ success: false, error: 'Transação não confirmada.' }, 400)
    }
    if (tx.from.toLowerCase() !== walletAddress.toLowerCase() || tx.to?.toLowerCase() !== pool.contract.toLowerCase()) {
      return c.json({ success: false, error: 'txHash não corresponde ao pool/carteira.' }, 400)
    }

    const position = {
      id: `yield-${Date.now()}`,
      walletAddress,
      txHash,
      poolId,
      amount,
      blockNumber: receipt.blockNumber,
      explorerUrl: `${ARC_TESTNET.explorerUrl}/tx/${txHash}`,
      status: 'active',
      openedAt: new Date().toISOString(),
    }
    positions.unshift(position)
    return c.json({ success: true, position })
  } catch (error) {
    return c.json({ success: false, error: (error as Error).message }, 500)
  }
})

yieldRouter.get('/positions', (c) => c.json({ success: true, positions }))

yieldRouter.post('/positions/:id/close', (c) => c.json({ success: false, error: 'Fechamento via API desabilitado. Use a wallet e registre txHash.' }, 501))
yieldRouter.post('/positions/:id/rebalance', (c) => c.json({ success: false, error: 'Rebalance automático desabilitado sem estratégia auditada.' }, 501))
yieldRouter.get('/project', (c) => c.json({ success: false, error: 'Projeções APY removidas para evitar dados simulados.' }, 501))

export default yieldRouter
