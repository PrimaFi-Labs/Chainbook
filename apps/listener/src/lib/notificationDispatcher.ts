// apps/listener/src/lib/notificationDispatcher.ts

import { supabase } from '../config/supabase.js'
import type { PostType } from '@chainbook/shared'
import { env } from '../config/env.js'

interface NotifyParams {
  postId: string
  walletAddress: string
  contractAddress: string | null
  amountUsd: number
  isWhaleAlert: boolean
  postType: PostType
}

export async function dispatchNotifications(params: NotifyParams): Promise<void> {
  const { postId, walletAddress, contractAddress, amountUsd, isWhaleAlert } = params

  // Run all SELECT queries in parallel — previously these were 4 sequential
  // awaits, each blocking the next. With Promise.all they overlap completely,
  // cutting dispatch latency by ~75% and releasing the DB connection faster.
  const [
    followersResult,
    walletTrackersResult,
    contractTrackersResult,
    alertSubsResult,
    whaleSubsResult,
  ] = await Promise.all([
    // 1. Followers of this wallet
    supabase
      .from('follows')
      .select('follower')
      .eq('subject', walletAddress.toLowerCase()),

    // 2. Users tracking this wallet
    supabase
      .from('tracked_entities')
      .select('tracker')
      .eq('entity_address', walletAddress.toLowerCase())
      .eq('entity_type', 'WALLET'),

    // 3. Users tracking this contract (parallel even when contractAddress is null — returns empty)
    contractAddress
      ? supabase
          .from('tracked_entities')
          .select('tracker')
          .eq('entity_address', contractAddress.toLowerCase())
          .eq('entity_type', 'CONTRACT')
      : Promise.resolve({ data: null, error: null }),

    // 4. Alert subscriptions for this wallet
    supabase
      .from('alert_subscriptions')
      .select('wallet_address, alert_type, threshold_usd, target_address')
      .eq('target_address', walletAddress.toLowerCase()),

    // 5. Whale alert subscribers (only fetched when needed)
    isWhaleAlert
      ? supabase
          .from('alert_subscriptions')
          .select('wallet_address')
          .eq('alert_type', 'WHALE_MOVE')
      : Promise.resolve({ data: null, error: null }),
  ])

  const notifications: Array<{
    wallet_address: string
    post_id: string
    type: string
  }> = []

  // 1. Followers
  if (followersResult.data && followersResult.data.length > 0) {
    for (const { follower } of followersResult.data) {
      notifications.push({
        wallet_address: follower,
        post_id: postId,
        type: 'FOLLOWED_WALLET_ACTIVITY',
      })
    }
  }

  // 2. Wallet trackers
  if (walletTrackersResult.data && walletTrackersResult.data.length > 0) {
    for (const { tracker } of walletTrackersResult.data) {
      notifications.push({
        wallet_address: tracker,
        post_id: postId,
        type: 'TRACKED_WALLET',
      })
    }
  }

  // 3. Contract trackers
  if (contractTrackersResult.data && contractTrackersResult.data.length > 0) {
    for (const { tracker } of contractTrackersResult.data) {
      notifications.push({
        wallet_address: tracker,
        post_id: postId,
        type: 'TRACKED_CONTRACT',
      })
    }
  }

  // 4. Alert subscriptions
  if (alertSubsResult.data && alertSubsResult.data.length > 0) {
    for (const sub of alertSubsResult.data) {
      if (sub.alert_type === 'ANY_ACTIVITY') {
        notifications.push({
          wallet_address: sub.wallet_address,
          post_id: postId,
          type: 'ALERT_ACTIVITY',
        })
      }
      if (sub.alert_type === 'LARGE_TRADE') {
        const threshold = sub.threshold_usd ?? env.ALERT_LARGE_TRADE_USD
        if (amountUsd >= threshold) {
          notifications.push({
            wallet_address: sub.wallet_address,
            post_id: postId,
            type: 'ALERT_LARGE_TRADE',
          })
        }
      }
    }
  }

  // 5. Whale alert subscribers
  if (isWhaleAlert && whaleSubsResult.data && whaleSubsResult.data.length > 0) {
    for (const { wallet_address } of whaleSubsResult.data) {
      notifications.push({
        wallet_address,
        post_id: postId,
        type: 'WHALE_ALERT',
      })
    }
  }

  if (notifications.length === 0) return

  // Deduplicate by wallet_address + post_id + type
  const unique = Array.from(
    new Map(
      notifications.map((n) => [`${n.wallet_address}-${n.post_id}-${n.type}`, n]),
    ).values(),
  )

  const { error } = await supabase.from('notifications').insert(unique)
  if (error) {
    console.error('[Notifications] Insert error:', error.message)
  }
}