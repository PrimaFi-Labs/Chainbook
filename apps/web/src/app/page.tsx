//apps/web/src/app/page.tsx

import { AppShell } from '@/components/layout/AppShell'
import { FeedStream } from '@/components/feed/FeedStream'
import { createAdminClient } from '@/lib/supabase/server'
import Image from 'next/image'
import type { Post } from '@chainbook/shared'

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const supabase = createAdminClient()
  const minUsd = Number(process.env.NEXT_PUBLIC_MIN_FEED_USD ?? '0')
  const minScore = Number(process.env.NEXT_PUBLIC_MIN_FEED_SCORE ?? '0')

  let query = supabase
    .from('posts')
    .select('*, wallet:wallets(*)')
    .order('created_at', { ascending: false })
    .limit(30)

  if (minUsd > 0) query = query.gte('amount_usd', minUsd)
  if (minScore > 0) query = query.gte('significance_score', minScore)
  query = query.eq('is_significant', true)

  const { data: posts, error } = await query

  return (
    <AppShell>
      <div className="flex flex-col gap-6">
        {/* Page Header */}
        <div className="glass-hero rounded-2xl border px-4 py-3 flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-400 via-blue-500 to-pink-500 flex items-center justify-center shadow-lg">
              <Image
                src="/assets/chainbook-icon.png"
                alt="Chainbook icon"
                width={20}
                height={20}
                className="h-5 w-5"
              />
            </div>
            <div className="flex flex-col">
              <h1 className="text-2xl font-bold text-gradient-brand">
                Live Feed
              </h1>
              <p className="text-xs text-muted-foreground">Real-time on-chain activity tracked</p>
            </div>
          </div>
          <Image
            src="/assets/chainbook-icon.png"
            alt="Chainbook icon"
            width={30}
            height={30}
            className="rounded-lg opacity-90"
          />
        </div>

        {/* Content */}
        {error ? (
          <div className="text-sm text-destructive bg-red-500/10 border border-red-500/30 rounded-lg p-4">
            Failed to load feed: {error.message}
          </div>
        ) : (
          <FeedStream initialPosts={(posts ?? []) as Post[]} />
        )}
      </div>
    </AppShell>
  )
}
