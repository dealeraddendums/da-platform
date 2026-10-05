-- 164: Self-service exports, Phase 1 — feed ownership + export-level exclusions.
-- Spec: exports-self-service-spec.md (suite root).
--
-- owner_scope / owner_id: who manages the feed. Every existing feed is a
-- SuperAdmin feed → 'platform' with no owner id (the column default), so
-- nothing about today's feeds changes.
--
-- export_exclusions: product/fee names dropped from every list / price / sum
-- column of the export (itemized lists, Subtotal, Total and the WO columns),
-- on top of the built-in discount/markup handling. A column can override it
-- with its own list in column_mappings (per-column `exclusions`, plus an
-- optional `separator`) — that lives in the existing jsonb, no DDL needed.
-- Empty by default = today's output.

ALTER TABLE public.feed_companies
  ADD COLUMN IF NOT EXISTS owner_scope text NOT NULL DEFAULT 'platform';

ALTER TABLE public.feed_companies
  ADD COLUMN IF NOT EXISTS owner_id uuid NULL;

ALTER TABLE public.feed_companies
  ADD CONSTRAINT feed_companies_owner_scope_check
  CHECK (owner_scope IN ('platform', 'group', 'dealer'));

-- platform feeds have no owner; group/dealer feeds must name theirs
-- (groups.id / dealers.id). Not FK'd: owner_id points at one of two tables.
ALTER TABLE public.feed_companies
  ADD CONSTRAINT feed_companies_owner_id_check
  CHECK ((owner_scope = 'platform' AND owner_id IS NULL)
      OR (owner_scope IN ('group', 'dealer') AND owner_id IS NOT NULL));

ALTER TABLE public.feed_companies
  ADD COLUMN IF NOT EXISTS export_exclusions text[] NOT NULL DEFAULT '{}';

ALTER TABLE public.feed_companies
  ADD COLUMN IF NOT EXISTS export_exclusion_match text NOT NULL DEFAULT 'exact';

ALTER TABLE public.feed_companies
  ADD CONSTRAINT feed_companies_export_exclusion_match_check
  CHECK (export_exclusion_match IN ('exact', 'contains'));

CREATE INDEX IF NOT EXISTS feed_companies_owner_idx
  ON public.feed_companies (owner_scope, owner_id);
