-- 095_dealers_converted_at.sql
-- DA Business Intelligence tab (super_admin) — trial-conversion funnel.
--
-- converted_at  set the MOMENT a trial dealer becomes a paying account, in:
--   • app/api/billing/me/subscription/route.ts  (self-serve isConversion path)
--   • app/api/dealers/[id]/route.ts             (super_admin Trial → paid PATCH)
-- It is the date a converted trial is bucketed by in the BI funnel
-- ("Trials converted to paying"). Cleared on re-downgrade so a later
-- re-conversion re-stamps it (paired with downgraded_at from migration 083).
--
-- Distinct from created_at (signup) and downgraded_at (cancel). NULL for:
--   • dealers still on trial,
--   • migrated dealers that were never trials (they're not in the funnel),
--   • paid dealers whose conversion predates this column AND whose da-billing
--     customer has no resolvable createdAt (backfill leaves them NULL).
--
-- Backfill (best-effort history, one-time): scripts/backfill-converted-at.mjs
-- stamps existing paying, non-migrated dealers from their da-billing customer
-- createdAt (the customer is created at conversion for self-serve dealers, so
-- it's a faithful proxy). Going forward the value is exact.
--
-- Apply via the Supabase SQL editor (primary DA project) or `supabase db push`.

ALTER TABLE public.dealers
  ADD COLUMN IF NOT EXISTS converted_at timestamptz NULL;

-- BI queries filter "converted in period" on this column; index the non-null
-- rows so the scan stays cheap as the funnel history grows.
CREATE INDEX IF NOT EXISTS dealers_converted_at_idx
  ON public.dealers (converted_at)
  WHERE converted_at IS NOT NULL;

COMMENT ON COLUMN public.dealers.converted_at IS
  'Timestamp a trial dealer became a paying account (Trial -> paid). Set in the self-serve subscription path and the super_admin Trial->paid PATCH; cleared on re-downgrade so re-conversion re-stamps. Drives the BI tab conversion funnel. See migration 095.';
