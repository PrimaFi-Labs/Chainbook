import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import {
  createProviderFromEnv,
  runAgentLoop,
  type NormedMessage,
  type ToolDefinition,
  type ToolCall,
} from '@chainbook/shared'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const AGENT_WALLET = process.env.AGENT_WALLET_ADDRESS ?? '0x00chainbookai'
const CHAT_MAX_ROUNDS = Number(process.env.AGENT_CHAT_MAX_ROUNDS ?? 4)
const CHAT_MAX_TOKENS = Number(process.env.AGENT_CHAT_MAX_TOKENS ?? 768)
const CHAT_REVIEW_ENABLED = process.env.AGENT_CHAT_REVIEW_ENABLED?.toLowerCase() !== 'false'
const CHAT_REVIEW_ROUNDS = Number(process.env.AGENT_CHAT_REVIEW_ROUNDS ?? 2)
const CHAT_REVIEW_TOKENS = Number(process.env.AGENT_CHAT_REVIEW_TOKENS ?? 480)
const CHAT_MAX_HISTORY_MESSAGES = Number(process.env.AGENT_CHAT_MAX_HISTORY_MESSAGES ?? 8)
const CHAT_MAX_MESSAGE_CHARS = Number(process.env.AGENT_CHAT_MAX_MESSAGE_CHARS ?? 1200)
const CHAT_MAX_REQUESTS_PER_MINUTE = Number(process.env.AGENT_CHAT_MAX_REQUESTS_PER_MINUTE ?? 12)
const CHAT_MAX_REQUESTS_PER_DAY = Number(process.env.AGENT_CHAT_MAX_REQUESTS_PER_DAY ?? 120)
const CHAT_MEMORY_LIMIT = Number(process.env.AGENT_CHAT_MEMORY_LIMIT ?? 8)
const CHAT_SIMILAR_QA_LIMIT = Number(process.env.AGENT_CHAT_SIMILAR_QA_LIMIT ?? 4)

interface RateBucket {
  minuteWindowStart: number
  minuteCount: number
  dayKey: string
  dayCount: number
}

interface ChatBody {
  messages: NormedMessage[]
  viewer_address?: string | null
  session_id?: string | null
}

interface ToolContext {
  subjectKey: string
}

const chatRateBuckets = new Map<string, RateBucket>()

function envString(key: string, fallback: string): string {
  const raw = process.env[key]
  if (typeof raw !== 'string') return fallback
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

function utcDayKey() {
  return new Date().toISOString().slice(0, 10)
}

function getClientKey(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0]?.trim() || 'unknown'
  return req.headers.get('x-real-ip') ?? 'unknown'
}

function sanitizeAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const addr = value.trim().toLowerCase()
  return /^0x[a-f0-9]{40}$/.test(addr) ? addr : null
}

function buildSubjectKey(viewerAddress: unknown, clientKey: string): string {
  const wallet = sanitizeAddress(viewerAddress)
  if (wallet) return `wallet:${wallet}`
  return `ip:${clientKey}`
}

function isTrendingCoinQuery(text: string): boolean {
  const lower = text.toLowerCase()
  return (
    (lower.includes('trend') || lower.includes('hot') || lower.includes('most active')) &&
    (lower.includes('coin') || lower.includes('token'))
  )
}

function hasTimeframeHint(text: string): boolean {
  const lower = text.toLowerCase()
  return (
    /\b\d+\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)\b/.test(lower) ||
    /\b(today|yesterday|daily|weekly|monthly|24h|6h|1h|7d)\b/.test(lower)
  )
}

function checkChatRateLimit(clientKey: string): { ok: true } | { ok: false; reason: string } {
  const now = Date.now()
  const dayKey = utcDayKey()
  const minuteWindowStart = now - (now % 60_000)
  const current = chatRateBuckets.get(clientKey)

  if (!current) {
    chatRateBuckets.set(clientKey, { minuteWindowStart, minuteCount: 1, dayKey, dayCount: 1 })
    return { ok: true }
  }

  if (current.dayKey !== dayKey) {
    current.dayKey = dayKey
    current.dayCount = 0
  }

  if (current.minuteWindowStart !== minuteWindowStart) {
    current.minuteWindowStart = minuteWindowStart
    current.minuteCount = 0
  }

  if (current.minuteCount >= CHAT_MAX_REQUESTS_PER_MINUTE) {
    return { ok: false, reason: `Rate limit hit: max ${CHAT_MAX_REQUESTS_PER_MINUTE} requests/min.` }
  }
  if (current.dayCount >= CHAT_MAX_REQUESTS_PER_DAY) {
    return { ok: false, reason: `Daily limit hit: max ${CHAT_MAX_REQUESTS_PER_DAY} requests/day.` }
  }

  current.minuteCount += 1
  current.dayCount += 1
  return { ok: true }
}

function sanitizeMessages(messages: NormedMessage[]): NormedMessage[] {
  const recent = messages.slice(-CHAT_MAX_HISTORY_MESSAGES)
  return recent.map((msg) => ({
    role: msg.role,
    content:
      typeof msg.content === 'string'
        ? msg.content.slice(0, CHAT_MAX_MESSAGE_CHARS)
        : msg.content,
  }))
}

async function getMemorySnapshot(subjectKey: string): Promise<string[]> {
  const { data } = await supabase
    .from('agent_chat_memories')
    .select('memory, category, confidence')
    .eq('subject_key', subjectKey)
    .order('updated_at', { ascending: false })
    .limit(CHAT_MEMORY_LIMIT)

  return (data ?? []).map((m) => `[${m.category}] ${m.memory} (conf=${Number(m.confidence).toFixed(2)})`)
}

async function getSimilarQASnapshot(subjectKey: string): Promise<string[]> {
  const { data } = await supabase
    .from('agent_chat_turns')
    .select('user_message, reply, created_at')
    .eq('subject_key', subjectKey)
    .order('created_at', { ascending: false })
    .limit(CHAT_SIMILAR_QA_LIMIT)

  return (data ?? []).map((r) => `Q: ${String(r.user_message).slice(0, 220)}\nA: ${String(r.reply).slice(0, 260)}`)
}

async function getFeedbackHints(subjectKey: string): Promise<string[]> {
  const { data } = await supabase
    .from('agent_chat_feedback')
    .select('score, reason, created_at')
    .eq('subject_key', subjectKey)
    .order('created_at', { ascending: false })
    .limit(8)

  return (data ?? [])
    .filter((f) => Number(f.score) === -1 && typeof f.reason === 'string' && f.reason.trim().length > 0)
    .map((f) => `Avoid this issue: ${String(f.reason).slice(0, 180)}`)
}

async function saveMemory(
  subjectKey: string,
  memory: string,
  category: 'general' | 'identity' | 'preference' | 'watchlist' | 'goal' = 'general',
  confidence = 0.6,
  source: 'implicit' | 'tool' | 'feedback' = 'implicit',
) {
  const normalized = memory.trim().replace(/\s+/g, ' ').slice(0, 280)
  if (normalized.length < 3) return

  const { data: existing } = await supabase
    .from('agent_chat_memories')
    .select('id, times_reinforced')
    .eq('subject_key', subjectKey)
    .eq('memory', normalized)
    .maybeSingle()

  if (existing?.id) {
    await supabase
      .from('agent_chat_memories')
      .update({
        times_reinforced: Number(existing.times_reinforced ?? 1) + 1,
        last_seen_at: new Date().toISOString(),
        confidence: Math.max(confidence, 0.6),
        source,
      })
      .eq('id', existing.id)
    return
  }

  await supabase.from('agent_chat_memories').insert({
    subject_key: subjectKey,
    memory: normalized,
    category,
    confidence,
    source,
    times_reinforced: 1,
    last_seen_at: new Date().toISOString(),
  })
}

function inferMemoriesFromMessage(userText: string): Array<{
  memory: string
  category: 'general' | 'identity' | 'preference' | 'watchlist' | 'goal'
}> {
  const out: Array<{ memory: string; category: 'general' | 'identity' | 'preference' | 'watchlist' | 'goal' }> = []
  const text = userText.trim()
  if (!text) return out

  const nameMatch = text.match(/\b(?:my name is|call me)\s+([a-z0-9 _-]{2,40})/i)
  if (nameMatch) out.push({ memory: `Name preference: ${nameMatch[1].trim()}`, category: 'identity' })

  const preferMatch = text.match(/\bi prefer\s+([^.!?\n]{3,120})/i)
  if (preferMatch) out.push({ memory: `Preference: ${preferMatch[1].trim()}`, category: 'preference' })

  const rememberMatch = text.match(/\bremember(?: that)?\s+([^.!?\n]{3,160})/i)
  if (rememberMatch) out.push({ memory: rememberMatch[1].trim(), category: 'general' })

  const walletMatch = text.match(/\bmy wallet is\s+(0x[a-fA-F0-9]{40})\b/i)
  if (walletMatch) out.push({ memory: `Primary wallet: ${walletMatch[1].toLowerCase()}`, category: 'watchlist' })

  const goalMatch = text.match(/\b(?:my goal is|i want to)\s+([^.!?\n]{5,180})/i)
  if (goalMatch) out.push({ memory: `Goal: ${goalMatch[1].trim()}`, category: 'goal' })

  const seen = new Set<string>()
  return out.filter((m) => {
    const key = `${m.category}:${m.memory.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'get_user_memory',
    description: 'Retrieve saved user memory/preferences to personalize responses.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many memory records to return (default 5, max 12)' },
      },
      required: [],
    },
  },
  {
    name: 'save_user_memory',
    description: 'Save an important long-term user preference/fact for future chats.',
    parameters: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'Memory to save (max 280 chars)' },
        category: { type: 'string', description: 'general | identity | preference | watchlist | goal' },
        confidence: { type: 'number', description: '0.0 to 1.0 confidence score' },
      },
      required: ['fact'],
    },
  },
  {
    name: 'get_similar_qa',
    description: 'Find prior similar Q&A from this user to improve consistency.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search phrase from current user prompt' },
        limit: { type: 'number', description: 'How many records to return (default 3, max 8)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_recent_whale_alerts',
    description: 'Fetch recent whale transfer events from Chainbook.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many to return (default 5, max 10)' },
      },
      required: [],
    },
  },
  {
    name: 'get_trending_tokens',
    description: 'Fetch top trending tokens/contracts ranked by event count and velocity.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many to return (default 5, max 10)' },
      },
      required: [],
    },
  },
  {
    name: 'get_hot_coins_by_activity',
    description: 'Fetch most active coins in feed by transaction activity and volume for a timeframe.',
    parameters: {
      type: 'object',
      properties: {
        timeframe_hours: { type: 'number', description: 'Window size in hours (1-168). Ask user if missing for trending-coin asks.' },
        limit: { type: 'number', description: 'How many to return (default 5, max 15)' },
      },
      required: ['timeframe_hours'],
    },
  },
  {
    name: 'estimate_price_impact',
    description: 'Estimate transfer impact using on-chain swap volume as liquidity proxy.',
    parameters: {
      type: 'object',
      properties: {
        amount_usd: { type: 'number', description: 'Transfer value in USD' },
        token_address: { type: 'string', description: 'Optional token contract address' },
      },
      required: ['amount_usd'],
    },
  },
  {
    name: 'get_wallet_profile',
    description: "Fetch wallet tier and Chainbook profile stats for a 0x address.",
    parameters: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Wallet address (0x...)' },
      },
      required: ['address'],
    },
  },
  {
    name: 'post_agent_insight',
    description: 'Publish an AGENT_INSIGHT post to the feed only on explicit user request.',
    parameters: {
      type: 'object',
      properties: {
        heading: { type: 'string', description: 'Headline (max 100 chars)' },
        content: { type: 'string', description: 'Analysis (max 500 chars)' },
        related_tx_hash: { type: 'string', description: 'Related tx hash (optional)' },
        related_token: { type: 'string', description: 'Related token address (optional)' },
        is_whale_alert: { type: 'boolean', description: 'True if about a whale event' },
      },
      required: ['heading', 'content'],
    },
  },
]

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  switch (name) {
    case 'get_user_memory': {
      const limit = Math.min(Math.max(Number(input.limit ?? 5), 1), 12)
      const { data, error } = await supabase
        .from('agent_chat_memories')
        .select('memory, category, confidence, times_reinforced, updated_at')
        .eq('subject_key', ctx.subjectKey)
        .order('updated_at', { ascending: false })
        .limit(limit)
      return error ? { error: error.message } : { memories: data ?? [], count: (data ?? []).length }
    }

    case 'save_user_memory': {
      const fact = String(input.fact ?? '').trim()
      if (!fact) return { error: 'fact required' }
      const categoryRaw = String(input.category ?? 'general').toLowerCase()
      const category = (['general', 'identity', 'preference', 'watchlist', 'goal'].includes(categoryRaw)
        ? categoryRaw
        : 'general') as 'general' | 'identity' | 'preference' | 'watchlist' | 'goal'
      const confidence = Math.min(Math.max(Number(input.confidence ?? 0.7), 0), 1)
      await saveMemory(ctx.subjectKey, fact, category, confidence, 'tool')
      return { saved: true, fact: fact.slice(0, 280), category, confidence }
    }

    case 'get_similar_qa': {
      const query = String(input.query ?? '').trim()
      if (query.length < 3) return { matches: [], count: 0 }
      const limit = Math.min(Math.max(Number(input.limit ?? 3), 1), 8)
      const needle = query.slice(0, 120).replace(/[%_]/g, '')
      const { data, error } = await supabase
        .from('agent_chat_turns')
        .select('id, user_message, reply, created_at')
        .eq('subject_key', ctx.subjectKey)
        .ilike('user_message', `%${needle}%`)
        .order('created_at', { ascending: false })
        .limit(limit)
      return error ? { error: error.message } : { matches: data ?? [], count: (data ?? []).length }
    }

    case 'get_recent_whale_alerts': {
      const limit = Math.min(Number(input.limit ?? 5), 10)
      const { data, error } = await supabase
        .from('posts')
        .select('id, wallet_address, amount_usd, token_in, token_out, contract_address, tx_hash, block_number, created_at, heading')
        .eq('is_whale_alert', true)
        .order('created_at', { ascending: false })
        .limit(limit)
      if (error) return { error: error.message }

      const addrs = Array.from(new Set((data ?? []).map((p) => p.wallet_address).filter(Boolean)))
      let tierMap: Record<string, string> = {}
      if (addrs.length) {
        const { data: ws } = await supabase.from('wallets').select('address, tier').in('address', addrs)
        tierMap = Object.fromEntries((ws ?? []).map((w) => [w.address, w.tier]))
      }

      return {
        whale_alerts: (data ?? []).map((p) => ({ ...p, wallet_tier: tierMap[p.wallet_address] ?? 'UNKNOWN' })),
        count: (data ?? []).length,
      }
    }

    case 'get_trending_tokens': {
      const limit = Math.min(Number(input.limit ?? 5), 10)
      const { data, error } = await supabase
        .from('trending_entities')
        .select('entity_address, entity_name, entity_type, event_count, unique_wallets, velocity, rank')
        .eq('entity_type', 'TOKEN')
        .order('rank', { ascending: true })
        .limit(limit)
      return error ? { error: error.message } : { trending: data ?? [], count: (data ?? []).length }
    }

    case 'get_hot_coins_by_activity': {
      const timeframeHours = Math.min(Math.max(Number(input.timeframe_hours ?? 24), 1), 168)
      const limit = Math.min(Math.max(Number(input.limit ?? 5), 1), 15)
      const since = new Date(Date.now() - timeframeHours * 3_600_000).toISOString()

      const { data: posts, error } = await supabase
        .from('posts')
        .select('token_in, token_out, contract_address, amount_usd, type, created_at')
        .gte('created_at', since)
        .in('type', ['SWAP', 'TRANSFER', 'LIQUIDITY_ADD', 'LIQUIDITY_REMOVE', 'MINT', 'NFT_TRADE'])
        .limit(2000)

      if (error) return { error: error.message }

      const byToken = new Map<string, { tx_count: number; volume_usd: number }>()
      for (const row of posts ?? []) {
        const addresses = [row.token_in, row.token_out, row.contract_address]
          .map((v) => (typeof v === 'string' ? v.toLowerCase() : null))
          .filter((v): v is string => Boolean(v))
        const unique = Array.from(new Set(addresses))
        for (const tokenAddr of unique) {
          const entry = byToken.get(tokenAddr) ?? { tx_count: 0, volume_usd: 0 }
          entry.tx_count += 1
          entry.volume_usd += Number(row.amount_usd ?? 0)
          byToken.set(tokenAddr, entry)
        }
      }

      const ranked = Array.from(byToken.entries())
        .map(([address, stats]) => ({ address, ...stats }))
        .sort((a, b) => (b.tx_count - a.tx_count) || (b.volume_usd - a.volume_usd))
        .slice(0, limit)

      const topAddresses = ranked.map((r) => r.address)
      let metadataMap: Record<string, { symbol: string | null; name: string | null }> = {}
      if (topAddresses.length > 0) {
        const { data: metas } = await supabase
          .from('token_metadata')
          .select('address, symbol, name')
          .in('address', topAddresses)
        metadataMap = Object.fromEntries(
          (metas ?? []).map((m) => [
            String(m.address).toLowerCase(),
            { symbol: m.symbol ?? null, name: m.name ?? null },
          ]),
        )
      }

      return {
        timeframe_hours: timeframeHours,
        hot_coins: ranked.map((row) => {
          const meta = metadataMap[row.address] ?? { symbol: null, name: null }
          return {
            token_address: row.address,
            symbol: meta.symbol,
            name: meta.name,
            tx_count: row.tx_count,
            volume_usd: Math.round(row.volume_usd * 100) / 100,
          }
        }),
        count: ranked.length,
      }
    }

    case 'estimate_price_impact': {
      const amountUsd = Number(input.amount_usd ?? 0)
      if (amountUsd <= 0) return { error: 'amount_usd must be > 0' }

      const since = new Date(Date.now() - 3_600_000).toISOString()
      let q = supabase
        .from('posts')
        .select('amount_usd')
        .in('type', ['SWAP', 'LIQUIDITY_ADD', 'LIQUIDITY_REMOVE'])
        .gte('created_at', since)
        .not('amount_usd', 'is', null)
        .gt('amount_usd', 0)

      if (input.token_address) {
        const a = String(input.token_address).toLowerCase()
        q = q.or(`token_in.eq.${a},token_out.eq.${a},contract_address.eq.${a}`)
      }

      const { data: swaps } = await q.limit(200)
      const vol = (swaps ?? []).reduce((s, r) => s + Number(r.amount_usd ?? 0), 0)
      const liq = Math.max(vol * 5, 5_000)
      const pct = (amountUsd / (liq + amountUsd)) * 100

      return {
        amount_usd: amountUsd,
        estimated_liquidity_usd: Math.round(liq),
        price_impact_pct: parseFloat(pct.toFixed(2)),
        severity: pct < 0.5 ? 'NEGLIGIBLE' : pct < 2 ? 'LOW' : pct < 7 ? 'MEDIUM' : pct < 20 ? 'HIGH' : 'CRITICAL',
        confidence: vol > 50_000 ? 'HIGH' : vol > 5_000 ? 'MEDIUM' : 'LOW',
      }
    }

    case 'get_wallet_profile': {
      const addr = String(input.address ?? '').trim().toLowerCase()
      if (!addr.startsWith('0x')) return { error: 'Invalid address - must start with 0x' }

      const { data, error } = await supabase
        .from('wallets')
        .select('address, ens_name, label, tier, reputation_score, volume_usd, follower_count, following_count, activity_count, first_seen_at')
        .eq('address', addr)
        .single()
      if (error || !data) return { error: 'Wallet not found on Chainbook' }

      const { count } = await supabase
        .from('posts')
        .select('id', { count: 'exact', head: true })
        .eq('wallet_address', addr)
        .gte('created_at', new Date(Date.now() - 86_400_000).toISOString())

      return { wallet: { ...data, recent_posts_24h: count ?? 0 } }
    }

    case 'post_agent_insight': {
      const heading = String(input.heading ?? '').trim().slice(0, 100)
      const content = String(input.content ?? '').trim().slice(0, 500)
      if (!heading || !content) return { error: 'heading and content required' }

      await supabase.from('wallets').upsert(
        { address: AGENT_WALLET, label: 'Chainbook AI', tier: 'WHALE', updated_at: new Date().toISOString() },
        { onConflict: 'address' },
      )

      const { data: post, error } = await supabase
        .from('posts')
        .insert({
          post_id_hash: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type: 'AGENT_INSIGHT',
          wallet_address: AGENT_WALLET,
          contract_address: (input.related_token as string) ?? null,
          token_in: (input.related_token as string) ?? null,
          amount_usd: 0,
          amount_raw: 0,
          tx_hash: input.related_tx_hash ? String(input.related_tx_hash) : `0xagent${Date.now().toString(16).padStart(60, '0')}`,
          block_number: 0,
          heading,
          content,
          is_whale_alert: Boolean(input.is_whale_alert),
          is_agent_post: true,
          is_significant: true,
          significance_score: 30,
          metadata: { agent: true, source: 'chat_panel', generated_at: new Date().toISOString() },
        })
        .select('id, created_at')
        .single()

      return error ? { error: error.message } : { posted: true, post_id: post?.id, heading }
    }

    default:
      return { error: `Unknown tool: ${name}` }
  }
}

const SYSTEM_PROMPT = `You are Chainbook AI, an on-chain analyst for Somnia.

Behavior goals:
- Be clear, specific, and useful for non-template questions.
- For factual on-chain claims, use tools first and cite concrete numbers or addresses.
- For conceptual questions, answer directly and then optionally suggest which tool can verify details.
- Personalize replies using memory when relevant, but avoid inventing user facts.
- Never give financial advice.

Execution policy:
1) If data is required, call the most relevant tool(s).
2) If personalization helps, call get_user_memory and/or get_similar_qa.
3) If user asks to remember something, call save_user_memory.
4) For "top/hot/trending coins by activity", use get_hot_coins_by_activity, not generic trending entities.
5) For trending/hot coin questions, if timeframe is missing, ask a concise follow-up: 1h, 6h, 24h, or 7d.
6) When coin metadata exists, use symbol/name first, then include address as evidence.
7) Only call post_agent_insight when user explicitly asks to post.
8) Prefer 3-6 concise sentences with concrete evidence.
9) Do not shorten on-chain addresses when presenting evidence.`

const REVIEW_PROMPT = `You are a verification pass for Chainbook AI.
- Review the previous draft answer.
- If evidence is missing or weak, call tools to verify.
- Improve factuality, clarity, and specificity.
- Keep concise (max 6 sentences) and avoid financial advice.
- Return only the final improved answer.`

export async function POST(req: NextRequest) {
  const startedAt = Date.now()
  try {
    const body = (await req.json()) as ChatBody
    const { messages } = body
    const clientKey = getClientKey(req)
    const rate = checkChatRateLimit(clientKey)
    if (rate.ok === false) return NextResponse.json({ error: rate.reason }, { status: 429 })

    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: 'messages array required' }, { status: 400 })
    }

    const subjectKey = buildSubjectKey(body.viewer_address, clientKey)
    const sessionId = typeof body.session_id === 'string' && body.session_id.trim().length > 0
      ? body.session_id.trim().slice(0, 120)
      : `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    const trimmedMessages = sanitizeMessages(messages)
    const latestUserMessage = [...trimmedMessages]
      .reverse()
      .find((m) => m.role === 'user' && typeof m.content === 'string')
    const latestUserText = typeof latestUserMessage?.content === 'string' ? latestUserMessage.content : ''

    if (latestUserText && isTrendingCoinQuery(latestUserText) && !hasTimeframeHint(latestUserText)) {
      return NextResponse.json({
        reply: 'For trending coins by activity, what timeframe should I use: 1h, 6h, 24h, or 7d?',
        reply_id: null,
      })
    }

    const [memorySnapshot, similarSnapshot, feedbackHints] = await Promise.all([
      getMemorySnapshot(subjectKey),
      getSimilarQASnapshot(subjectKey),
      getFeedbackHints(subjectKey),
    ])

    const contextBlocks: string[] = []
    if (memorySnapshot.length > 0) {
      contextBlocks.push(`Known user memory:\n${memorySnapshot.map((m) => `- ${m}`).join('\n')}`)
    }
    if (similarSnapshot.length > 0) {
      contextBlocks.push(`Recent prior Q&A:\n${similarSnapshot.map((s) => `- ${s}`).join('\n')}`)
    }
    if (feedbackHints.length > 0) {
      contextBlocks.push(`Recent quality feedback to apply:\n${feedbackHints.map((s) => `- ${s}`).join('\n')}`)
    }

    const contextualMessages: NormedMessage[] = [
      ...(contextBlocks.length > 0
        ? [{ role: 'user', content: `Context for personalization and consistency:\n${contextBlocks.join('\n\n')}` } as NormedMessage]
        : []),
      ...trimmedMessages,
    ]

    let provider
    try {
      provider = createProviderFromEnv()
    } catch (err) {
      return NextResponse.json({ error: String(err) }, { status: 500 })
    }

    const usedTools = new Set<string>()
    const executor = async (calls: ToolCall[]) =>
      Promise.all(calls.map(async (call) => {
        usedTools.add(call.name)
        const result = await executeTool(call.name, call.input, { subjectKey }).catch((err) => ({ error: String(err) }))
        return { id: call.id, result }
      }))

    const draft = await runAgentLoop({
      provider,
      initialMessages: contextualMessages,
      tools: TOOLS,
      system: SYSTEM_PROMPT,
      executor,
      maxRounds: CHAT_MAX_ROUNDS,
      maxTokens: CHAT_MAX_TOKENS,
    })

    let reply = draft
    if (CHAT_REVIEW_ENABLED) {
      reply = await runAgentLoop({
        provider,
        initialMessages: [
          ...contextualMessages,
          { role: 'assistant', content: draft },
          { role: 'user', content: 'Review and improve the draft answer. Verify with tools if needed, then return the final answer.' },
        ],
        tools: TOOLS,
        system: REVIEW_PROMPT,
        executor,
        maxRounds: CHAT_REVIEW_ROUNDS,
        maxTokens: CHAT_REVIEW_TOKENS,
      })
    }

    if (latestUserText) {
      const inferred = inferMemoriesFromMessage(latestUserText)
      for (const memory of inferred) {
        await saveMemory(subjectKey, memory.memory, memory.category, 0.62, 'implicit')
      }
    }

    const latencyMs = Date.now() - startedAt
    const providerName = envString('AGENT_PROVIDER', 'anthropic')
    const modelName = envString('AGENT_MODEL', '(provider-default)')
    const { data: turn, error: turnError } = await supabase
      .from('agent_chat_turns')
      .insert({
        subject_key: subjectKey,
        session_id: sessionId,
        user_message: latestUserText || '(no-user-text)',
        reply,
        provider: providerName,
        model: modelName,
        tools_used: Array.from(usedTools),
        latency_ms: latencyMs,
      })
      .select('id')
      .single()

    if (turnError) {
      console.warn('[Agent chat] failed to persist turn:', turnError.message)
    }

    return NextResponse.json({ reply, reply_id: turn?.id ?? null })
  } catch (err) {
    console.error('[Agent chat] Error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
