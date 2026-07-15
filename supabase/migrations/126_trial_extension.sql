-- Migration 126: SuperAdmin trial extension overrides.
--
-- Trial expiry has no stored date — it is derived in lib/print-eligibility.ts
-- as created_at + 30 days OR > 30 distinct printed vehicles (print_history is
-- immutable, so the print axis can't be "reset"). These two nullable override
-- columns let a super_admin extend a trial without touching history:
--
--   trial_ends_at    — when set, replaces created_at + 30d as the trial's
--                      time-axis expiry. An ACTIVE (future) value also grants
--                      trial-track printing to a Free/legacy dealer even if
--                      the daily ETL reverts account_type (operator override).
--   trial_prints_cap — when set, replaces the default 30-print cap.
--
-- NULL in both columns = pre-126 behavior, unchanged for every existing row.

alter table dealers
  add column if not exists trial_ends_at timestamptz,
  add column if not exists trial_prints_cap integer;

comment on column dealers.trial_ends_at is
  'Operator-set trial expiry override (extend-trial). NULL = derived created_at + 30 days.';
comment on column dealers.trial_prints_cap is
  'Operator-set trial print-cap override (extend-trial). NULL = default 30 distinct vehicles.';
