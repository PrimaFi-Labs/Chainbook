// Simple price feed with in-memory TTL cache.
// Uses CoinGecko free API — no key required.
// Falls back to 0 gracefully if unavailable.
// apps/listener/src/lib/priceFeed.ts

import { publicClientHttp } from '../config/chain.js'
import { env } from '../config/env.js'

interface CacheEntry {
  price: number
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

const DIA_ADAPTER_ABI = [
  {
    name: 'latestRoundData',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
] as const

async function fetchOraclePrice(): Promise<number> {
  const address = env.SOMI_ORACLE_ADAPTER_ADDRESS as `0x${string}` | undefined
  if (!address) return 0
  try {
    const [, answer] = await publicClientHttp.readContract({
      address,
      abi: DIA_ADAPTER_ABI,
      functionName: 'latestRoundData',
    })
    if (typeof answer !== 'bigint' || answer <= 0n) return 0
    const scale = Math.pow(10, env.SOMI_ORACLE_DECIMALS)
    return Number(answer) / scale
  } catch {
    return 0
  }
}

async function fetchPrice(coinId: string): Promise<number> {
  const now = Date.now()
  const cached = cache.get(coinId)
  if (cached && cached.expiresAt > now) return cached.price

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`,
    )
    if (!res.ok) {
      const oracle = await fetchOraclePrice()
      if (oracle > 0) {
        cache.set(coinId, { price: oracle, expiresAt: now + env.PRICE_FEED_CACHE_TTL_MS })
      }
      return oracle
    }
    const json = (await res.json()) as Record<string, { usd: number }>
    const price = json[coinId]?.usd ?? 0
    if (price > 0) {
      cache.set(coinId, { price, expiresAt: now + env.PRICE_FEED_CACHE_TTL_MS })
      return price
    }
    const oracle = await fetchOraclePrice()
    if (oracle > 0) {
      cache.set(coinId, { price: oracle, expiresAt: now + env.PRICE_FEED_CACHE_TTL_MS })
    }
    return oracle
  } catch {
    const oracle = await fetchOraclePrice()
    if (oracle > 0) {
      cache.set(coinId, { price: oracle, expiresAt: now + env.PRICE_FEED_CACHE_TTL_MS })
    }
    return oracle
  }
}

// Convert raw token amount (in wei) to USD
// amountRaw: bigint in wei (18 decimals assumed unless overridden)
export async function toUsd(
  amountRaw: bigint | null,
  coinId = 'somnia-network', // CoinGecko ID — update when STT is listed
  decimals = 18,
): Promise<number> {
  if (!amountRaw || amountRaw === 0n) return 0
  const price = await fetchPrice(coinId)
  if (price === 0) return 0
  const amount = Number(amountRaw) / Math.pow(10, decimals)
  return amount * price
}
