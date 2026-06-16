-- 100_migration_readiness.sql — Phase 13b step 1 (migration readiness console).
-- Apply in the Supabase SQL editor (prod box has no direct Postgres), then deploy
-- the code that depends on it. See phase-13-self-serve-migration.md → "13b detailed".
--
-- Two operator-set flags on dealers. Everything else in the readiness gate
-- (ETL-complete, billing-template-staged, eligibility) is COMPUTED from existing
-- data — these two are the only human inputs.

-- "Template confirmed" — operator has applied the default/group builder template
-- for this dealer and eyeballed it (the LIGHT gate per the 2026-06-16 template
-- decision: default + synced options, no per-dealer layout build).
alter table dealers add column if not exists template_confirmed boolean not null default false;

-- "Flagged complex" — operator escape hatch to force a single dealer to
-- white-glove even if it isn't in an excluded group. Eligibility = NOT in the
-- white-glove group list AND NOT migration_complex.
alter table dealers add column if not exists migration_complex boolean not null default false;
