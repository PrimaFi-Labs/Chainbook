//apps/web/src/components/feed/PostCard.tsx

'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import {
  Check,
  Copy,
  ExternalLink,
  Heart,
  MessageCircle,
  Share2,
  Sparkles,
  UserMinus,
  UserPlus,
} from 'lucide-react'
import { useWriteContract } from 'wagmi'
import { useConnectedAccount } from '@/lib/hooks/useConnectedAccount'
import {
  cn,
  displayName,
  formatUsd,
  isNativeToken,
  POST_TYPE_META,
  shortAddress,
  timeAgo,
  txUrl,
} from '@/lib/utils'
import { CONTRACT_ADDRESSES, POST_REGISTRY_ABI } from '@/lib/contracts'
import { WalletAvatar } from '@/components/wallet/WalletAvatar'
import { followWallet, unfollowWallet } from '@/lib/api/follows'
import { likePost } from '@/lib/api/likes'
import type { Post } from '@chainbook/shared'

interface PostCardProps {
  post: Post
  onLikeSound?: () => void
  viewerAddress?: string
  followingAddresses?: string[]
  onFollowChange?: (address: string, following: boolean) => void
  showFollowButton?: boolean
}

function likeKey(walletAddress: string, postId: string) {
  return `chainbook_liked_${walletAddress.toLowerCase()}_${postId}`
}

export function PostCard({
  post,
  onLikeSound,
  viewerAddress,
  followingAddresses,
  onFollowChange,
  showFollowButton = true,
}: PostCardProps) {
  const { isConnected, address, requireConnection, isWaitingForConnection } = useConnectedAccount()
  const { writeContractAsync } = useWriteContract()

  const [localLikeCount, setLocalLikeCount] = useState(post.like_count ?? 0)
  const [hasLiked, setHasLiked] = useState(false)
  const [likeError, setLikeError] = useState<string | null>(null)
  const [isFollowPending, setIsFollowPending] = useState(false)
  const [showShare, setShowShare] = useState(false)
  const [copied, setCopied] = useState(false)
  const shareRef = useRef<HTMLDivElement>(null)

  const postWalletAddress = post.wallet_address.toLowerCase()
  const isOwnPost = !!viewerAddress && viewerAddress === postWalletAddress
  const isFollowingPost = followingAddresses?.includes(postWalletAddress) ?? false
  const commentCount = post.comment_count ?? 0
  const typeMeta = POST_TYPE_META[post.type]

  useEffect(() => {
    if (!address) return
    setHasLiked(localStorage.getItem(likeKey(address, post.id)) === '1')
  }, [address, post.id])

  useEffect(() => {
    setLocalLikeCount(post.like_count ?? 0)
  }, [post.like_count])

  useEffect(() => {
    if (!showShare) return
    function onClickOutside(e: MouseEvent) {
      if (shareRef.current && !shareRef.current.contains(e.target as Node)) {
        setShowShare(false)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [showShare])

  async function handleLike() {
    setLikeError(null)
    if (!requireConnection()) return
    if (hasLiked || isWaitingForConnection) return

    setHasLiked(true)
    setLocalLikeCount((c) => c + 1)
    onLikeSound?.()
    if (address) localStorage.setItem(likeKey(address, post.id), '1')

    try {
      const updatedCount = await likePost({ postId: post.id, walletAddress: address! })
      setLocalLikeCount(updatedCount)
      writeContractAsync({
        address: CONTRACT_ADDRESSES.postRegistry,
        abi: POST_REGISTRY_ABI,
        functionName: 'likePost',
        args: [post.post_id_hash as `0x${string}`],
      }).catch((err) => console.warn('On-chain like skipped:', err))
    } catch (error) {
      setLocalLikeCount((c) => Math.max(0, c - 1))
      setHasLiked(false)
      if (address) localStorage.removeItem(likeKey(address, post.id))
      setLikeError(error instanceof Error ? error.message : 'Failed to like post')
    }
  }

  async function handleFollow() {
    if (!requireConnection()) return
    if (isFollowPending || isWaitingForConnection || isOwnPost) return

    setIsFollowPending(true)
    const follower = address!.toLowerCase()
    const subject = postWalletAddress

    try {
      if (isFollowingPost) {
        await unfollowWallet({ follower, subject })
        onFollowChange?.(subject, false)
      } else {
        await followWallet({ follower, subject })
        onFollowChange?.(subject, true)
      }
    } catch (err) {
      console.error('Follow action failed:', err)
    } finally {
      setIsFollowPending(false)
    }
  }

  function handleShareCopy() {
    navigator.clipboard.writeText(`${window.location.origin}/post/${post.id}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  async function handleNativeShare() {
    const url = `${window.location.origin}/post/${post.id}`
    if (!navigator.share) {
      handleShareCopy()
      return
    }
    try {
      await navigator.share({
        title: 'Chainbook On-chain Activity',
        text: 'On-chain activity spotted on Chainbook.',
        url,
      })
      setShowShare(false)
    } catch {
      // user cancelled share prompt
    }
  }

  function handleShareTwitter() {
    const url = encodeURIComponent(`${window.location.origin}/post/${post.id}`)
    const text = encodeURIComponent('On-chain activity spotted on Chainbook')
    window.open(`https://twitter.com/intent/tweet?text=${text}&url=${url}`, '_blank', 'noopener')
    setShowShare(false)
  }

  function handleShareTelegram() {
    const url = encodeURIComponent(`${window.location.origin}/post/${post.id}`)
    window.open(`https://t.me/share/url?url=${url}`, '_blank', 'noopener')
    setShowShare(false)
  }

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.2 }}
      className={cn(
        'glass-panel rounded-2xl border p-4 flex flex-col gap-3 transition-all hover:shadow-2xl cursor-pointer',
        post.is_whale_alert && 'border-cyan-400/45 bg-gradient-to-br from-card/95 via-card/95 to-cyan-500/10 shadow-cyan-500/20',
        !post.is_whale_alert && 'border-border/70 hover:border-cyan-400/25',
      )}
    >
      {post.is_whale_alert && (
        <div className="flex items-center gap-2 bg-gradient-to-r from-cyan-500/20 via-blue-500/20 to-purple-500/20 text-cyan-200 text-xs font-bold px-3 py-2 rounded-xl border border-cyan-400/40">
          <Sparkles className="w-3.5 h-3.5" />
          <span>WHALE ALERT</span>
          <span className="ml-auto inline-flex h-2 w-2 rounded-full bg-cyan-300 animate-pulse" />
        </div>
      )}

      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <WalletAvatar
            address={post.wallet_address}
            tier={(post.wallet?.tier ?? 'SHRIMP')}
            ensName={post.wallet?.ens_name}
            label={post.wallet?.label}
            size="md"
          />
          <div className="flex flex-col min-w-0">
            <Link href={`/wallet/${post.wallet_address}`} className="font-medium text-sm text-foreground hover:underline truncate">
              {displayName(post.wallet_address, post.wallet?.ens_name, post.wallet?.label)}
            </Link>
            <span className="text-xs text-muted-foreground">{timeAgo(post.created_at)}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {showFollowButton && !isOwnPost && (isConnected || isWaitingForConnection) && (
            <button
              onClick={handleFollow}
              disabled={isFollowPending || isWaitingForConnection}
              title={isFollowingPost ? 'Unfollow' : 'Follow'}
              className={cn(
                'flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border transition-all transform hover:scale-105 disabled:opacity-40 disabled:scale-100 font-medium',
                isFollowingPost
                  ? 'border-red-400/50 text-red-300 bg-red-500/10 hover:border-red-400/80'
                  : 'border-cyan-400/50 text-cyan-300 bg-cyan-500/10 hover:border-cyan-300/80',
              )}
            >
              {isFollowingPost ? <UserMinus className="w-3 h-3" /> : <UserPlus className="w-3 h-3" />}
              <span>{isFollowingPost ? 'Following' : 'Follow'}</span>
            </button>
          )}
          <div className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium bg-gradient-to-r from-cyan-500/20 to-blue-500/20 text-cyan-200 border border-cyan-500/30">
            <span className="text-base">{typeMeta.icon}</span>
            <span>{typeMeta.label}</span>
          </div>
        </div>
      </div>

      <EventSummary post={post} />

      {likeError && (
        <div className="text-xs text-red-300 bg-red-500/15 rounded-lg px-3 py-2 border border-red-500/40 font-medium">
          {likeError}
        </div>
      )}

      <div className="flex items-center justify-between pt-1 border-t border-border/50">
        <div className="flex items-center gap-4">
          <button
            onClick={handleLike}
            disabled={hasLiked || isWaitingForConnection}
            title={!isConnected ? 'Connect wallet to like' : hasLiked ? 'Already liked' : isWaitingForConnection ? 'Connecting...' : 'Like'}
            className={cn(
              'flex items-center gap-1.5 text-xs transition-all transform hover:scale-110 font-medium',
              hasLiked ? 'text-red-400 cursor-default' : 'text-muted-foreground hover:text-red-400',
              isWaitingForConnection && 'opacity-40 cursor-not-allowed scale-100',
            )}
          >
            <Heart className={cn('w-4 h-4 transition-all', hasLiked && 'fill-red-400 scale-125')} />
            <span>{localLikeCount}</span>
          </button>

          <Link
            href={`/post/${post.id}`}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-cyan-400 transition-all transform hover:scale-110 font-medium"
          >
            <MessageCircle className="w-4 h-4" />
            {commentCount > 0 && <span>{commentCount}</span>}
          </Link>

          <div ref={shareRef} className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation()
                setShowShare((v) => !v)
              }}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-blue-400 transition-all transform hover:scale-110 font-medium"
              title="Share"
            >
              <Share2 className="w-4 h-4" />
            </button>
            {showShare && (
              <div className="absolute bottom-8 left-0 z-50 min-w-[198px] overflow-hidden rounded-2xl border border-cyan-400/25 glass-hero">
                <div className="border-b border-border/60 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-cyan-200">
                  Share Signal
                </div>
                <button
                  onClick={() => {
                    handleShareCopy()
                    setShowShare(false)
                  }}
                  className="flex items-center gap-2 w-full px-3 py-2.5 text-xs text-foreground hover:bg-accent/60 transition-colors text-left"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copied!' : 'Copy link'}
                </button>
                <button
                  onClick={handleNativeShare}
                  className="flex items-center gap-2 w-full px-3 py-2.5 text-xs text-foreground hover:bg-accent/60 transition-colors text-left"
                >
                  <Share2 className="w-3.5 h-3.5" />
                  Share...
                </button>
                <button
                  onClick={handleShareTwitter}
                  className="flex items-center gap-2 w-full px-3 py-2.5 text-xs text-foreground hover:bg-accent/60 transition-colors text-left"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.746l7.73-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
                  Share on X
                </button>
                <button
                  onClick={handleShareTelegram}
                  className="flex items-center gap-2 w-full px-3 py-2.5 text-xs text-foreground hover:bg-accent/60 transition-colors text-left"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0h-.056zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" /></svg>
                  Share on Telegram
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">Block {post.block_number}</span>
          <a
            href={txUrl(post.tx_hash)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ExternalLink className="w-3 h-3" />
            <span className="font-mono">{post.tx_hash.slice(0, 10)}...</span>
          </a>
        </div>
      </div>
    </motion.article>
  )
}

function EventSummary({ post }: { post: Post }) {
  const from = shortAddress(post.wallet_address)
  const meta = post.metadata as Record<string, unknown>

  const tokenSymbol = (meta?.token_symbol as string | null) ?? null
  const tokenInSymbol = (meta?.token_in_symbol as string | null) ?? null
  const tokenOutSymbol = (meta?.token_out_symbol as string | null) ?? null
  const toAddress = (meta?.to as string | null) ?? null
  const fromDeltaRaw = (meta?.reactivity_balance_from_delta as string | null) ?? null
  const toDeltaRaw = (meta?.reactivity_balance_to_delta as string | null) ?? null
  const transferAmountRaw = (meta?.reactivity_transfer_amount_raw as string | number | bigint | null) ?? null
  const tokenDecimals = (meta?.token_in_decimals as number | null) ?? null
  const tokenRawValue = (meta?.value as string | number | bigint | null) ?? post.amount_raw ?? null
  const tokenAmountStr = tokenRawValue ? formatTokenAmount(tokenRawValue, tokenDecimals ?? 18) : null
  const fromDeltaStr = fromDeltaRaw != null ? formatSignedTokenDelta(fromDeltaRaw, tokenDecimals ?? 18) : null
  const toDeltaStr = toDeltaRaw != null ? formatSignedTokenDelta(toDeltaRaw, tokenDecimals ?? 18) : null
  const transferAmountLabel = transferAmountRaw != null ? formatTokenAmount(transferAmountRaw, tokenDecimals ?? 18) : null
  const amountStr = post.amount_usd && isNativeToken(tokenSymbol) ? formatUsd(post.amount_usd) : null
  const tokenInLabel = tokenInSymbol ?? (post.token_in ? shortAddress(post.token_in) : null)
  const tokenOutLabel = tokenOutSymbol ?? (post.token_out ? shortAddress(post.token_out) : null)

  switch (post.type) {
    case 'SWAP':
      return (
        <p className="text-sm text-foreground">
          <span className="font-mono text-muted-foreground">{from}</span>{' '}
          swapped {amountStr ? <span className="font-semibold text-blue-400">{amountStr}</span> : 'tokens'}
          {tokenInLabel && tokenOutLabel && (
            <>
              {' '}from <span className="font-mono text-xs bg-muted px-1 rounded">{tokenInLabel}</span> to{' '}
              <span className="font-mono text-xs bg-muted px-1 rounded">{tokenOutLabel}</span>
            </>
          )}
        </p>
      )
    case 'TRANSFER': {
      const eventKind = typeof meta?.event_kind === 'string' ? meta.event_kind : null
      const approvalSpender = typeof meta?.approval_spender === 'string' ? meta.approval_spender : null
      const tokenLabel = tokenSymbol ?? (post.token_in ? shortAddress(post.token_in) : null)

      if (eventKind === 'APPROVAL') {
        return (
          <p className="text-sm text-foreground">
            <span className="font-mono text-muted-foreground">{from}</span>{' '}
            approved {approvalSpender ? <span className="font-mono text-xs bg-muted px-1 rounded">{shortAddress(approvalSpender)}</span> : 'a spender'}
            {' '}for{' '}
            {tokenAmountStr ? (
              <span className="font-semibold text-green-400">{tokenAmountStr} {tokenLabel}</span>
            ) : (
              <span className="font-semibold text-green-400">token allowance</span>
            )}
          </p>
        )
      }

      return (
        <p className="text-sm text-foreground">
          <span className="font-mono text-muted-foreground">{from}</span>{' '}
          transferred{' '}
          {tokenAmountStr ? (
            <span className="font-semibold text-green-400">{tokenAmountStr} {tokenSymbol ?? ''}</span>
          ) : amountStr ? (
            <span className="font-semibold text-green-400">{amountStr}</span>
          ) : (
            'tokens'
          )}
          {toAddress && (
            <span className="ml-2 text-xs text-muted-foreground">
              to <span className="font-mono">{shortAddress(toAddress)}</span>
            </span>
          )}
          {(fromDeltaStr || toDeltaStr) && (
            <span className="ml-2 text-xs text-muted-foreground">
              {' '}· bal {fromDeltaStr ?? '-'} / {toDeltaStr ?? '+'}
              {transferAmountLabel ? ` (${transferAmountLabel})` : ''}
            </span>
          )}
        </p>
      )
    }
    case 'MINT':
      return (
        <p className="text-sm text-foreground">
          <span className="font-mono text-muted-foreground">{from}</span>{' '}
          minted {post.contract_address ? <span className="font-mono text-xs bg-muted px-1 rounded">{shortAddress(post.contract_address)}</span> : 'an NFT'}
        </p>
      )
    case 'LIQUIDITY_ADD':
    case 'LIQUIDITY_REMOVE':
      return (
        <p className="text-sm text-foreground">
          <span className="font-mono text-muted-foreground">{from}</span>{' '}
          {post.type === 'LIQUIDITY_ADD' ? 'added' : 'removed'} liquidity
          {amountStr && <> worth <span className="font-semibold text-cyan-400">{amountStr}</span></>}
        </p>
      )
    case 'DAO_VOTE':
      return (
        <p className="text-sm text-foreground">
          <span className="font-mono text-muted-foreground">{from}</span>{' '}
          voted on proposal{' '}
          {(post.metadata as { proposalId?: string }).proposalId ? (
            <span className="font-mono text-xs bg-muted px-1 rounded">#{(post.metadata as { proposalId?: string }).proposalId}</span>
          ) : null}
        </p>
      )
    case 'NFT_TRADE':
      return (
        <p className="text-sm text-foreground">
          <span className="font-mono text-muted-foreground">{from}</span>{' '}
          traded an NFT
          {post.contract_address && (
            <>
              {' '}from <span className="font-mono text-xs bg-muted px-1 rounded">{shortAddress(post.contract_address)}</span>
            </>
          )}
          {amountStr && <> for <span className="font-semibold text-indigo-400">{amountStr}</span></>}
        </p>
      )
    case 'CONTRACT_DEPLOY':
      return (
        <p className="text-sm text-foreground">
          <span className="font-mono text-muted-foreground">{from}</span>{' '}
          deployed contract{' '}
          {post.contract_address ? <span className="font-mono text-xs bg-muted px-1 rounded">{shortAddress(post.contract_address)}</span> : null}
        </p>
      )
    default:
      return (
        <p className="text-sm text-muted-foreground">
          On-chain activity from <span className="font-mono">{from}</span>
        </p>
      )
  }
}

function normalizeRawAmount(value: string | number | bigint): string {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') return Number.isFinite(value) ? value.toString() : '0'

  const trimmed = value.trim()
  if (!trimmed.toLowerCase().includes('e')) return trimmed

  const [mantissa, exponentRaw] = trimmed.toLowerCase().split('e')
  const exponent = Number(exponentRaw)
  if (!mantissa || !Number.isFinite(exponent)) return trimmed
  const sign = mantissa.startsWith('-') ? '-' : ''
  const unsigned = mantissa.replace('-', '')
  const dotIndex = unsigned.indexOf('.')
  const digits = unsigned.replace('.', '')
  const intDigits = dotIndex === -1 ? digits.length : dotIndex
  const totalIntDigits = intDigits + exponent
  if (totalIntDigits <= 0) return `${sign}0`
  if (totalIntDigits >= digits.length) {
    return `${sign}${digits}${'0'.repeat(totalIntDigits - digits.length)}`
  }
  return `${sign}${digits.slice(0, totalIntDigits)}`
}

function formatTokenAmount(balanceRaw: string | number | bigint, decimals: number): string {
  try {
    const normalized = normalizeRawAmount(balanceRaw)
    const raw = normalized.replace(/^0+/, '') || '0'
    if (decimals === 0) return raw
    const pad = raw.padStart(decimals + 1, '0')
    const intPart = pad.slice(0, -decimals)
    let fracPart = pad.slice(-decimals).replace(/0+$/, '')
    if (fracPart.length > 6) fracPart = fracPart.slice(0, 6)
    return fracPart ? `${intPart}.${fracPart}` : intPart
  } catch {
    return normalizeRawAmount(balanceRaw)
  }
}

function formatSignedTokenDelta(balanceRaw: string | number | bigint, decimals: number): string {
  const trimmed = normalizeRawAmount(balanceRaw)
  if (!trimmed) return '0'
  const negative = trimmed.startsWith('-')
  const abs = negative ? trimmed.slice(1) : trimmed
  const formatted = formatTokenAmount(abs, decimals)
  return `${negative ? '-' : '+'}${formatted}`
}
