'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { AnimatePresence } from 'framer-motion'
import { useAccount } from 'wagmi'
import { usePrivy } from '@privy-io/react-auth'
import { PostCard } from './PostCard'
import { SuggestedFollows } from './SuggestedFollows'
import { useSoundContext } from '@/components/providers/SoundProvider'
import { createClient } from '@/lib/supabase/client'
import { getCommentCounts } from '@/lib/api/comments'
import { isExcludedContract } from '@/lib/utils'
import { SOUNDS } from '@/lib/sounds/soundManager'
import type { Post, PostType } from '@chainbook/shared'

const PAGE_SIZE = 30

interface FeedStreamProps {
  initialPosts: Post[]
}

type FeedMode = 'for_you' | 'following' | 'spotlight'
type SpotlightEventFilter =
  | 'all'
  | 'TRANSFER'
  | 'SWAP'
  | 'MINT'
  | 'DAO_VOTE'
  | 'LIQUIDITY'
  | 'CONTRACT_DEPLOY'
  | 'NFT_TRADE'

function matchesSpotlightEventFilter(type: PostType, filter: SpotlightEventFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'LIQUIDITY') return type === 'LIQUIDITY_ADD' || type === 'LIQUIDITY_REMOVE'
  return type === filter
}

export function FeedStream({ initialPosts }: FeedStreamProps) {
  const [posts, setPosts] = useState<Post[]>(initialPosts)
  const [newCount, setNewCount] = useState(0)
  const [mode, setMode] = useState<FeedMode>('for_you')
  const [spotlightContractFilter, setSpotlightContractFilter] = useState('')
  const [spotlightEventFilter, setSpotlightEventFilter] = useState<SpotlightEventFilter>('all')
  const [followingAddresses, setFollowingAddresses] = useState<string[]>([])
  const [followingLoaded, setFollowingLoaded] = useState(false)

  // ── Infinite scroll state ──────────────────────────────────────────────────
  // cursor: created_at of the oldest post in the list, used to fetch the next page.
  // spotlightCursor: created_at of the oldest row in reactivity_spotlight_posts,
  //   used to paginate that table before fetching the corresponding posts.
  // hasMore: false when the last page returned fewer rows than PAGE_SIZE.
  // isLoadingMore: prevents concurrent loadMore calls.
  // firstFetchDone: tracks whether the initial fetchLatest has run after a mode
  //   switch, so subsequent polls don't overwrite the cursor.
  const [cursor, setCursor] = useState<string | null>(
    initialPosts.length > 0 ? initialPosts[initialPosts.length - 1].created_at : null,
  )
  const [spotlightCursor, setSpotlightCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(initialPosts.length >= PAGE_SIZE)
  const [isLoadingMore, setIsLoadingMore] = useState(false)

  // true on mount because initialPosts already seeded the cursor
  const firstFetchDoneRef = useRef(initialPosts.length > 0)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const supabase = createClient()
  const { address: wagmiAddress } = useAccount()
  const { user } = usePrivy()
  const { play: playSound } = useSoundContext()
  const viewerAddress = wagmiAddress ?? user?.wallet?.address

  const normalizedSpotlightContract = spotlightContractFilter.trim().toLowerCase()

  const playLikeSound = useCallback(() => {
    void playSound(SOUNDS.SOCIAL.like)
  }, [playSound])

  const filterContractPosts = useCallback((postsToFilter: Post[]): Post[] => {
    return postsToFilter.filter(
      (post) => !isExcludedContract((post.wallet as any)?.contract_type),
    )
  }, [])

  const prependPost = useCallback(
    (post: Post) => {
      if (isExcludedContract((post.wallet as any)?.contract_type)) return
      setPosts((prev) => {
        if (prev.some((p) => p.id === post.id)) return prev
        return [post, ...prev]
      })
      setNewCount((c) => c + 1)
      if (post.is_whale_alert) {
        void playSound(SOUNDS.ALERT.whale)
      }
    },
    [playSound],
  )

  const syncCommentCounts = useCallback(
    async (postIds: string[]) => {
      if (postIds.length === 0) return
      try {
        const counts = await getCommentCounts(postIds)
        setPosts((prev) => {
          let changed = false
          const next = prev.map((p) => {
            const count = counts[p.id]
            if (count === undefined) return p
            const current = p.comment_count ?? 0
            if (current === count) return p
            changed = true
            return { ...p, comment_count: count }
          })
          return changed ? next : prev
        })
      } catch (error) {
        console.warn('Comment count sync failed:', error)
      }
    },
    [],
  )

  // ── switchMode ─────────────────────────────────────────────────────────────
  // Resets all pagination state so the new mode starts fresh.
  function switchMode(newMode: FeedMode) {
    setPosts([])
    setNewCount(0)
    setCursor(null)
    setSpotlightCursor(null)
    setHasMore(true)
    firstFetchDoneRef.current = false
    setMode(newMode)
  }

  // ── loadMore ───────────────────────────────────────────────────────────────
  // Called by the IntersectionObserver when the sentinel comes into view.
  // Fetches the next page of posts older than the current cursor and appends them.
  const loadMore = useCallback(async () => {
    if (isLoadingMore || !hasMore) return
    setIsLoadingMore(true)

    try {
      if (mode === 'for_you') {
        if (!cursor) { setHasMore(false); return }

        let query = supabase
          .from('posts')
          .select('*, wallet:wallets(*)')
          .lt('created_at', cursor)
          .order('created_at', { ascending: false })
          .limit(PAGE_SIZE)

        if (followingAddresses.length > 0) {
          const inList = followingAddresses.join(',')
          query = query.or(
            `wallet_address.in.(${inList}),is_whale_alert.eq.true,is_significant.eq.true`,
          )
        } else {
          query = query.eq('is_significant', true)
        }

        const { data, error } = await query
        if (error || !data) return

        const filtered = filterContractPosts(data)
        if (filtered.length < PAGE_SIZE) setHasMore(false)
        if (filtered.length > 0) {
          setCursor(filtered[filtered.length - 1].created_at)
          setPosts((prev) => {
            const seen = new Set(prev.map((p) => p.id))
            return [...prev, ...filtered.filter((p) => !seen.has(p.id))]
          })
        } else {
          setHasMore(false)
        }

      } else if (mode === 'following') {
        if (!cursor || followingAddresses.length === 0) { setHasMore(false); return }

        const { data, error } = await supabase
          .from('posts')
          .select('*, wallet:wallets(*)')
          .in('wallet_address', followingAddresses)
          .lt('created_at', cursor)
          .order('created_at', { ascending: false })
          .limit(PAGE_SIZE)

        if (error || !data) return

        const filtered = filterContractPosts(data)
        if (filtered.length < PAGE_SIZE) setHasMore(false)
        if (filtered.length > 0) {
          setCursor(filtered[filtered.length - 1].created_at)
          setPosts((prev) => {
            const seen = new Set(prev.map((p) => p.id))
            return [...prev, ...filtered.filter((p) => !seen.has(p.id))]
          })
        } else {
          setHasMore(false)
        }

      } else if (mode === 'spotlight') {
        // Paginate reactivity_spotlight_posts first to get the next batch of IDs
        let spotlightQuery = supabase
          .from('reactivity_spotlight_posts')
          .select('post_id, created_at')
          .order('created_at', { ascending: false })
          .limit(PAGE_SIZE)

        if (spotlightCursor) {
          spotlightQuery = spotlightQuery.lt('created_at', spotlightCursor)
        }

        const { data: spotlightRows, error: spotlightError } = await spotlightQuery
        if (spotlightError || !spotlightRows || spotlightRows.length === 0) {
          setHasMore(false)
          return
        }

        setSpotlightCursor(spotlightRows[spotlightRows.length - 1].created_at)
        if (spotlightRows.length < PAGE_SIZE) setHasMore(false)

        const ids = spotlightRows.map((r) => r.post_id)
        let query = supabase
          .from('posts')
          .select('*, wallet:wallets(*)')
          .in('id', ids)
          .order('created_at', { ascending: false })

        if (normalizedSpotlightContract) {
          const isExactAddress = /^0x[a-f0-9]{40}$/.test(normalizedSpotlightContract)
          if (isExactAddress) {
            query = query.eq('contract_address', normalizedSpotlightContract)
          } else {
            query = query.ilike('contract_address', `%${normalizedSpotlightContract}%`)
          }
        }
        if (spotlightEventFilter !== 'all') {
          if (spotlightEventFilter === 'LIQUIDITY') {
            query = query.in('type', ['LIQUIDITY_ADD', 'LIQUIDITY_REMOVE'])
          } else {
            query = query.eq('type', spotlightEventFilter)
          }
        }

        const { data, error } = await query
        if (error || !data) return

        const filtered = filterContractPosts(data)
        if (filtered.length > 0) {
          setPosts((prev) => {
            const seen = new Set(prev.map((p) => p.id))
            return [...prev, ...filtered.filter((p) => !seen.has(p.id))]
          })
        }
      }
    } finally {
      setIsLoadingMore(false)
    }
  }, [
    isLoadingMore, hasMore, mode, cursor, spotlightCursor,
    followingAddresses, normalizedSpotlightContract, spotlightEventFilter,
    supabase, filterContractPosts,
  ])

  // ── IntersectionObserver ───────────────────────────────────────────────────
  // Watches the sentinel div at the bottom of the list. Fires loadMore when
  // the user scrolls within 200px of it.
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !isLoadingMore) {
          void loadMore()
        }
      },
      { rootMargin: '200px' },
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, isLoadingMore, loadMore])

  // ── Following addresses ────────────────────────────────────────────────────
  useEffect(() => {
    if (!viewerAddress) {
      setFollowingAddresses([])
      setFollowingLoaded(true)
      return
    }
    setFollowingLoaded(false)
    const addr = viewerAddress.toLowerCase()
    supabase
      .from('follows')
      .select('subject')
      .eq('follower', addr)
      .then(({ data }) => {
        setFollowingAddresses((data ?? []).map((d) => d.subject))
        setFollowingLoaded(true)
      })
  }, [viewerAddress])

  // ── fetchLatest + realtime subscription ───────────────────────────────────
  useEffect(() => {
    let isMounted = true

    async function fetchLatest() {
      let query = supabase
        .from('posts')
        .select('*, wallet:wallets(*)')
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE)

      if (mode === 'following') {
        if (!followingLoaded) return
        if (followingAddresses.length === 0) {
          if (isMounted) setPosts([])
          return
        }
        query = query.in('wallet_address', followingAddresses)

      } else if (mode === 'spotlight') {
        const { data: spotlightRows, error: spotlightError } = await supabase
          .from('reactivity_spotlight_posts')
          .select('post_id, created_at')
          .order('created_at', { ascending: false })
          .limit(PAGE_SIZE)

        if (spotlightError || !isMounted) return

        const ids = (spotlightRows ?? []).map((r) => r.post_id)
        if (ids.length === 0) {
          if (isMounted) { setPosts([]); setHasMore(false) }
          return
        }

        // Set spotlight cursor from this initial page so loadMore knows where to start
        if (isMounted && !firstFetchDoneRef.current && spotlightRows && spotlightRows.length > 0) {
          setSpotlightCursor(spotlightRows[spotlightRows.length - 1].created_at)
          setHasMore(spotlightRows.length >= PAGE_SIZE)
        }

        query = query.in('id', ids)
        if (normalizedSpotlightContract) {
          const isExactAddress = /^0x[a-f0-9]{40}$/.test(normalizedSpotlightContract)
          if (isExactAddress) {
            query = query.eq('contract_address', normalizedSpotlightContract)
          } else {
            query = query.ilike('contract_address', `%${normalizedSpotlightContract}%`)
          }
        }
        if (spotlightEventFilter !== 'all') {
          if (spotlightEventFilter === 'LIQUIDITY') {
            query = query.in('type', ['LIQUIDITY_ADD', 'LIQUIDITY_REMOVE'])
          } else {
            query = query.eq('type', spotlightEventFilter)
          }
        }

      } else {
        // for_you
        if (followingAddresses.length > 0) {
          const inList = followingAddresses.join(',')
          query = query.or(
            `wallet_address.in.(${inList}),is_whale_alert.eq.true,is_significant.eq.true`,
          )
        } else {
          query = query.eq('is_significant', true)
        }
      }

      const { data, error } = await query
      if (error || !data || !isMounted) return

      const filteredData = filterContractPosts(data)

      setPosts((prev) => {
        const seen = new Set(prev.map((p) => p.id))
        const incoming = filteredData.filter((p) => !seen.has(p.id))
        if (incoming.length > 0) setNewCount((c) => c + incoming.length)
        return incoming.length > 0 ? [...incoming, ...prev] : prev
      })

      // Only set cursor on the first fetch after a mode switch — polls must not
      // overwrite it, otherwise scrolling back up resets the loadMore position.
      if (!firstFetchDoneRef.current && filteredData.length > 0) {
        firstFetchDoneRef.current = true
        if (mode !== 'spotlight') {
          setCursor(filteredData[filteredData.length - 1].created_at)
          setHasMore(filteredData.length >= PAGE_SIZE)
        }
      }
    }

    const channel = supabase
      .channel('chainbook-feed')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'posts' },
        async (payload) => {
          if (mode === 'spotlight') {
            const { data: spotlightRow } = await supabase
              .from('reactivity_spotlight_posts')
              .select('post_id')
              .eq('post_id', payload.new.id)
              .maybeSingle()
            if (!spotlightRow) return
          }
          const { data } = await supabase
            .from('posts')
            .select('*, wallet:wallets(*)')
            .eq('id', payload.new.id)
            .single()
          if (!data) return
          if (mode === 'spotlight') {
            const contractAddress = (data as Post).contract_address?.toLowerCase() ?? ''
            if (normalizedSpotlightContract) {
              const isExact = /^0x[a-f0-9]{40}$/.test(normalizedSpotlightContract)
              if (isExact && contractAddress !== normalizedSpotlightContract) return
              if (!isExact && !contractAddress.includes(normalizedSpotlightContract)) return
            }
            if (!matchesSpotlightEventFilter((data as Post).type, spotlightEventFilter)) return
          }
          prependPost(data as Post)
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'posts' },
        (payload) => {
          if (!isMounted) return
          setPosts((prev) =>
            prev.map((p) =>
              p.id === payload.new.id
                ? {
                    ...p,
                    like_count: payload.new.like_count,
                    comment_count: payload.new.comment_count,
                  }
                : p,
            ),
          )
        },
      )
      .subscribe()

    void fetchLatest()
    const pollId = setInterval(fetchLatest, 30_000)

    return () => {
      isMounted = false
      clearInterval(pollId)
      supabase.removeChannel(channel)
    }
  }, [
    prependPost,
    supabase,
    mode,
    followingAddresses,
    followingLoaded,
    normalizedSpotlightContract,
    spotlightEventFilter,
    filterContractPosts,
  ])

  // ── Comment count sync ─────────────────────────────────────────────────────
  useEffect(() => {
    if (posts.length === 0) return
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
    syncTimerRef.current = setTimeout(() => {
      void syncCommentCounts(posts.map((p) => p.id))
    }, 200)
    return () => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
    }
  }, [posts, syncCommentCounts])

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-3">

      {/* Mode tabs */}
      <div className="flex items-center gap-2 text-xs">
        <button
          onClick={() => switchMode('for_you')}
          className={`px-3 py-1 rounded-full border ${mode === 'for_you' ? 'border-blue-400 text-blue-400' : 'border-border text-muted-foreground'}`}
        >
          For You
        </button>
        <button
          onClick={() => switchMode('following')}
          className={`px-3 py-1 rounded-full border ${mode === 'following' ? 'border-blue-400 text-blue-400' : 'border-border text-muted-foreground'}`}
        >
          Following
        </button>
        <button
          onClick={() => switchMode('spotlight')}
          className={`px-3 py-1 rounded-full border ${mode === 'spotlight' ? 'border-blue-400 text-blue-400' : 'border-border text-muted-foreground'}`}
        >
          Spotlight
        </button>
      </div>

      {/* Spotlight filters */}
      {mode === 'spotlight' && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <input
            value={spotlightContractFilter}
            onChange={(e) => {
              setSpotlightContractFilter(e.target.value)
              setPosts([])
              setNewCount(0)
              setCursor(null)
              setSpotlightCursor(null)
              setHasMore(true)
              firstFetchDoneRef.current = false
            }}
            placeholder="Filter by contract address"
            className="w-full max-w-sm rounded-md border border-border bg-transparent px-3 py-1.5 text-foreground outline-none focus:border-blue-400"
          />
          {(
            [
              ['all', 'All'],
              ['TRANSFER', 'Transfer'],
              ['SWAP', 'Swap'],
              ['MINT', 'Mint'],
              ['DAO_VOTE', 'DAO'],
              ['LIQUIDITY', 'Liquidity'],
              ['CONTRACT_DEPLOY', 'Deploy'],
              ['NFT_TRADE', 'NFT'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              onClick={() => {
                setSpotlightEventFilter(value)
                setPosts([])
                setNewCount(0)
                setCursor(null)
                setSpotlightCursor(null)
                setHasMore(true)
                firstFetchDoneRef.current = false
              }}
              className={`rounded-md border px-3 py-1.5 ${
                spotlightEventFilter === value
                  ? 'border-blue-400 text-blue-400'
                  : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              {label}
            </button>
          ))}
          <button
            onClick={() => {
              setSpotlightContractFilter('')
              setSpotlightEventFilter('all')
              setPosts([])
              setNewCount(0)
              setCursor(null)
              setSpotlightCursor(null)
              setHasMore(true)
              firstFetchDoneRef.current = false
            }}
            className="rounded-md border border-border px-3 py-1.5 text-muted-foreground hover:text-foreground"
          >
            Reset
          </button>
        </div>
      )}

      {/* New posts indicator */}
      {newCount > 0 && (
        <button
          onClick={() => {
            setNewCount(0)
            window.scrollTo({ top: 0, behavior: 'smooth' })
          }}
          className="text-xs text-blue-400 font-medium text-center py-2 border border-blue-400/20 rounded-lg bg-blue-400/5 hover:bg-blue-400/10 transition-colors"
        >
          ↑ {newCount} new {newCount === 1 ? 'event' : 'events'}
        </button>
      )}

      {/* Posts list */}
      <AnimatePresence mode="popLayout">
        {posts.map((post) => (
          <PostCard
            key={post.id}
            post={post}
            onLikeSound={playLikeSound}
            viewerAddress={viewerAddress?.toLowerCase()}
            followingAddresses={followingAddresses}
            onFollowChange={(address, following) => {
              setFollowingAddresses((prev) =>
                following
                  ? [...prev, address.toLowerCase()]
                  : prev.filter((a) => a !== address.toLowerCase()),
              )
            }}
          />
        ))}
      </AnimatePresence>

      {/* Infinite scroll sentinel + loading / end states */}
      <div ref={sentinelRef} className="py-6 flex justify-center">
        {isLoadingMore && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-block w-3 h-3 border-2 border-cyan-400/40 border-t-cyan-400 rounded-full animate-spin" />
            Loading more...
          </div>
        )}
        {!hasMore && posts.length > 0 && (
          <p className="text-xs text-muted-foreground">
            You've reached the beginning of the feed.
          </p>
        )}
      </div>

      {/* Empty state */}
      {posts.length === 0 && !isLoadingMore && (
        <div className="text-center text-muted-foreground py-8">
          {mode === 'following' && !followingLoaded ? (
            <>
              <p className="text-3xl mb-3">⏳</p>
              <p className="text-sm">Loading feed…</p>
            </>
          ) : mode === 'following' && followingLoaded && followingAddresses.length === 0 ? (
            <SuggestedFollows
              followingAddresses={followingAddresses}
              onFollowChange={(addr: string, following: boolean) => {
                setFollowingAddresses((prev) =>
                  following
                    ? [...prev, addr.toLowerCase()]
                    : prev.filter((a) => a !== addr.toLowerCase()),
                )
              }}
            />
          ) : (
            <>
              <p className="text-4xl mb-3">📡</p>
              <p className="text-sm">
                {mode === 'following'
                  ? 'No recent activity from wallets you follow.'
                  : mode === 'spotlight'
                    ? 'No spotlight events yet.'
                    : 'Listening for on-chain activity...'}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}