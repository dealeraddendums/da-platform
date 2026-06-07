-- 093: one-time sample-data seed guard for standalone Trial dealers.
--
-- New standalone Trial dealers (account_type='Trial' AND group_id IS NULL) get
-- seeded with one sample Required product (Ceramic Tint) + two sample vehicles
-- (SAMPLE-NEW / SAMPLE-USED) so a fresh trial isn't an empty account. This
-- column records when that happened so the seed runs exactly once: a re-run or
-- re-save never duplicates, and a dealer who deletes the samples doesn't get
-- them back. NULL = never seeded.
ALTER TABLE public.dealers
  ADD COLUMN IF NOT EXISTS sample_seeded_at timestamptz NULL;

COMMENT ON COLUMN public.dealers.sample_seeded_at IS
  'When standalone-Trial sample data was seeded (Ceramic Tint product + SAMPLE-NEW/SAMPLE-USED vehicles). NULL = not seeded. One-time guard; see lib/provisioning.ts seedTrialSampleData.';
