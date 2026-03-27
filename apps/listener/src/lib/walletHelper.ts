// apps/listener/src/lib/walletHelper.ts

import { supabase } from '../config/supabase.js'

// ─── In-memory wallet dedup cache ─────────────────────────────────────────────
// ensureWallet is called for every single event processed. Without a cache,
// this means one Supabase upsert per event even for wallets we wrote minutes
// ago. The knownWallets Set tracks addresses upserted this session so repeat
// calls are a cheap Set.has() instead of a network round-trip.
//
// Cap at 50k entries (~4–5 MB). On overflow we clear the whole set — entries
// are cheap to re-verify once per session on the next call.
const WALLET_CACHE_MAX = 50_000
const knownWallets = new Set<string>()

function markWalletKnown(address: string): void {
  if (knownWallets.size >= WALLET_CACHE_MAX) {
    knownWallets.clear()
  }
  knownWallets.add(address)
}

export async function ensureWallet(address: string): Promise<void> {
  if (!address || address === '0x0000000000000000000000000000000000000000') return

  const addr = address.toLowerCase()

  // Skip DB call entirely for wallets already confirmed this session
  if (knownWallets.has(addr)) return

  const payload = {
    address: addr,
    updated_at: new Date().toISOString(),
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { error } = await supabase
        .from('wallets')
        .upsert(payload, { onConflict: 'address', ignoreDuplicates: true })

      if (!error) {
        markWalletKnown(addr)
        return
      }

      if (!error.message.toLowerCase().includes('fetch failed') || attempt === 3) {
        console.error(`[WalletUpsert] Failed for ${address}:`, error.message)
        return
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.toLowerCase().includes('fetch failed') || attempt === 3) {
        console.error(`[WalletUpsert] Failed for ${address}:`, message)
        return
      }
    }

    await sleep(attempt * 300)
  }
}

export async function incrementWalletStats(
  address: string,
  volumeUsd: number,
): Promise<void> {
  if (!address) return
  await supabase.rpc('increment_wallet_stats', {
    p_address: address.toLowerCase(),
    p_volume_usd: volumeUsd,
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}