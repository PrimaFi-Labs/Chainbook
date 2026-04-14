import EventEmitter from 'node:events'
import { supabase } from '../config/supabase.js'
import { env } from '../config/env.js'
import {
  createProviderFromEnv,
  runAgentLoop,
  type ToolDefinition,
  type ToolCall,
  type NormedMessage,
} from '@chainbook/shared'

// Event bus used by eventProcessor.ts to notify new posts.
export const agentEventBus = new EventEmitter()
agentEventBus.setMaxListeners(10)

const CFG = {
  dailyBudget: env.AGENT_DAILY_BUDGET,
  maxCallsPerMinute: env.AGENT_MAX_CALLS_PER_MINUTE,
  maxCommentsPerHour: env.AGENT_MAX_COMMENTS_PER_HOUR,
  maxInsightsPerHour: env.AGENT_MAX_INSIGHTS_PER_HOUR,
  batchWindowMs: env.AGENT_BATCH_WINDOW_MS,
  cooldownMs: env.AGENT_COOLDOWN_MS,
  minAmountRaw: BigInt(env.AGENT_MIN_AMOUNT_RAW),
  agentWallet: String(env.AGENT_WALLET_ADDRESS ?? '0x00chainbookai'),
  maxTokens: 256,
  maxRounds: 2,
}

const NON_TRANSFER_PRIORITY_TYPES = new Set([
  'MINT',
  'NFT_TRADE',
  'CONTRACT_DEPLOY',
  'DAO_VOTE',
])

interface RawPost {
  id?: string
  type?: string
  wallet_address?: string | null
  amount_usd?: number | string | null
  amount_raw?: string | null
  is_whale_alert?: boolean | null
  significance_score?: number | string | null
  tx_hash?: string
  block_number?: number | bigint
  token_in?: string | null
  token_out?: string | null
  contract_address?: string | null
  heading?: string | null
  content?: string | null
  [key: string]: unknown
}

interface NormedPost {
  id: string
  type: string
  wallet_address: string
  amount_usd: number
  amount_raw: bigint
  is_whale_alert: boolean
  significance_score: number
  tx_hash: string
  token_in: string | null
  token_out: string | null
  contract_address: string | null
  heading: string
}

function normalize(raw: RawPost): NormedPost | null {
  if (!raw?.id) return null
  return {
    id: String(raw.id),
    type: String(raw.type ?? 'UNKNOWN'),
    wallet_address: String(raw.wallet_address ?? ''),
    amount_usd: Number(raw.amount_usd ?? 0),
    amount_raw: toBigInt(raw.amount_raw),
    is_whale_alert: raw.is_whale_alert === true,
    significance_score: Number(raw.significance_score ?? 0),
    tx_hash: String(raw.tx_hash ?? ''),
    token_in: raw.token_in ? String(raw.token_in) : null,
    token_out: raw.token_out ? String(raw.token_out) : null,
    contract_address: raw.contract_address ? String(raw.contract_address) : null,
    heading: String(raw.heading ?? ''),
  }
}

let dailyCalls = 0
let budgetDay = utcDay()
let minuteWindowStart = 0
let minuteCalls = 0
let hourWindow = utcHour()
let commentsThisHour = 0
let insightsThisHour = 0

function utcDay() {
  return new Date().toISOString().slice(0, 10)
}

function utcHour() {
  return new Date().toISOString().slice(0, 13)
}

function budgetCheck(): 'ok' | 'whale_only' | 'paused' {
  const today = utcDay()
  if (today !== budgetDay) {
    dailyCalls = 0
    budgetDay = today
  }

  const ratio = dailyCalls / CFG.dailyBudget
  if (ratio >= 1) return 'paused'
  if (ratio >= 0.8) return 'whale_only'
  return 'ok'
}

function budgetConsume() {
  const today = utcDay()
  if (today !== budgetDay) {
    dailyCalls = 0
    budgetDay = today
  }

  dailyCalls += 1
  const used = dailyCalls
  const cap = CFG.dailyBudget

  if (used === Math.floor(cap * 0.8)) {
    console.warn(`[AutonomousAgent] 80% daily budget used (${used}/${cap}). Switching to whale-only mode.`)
  }
  if (used >= cap) {
    console.warn(`[AutonomousAgent] Daily budget exhausted (${cap} calls). Pausing until midnight UTC.`)
  }
}

function minuteRateCheckAndConsume(): boolean {
  const now = Date.now()
  const windowStart = now - (now % 60_000)

  if (windowStart !== minuteWindowStart) {
    minuteWindowStart = windowStart
    minuteCalls = 0
  }

  if (minuteCalls >= CFG.maxCallsPerMinute) return false
  minuteCalls += 1
  return true
}

function resetHourlyIfNeeded() {
  const currentHour = utcHour()
  if (currentHour === hourWindow) return
  hourWindow = currentHour
  commentsThisHour = 0
  insightsThisHour = 0
}

function canWriteComment(): boolean {
  resetHourlyIfNeeded()
  return commentsThisHour < CFG.maxCommentsPerHour
}

function canWriteInsight(): boolean {
  resetHourlyIfNeeded()
  return insightsThisHour < CFG.maxInsightsPerHour
}

function consumeWrite(kind: 'comment' | 'insight') {
  resetHourlyIfNeeded()
  if (kind === 'comment') commentsThisHour += 1
  else insightsThisHour += 1
}

const cooldowns = new Map<string, number>()

function isOnCooldown(post: NormedPost): boolean {
  if (NON_TRANSFER_PRIORITY_TYPES.has(post.type)) return false
  const keys = [post.contract_address, post.token_in, post.token_out]
    .filter(Boolean)
    .map((key) => `${post.type}:${String(key).toLowerCase()}`) as string[]
  const now = Date.now()

  return keys.some((key) => {
    const last = cooldowns.get(key.toLowerCase()) ?? 0
    return now - last < CFG.cooldownMs
  })
}

function setCooldown(post: NormedPost) {
  if (NON_TRANSFER_PRIORITY_TYPES.has(post.type)) return
  const keys = [post.contract_address, post.token_in, post.token_out].filter(Boolean) as string[]
  const now = Date.now()
  keys.forEach((key) => cooldowns.set(`${post.type}:${key.toLowerCase()}`, now))
}

const commentedPosts = new Set<string>()
const BANNED_TONE_PATTERNS = [
  'idiot',
  'stupid',
  'scammer',
  'fraud',
  'loser',
  'trash',
  'retard',
]
const FINANCIAL_ADVICE_PATTERNS = [
  'you should buy',
  'buy now',
  'sell now',
  'ape in',
  'guaranteed profit',
  'financial advice',
]

function compactText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function hasEvidence(text: string): boolean {
  return (
    /\$[\d,.]+/.test(text) ||
    /\b\d+(\.\d+)?%/.test(text) ||
    /0x[a-fA-F0-9]{6,}/.test(text) ||
    /\b\d[\d,]*(\.\d+)?\b/.test(text)
  )
}

function hasUnsafeTone(text: string): boolean {
  const lower = text.toLowerCase()
  return BANNED_TONE_PATTERNS.some((term) => lower.includes(term))
}

function hasFinancialAdvice(text: string): boolean {
  const lower = text.toLowerCase()
  return FINANCIAL_ADVICE_PATTERNS.some((term) => lower.includes(term))
}

let batchBuffer: NormedPost[] = []
let batchTimer: ReturnType<typeof setTimeout> | null = null

function enqueueBatch(post: NormedPost) {
  batchBuffer.push(post)

  if (!batchTimer) {
    batchTimer = setTimeout(() => {
      const batch = batchBuffer
      batchBuffer = []
      batchTimer = null
      void flushBatch(batch)
    }, CFG.batchWindowMs)
  }
}

async function flushBatch(batch: NormedPost[]) {
  if (batch.length === 0) return

  const ranked = batch.sort((a, b) => {
    if (a.is_whale_alert !== b.is_whale_alert) return a.is_whale_alert ? -1 : 1
    if (b.amount_usd !== a.amount_usd) return b.amount_usd - a.amount_usd
    return b.significance_score - a.significance_score
  })

  const processCap = Math.min(
    Math.max(Math.floor(CFG.maxCallsPerMinute * 0.75), 3),
    Math.max(ranked.length, 3),
  )
  console.log(`[AutonomousAgent] Batch: ${batch.length} events -> target up to ${processCap}`)

  let processed = 0
  for (const post of ranked) {
    if (processed >= processCap) break
    if (isOnCooldown(post)) {
      console.log(`[AutonomousAgent] Cooldown active for post ${post.id} - skipping`)
      continue
    }
    await processPost(post)
    processed += 1
    await sleep(2_000)
  }
}

function isSignificant(post: NormedPost): boolean {
  if (post.type === 'AGENT_INSIGHT') return false
  if (NON_TRANSFER_PRIORITY_TYPES.has(post.type)) return true
  return post.is_whale_alert || post.amount_raw >= CFG.minAmountRaw
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'get_event_context',
    description: 'Get full details of the triggering on-chain event: post, token metadata, sender wallet. Always call this first.',
    parameters: {
      type: 'object',
      properties: {
        post_id: { type: 'string' },
      },
      required: ['post_id'],
    },
  },
  {
    name: 'estimate_price_impact',
    description: 'Estimate % price impact using on-chain swap volume. Returns severity: NEGLIGIBLE/LOW/MEDIUM/HIGH/CRITICAL.',
    parameters: {
      type: 'object',
      properties: {
        amount_usd: { type: 'number' },
        token_address: { type: 'string' },
      },
      required: ['amount_usd'],
    },
  },
  {
    name: 'post_comment',
    description: 'Post a 2-sentence comment on the event post. Specific numbers only. Max 280 chars.',
    parameters: {
      type: 'object',
      properties: {
        post_id: { type: 'string' },
        content: { type: 'string', description: 'Max 280 chars' },
      },
      required: ['post_id', 'content'],
    },
  },
  {
    name: 'post_insight',
    description: 'Publish an AGENT_INSIGHT post only for whale events with high or critical estimated impact.',
    parameters: {
      type: 'object',
      properties: {
        heading: { type: 'string', description: 'Max 100 chars' },
        content: { type: 'string', description: 'Max 500 chars' },
        source_post_id: { type: 'string' },
        is_whale_alert: { type: 'boolean' },
      },
      required: ['heading', 'content', 'source_post_id'],
    },
  },
]

function makeExecutor() {
  return async (calls: ToolCall[]) =>
    Promise.all(
      calls.map(async (call) => {
        let result: unknown

        switch (call.name) {
          case 'get_event_context': {
            const { data: post } = await supabase
              .from('posts')
              .select('id, type, heading, amount_usd, is_whale_alert, tx_hash, token_in, contract_address, wallets(tier, volume_usd, activity_count)')
              .eq('id', String(call.input.post_id ?? ''))
              .single()

            const tokenAddr = (post as RawPost | null)?.token_in as string | undefined
            const { data: token } = tokenAddr
              ? await supabase.from('token_metadata').select('symbol, name').eq('address', tokenAddr).single()
              : { data: null }

            result = { post, token }
            break
          }

          case 'estimate_price_impact': {
            const amountUsd = Number(call.input.amount_usd ?? 0)
            const since = new Date(Date.now() - 3_600_000).toISOString()

            let q = supabase
              .from('posts')
              .select('amount_usd')
              .in('type', ['SWAP', 'LIQUIDITY_ADD', 'LIQUIDITY_REMOVE'])
              .gte('created_at', since)
              .not('amount_usd', 'is', null)
              .gt('amount_usd', 0)

            if (call.input.token_address) {
              const tokenAddress = String(call.input.token_address).toLowerCase()
              q = q.or(`token_in.eq.${tokenAddress},token_out.eq.${tokenAddress},contract_address.eq.${tokenAddress}`)
            }

            const { data: swaps } = await q.limit(200)
            const vol = (swaps ?? []).reduce((sum, row) => sum + Number(row.amount_usd ?? 0), 0)
            const liq = Math.max(vol * 5, 5_000)
            const pct = (amountUsd / (liq + amountUsd)) * 100

            result = {
              price_impact_pct: parseFloat(pct.toFixed(2)),
              severity: pct < 0.5 ? 'NEGLIGIBLE' : pct < 2 ? 'LOW' : pct < 7 ? 'MEDIUM' : pct < 20 ? 'HIGH' : 'CRITICAL',
              confidence: vol > 50_000 ? 'HIGH' : vol > 5_000 ? 'MEDIUM' : 'LOW',
            }
            break
          }

          case 'post_comment': {
            const postId = String(call.input.post_id ?? '')
            const content = compactText(String(call.input.content ?? '')).slice(0, 280)

            if (!canWriteComment()) {
              result = { skipped: true, reason: `comment hourly cap reached (${CFG.maxCommentsPerHour})` }
              break
            }
            if (commentedPosts.has(postId)) {
              result = { skipped: true, reason: 'already commented on this post' }
              break
            }
            if (!hasEvidence(content)) {
              result = { skipped: true, reason: 'comment missing evidence markers ($, %, or address)' }
              break
            }
            if (hasUnsafeTone(content) || hasFinancialAdvice(content)) {
              result = { skipped: true, reason: 'comment violates tone/advice guardrails' }
              break
            }

            const { data, error } = await supabase
              .from('comments')
              .insert({ post_id: postId, wallet_address: CFG.agentWallet, content })
              .select('id')
              .single()

            if (!error) {
              commentedPosts.add(postId)
              consumeWrite('comment')
              console.log(`[AutonomousAgent] Commented on post ${postId}`)
            }
            result = error ? { error: error.message } : { commented: true, comment_id: data?.id }
            break
          }

          case 'post_insight': {
            const heading = compactText(String(call.input.heading ?? '')).slice(0, 100)
            const content = compactText(String(call.input.content ?? '')).slice(0, 500)
            const sourceId = String(call.input.source_post_id ?? '')

            if (!canWriteInsight()) {
              result = { skipped: true, reason: `insight hourly cap reached (${CFG.maxInsightsPerHour})` }
              break
            }
            if (hasUnsafeTone(heading) || hasUnsafeTone(content) || hasFinancialAdvice(content)) {
              result = { skipped: true, reason: 'insight violates tone/advice guardrails' }
              break
            }
            if (!hasEvidence(content)) {
              result = { skipped: true, reason: 'insight missing evidence markers ($, %, or address)' }
              break
            }

            const { data: sourcePost } = await supabase
              .from('posts')
              .select('id, type, tx_hash, wallet_address, amount_usd, is_whale_alert, significance_score, token_in, contract_address')
              .eq('id', sourceId)
              .single()

            const sourceIsWhale = (sourcePost as RawPost | null)?.is_whale_alert === true
            const sourceType = String((sourcePost as RawPost | null)?.type ?? '')
            const sourceScore = Number((sourcePost as RawPost | null)?.significance_score ?? 0)
            const sourceIsHighSignalType = NON_TRANSFER_PRIORITY_TYPES.has(sourceType)
            if (!sourcePost || (!sourceIsWhale && !sourceIsHighSignalType && sourceScore < 25)) {
              result = {
                skipped: true,
                reason: 'insight requires whale, high-signal type, or significant source post',
              }
              break
            }

            await supabase.from('wallets').upsert(
              {
                address: CFG.agentWallet,
                label: 'Chainbook AI',
                tier: 'WHALE',
                updated_at: new Date().toISOString(),
              },
              { onConflict: 'address' },
            )

            const { data, error } = await supabase
              .from('posts')
              .insert({
                post_id_hash: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                type: 'AGENT_INSIGHT',
                wallet_address: CFG.agentWallet,
                tx_hash: `0xagent${Date.now().toString(16).padStart(60, '0')}`,
                block_number: 0,
                heading,
                content,
                source_post_id: sourceId || null,
                is_whale_alert: Boolean(call.input.is_whale_alert),
                is_agent_post: true,
                is_significant: true,
                significance_score: 30,
                metadata: {
                  agent: true,
                  source: 'autonomous',
                  generated_at: new Date().toISOString(),
                  source_post_type: (sourcePost as RawPost).type ?? null,
                  source_post_tx_hash: (sourcePost as RawPost).tx_hash ?? null,
                  source_post_wallet: (sourcePost as RawPost).wallet_address ?? null,
                  source_post_amount_usd: Number((sourcePost as RawPost | null)?.amount_usd ?? 0),
                  source_post_token: (sourcePost as RawPost).token_in ?? (sourcePost as RawPost).contract_address ?? null,
                  guardrails: {
                    requires_evidence: true,
                    blocks_financial_advice: true,
                    blocks_abusive_tone: true,
                  },
                },
              })
              .select('id')
              .single()

            if (!error) {
              consumeWrite('insight')
              console.log(`[AutonomousAgent] Posted insight ${data?.id}`)
            }
            result = error ? { error: error.message } : { posted: true, post_id: data?.id }
            break
          }

          default:
            result = { error: `Unknown tool: ${call.name}` }
        }

        return { id: call.id, result }
      }),
    )
}

const SYSTEM_PROMPT =
  `You are Chainbook AI on Somnia Network. Analyse the on-chain event and respond.\n\n` +
  `Steps:\n` +
  `1. Call get_event_context.\n` +
  `2. For swaps/transfers/LP events, call estimate_price_impact when useful.\n` +
  `3. Call post_comment with 2 sentences max (specific numbers, 280 chars max).\n` +
  `4. Call post_insight for major whale events OR standout MINT/NFT_TRADE/CONTRACT_DEPLOY events with concrete evidence.\n\n` +
  `Comment format by event:\n` +
  `- SWAP/TRANSFER/LIQUIDITY: include value/impact.\n` +
  `- MINT/NFT_TRADE/CONTRACT_DEPLOY/DAO_VOTE: include event type, wallet/contract, and concrete on-chain details.\n` +
  `Guardrails:\n` +
  `- Include evidence in every output (amounts, %, tx hash, or 0x addresses).\n` +
  `- No abusive language, personal attacks, or defamatory claims.\n` +
  `- No financial advice ("buy now", "sell now", "you should buy").\n` +
  `- Keep tone sharp but factual.\n` +
  `Never write "I" or "as an AI". Never repeat the event heading.`

async function processPost(post: NormedPost): Promise<void> {
  const budget = budgetCheck()
  if (budget === 'paused') return

  if (budget === 'whale_only' && !post.is_whale_alert) {
    console.log(`[AutonomousAgent] Budget at 80% - skipping non-whale post ${post.id}`)
    return
  }

  if (!minuteRateCheckAndConsume()) {
    console.log(`[AutonomousAgent] Per-minute cap reached (${CFG.maxCallsPerMinute}/min) - skipping ${post.id}`)
    return
  }

  let provider
  try {
    provider = createProviderFromEnv()
  } catch (err) {
    console.error('[AutonomousAgent] Provider error:', err)
    return
  }

  const messages: NormedMessage[] = [
    {
      role: 'user',
      content:
      `Event: post_id=${post.id} type=${post.type} ` +
      `whale=${post.is_whale_alert} usd=$${post.amount_usd} ` +
      `amount_raw=${post.amount_raw.toString()} score=${post.significance_score} from=${post.wallet_address || 'unknown'} ` +
      `token=${post.token_in ?? post.contract_address ?? 'unknown'}`,
    },
  ]

  try {
    budgetConsume()
    await runAgentLoop({
      provider,
      initialMessages: messages,
      tools: TOOLS,
      system: SYSTEM_PROMPT,
      executor: makeExecutor(),
      maxRounds: CFG.maxRounds,
      maxTokens: CFG.maxTokens,
    })
    setCooldown(post)
  } catch (err) {
    console.error(`[AutonomousAgent] Error processing post ${post.id}:`, err)
  }
}

function handleNewPost(raw: RawPost): void {
  const post = normalize(raw)
  if (!post || !isSignificant(post)) return
  enqueueBatch(post)
}

export async function startAutonomousAgent(): Promise<void> {
  agentEventBus.on('new_post', handleNewPost)

  console.log(
    '[AutonomousAgent] Ready\n' +
      `  provider    = ${String(env.AGENT_PROVIDER ?? 'anthropic')}\n` +
      `  model       = ${String(env.AGENT_MODEL ?? '(default - cheapest for provider)')}\n` +
      `  min_amount_raw = ${CFG.minAmountRaw.toString()} (base units)\n` +
      `  daily_budget= ${CFG.dailyBudget} calls/day\n` +
      `  comments/hr = ${CFG.maxCommentsPerHour}\n` +
      `  insights/hr = ${CFG.maxInsightsPerHour}\n` +
      `  batch_window= ${CFG.batchWindowMs / 1000}s\n` +
      `  cooldown    = ${CFG.cooldownMs / 60_000}min per contract`,
  )
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      return BigInt(value)
    } catch {
      return 0n
    }
  }
  return 0n
}
