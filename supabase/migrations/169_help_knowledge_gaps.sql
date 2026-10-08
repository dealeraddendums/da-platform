-- 169_help_knowledge_gaps.sql — questions Steven couldn't answer from the
-- Help Center, rolled up so the support team sees what to write next.
--
-- One row per distinct question (question_key = the question's significant
-- words, stemmed + sorted, so "how do I limit a product to used vehicles" and
-- "how can I limit products to used vehicles" are the same row). Written
-- fire-and-forget from /api/help/chat via log_help_gap() — never on the
-- reply's critical path. Read by super_admin on the Help review screen.

create table if not exists help_knowledge_gaps (
  id                   uuid primary key default gen_random_uuid(),
  question_key         text not null unique,
  question             text not null,          -- most recent wording
  sample_questions     text[] not null default '{}', -- up to 5 distinct wordings
  ask_count            integer not null default 1,
  -- Why it was logged, most recent: 'no_article' (retrieval matched nothing),
  -- 'escalated' (Steven said it couldn't resolve), 'unanswered' (its answer
  -- said the material didn't cover it).
  reason               text not null,
  top_article          text,                   -- best retrieval candidate, if any
  top_score            integer,
  last_conversation_id uuid,
  last_dealer_id       text,
  last_dealership      text,
  last_asker           text,                   -- "Name <email> (role)"
  status               text not null default 'open' check (status in ('open','covered','ignored')),
  first_seen           timestamptz not null default now(),
  last_seen            timestamptz not null default now()
);
create index if not exists help_knowledge_gaps_rank_idx on help_knowledge_gaps (status, ask_count desc, last_seen desc);
alter table help_knowledge_gaps enable row level security;

-- Atomic upsert + count, so two dealers asking at once can't lose a tally.
create or replace function log_help_gap(
  p_key text, p_question text, p_reason text, p_top_article text, p_top_score integer,
  p_conversation_id uuid, p_dealer_id text, p_dealership text, p_asker text
) returns void language sql security definer set search_path = public as $$
  insert into help_knowledge_gaps (question_key, question, sample_questions, reason, top_article, top_score,
    last_conversation_id, last_dealer_id, last_dealership, last_asker)
  values (p_key, p_question, array[p_question], p_reason, p_top_article, p_top_score,
    p_conversation_id, p_dealer_id, p_dealership, p_asker)
  on conflict (question_key) do update set
    question = excluded.question,
    sample_questions = case
      when excluded.question = any(help_knowledge_gaps.sample_questions) then help_knowledge_gaps.sample_questions
      else (array[excluded.question] || help_knowledge_gaps.sample_questions)[1:5] end,
    ask_count = help_knowledge_gaps.ask_count + 1,
    reason = excluded.reason,
    top_article = excluded.top_article,
    top_score = excluded.top_score,
    last_conversation_id = excluded.last_conversation_id,
    last_dealer_id = excluded.last_dealer_id,
    last_dealership = excluded.last_dealership,
    last_asker = excluded.last_asker,
    last_seen = now(),
    -- A gap someone marked covered that keeps getting asked is open again.
    status = case when help_knowledge_gaps.status = 'covered' then 'open' else help_knowledge_gaps.status end;
$$;
revoke all on function log_help_gap(text, text, text, text, integer, uuid, text, text, text) from public, anon, authenticated;
