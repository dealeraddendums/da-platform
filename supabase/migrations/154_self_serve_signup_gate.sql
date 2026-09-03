-- 154: self-serve trial signup gate — decision log + human review queue.
--
-- Context: on 2026-09-03 two obviously-fake self-serve trials ("bob" /
-- "alice victim", throwaway domains, zip 00702) auto-provisioned real Trial
-- accounts, sample data, welcome emails and HubSpot records at 3:31 and 5:27 AM
-- Pacific. Nothing was breached — neither ever signed in — but nothing stopped
-- them either: the only checks were a Turnstile challenge (which they passed)
-- and an email regex.
--
-- This table is BOTH the audit log and the review queue: every public
-- trial-signup attempt gets exactly one row recording what we decided and why,
-- and the rows we decline to auto-provision stay as `pending_review` for a
-- human. One table because the queue is just a subset of the log, and because
-- the log doubles as the per-IP rate-limit ledger (see lib/signup-guard.ts) —
-- shared state, unlike the in-memory limiter that resets on every deploy and
-- only ever saw one of the two PM2 workers.
--
-- Scope: the PUBLIC self-serve path only. super_admin / group-admin dealer
-- creation and existing-user logins never touch this table.
CREATE TABLE IF NOT EXISTS public.self_serve_signups (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- ── The signup's OWN submitted data. Nothing else is ever stored here, and
  --    nothing else is ever sent to the AI evaluator (privacy requirement).
  email           text        NOT NULL,
  contact_name    text,
  dealership      text,
  phone           text,
  zip             text,
  account_kind    text        NOT NULL DEFAULT 'single' CHECK (account_kind IN ('single','group')),
  group_name      text,
  attribution     jsonb,
  source_ip       text,

  -- ── What we did and why.
  --    provisioned         → auto-approved, account created
  --    pending_review      → held for a human (AI said suspicious/fake, or AI failed)
  --    approved            → a human approved a held row; account created
  --    denied              → a human denied a held row; nothing created
  --    blocked_afterhours  → outside 5 AM–9 PM Pacific
  --    blocked_ratelimit   → too many attempts from one IP
  --    blocked_domain      → disposable domain, or the domain has no MX record
  --    blocked_invalid     → failed basic field sanity
  decision        text        NOT NULL CHECK (decision IN (
                                'provisioned','pending_review','approved','denied',
                                'blocked_afterhours','blocked_ratelimit','blocked_domain','blocked_invalid')),
  decision_reason text,

  -- ── AI legitimacy verdict (Layer 3). ai_verdict 'error' = the call failed or
  --    timed out, which routes to review — never to auto-approve.
  ai_verdict      text        CHECK (ai_verdict IN ('legit','suspicious','fake','error','skipped')),
  ai_confidence   numeric,
  ai_reasons      jsonb,
  ai_model        text,
  ai_ms           integer,

  -- ── Human review. review_token is single-use: consumed (set NULL) the moment
  --    a decision is recorded, so a re-clicked or scanner-prefetched email link
  --    cannot flip an already-decided row.
  review_token    text        UNIQUE,
  reviewed_at     timestamptz,
  reviewed_by     text,

  -- ── Provisioning result, when we provisioned.
  dealer_uuid     uuid,
  dealer_id       text,
  group_id        uuid
);

-- The rate-limit ledger reads (source_ip, created_at).
CREATE INDEX IF NOT EXISTS self_serve_signups_ip_idx      ON public.self_serve_signups (source_ip, created_at DESC);
CREATE INDEX IF NOT EXISTS self_serve_signups_decision_idx ON public.self_serve_signups (decision, created_at DESC);
CREATE INDEX IF NOT EXISTS self_serve_signups_email_idx    ON public.self_serve_signups (lower(email), created_at DESC);

-- Service-role only; every reader/writer is an authenticated route using the
-- admin client, or the token-gated review endpoint.
ALTER TABLE public.self_serve_signups ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.self_serve_signups IS
  'One row per PUBLIC self-serve trial signup attempt: the decision log, the human review queue, and the per-IP rate-limit ledger.';
