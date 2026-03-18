import { Hono } from 'hono'
import { ethers } from 'ethers'
import { ARC_TESTNET } from '../types/arc'

const swapRouter = new Hono()

const provider = new ethers.JsonRpcProvider(ARC_TESTNET.rpcUrl)
const PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]

const txHistory: Array<Record<string, unknown>> = []

function getPairAddress() {
  return process.env.ARC_SWAP_PAIR_ADDRESS
}

function getRouterAddress() {
  return process.env.ARC_SWAP_ROUTER_ADDRESS
}

async function getPoolState() {
  const pairAddress = getPairAddress()
  if (!pairAddress) {
    throw new Error('ARC_SWAP_PAIR_ADDRESS não configurado')
  }

  const pair = new ethers.Contract(pairAddress, PAIR_ABI, provider)
  const [reserves, token0, token1] = await Promise.all([
    pair.getReserves(),
    pair.token0(),
    pair.token1(),
  ])

  const reserve0 = Number(ethers.formatUnits(reserves.reserve0, 6))
  const reserve1 = Number(ethers.formatUnits(reserves.reserve1, 6))

  return {
    pairAddress,
    token0: token0.toLowerCase(),
    token1: token1.toLowerCase(),
    reserve0,
    reserve1,
  }
}

function quoteConstantProduct(amountIn: number, reserveIn: number, reserveOut: number, fee = 0.003) {
  const amountInWithFee = amountIn * (1 - fee)
  const amountOut = (amountInWithFee * reserveOut) / (reserveIn + amountInWithFee)
  const priceImpact = (amountIn / reserveIn) * 100
  return { amountOut, feePercent: fee * 100, priceImpact }
}

swapRouter.get('/rates', async (c) => {
  try {
    const state = await getPoolState()
    const usdcIsToken0 = state.token0 === ARC_TESTNET.usdcAddress.toLowerCase()
    const usdcReserve = usdcIsToken0 ? state.reserve0 : state.reserve1
    const eurcReserve = usdcIsToken0 ? state.reserve1 : state.reserve0

    if (!usdcReserve || !eurcReserve) {
      return c.json({ success: false, error: 'Pool sem liquidez suficiente.' }, 503)
    }

    return c.json({
      success: true,
      rates: {
        USDC_TO_EURC: Number((eurcReserve / usdcReserve).toFixed(6)),
        EURC_TO_USDC: Number((usdcReserve / eurcReserve).toFixed(6)),
        source: 'On-chain ARC_SWAP_PAIR_ADDRESS reserves',
        updatedAt: new Date().toISOString(),
      },
      pool: {
        pairAddress: state.pairAddress,
        usdcReserve,
        eurcReserve,
        fee: '0.3%',
        totalSwaps: txHistory.length,
      },
      network: { name: 'Arc Testnet', chainId: ARC_TESTNET.chainId, explorer: ARC_TESTNET.explorerUrl },
    })
  } catch (error) {
    return c.json({ success: false, error: (error as Error).message }, 503)
  }
})

swapRouter.get('/quote', async (c) => {
  try {
    const fromToken = (c.req.query('from') || 'USDC').toUpperCase()
    const amount = Number(c.req.query('amount') || 0)
    if (!['USDC', 'EURC'].includes(fromToken) || amount <= 0) {
      return c.json({ success: false, error: 'Parâmetros inválidos.' }, 400)
    }

    const state = await getPoolState()
    const usdcIsToken0 = state.token0 === ARC_TESTNET.usdcAddress.toLowerCase()
    const usdcReserve = usdcIsToken0 ? state.reserve0 : state.reserve1
    const eurcReserve = usdcIsToken0 ? state.reserve1 : state.reserve0

    const [reserveIn, reserveOut] = fromToken === 'USDC' ? [usdcReserve, eurcReserve] : [eurcReserve, usdcReserve]
    const quote = quoteConstantProduct(amount, reserveIn, reserveOut)

    const toToken = fromToken === 'USDC' ? 'EURC' : 'USDC'
    const amountOut = Number(quote.amountOut.toFixed(6))
    const rate = amount > 0 ? Number((amountOut / amount).toFixed(6)) : 0
    const fee = Number((amount * (quote.feePercent / 100)).toFixed(6))
    const minimumReceived = Number((amountOut * 0.995).toFixed(6))

    return c.json({
      success: true,
      quote: {
        fromToken,
        toToken,
        amountIn: amount,
        amountOut,
        rate,
        fee,
        feePercent: quote.feePercent,
        minimumReceived,
        priceImpact: Number(quote.priceImpact.toFixed(4)),
        network: 'Arc Testnet',
      },
    })
  } catch (error) {
    return c.json({ success: false, error: (error as Error).message }, 503)
  }
})

swapRouter.post('/execute', async (c) => {
  try {
    const body = await c.req.json()
    const { txHash, walletAddress, amountIn, fromToken, toToken, amountOut } = body

    if (!txHash || !walletAddress || !amountIn || !fromToken || !toToken) {
      return c.json({ success: false, error: 'Campos obrigatórios ausentes.' }, 400)
    }

    const tx = await provider.getTransaction(txHash)
    const receipt = await provider.getTransactionReceipt(txHash)
    if (!tx || !receipt || receipt.status !== 1) {
      return c.json({ success: false, error: 'Transação não confirmada on-chain.' }, 400)
    }

    if (tx.from.toLowerCase() !== String(walletAddress).toLowerCase()) {
      return c.json({ success: false, error: 'walletAddress não corresponde ao txHash.' }, 400)
    }

    const router = getRouterAddress()
    if (router && tx.to?.toLowerCase() !== router.toLowerCase()) {
      return c.json({ success: false, error: 'Transação não enviada ao router oficial.' }, 400)
    }

    const normalizedAmountIn = Number(amountIn)
    let normalizedAmountOut = Number(amountOut || 0)

    if (!normalizedAmountOut && normalizedAmountIn > 0) {
      const state = await getPoolState()
      const usdcIsToken0 = state.token0 === ARC_TESTNET.usdcAddress.toLowerCase()
      const usdcReserve = usdcIsToken0 ? state.reserve0 : state.reserve1
      const eurcReserve = usdcIsToken0 ? state.reserve1 : state.reserve0
      const [reserveIn, reserveOut] = fromToken === 'USDC' ? [usdcReserve, eurcReserve] : [eurcReserve, usdcReserve]
      normalizedAmountOut = Number(quoteConstantProduct(normalizedAmountIn, reserveIn, reserveOut).amountOut.toFixed(6))
    }

    const record = {
      id: `swap-${Date.now()}`,
      txHash,
      walletAddress,
      fromToken,
      toToken,
      amountIn: normalizedAmountIn,
      amountOut: normalizedAmountOut,
      blockNumber: receipt.blockNumber,
      timestamp: new Date().toISOString(),
      explorerUrl: `${ARC_TESTNET.explorerUrl}/tx/${txHash}`,
      status: 'completed',
      source: 'on-chain-verified',
    }

    txHistory.unshift(record)
    if (txHistory.length > 200) txHistory.pop()

    return c.json({ success: true, swap: record })
  } catch (error) {
    return c.json({ success: false, error: (error as Error).message }, 500)
  }
})

swapRouter.get('/history', (c) => c.json({ success: true, swaps: txHistory }))

export default swapRouter
