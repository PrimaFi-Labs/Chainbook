-- ============================================================
-- CHAINBOOK - Agent memory + quality feedback loop
-- Run after 018.
-- ============================================================

create table if not exists agent_chat_memories (
  id                uuid primary key default gen_random_uuid(),
  subject_key       text not null,
  memory            text not null check (char_length(memory) between 3 and 280),
  category          text not null default 'general'
                    check (category in ('general', 'identity', 'preference', 'watchlist', 'goal')),
  confidence        numeric not null default 0.6 check (confidence >= 0 and confidence <= 1),
  source            text not null default 'implicit'
                    check (source in ('implicit', 'tool', 'feedback')),
  times_reinforced  int not null default 1,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  last_seen_at      timestamptz not null default now()
);

create unique index if not exists agent_chat_memories_subject_memory_uq
  on agent_chat_memories(subject_key, memory);

create index if not exists agent_chat_memories_subject_idx
  on agent_chat_memories(subject_key, updated_at desc);

drop trigger if exists agent_chat_memories_updated_at on agent_chat_memories;
create trigger agent_chat_memories_updated_at
  before update on agent_chat_memories
  for each row execute procedure update_updated_at();

create table if not exists agent_chat_turns (
  id                uuid primary key default gen_random_uuid(),
  subject_key       text not null,
  session_id        text not null,
  user_message      text not null,
  reply             text not null,
  provider          text not null,
  model             text not null,
  tools_used        jsonb not null default '[]'::jsonb,
  latency_ms        int not null default 0,
  created_at        timestamptz not null default now()
);

create index if not exists agent_chat_turns_subject_idx
  on agent_chat_turns(subject_key, created_at desc);

create index if not exists agent_chat_turns_session_idx
  on agent_chat_turns(session_id, created_at desc);

create table if not exists agent_chat_feedback (
  id                uuid primary key default gen_random_uuid(),
  turn_id           uuid not null references agent_chat_turns(id) on delete cascade,
  subject_key       text not null,
  score             smallint not null check (score in (-1, 1)),
  reason            text check (char_length(reason) <= 500),
  created_at        timestamptz not null default now()
);

create unique index if not exists agent_chat_feedback_turn_uq
  on agent_chat_feedback(turn_id, subject_key);

create index if not exists agent_chat_feedback_subject_idx
  on agent_chat_feedback(subject_key, created_at desc);

alter table agent_chat_memories enable row level security;
alter table agent_chat_turns enable row level security;
alter table agent_chat_feedback enable row level security;

create policy "Service role full access on agent_chat_memories"
  on agent_chat_memories for all using (auth.role() = 'service_role');

create policy "Service role full access on agent_chat_turns"
  on agent_chat_turns for all using (auth.role() = 'service_role');

create policy "Service role full access on agent_chat_feedback"
  on agent_chat_feedback for all using (auth.role() = 'service_role');
