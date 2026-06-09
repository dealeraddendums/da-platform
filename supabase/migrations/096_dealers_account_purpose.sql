-- 096_dealers_account_purpose.sql
-- Account-purpose classifier (Real / Test / Sales Demo) — flag at creation.
-- Spec: docs/account-purpose-classifier.md. Root-cause fix for test/demo
-- pollution: classify an account's PURPOSE at creation instead of hand-sweeping
-- is_test after the fact.
--
-- `is_test` stays THE exclusion gate (already wired through BI, billing,
-- HubSpot). `account_purpose` adds the test-vs-demo distinction. Invariant
-- enforced in app code on every write: is_test = (account_purpose <> 'real').
--
-- Apply via the Supabase SQL editor (primary DA project) or `supabase db push`.

-- ── DDL ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.dealers
  ADD COLUMN IF NOT EXISTS account_purpose text NOT NULL DEFAULT 'real';

DO $$ BEGIN
  ALTER TABLE public.dealers
    ADD CONSTRAINT dealers_account_purpose_check
    CHECK (account_purpose IN ('real','test','sales_demo'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN public.dealers.account_purpose IS
  'Creation-time classification: real | test | sales_demo. is_test is kept in sync as (account_purpose <> ''real'') by app code. Drives the test/demo exclusion + a future sales-demo cut. See migration 096 / docs/account-purpose-classifier.md.';

-- ── One-time backfill ────────────────────────────────────────────────────────
-- The 8 sales demos were flagged is_test=true this session and all carry "demo"
-- in the name (Andre / Asher Enterprises / Tyler Jorgensen / CA ClearBra /
-- Millennium Dealer Services / CDS Zoom / STARSHIELD / Toyota Demo).
UPDATE public.dealers
   SET account_purpose = 'sales_demo'
 WHERE is_test = true AND name ILIKE '%demo%';

-- Every other is_test account (QA/test fixtures) → 'test'.
UPDATE public.dealers
   SET account_purpose = 'test'
 WHERE is_test = true AND account_purpose <> 'sales_demo';

-- Everything else stays 'real' (the column default). is_test already equals
-- (account_purpose <> 'real') after this session's flagging, so no is_test
-- writes are needed here.
