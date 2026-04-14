import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

interface FeedbackBody {
  reply_id?: string
  score?: number
  reason?: string
  viewer_address?: string | null
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

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as FeedbackBody
    const replyId = String(body.reply_id ?? '').trim()
    const score = Number(body.score)
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : null

    if (!replyId) return NextResponse.json({ error: 'reply_id required' }, { status: 400 })
    if (score !== 1 && score !== -1) return NextResponse.json({ error: 'score must be 1 or -1' }, { status: 400 })

    const subjectKey = buildSubjectKey(body.viewer_address, getClientKey(req))
    const { error } = await supabase
      .from('agent_chat_feedback')
      .upsert(
        {
          turn_id: replyId,
          subject_key: subjectKey,
          score,
          reason,
        },
        { onConflict: 'turn_id,subject_key' },
      )

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[Agent feedback] Error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
