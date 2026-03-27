// apps/listener/src/index.ts

import { SDK } from '@somnia-chain/reactivity'
import { type Hex } from 'viem'
import { publicClientWs, publicClientHttp, publicClientReactivityWs } from './config/chain.js'
import { processEvent, processNativeTransfer, processContractDeploy } from './lib/eventProcessor.js'
import { startTrendingFlushInterval } from './lib/trendingEngine.js'
import { startReputationFlushInterval } from './lib/eventProcessor.js'
import {
  ERC20_TRANSFER_TOPIC,
  ERC20_APPROVAL_TOPIC,
  ERC1155_TRANSFER_SINGLE_TOPIC,
  ERC1155_TRANSFER_BATCH_TOPIC,
  SWAP_V2_TOPIC,
  SWAP_V3_TOPIC,
  LIQUIDITY_ADD_TOPIC,
  LIQUIDITY_REMOVE_TOPIC,
  DAO_VOTE_TOPIC,
  WHALE_DETECTED_TOPIC,
} from './lib/eventSignatures.js'
import { env } from './config/env.js'
import { startKeepAliveServer } from './lib/keepAlive.js'

interface ReactivityNotification {
  topics: Hex[]
  data: Hex
  address: Hex
  transactionHash?: Hex
  blockNumber?: bigint
  logIndex?: number
  simulationResults?: Hex[]
}

type SubscriptionInitParams = Record<string, unknown>
let hasLoggedWildcardPayload = false
let hasLoggedSpotlightPayload = false
let hasLoggedMalformedPayload = false
let lastSignalCleanupAt = 0

type ReactivitySignalSource = 'reactivity_wildcard' | 'reactivity_spotlight'
type ReactivitySignal = {
  source: ReactivitySignalSource
  simulationResults?: Hex[]
}

type SignalBucket = {
  wildcard: ReactivitySignal[]
  spotlight: ReactivitySignal[]
  expiresAt: number
}

const REACTIVITY_SIGNAL_TTL_MS = 120_000
const reactivitySignalBuckets = new Map<string, SignalBucket>()

// ─── Block deduplication ─────────────────────────────────────────────────────
// watchBlocks and the poll interval both call processBlockNumber. Without dedup
// the same block is processed twice every poll cycle, doubling RPC + DB cost.
// We record each processed block with a timestamp and skip re-processing within
// the dedup TTL window.
const BLOCK_DEDUP_TTL_MS = env.LISTENER_BLOCK_DEDUP_TTL_MS ?? 30_000
const processedBlocks = new Map<string, number>()
let lastBlockDedupCleanup = 0

function markBlockProcessed(blockNumber: bigint): void {
  const key = blockNumber.toString()
  processedBlocks.set(key, Date.now())
  const now = Date.now()
  if (now - lastBlockDedupCleanup > 60_000) {
    lastBlockDedupCleanup = now
    const cutoff = now - BLOCK_DEDUP_TTL_MS * 2
    for (const [k, ts] of processedBlocks.entries()) {
      if (ts < cutoff) processedBlocks.delete(k)
    }
  }
}

function isBlockAlreadyProcessed(blockNumber: bigint): boolean {
  const key = blockNumber.toString()
  const ts = processedBlocks.get(key)
  if (!ts) return false
  if (Date.now() - ts > BLOCK_DEDUP_TTL_MS) {
    processedBlocks.delete(key)
    return false
  }
  return true
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseConfiguredEthCalls(): Array<{ to: Hex; data: Hex }> {
  const raw = env.REACTIVITY_ETH_CALLS_JSON
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as Array<{ to?: string; data?: string }>
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((call) => typeof call?.to === 'string' && typeof call?.data === 'string')
      .map((call) => ({ to: call.to as Hex, data: call.data as Hex }))
  } catch (error) {
    console.error('[Main] Failed to parse REACTIVITY_ETH_CALLS_JSON:', error)
    return []
  }
}

function sanitizeAddressList(values: string[]): Hex[] {
  return values
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^0x[a-f0-9]{40}$/.test(value)) as Hex[]
}

function sanitizeTopicList(values: string[]): Hex[] {
  return values
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^0x[a-f0-9]{64}$/.test(value)) as Hex[]
}

async function subscribeSafe(
  sdk: SDK,
  params: SubscriptionInitParams,
  label: string,
): Promise<{ unsubscribe?: () => Promise<unknown> | unknown } | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const subscription = await sdk.subscribe(params as never)
      if (subscription instanceof Error) {
        if (attempt === 2) {
          console.error(`[Main] ${label} failed (return):`, subscription)
          return null
        }
      } else {
        return subscription as unknown as { unsubscribe?: () => Promise<unknown> | unknown }
      }
    } catch (error) {
      if (attempt === 2) {
        console.error(`[Main] ${label} failed (throw):`, error)
        return null
      }
    }
    await sleep(300 * attempt)
  }
  return null
}

function eventFingerprint(input: { topics: Hex[]; data: Hex }): string {
  return [
    ...input.topics.map((topic) => topic.toLowerCase()),
    input.data.toLowerCase(),
  ].join('|')
}

function maybeCleanupReactivitySignals(now: number) {
  if (now - lastSignalCleanupAt < 15_000) return
  lastSignalCleanupAt = now
  for (const [fingerprint, bucket] of reactivitySignalBuckets.entries()) {
    if (
      bucket.expiresAt <= now ||
      (bucket.wildcard.length === 0 && bucket.spotlight.length === 0)
    ) {
      reactivitySignalBuckets.delete(fingerprint)
    }
  }
}

function recordReactivitySignal(
  event: ReactivityNotification,
  source: ReactivitySignalSource,
) {
  const now = Date.now()
  maybeCleanupReactivitySignals(now)
  const fingerprint = eventFingerprint({ topics: event.topics, data: event.data })
  const bucket = reactivitySignalBuckets.get(fingerprint) ?? {
    wildcard: [],
    spotlight: [],
    expiresAt: now + REACTIVITY_SIGNAL_TTL_MS,
  }
  bucket.expiresAt = now + REACTIVITY_SIGNAL_TTL_MS
  const signal: ReactivitySignal = { source, simulationResults: event.simulationResults }
  if (source === 'reactivity_spotlight') {
    bucket.spotlight.push(signal)
  } else {
    bucket.wildcard.push(signal)
  }
  reactivitySignalBuckets.set(fingerprint, bucket)
}

function consumeReactivitySignal(input: { topics: Hex[]; data: Hex }): ReactivitySignal | null {
  const now = Date.now()
  maybeCleanupReactivitySignals(now)
  const fingerprint = eventFingerprint(input)
  const bucket = reactivitySignalBuckets.get(fingerprint)
  if (!bucket) return null
  const signal = bucket.spotlight.shift() ?? bucket.wildcard.shift() ?? null
  if (bucket.spotlight.length === 0 && bucket.wildcard.length === 0) {
    reactivitySignalBuckets.delete(fingerprint)
  } else {
    reactivitySignalBuckets.set(fingerprint, bucket)
  }
  return signal
}

function normalizeNotification(data: unknown): ReactivityNotification | null {
  if (!data || typeof data !== 'object') return null

  const topLevel = data as Record<string, unknown>
  const candidates: Array<Record<string, unknown>> = [topLevel]

  if (topLevel.result && typeof topLevel.result === 'object') {
    candidates.push(topLevel.result as Record<string, unknown>)
  }
  if (topLevel.params && typeof topLevel.params === 'object') {
    candidates.push(topLevel.params as Record<string, unknown>)
    const params = topLevel.params as Record<string, unknown>
    if (params.result && typeof params.result === 'object') {
      candidates.push(params.result as Record<string, unknown>)
      const nested = params.result as Record<string, unknown>
      if (nested.result && typeof nested.result === 'object') {
        candidates.push(nested.result as Record<string, unknown>)
      }
    }
  }

  for (const candidate of candidates) {
    const nestedLog =
      candidate.log && typeof candidate.log === 'object'
        ? (candidate.log as Record<string, unknown>)
        : null

    const topicsRaw = candidate.topics ?? candidate.eventTopics ?? nestedLog?.topics
    const topics = Array.isArray(topicsRaw) ? (topicsRaw as Hex[]) : null

    const payloadRaw = candidate.data ?? candidate.eventData ?? nestedLog?.data
    const payload = typeof payloadRaw === 'string' ? (payloadRaw as Hex) : null

    const addressRaw =
      candidate.address ??
      candidate.emitter ??
      candidate.contractAddress ??
      nestedLog?.address
    const address = typeof addressRaw === 'string' ? (addressRaw as Hex) : null

    const txHashRaw =
      candidate.transactionHash ??
      candidate.txHash ??
      candidate.tx_hash ??
      candidate.hash ??
      nestedLog?.transactionHash ??
      nestedLog?.txHash
    const transactionHash = typeof txHashRaw === 'string' ? (txHashRaw as Hex) : null

    const blockNumberRaw =
      candidate.blockNumber ??
      candidate.block_number ??
      nestedLog?.blockNumber ??
      nestedLog?.block_number
    const blockNumber =
      typeof blockNumberRaw === 'bigint'
        ? blockNumberRaw
        : typeof blockNumberRaw === 'number'
          ? BigInt(blockNumberRaw)
          : typeof blockNumberRaw === 'string'
            ? BigInt(blockNumberRaw)
            : null

    const logIndexRaw = candidate.logIndex ?? candidate.log_index ?? nestedLog?.logIndex
    const logIndex =
      typeof logIndexRaw === 'number'
        ? logIndexRaw
        : typeof logIndexRaw === 'string'
          ? Number(logIndexRaw)
          : undefined

    const simulationResultsRaw =
      candidate.simulationResults ??
      candidate.simulation_results ??
      candidate.ethCallResults ??
      nestedLog?.simulationResults
    const simulationResults = Array.isArray(simulationResultsRaw)
      ? (simulationResultsRaw as Hex[])
      : undefined

    // address is optional — the Somnia Reactivity SDK payload does not include it.
    // '0x' is a safe placeholder; the real address is filled in by processBlockNumber
    // via getLogs when the signal is matched to a log entry.
    if (topics && payload) {
      return {
        topics,
        data: payload,
        address: (address ?? '0x') as Hex,
        ...(transactionHash ? { transactionHash } : {}),
        ...(blockNumber != null ? { blockNumber } : {}),
        logIndex,
        simulationResults,
      }
    }
  }

  if (!hasLoggedMalformedPayload) {
    hasLoggedMalformedPayload = true
    console.warn(
      '[Main] Reactivity payload received but could not be normalized. Top-level keys:',
      Object.keys(topLevel),
    )
  }
  return null
}

async function main() {

  startKeepAliveServer()  
  console.log('CHAINBOOK Listener starting...')

  const subscriptions: Array<{ unsubscribe?: () => Promise<unknown> | unknown }> = []
  const ingestionSourceCounters = {
    reactivity_wildcard: 0,
    reactivity_spotlight: 0,
    log_fallback: 0,
  }

  // Used only by getLogs in processBlockNumber (HTTP fallback cost control).
  // The reactivity WS subscriptions use no topicOverrides — true wildcard.
  const TOPIC_FILTERS: Hex[] = [
    ERC20_TRANSFER_TOPIC,
    ERC20_APPROVAL_TOPIC,
    ERC1155_TRANSFER_SINGLE_TOPIC,
    ERC1155_TRANSFER_BATCH_TOPIC,
    SWAP_V2_TOPIC,
    SWAP_V3_TOPIC,
    LIQUIDITY_ADD_TOPIC,
    LIQUIDITY_REMOVE_TOPIC,
    DAO_VOTE_TOPIC,
    WHALE_DETECTED_TOPIC as Hex,
  ]

  const spotlightSources = sanitizeAddressList(env.REACTIVITY_SPOTLIGHT_SOURCES)
  const spotlightTopicsFromEnv = sanitizeTopicList(env.REACTIVITY_SPOTLIGHT_TOPICS)

  if (env.LISTENER_USE_WS) {
    console.log('[Main] Reactivity WS enabled')
    console.log(`[Main] Reactivity WS URL: ${env.SOMNIA_REACTIVITY_WS ?? env.SOMNIA_RPC_WS}`)
    console.log(`[Main] Spotlight enabled: ${env.REACTIVITY_SPOTLIGHT_ENABLED ? 'yes' : 'no'}`)
    console.log(`[Main] Spotlight sources loaded: ${spotlightSources.length}`)
    if (env.REACTIVITY_SPOTLIGHT_SOURCES.length !== spotlightSources.length) {
      console.warn(
        `[Main] Ignoring ${env.REACTIVITY_SPOTLIGHT_SOURCES.length - spotlightSources.length} invalid spotlight source address(es).`,
      )
    }
    if (spotlightSources.length > 0) {
      console.log(`[Main] Spotlight sources: ${spotlightSources.join(',')}`)
    }
    console.log(`[Main] Spotlight topics loaded: ${spotlightTopicsFromEnv.length}`)
    if (spotlightTopicsFromEnv.length > 0) {
      console.log(`[Main] Spotlight topics: ${spotlightTopicsFromEnv.join(',')}`)
    } else {
      console.log(`[Main] Spotlight topics fallback (TOPIC_FILTERS): ${TOPIC_FILTERS.length}`)
    }
    console.log(
      `[Main] Showcase handler configured: ${env.REACTIVITY_SHOWCASE_HANDLER_ADDRESS ? 'yes' : 'no'}`,
    )
    console.log(`[Main] Reactivity signal match wait ms: ${env.REACTIVITY_SIGNAL_MATCH_WAIT_MS}`)
    console.log(`[Main] Block dedup TTL ms: ${BLOCK_DEDUP_TTL_MS}`)
  }

  if (env.LISTENER_USE_WS) {
    const primarySdk = new SDK({ public: publicClientReactivityWs })
    const fallbackSdk =
      env.SOMNIA_REACTIVITY_WS && env.SOMNIA_REACTIVITY_WS !== env.SOMNIA_RPC_WS
        ? new SDK({ public: publicClientWs })
        : null

    const subscribeWithFallback = async (
      params: SubscriptionInitParams,
      label: string,
    ): Promise<{ unsubscribe?: () => Promise<unknown> | unknown } | null> => {
      const primary = await subscribeSafe(primarySdk, params, `${label} (primary WS)`)
      if (primary) return primary
      if (!fallbackSdk) return null
      console.warn(`[Main] ${label}: retrying on fallback WS ${env.SOMNIA_RPC_WS}`)
      return subscribeSafe(fallbackSdk, params, `${label} (fallback WS)`)
    }

    const configuredEthCalls = parseConfiguredEthCalls()
    const spotlightOnlyPushChanges = configuredEthCalls.length > 0
    if (env.REACTIVITY_SPOTLIGHT_ENABLED && !spotlightOnlyPushChanges) {
      console.warn(
        '[Main] Spotlight has no ethCalls configured; disabling onlyPushChanges to avoid dropped notifications.',
      )
    }

    const baseParams: Record<string, unknown> = {
      ethCalls: configuredEthCalls,
      onError: (error: Error) => {
        console.error('[Main] Reactivity onError:', error)
      },
    }
    if (env.REACTIVITY_CONTEXT) {
      baseParams.context = env.REACTIVITY_CONTEXT
    }

    // ── Wildcard subscription ────────────────────────────────────────────────
    // No topicOverrides — receives every on-chain event. All signals are stored
    // and matched in processBlockNumber. This is future-proof: adding new event
    // types to classifyEventTopic automatically starts working without any
    // subscription code change.
    console.log('Subscribing to Somnia Reactivity (wildcard)...')
    const wildcardParams = {
      ...baseParams,
      onlyPushChanges: false,
      onData: (data: unknown) => {
        if (!hasLoggedWildcardPayload && data && typeof data === 'object') {
          hasLoggedWildcardPayload = true
          console.log(
            '[Main] Wildcard Reactivity payload keys:',
            Object.keys(data as Record<string, unknown>),
          )
        }
        const payload = normalizeNotification(data)
        if (!payload) return

        recordReactivitySignal(payload, 'reactivity_wildcard')

        const txHash = payload.transactionHash
        const blockNumber = payload.blockNumber
        if (!txHash || blockNumber == null) return

        Promise.resolve().then(async () => {
          try {
            await processEvent(
              {
                topics: payload.topics,
                data: payload.data,
                address: payload.address,
                transactionHash: txHash,
                blockNumber,
                logIndex: payload.logIndex,
              },
              {
                source: 'reactivity_wildcard',
                simulationResults: payload.simulationResults,
              },
            )
          } catch (err) {
            console.error('[Main] Unhandled error in processEvent:', err)
          }
        })
      },
    } as unknown as SubscriptionInitParams

    const wildcardSubscription = await subscribeWithFallback(wildcardParams, 'Wildcard')
    let wildcardCreated = 0
    if (wildcardSubscription) {
      wildcardCreated = 1
      subscriptions.push(wildcardSubscription)
    }
    if (wildcardCreated === 0) {
      console.warn('[Main] Reactivity wildcard subscription unavailable; relying on fallback logs.')
    } else {
      console.log('Reactivity subscription active (1 wildcard)')
    }

    // ── Spotlight subscription ───────────────────────────────────────────────
    if (env.REACTIVITY_SPOTLIGHT_ENABLED) {
      console.log('Subscribing to Reactivity Spotlight (wildcard)...')
      const spotlightParamsRaw: Record<string, unknown> = {
        ...baseParams,
        onlyPushChanges: spotlightOnlyPushChanges,
        onData: (data: unknown) => {
          if (!hasLoggedSpotlightPayload && data && typeof data === 'object') {
            hasLoggedSpotlightPayload = true
            console.log(
              '[Main] Spotlight Reactivity payload keys:',
              Object.keys(data as Record<string, unknown>),
            )
          }
          const payload = normalizeNotification(data)
          if (!payload) return

          recordReactivitySignal(payload, 'reactivity_spotlight')

          const txHash = payload.transactionHash
          const blockNumber = payload.blockNumber
          if (!txHash || blockNumber == null) return

          Promise.resolve().then(async () => {
            try {
              await processEvent(
                {
                  topics: payload.topics,
                  data: payload.data,
                  address: payload.address,
                  transactionHash: txHash,
                  blockNumber,
                  logIndex: payload.logIndex,
                },
                {
                  source: 'reactivity_spotlight',
                  simulationResults: payload.simulationResults,
                },
              )
            } catch (err) {
              console.error('[Main] Unhandled error in spotlight processEvent:', err)
            }
          })
        },
      }
      if (spotlightSources.length > 0) {
        spotlightParamsRaw.eventContractSources = spotlightSources
      }

      const spotlightSubscription = await subscribeWithFallback(
        spotlightParamsRaw as SubscriptionInitParams,
        'Spotlight',
      )
      if (!spotlightSubscription) {
        console.warn('[Main] Spotlight subscription disabled')
      } else {
        subscriptions.push(spotlightSubscription)
        console.log('Reactivity spotlight subscription active (1 wildcard)')
      }
    }
  } else {
    console.log('LISTENER_USE_WS=false - skipping Reactivity subscription')
    console.warn(
      '[Main] Reactivity WebSocket subscription is disabled; ingestion will rely on fallback logs only.',
    )
  }

  async function processBlockNumber(
    blockNumber: bigint,
    options?: { preferReactivitySignals?: boolean },
  ) {
    // Block deduplication — prevents watchBlocks and poll from double-processing
    if (isBlockAlreadyProcessed(blockNumber)) return
    markBlockProcessed(blockNumber)

    if (options?.preferReactivitySignals && env.REACTIVITY_SIGNAL_MATCH_WAIT_MS > 0) {
      await sleep(env.REACTIVITY_SIGNAL_MATCH_WAIT_MS)
    }

    const logs = await publicClientHttp.getLogs({
      fromBlock: blockNumber,
      toBlock: blockNumber,
      topics: [TOPIC_FILTERS],
    } as never)

    for (const log of logs) {
      try {
        const signal = consumeReactivitySignal({
          topics: log.topics as `0x${string}`[],
          data: log.data as `0x${string}`,
        })
        const resolvedSource = signal?.source ?? 'log_fallback'
        ingestionSourceCounters[resolvedSource] += 1
        await processEvent(
          {
            topics: log.topics as `0x${string}`[],
            data: log.data as `0x${string}`,
            address: log.address as `0x${string}`,
            transactionHash: log.transactionHash as `0x${string}`,
            blockNumber: log.blockNumber as bigint,
            logIndex: log.logIndex,
          },
          {
            source: resolvedSource,
            simulationResults: signal?.simulationResults,
          },
        )
      } catch (err) {
        console.error('[Logs] Unhandled error in processEvent:', err)
      }
    }

    const fullBlock = await publicClientHttp.getBlock({
      blockNumber,
      includeTransactions: true,
    })

    for (const tx of fullBlock.transactions) {
      if (typeof tx === 'string') continue
      if (!tx.to) {
        await processContractDeploy({
          hash: tx.hash,
          from: tx.from,
          blockNumber: fullBlock.number,
        })
        continue
      }
      if (tx.value === 0n) continue
      await processNativeTransfer({
        hash: tx.hash,
        from: tx.from,
        to: tx.to,
        value: tx.value,
        blockNumber: fullBlock.number,
      })
    }
  }

  const blockClient = env.LISTENER_USE_WS ? publicClientWs : publicClientHttp
  const unwatchBlocks = blockClient.watchBlocks({
    onBlock: async (block) => {
      try {
        if (!block) return
        const blockNumber = block.number
        if (blockNumber == null) return
        await processBlockNumber(blockNumber, { preferReactivitySignals: true })
      } catch (err) {
        console.error('[Blocks] Failed to process block:', err)
      }
    },
    onError: (error) => {
      console.error('[Blocks] watchBlocks error:', error)
    },
  })

  // Bootstrap recent blocks
  try {
    const latest = await publicClientHttp.getBlockNumber()
    const count = env.LISTENER_BOOTSTRAP_BLOCKS
    const start = count > 0 ? latest - BigInt(count - 1) : latest
    const from = start < 0n ? 0n : start
    console.log(`[Bootstrap] Processing blocks ${from}–${latest} (${count} blocks)...`)
    for (let b = from; b <= latest; b++) {
      await processBlockNumber(b)
    }
    console.log('[Bootstrap] Complete.')
  } catch (err) {
    console.error('[Bootstrap] Failed to process recent blocks:', err)
  }

  // Poll fallback — block dedup ensures no double-processing with watchBlocks
  let lastProcessedBlock: bigint | null = null
  const pollId = setInterval(async () => {
    try {
      const latest = await publicClientHttp.getBlockNumber()
      if (lastProcessedBlock == null) {
        lastProcessedBlock = latest
        return
      }
      for (let b = lastProcessedBlock + 1n; b <= latest; b++) {
        await processBlockNumber(b)
      }
      lastProcessedBlock = latest
    } catch (err) {
      console.error('[Poll] Failed to poll blocks:', err)
    }
  }, env.LISTENER_POLL_INTERVAL_MS)

  const metricsId = setInterval(() => {
    const total =
      ingestionSourceCounters.reactivity_wildcard +
      ingestionSourceCounters.reactivity_spotlight +
      ingestionSourceCounters.log_fallback
    if (total === 0) return
    console.log(
      `[Metrics] source mix | reactivity_wildcard=${ingestionSourceCounters.reactivity_wildcard} ` +
        `reactivity_spotlight=${ingestionSourceCounters.reactivity_spotlight} ` +
        `log_fallback=${ingestionSourceCounters.log_fallback}`,
    )
  }, 60_000)

  startTrendingFlushInterval()
  startReputationFlushInterval()

  const shutdown = async (signal: string) => {
    console.log(`\n[Main] Received ${signal}. Shutting down gracefully...`)
    try {
      await Promise.allSettled(subscriptions.map((s) => s.unsubscribe?.()))
    } catch {}
    try { unwatchBlocks?.() } catch {}
    try { clearInterval(pollId) } catch {}
    try { clearInterval(metricsId) } catch {}
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('uncaughtException', (err) => {
    console.error('[Main] Uncaught exception:', err)
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[Main] Unhandled rejection:', reason)
  })

  console.log('CHAINBOOK Listener is running')
}

main().catch((err) => {
  console.error('Fatal error during startup:', err)
  process.exit(1)
})