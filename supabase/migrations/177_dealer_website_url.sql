-- 177 — dealer website URL (2026-10-15)
-- Captured (required) on the self-serve trial signup, optional on the
-- super_admin / group-admin create forms and the dealer profile. Normalized
-- in lib/website-url.ts (https:// added when missing, http(s) only).
-- Synced to the HubSpot Company `website` property. NULL = not captured:
-- existing dealers stay blank (no backfill).

alter table public.dealers
  add column if not exists website_url text;

-- The self-serve decision log carries it from the confirmed lead to the
-- dealer (and to a human reviewer, for held signups).
alter table public.self_serve_signups
  add column if not exists website_url text;
