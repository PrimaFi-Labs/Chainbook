// apps/listener/src/lib/trendingEngine.ts

import { supabase } from '../config/supabase.js'
import { env } from '../config/env.js'

interface EntityWindow {
  eventCount: number
  wallets: Set<string>
  lastActivity: number
}

const windows = new Map<string, EntityWindow>()
const WINDOW_MS = 3_600_000 // 1 hour sliding window

export function incrementTrending(entityAddress: string, wallet: string): void {
  const addr = entityAddress.toLowerCase()
  const existing = windows.get(addr)

  if (existing) {
    existing.eventCount++
    existing.wallets.add(wallet.toLowerCase())
    existing.lastActivity = Date.now()
  } else {
    windows.set(addr, {
      eventCount: 1,
      wallets: new Set([wallet.toLowerCase()]),
      lastActivity: Date.now(),
    })
  }
}

export async function flushTrending(): Promise<void> {
  if (windows.size === 0) return

  const now = Date.now()

  for (const [addr, window] of windows.entries()) {
    if (now - window.lastActivity > WINDOW_MS) {
      windows.delete(addr)
    }
  }

  if (windows.size === 0) return

  const sorted = Array.from(windows.entries())
    .sort((a, b) => b[1].eventCount - a[1].eventCount)
    .slice(0, 50)

  const rows = sorted.map(([addr, data], index) => ({
    entity_address: addr,
    entity_type: 'CONTRACT',
    event_count: data.eventCount,
    unique_wallets: data.wallets.size,
    velocity: parseFloat((data.eventCount / 60).toFixed(4)),
    rank: index + 1,
    updated_at: new Date().toISOString(),
  }))

  const { error } = await supabase
    .from('trending_entities')
    .upsert(rows, { onConflict: 'entity_address' })

  if (error) {
    console.error('[TrendingEngine] Flush error:', error.message)
  } else {
    console.log(`[TrendingEngine] Flushed ${rows.length} trending entities`)
  }
}

export function startTrendingFlushInterval(): void {
  setInterval(flushTrending, env.TRENDING_REFRESH_INTERVAL_MS)
  console.log(`[TrendingEngine] Flush interval started (${env.TRENDING_REFRESH_INTERVAL_MS}ms)`)
}