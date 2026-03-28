// apps/listener/src/lib/eventProcessor.ts

import { decodeAbiParameters, keccak256, parseAbiParameters, toHex, type Hex } from 'viem'
import type { PostType } from '@chainbook/shared'
import { supabase } from '../config/supabase.js'
import { classifyEventTopic, extractFromAddressForTopic } from './eventSignatures.js'
import { decodeEvent } from './eventDecoder.js'
import { toUsd } from './priceFeed.js'
import { ensureWallet } from './walletHelper.js'
import { incrementTrending } from './trendingEngine.js'
import { dispatchNotifications } from './notificationDispatcher.js'
import { env } from '../config/env.js'
import { publicClientHttp } from '../config/chain.js'
import { getTokenMetadata } from './tokenMetadata.js'
import { updateWalletTokenHolding, updateWalletNativeBalanceUsd, upsertMintedToken } from './walletTokens.js'

// ─── Reputation queue ─────────────────────────────────────────────────────────
const reputationQueue = new Map<string, { volumeUsd: number; activityCount: number }>()

// ─── Concurrency limiters ─────────────────────────────────────────────────────
let rpcConcurrent = 0
let dbConcurrent = 0

async function withRpcLimit<T>(fn: () => Promise<T>): Promise<T> {
  while (rpcConcurrent >= env.MAX_CONCURRENT_RPC_CALLS) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  rpcConcurrent++
  try {
    return await fn()
  } finally {
    rpcConcurrent--
  }
}

async function withDbLimit<T>(fn: () => Promise<T>): Promise<T> {
  while (dbConcurrent >= env.MAX_CONCURRENT_DB_OPERATIONS) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  dbConcurrent++
  try {
    return await fn()
  } finally {
    dbConcurrent--
  }
}

// ─── Post source cache ────────────────────────────────────────────────────────
const POST_SOURCE_CACHE_TTL_MS = env.POST_SOURCE_CACHE_TTL_MS ?? 120_000
const postSourceCache = new Map<string, { source: string; cachedAt: number }>()
let lastPostSourceCacheCleanup = 0

function getCachedPostSource(postIdHash: string): string | null {
  const entry = postSourceCache.get(postIdHash)
  if (!entry) return null
  if (Date.now() - entry.cachedAt > POST_SOURCE_CACHE_TTL_MS) {
    postSourceCache.delete(postIdHash)
    return null
  }
  return entry.source
}

function setCachedPostSource(postIdHash: string, source: string): void {
  postSourceCache.set(postIdHash, { source, cachedAt: Date.now() })
  const now = Date.now()
  if (now - lastPostSourceCacheCleanup > 60_000) {
    lastPostSourceCacheCleanup = now
    const cutoff = now - POST_SOURCE_CACHE_TTL_MS
    for (const [k, v] of postSourceCache.entries()) {
      if (v.cachedAt < cutoff) postSourceCache.delete(k)
    }
  }
}

// ─── txFromCache (capped) ─────────────────────────────────────────────────────
const TX_FROM_CACHE_MAX = 2_000
const txFromCache = new Map<string, string>()

function setTxFromCache(txHash: string, from: string): void {
  if (txFromCache.size >= TX_FROM_CACHE_MAX) {
    const firstKey = txFromCache.keys().next().value
    if (firstKey !== undefined) txFromCache.delete(firstKey)
  }
  txFromCache.set(txHash, from)
}

// ─── ERC-20 balanceOf ABI ─────────────────────────────────────────────────────
const ERC20_BALANCE_OF_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
] as const

const DEFAULT_SHOWCASE_TOPIC = keccak256(
  toHex('ReactivityProof(address,bytes32,bytes32,uint256)'),
)

// Pre-compute native STT minimum in wei once at startup.
const NATIVE_STT_MIN_WEI = BigInt(env.NATIVE_STT_MIN_AMOUNT) * (10n ** 18n)

export function queueReputationUpdate(wallet: string, volumeUsd: number): void {
  const existing = reputationQueue.get(wallet)
  if (existing) {
    existing.volumeUsd += volumeUsd
    existing.activityCount++
  } else {
    reputationQueue.set(wallet, { volumeUsd, activityCount: 1 })
  }
}

export async function flushReputationQueue(): Promise<void> {
  if (reputationQueue.size === 0) return
  const updates = Array.from(reputationQueue.entries())
  reputationQueue.clear()
  for (const [wallet, data] of updates) {
    const { error } = await supabase.rpc('update_wallet_reputation', {
      p_address: wallet.toLowerCase(),
      p_volume_delta: data.volumeUsd,
      p_activity_delta: data.activityCount,
    })
    if (error) {
      console.error(`[ReputationQueue] RPC error for ${wallet}:`, error.message)
    }
  }
  console.log(`[ReputationQueue] Flushed ${updates.length} wallet reputation updates`)
}

export function startReputationFlushInterval(): void {
  setInterval(flushReputationQueue, env.REPUTATION_UPDATE_INTERVAL_MS)
  console.log(`[ReputationQueue] Flush interval started (${env.REPUTATION_UPDATE_INTERVAL_MS}ms)`)
}

// ─── Main event handler ───────────────────────────────────────────────────────

interface ReactivityData {
  topics: Hex[]
  data: Hex
  address: Hex
  transactionHash: Hex
  blockNumber: bigint
  logIndex?: number
}

interface ProcessEventOptions {
  source?: string
  simulationResults?: Hex[]
}

export async function processEvent(
  raw: ReactivityData,
  options?: ProcessEventOptions,
): Promise<void> {
  if (!raw?.topics || raw.topics.length === 0) return
  const topic0 = raw.topics[0]
  if (!topic0) return

  await maybeRecordShowcaseEvent(raw)

  const from = extractFromAddressForTopic(topic0, raw.topics)
  let postType = classifyEventTopic(topic0, from)
  if (!postType) return

  const decoded = decodeEvent(topic0, raw.topics, raw.data, raw.address)
  if (!decoded) return

  const tokenMeta =
    (await getTokenMetadata(decoded.tokenIn)) ??
    (await getTokenMetadata(decoded.contractAddress))
  const tokenOutMeta = await getTokenMetadata(decoded.tokenOut)

  if (postType === 'TRANSFER' && tokenMeta?.is_nft) {
    postType = 'NFT_TRADE'
  }

  // ── USD pricing ───────────────────────────────────────────────────────────
  let amountUsd = 0
  const tokenSymbolUpper = tokenMeta?.symbol?.toUpperCase()
  if (
    decoded.amountRaw != null &&
    tokenSymbolUpper != null &&
    tokenSymbolUpper === env.NATIVE_TOKEN_SYMBOL.toUpperCase()
  ) {
    const decimals = tokenMeta?.decimals ?? 18
    amountUsd = await toUsd(decoded.amountRaw, 'somnia-network', decimals)
  }

  // ── Unpriced ERC20 TRANSFER minimum amount filter ─────────────────────────
  // Drops dust/spam before any DB or RPC work.
  // Only affects unpriced TRANSFER posts — all other types pass through.
  if (postType === 'TRANSFER' && amountUsd === 0 && decoded.amountRaw != null) {
    const decimals = BigInt(tokenMeta?.decimals ?? 18)
    const minRaw = BigInt(env.ERC20_TRANSFER_MIN_AMOUNT) * (10n ** decimals)
    if (decoded.amountRaw < minRaw) return
  }

  const isWhaleAlert = decoded.isWhaleEvent === true || amountUsd >= env.WHALE_THRESHOLD_USD
  const significanceScore = calculateSignificanceScore(amountUsd, postType, isWhaleAlert)

  // Unpriced transfers that passed the minimum filter above are always significant.
  const isUnpricedTransferAboveMin =
    postType === 'TRANSFER' && amountUsd === 0 && decoded.amountRaw != null

  const isSignificant =
    postType !== 'TRANSFER' ||
    amountUsd >= env.SIGNIFICANT_MIN_USD ||
    significanceScore >= env.SIGNIFICANT_MIN_SCORE ||
    isUnpricedTransferAboveMin

  const postIdHash = keccak256(toHex(`${raw.transactionHash}-${raw.logIndex ?? 0}`))
  const resolvedWallet = await resolveWalletAddress(decoded.wallet, raw.transactionHash)
  await ensureWallet(resolvedWallet)

  const post = {
    post_id_hash: postIdHash,
    heading: `${postType} activity`,
    content: '',
    type: postType,
    wallet_address: resolvedWallet.toLowerCase(),
    contract_address: decoded.contractAddress?.toLowerCase() ?? null,
    token_in: decoded.tokenIn?.toLowerCase() ?? null,
    token_out: decoded.tokenOut?.toLowerCase() ?? null,
    amount_raw: decoded.amountRaw?.toString() ?? null,
    amount_usd: amountUsd,
    tx_hash: raw.transactionHash,
    block_number: Number(raw.blockNumber),
    metadata: {
      ...decoded.metadata,
      event_topic0: topic0.toLowerCase(),
      event_emitter: raw.address.toLowerCase(),
      token_symbol: tokenMeta?.symbol ?? null,
      token_name: tokenMeta?.name ?? null,
      token_in_symbol: tokenMeta?.symbol ?? null,
      token_in_name: tokenMeta?.name ?? null,
      token_in_decimals: tokenMeta?.decimals ?? null,
      token_out_symbol: tokenOutMeta?.symbol ?? null,
      token_out_name: tokenOutMeta?.name ?? null,
      token_out_decimals: tokenOutMeta?.decimals ?? null,
      is_nft: tokenMeta?.is_nft ?? false,
      reactivity_source: options?.source ?? 'unknown',
      reactivity_simulation_results_count: options?.simulationResults?.length ?? 0,
    },
    is_whale_alert: isWhaleAlert,
    significance_score: significanceScore,
    is_significant: isSignificant,
  }

  if (postType === 'TRANSFER' && env.REACTIVITY_BALANCE_DELTA_ENABLED) {
    const fromAddress = toAddressOrNull(decoded.metadata?.from)
    const toAddress = toAddressOrNull(decoded.metadata?.to)
    const balanceMeta = await buildTransferBalanceMetadata({
      tokenAddress: decoded.tokenIn,
      fromAddress,
      toAddress,
      blockNumber: raw.blockNumber,
      amountRaw: decoded.amountRaw,
      simulationResults: options?.simulationResults,
    })
    if (balanceMeta) {
      post.metadata = { ...post.metadata, ...balanceMeta }
    }
  }

  // ── Source priority check ─────────────────────────────────────────────────
  const incomingSource = options?.source ?? 'unknown'
  const incomingPriority = sourcePriority(incomingSource)

  if (incomingSource !== 'reactivity_spotlight') {
    const cachedSource = getCachedPostSource(postIdHash)
    const existingSource = cachedSource ?? (await getExistingPostSource(postIdHash))
    if (existingSource != null && incomingPriority < sourcePriority(existingSource)) {
      return
    }
  }

  const { data: insertedPost, error } = await upsertPostWithRetry(post)
  if (error) {
    console.error('[EventProcessor] Post upsert error:', error.message)
    return
  }

  setCachedPostSource(postIdHash, incomingSource)

  if (options?.source === 'reactivity_spotlight' && insertedPost?.id) {
    const { error: spotlightError } = await supabase
      .from('reactivity_spotlight_posts')
      .upsert({ post_id: insertedPost.id }, { onConflict: 'post_id' })
    if (spotlightError) {
      console.error('[EventProcessor] Spotlight upsert error:', spotlightError.message)
    } else {
      console.log(
        `[Spotlight] ${postType} | tx ${raw.transactionHash.slice(0, 10)}... | post ${insertedPost.id}`,
      )
    }
  }

  console.log(
    `[EventProcessor][${incomingSource}] ${isWhaleAlert ? 'WHALE ' : ''}${postType} | $${amountUsd.toFixed(2)} | ${resolvedWallet.slice(0, 8)}...`,
  )

  void incrementTrending(decoded.contractAddress, resolvedWallet)
  void queueReputationUpdate(resolvedWallet, amountUsd)

  // ERC20 token holding tracking — disabled by default (expensive: one balanceOf
  // RPC per token per wallet per event). Only enable for portfolio features.
  if (env.ENABLE_TOKEN_HOLDING_TRACKING && decoded.tokenIn) {
    const fromAddr =
      typeof decoded.metadata?.from === 'string' ? decoded.metadata.from : resolvedWallet
    const toAddr =
      typeof decoded.metadata?.to === 'string' ? decoded.metadata.to : undefined
    if (fromAddr && !isZeroAddress(fromAddr)) {
      void withRpcLimit(() =>
        updateWalletTokenHolding(fromAddr, decoded.tokenIn!, tokenMeta?.decimals ?? null),
      )
    }
    if (toAddr && !isZeroAddress(toAddr)) {
      void withRpcLimit(() =>
        updateWalletTokenHolding(toAddr, decoded.tokenIn!, tokenMeta?.decimals ?? null),
      )
    }
  }

  if (postType === 'MINT' && decoded.tokenIn) {
    const mintedOwner = (decoded.metadata?.to as string | undefined) ?? resolvedWallet
    if (mintedOwner && !isZeroAddress(mintedOwner)) {
      void upsertMintedToken(mintedOwner, decoded.tokenIn, 'MINTED', raw.transactionHash)
    }
  }

  if (
    insertedPost?.id &&
    env.ENABLE_NOTIFICATIONS &&
    amountUsd >= env.NOTIFICATION_MIN_USD_THRESHOLD
  ) {
    void withDbLimit(() =>
      dispatchNotifications({
        postId: insertedPost.id,
        walletAddress: resolvedWallet,
        contractAddress: decoded.contractAddress,
        amountUsd,
        isWhaleAlert,
        postType,
      }),
    )
  }
}

// ─── Native transfer ──────────────────────────────────────────────────────────

interface NativeTransfer {
  hash: Hex
  from: Hex
  to?: Hex | null
  value: bigint
  blockNumber?: bigint | null
}

export async function processNativeTransfer(tx: NativeTransfer): Promise<void> {
  if (!tx.to) return
  if (!tx.value || tx.value === 0n) return

  // ── Native STT minimum filter ─────────────────────────────────────────────
  // Drops dust/micro transfers before pricing, DB, or RPC work.
  if (tx.value < NATIVE_STT_MIN_WEI) return

  const amountUsd = await toUsd(tx.value, 'somnia-network', 18)
  const isWhaleAlert = amountUsd >= env.WHALE_THRESHOLD_USD
  const significanceScore = calculateSignificanceScore(amountUsd, 'TRANSFER', isWhaleAlert)
  const isSignificant =
    amountUsd >= env.SIGNIFICANT_MIN_USD || significanceScore >= env.SIGNIFICANT_MIN_SCORE

  const postIdHash = keccak256(toHex(`${tx.hash}-0`))
  await ensureWallet(tx.from)

  const post = {
    post_id_hash: postIdHash,
    heading: 'Native transfer',
    content: '',
    type: 'TRANSFER' as const,
    wallet_address: tx.from.toLowerCase(),
    contract_address: null,
    token_in: null,
    token_out: null,
    amount_raw: tx.value.toString(),
    amount_usd: amountUsd,
    tx_hash: tx.hash,
    block_number: Number(tx.blockNumber ?? 0n),
    metadata: {
      to: tx.to.toLowerCase(),
      is_native: true,
      token_symbol: env.NATIVE_TOKEN_SYMBOL,
      token_name: env.NATIVE_TOKEN_NAME,
      token_in_symbol: env.NATIVE_TOKEN_SYMBOL,
      token_in_name: env.NATIVE_TOKEN_NAME,
      token_in_decimals: 18,
    },
    is_whale_alert: isWhaleAlert,
    significance_score: significanceScore,
    is_significant: isSignificant,
  }

  const { data: insertedPost, error } = await upsertPostWithRetry(post)
  if (error) {
    console.error('[NativeTransfer] Post upsert error:', error.message)
    return
  }

  console.log(
    `[NativeTransfer] ${isWhaleAlert ? 'WHALE ' : ''}TRANSFER | $${amountUsd.toFixed(2)} | ${tx.from.slice(0, 8)}...`,
  )

  void incrementTrending(tx.to, tx.from)
  void queueReputationUpdate(tx.from, amountUsd)

  // Native STT balance tracking — re-enabled. This is the data that drives the
  // whale / shark / crab / shrimp labelling system. One getBalance call per
  // unique wallet per native transfer — low cost, high value for correctness.
  if (env.ENABLE_NATIVE_BALANCE_TRACKING) {
    void withRpcLimit(() => updateWalletNativeBalanceUsd(tx.from))
    if (tx.to) void withRpcLimit(() => updateWalletNativeBalanceUsd(tx.to!))
  }

  if (
    insertedPost?.id &&
    env.ENABLE_NOTIFICATIONS &&
    amountUsd >= env.NOTIFICATION_MIN_USD_THRESHOLD
  ) {
    void withDbLimit(() =>
      dispatchNotifications({
        postId: insertedPost.id,
        walletAddress: tx.from,
        contractAddress: tx.to!,
        amountUsd,
        isWhaleAlert,
        postType: 'TRANSFER',
      }),
    )
  }
}

// ─── Contract deploy ──────────────────────────────────────────────────────────

interface ContractDeploy {
  hash: Hex
  from: Hex
  blockNumber?: bigint | null
}

export async function processContractDeploy(tx: ContractDeploy): Promise<void> {
  const postIdHash = keccak256(toHex(`${tx.hash}-deploy`))
  const receipt = await publicClientHttp.getTransactionReceipt({ hash: tx.hash })
  const deployedAddress = receipt?.contractAddress
  if (!deployedAddress) return

  await ensureWallet(tx.from)
  const deployedMeta = await getTokenMetadata(deployedAddress)

  const post = {
    post_id_hash: postIdHash,
    heading: 'Contract deployed',
    content: '',
    type: 'CONTRACT_DEPLOY' as const,
    wallet_address: tx.from.toLowerCase(),
    contract_address: deployedAddress.toLowerCase(),
    token_in: null,
    token_out: null,
    amount_raw: null,
    amount_usd: 0,
    tx_hash: tx.hash,
    block_number: Number(tx.blockNumber ?? 0n),
    metadata: {
      contract_address: deployedAddress.toLowerCase(),
      token_symbol: deployedMeta?.symbol ?? null,
      token_name: deployedMeta?.name ?? null,
      token_decimals: deployedMeta?.decimals ?? null,
      is_nft: deployedMeta?.is_nft ?? false,
    },
    is_whale_alert: false,
    significance_score: calculateSignificanceScore(0, 'CONTRACT_DEPLOY', false),
    is_significant: true,
  }

  const { data: insertedPost, error } = await upsertPostWithRetry(post)
  if (error) {
    console.error('[ContractDeploy] Post upsert error:', error.message)
    return
  }

  console.log(`[ContractDeploy] DEPLOY | ${tx.from.slice(0, 8)}...`)

  void incrementTrending(deployedAddress, tx.from)
  void queueReputationUpdate(tx.from, 0)
  if (deployedMeta?.symbol || deployedMeta?.decimals != null) {
    void upsertMintedToken(tx.from, deployedAddress, 'CREATED', tx.hash)
  }

  if (insertedPost?.id) {
    void dispatchNotifications({
      postId: insertedPost.id,
      walletAddress: tx.from,
      contractAddress: deployedAddress,
      amountUsd: 0,
      isWhaleAlert: false,
      postType: 'CONTRACT_DEPLOY',
    })
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function calculateSignificanceScore(
  amountUsd: number,
  postType: PostType,
  isWhaleAlert: boolean,
): number {
  const base = Math.log10(Math.max(amountUsd, 1)) * 10
  const typeBonus: Record<PostType, number> = {
    SWAP: 8,
    TRANSFER: 4,
    MINT: 3,
    DAO_VOTE: 5,
    LIQUIDITY_ADD: 6,
    LIQUIDITY_REMOVE: 6,
    CONTRACT_DEPLOY: 6,
    NFT_TRADE: 7,
  }
  const whaleBonus = isWhaleAlert ? 20 : 0
  return Number((base + (typeBonus[postType] ?? 0) + whaleBonus).toFixed(2))
}

async function resolveWalletAddress(decodedWallet: string, txHash: Hex): Promise<string> {
  if (!env.USE_TX_FROM_AS_WALLET) return decodedWallet
  const cached = txFromCache.get(txHash)
  if (cached) return cached
  try {
    const tx = await publicClientHttp.getTransaction({ hash: txHash })
    if (tx?.from) {
      setTxFromCache(txHash, tx.from)
      return tx.from
    }
  } catch {
    // fall back to decoded wallet
  }
  return decodedWallet
}

function isZeroAddress(address: string): boolean {
  return address.toLowerCase() === '0x0000000000000000000000000000000000000000'
}

function toAddressOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  if (!trimmed.startsWith('0x') || trimmed.length !== 42) return null
  return trimmed
}

function decodeUintResult(value: Hex | undefined): bigint | null {
  if (!value) return null
  try {
    const [decoded] = decodeAbiParameters(parseAbiParameters('uint256'), value)
    return decoded
  } catch {
    return null
  }
}

async function readBalanceAtBlock(
  tokenAddress: string,
  walletAddress: string,
  blockNumber: bigint,
): Promise<bigint | null> {
  if (blockNumber < 0n) return null
  try {
    const result = await publicClientHttp.readContract({
      address: tokenAddress as Hex,
      abi: ERC20_BALANCE_OF_ABI,
      functionName: 'balanceOf',
      args: [walletAddress as Hex],
      blockNumber,
    })
    return result as bigint
  } catch {
    return null
  }
}

interface TransferBalanceMetaInput {
  tokenAddress: string | null
  fromAddress: string | null
  toAddress: string | null
  blockNumber: bigint
  amountRaw: bigint | null
  simulationResults?: Hex[]
}

async function buildTransferBalanceMetadata(
  input: TransferBalanceMetaInput,
): Promise<Record<string, string | number> | null> {
  if (!input.tokenAddress || !input.fromAddress || !input.toAddress) return null
  if (isZeroAddress(input.fromAddress) || isZeroAddress(input.toAddress)) return null

  let fromBefore = decodeUintResult(input.simulationResults?.[0])
  let fromAfter = decodeUintResult(input.simulationResults?.[1])
  let toBefore = decodeUintResult(input.simulationResults?.[2])
  let toAfter = decodeUintResult(input.simulationResults?.[3])

  if (env.REACTIVITY_BALANCE_RPC_FALLBACK) {
    if (fromAfter == null) {
      fromAfter = await readBalanceAtBlock(input.tokenAddress, input.fromAddress, input.blockNumber)
    }
    if (toAfter == null) {
      toAfter = await readBalanceAtBlock(input.tokenAddress, input.toAddress, input.blockNumber)
    }
    if (input.blockNumber > 0n) {
      if (fromBefore == null) {
        fromBefore = await readBalanceAtBlock(
          input.tokenAddress,
          input.fromAddress,
          input.blockNumber - 1n,
        )
      }
      if (toBefore == null) {
        toBefore = await readBalanceAtBlock(
          input.tokenAddress,
          input.toAddress,
          input.blockNumber - 1n,
        )
      }
    }
  }

  if (fromBefore == null || fromAfter == null || toBefore == null || toAfter == null) {
    return null
  }

  return {
    reactivity_balance_from_before: fromBefore.toString(),
    reactivity_balance_from_after: fromAfter.toString(),
    reactivity_balance_from_delta: (fromAfter - fromBefore).toString(),
    reactivity_balance_to_before: toBefore.toString(),
    reactivity_balance_to_after: toAfter.toString(),
    reactivity_balance_to_delta: (toAfter - toBefore).toString(),
    reactivity_balance_verified_with_simulation:
      input.simulationResults && input.simulationResults.length >= 4 ? 1 : 0,
    reactivity_transfer_amount_raw: input.amountRaw?.toString() ?? '0',
  }
}

async function maybeRecordShowcaseEvent(raw: ReactivityData): Promise<void> {
  const configuredAddress = env.REACTIVITY_SHOWCASE_HANDLER_ADDRESS?.toLowerCase()
  if (!configuredAddress) return
  if (raw.address.toLowerCase() !== configuredAddress) return

  const expectedTopic = (env.REACTIVITY_SHOWCASE_TOPIC0 ?? DEFAULT_SHOWCASE_TOPIC).toLowerCase()
  const observedTopic = raw.topics[0]?.toLowerCase()
  if (!observedTopic || observedTopic !== expectedTopic) return

  const { error } = await supabase
    .from('reactivity_showcase_events')
    .upsert(
      {
        tx_hash: raw.transactionHash.toLowerCase(),
        event_contract: raw.address.toLowerCase(),
        topic0: raw.topics[0].toLowerCase(),
        block_number: Number(raw.blockNumber),
      },
      { onConflict: 'tx_hash' },
    )

  if (error) {
    console.error('[EventProcessor] Showcase event upsert error:', error.message)
  }
}

async function upsertPostWithRetry(post: Record<string, unknown>) {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await supabase
        .from('posts')
        .upsert(post, { onConflict: 'post_id_hash' })
        .select('id')
        .single()
      if (!result.error) return result
      lastError = result.error
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      if (!message.toLowerCase().includes('fetch failed') || attempt === 3) break
    }
    await sleep(attempt * 400)
  }
  return {
    data: null,
    error:
      lastError instanceof Error
        ? { message: lastError.message }
        : { message: String(lastError ?? 'Unknown post upsert error') },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function getExistingPostSource(postIdHash: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('posts')
    .select('metadata')
    .eq('post_id_hash', postIdHash)
    .maybeSingle()

  if (error || !data) return null
  const metadata = data.metadata as Record<string, unknown> | null
  const source = metadata?.reactivity_source
  return typeof source === 'string' ? source : null
}

function sourcePriority(source: string): number {
  switch (source) {
    case 'reactivity_spotlight': return 4
    case 'reactivity_wildcard':  return 3
    case 'legacy_unknown':       return 2
    case 'unknown':              return 1
    case 'log_fallback':
    default:                     return 0
  }
}