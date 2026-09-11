-- 157_prints_last_30_v5.sql — give the 5.0 print-count cache its own column.
--
-- `dealers.last30` is overloaded. It is meant to mirror Aurora
-- dealer_dim.LAST30 (4.0 print activity, written nightly by the ETL), but the
-- sync-hubspot-computed cron also overwrites it with the dealer's own 5.0
-- print count for migrated / ss_ / native dealers. The two writers fight ~3h
-- apart, so a migrated dealer's "4.0" figure oscillates through the day.
--
-- This column is the 5.0 cache's own home. Populating it is step one; see the
-- note below before assuming last30 can simply be left to the ETL.
alter table dealers add column if not exists prints_last_30_v5 int;

comment on column dealers.prints_last_30_v5 is
  'Distinct vehicles with a 5.0 print in the last 30 days (print_history), '
  'refreshed by the sync-hubspot-computed cron for dealers active on 5.0. '
  'Separate from last30, which mirrors Aurora dealer_dim.LAST30 (4.0 activity).';

-- ⚠️ last30 is STILL written with the 5.0 count for 5.0 dealers, deliberately.
-- DA Pulse reads da-platform.dealers.last30 directly (DA_PLATFORM_SB_URL) and
-- gates on it in four places — sync_pvr (last30>=20), sync_vehicles (>=1),
-- sync_nightly (>0) and sync_vitals, which explicitly "falls back to DA
-- Platform dealers.last30 for dealers not yet in Aurora", i.e. 5.0 natives.
-- Making last30 pure-Aurora would drop every 5.0-native dealer out of Pulse
-- reporting (10 active natives are over the PVR threshold today purely on
-- their 5.0 count, including LAX CDJR at 292 and Winter Haven Honda at 231).
-- Retiring the clobber therefore requires moving those four Pulse gates onto
-- this column first.
