// apps/listener/src/lib/tokenMetadata.ts

import { supabase } from '../config/supabase.js'
import { publicClientHttp } from '../config/chain.js'
import { env } from '../config/env.js'
import type { Hex } from 'viem'

interface TokenMetadata {
  address: string
  name: string | null
  symbol: string | null
  decimals: number | null
  is_nft: boolean
  updated_at: string
}

const ERC20_ABI = [
  {
    name: 'name',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    name: 'symbol',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    name: 'supportsInterface',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'bytes4' }],
    outputs: [{ type: 'bool' }],
  },
] as const

const ERC721_INTERFACE_ID = '0x80ac58cd'

const cache = new Map<string, { value: TokenMetadata; fetchedAt: number }>()

let metadataRpcConcurrent = 0
async function withMetadataRpcLimit<T>(fn: () => Promise<T>): Promise<T> {
  while (metadataRpcConcurrent >= env.MAX_CONCURRENT_RPC_CALLS) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  metadataRpcConcurrent++
  try {
    return await fn()
  } finally {
    metadataRpcConcurrent--
  }
}

function isStale(updatedAt: string): boolean {
  const last = new Date(updatedAt).getTime()
  return Number.isNaN(last) || Date.now() - last > env.TOKEN_METADATA_TTL_MS
}

async function fetchOnChain(address: Hex): Promise<TokenMetadata | null> {
  try {
    const [name, symbol, decimals] = await Promise.allSettled([
      publicClientHttp.readContract({ address, abi: ERC20_ABI, functionName: 'name' }),
      publicClientHttp.readContract({ address, abi: ERC20_ABI, functionName: 'symbol' }),
      publicClientHttp.readContract({ address, abi: ERC20_ABI, functionName: 'decimals' }),
    ])

    let isNft = false
    try {
      isNft = await publicClientHttp.readContract({
        address,
        abi: ERC20_ABI,
        functionName: 'supportsInterface',
        args: [ERC721_INTERFACE_ID],
      })
    } catch {
      isNft = false
    }

    const resolved: TokenMetadata = {
      address: address.toLowerCase(),
      name: name.status === 'fulfilled' ? (name.value as string) : null,
      symbol: symbol.status === 'fulfilled' ? (symbol.value as string) : null,
      decimals: decimals.status === 'fulfilled' ? Number(decimals.value) : null,
      is_nft: isNft === true,
      updated_at: new Date().toISOString(),
    }

    return resolved
  } catch {
    return null
  }
}

export async function getTokenMetadata(address?: string | null): Promise<TokenMetadata | null> {
  if (!address) return null
  const addr = address.toLowerCase()

  const cached = cache.get(addr)
  if (cached && Date.now() - cached.fetchedAt < env.TOKEN_METADATA_TTL_MS) {
    return cached.value
  }

  const { data: existing } = await supabase
    .from('token_metadata')
    .select('*')
    .eq('address', addr)
    .single()

  if (existing && !isStale(existing.updated_at)) {
    const value = existing as TokenMetadata
    cache.set(addr, { value, fetchedAt: Date.now() })
    return value
  }

  const onChain = await withMetadataRpcLimit(() => fetchOnChain(addr as Hex))
  if (!onChain) return existing ?? null

  await supabase
    .from('token_metadata')
    .upsert(onChain, { onConflict: 'address' })

  cache.set(addr, { value: onChain, fetchedAt: Date.now() })
  return onChain
}