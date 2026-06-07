-- 094: per-dealer / per-group "config lock" for the DA Legacy ETL.
--
-- When a dealer (or a whole group) starts using the new platform in a limited /
-- parallel capacity, edits made in the new platform must NOT be reverted by the
-- nightly DA Legacy ETL (Aurora -> Supabase). Setting etl_locked = true tells the
-- ETL to leave that dealer/group's CONFIG alone: it skips Job 1 Dealers,
-- 2 Groups, 3 Profiles, 4 Settings, 5 Options, 7 Addendum Data, 8 Logos.
--
-- The ONLY ETL job that still runs for a locked dealer is Job 6 Vehicle Print
-- Status (print_history) — legacy prints during parallel operation still need to
-- flow into Supabase for accurate print counts / trial caps / billing usage.
--
-- Intentionally distinct from migration_status='migrated' (which skips a dealer
-- on ALL jobs, including print status). A locked dealer is mid-migration: frozen
-- config, live print telemetry.
--
-- Group lock CASCADES to members: a dealer is config-locked if dealers.etl_locked
-- OR its group's groups.etl_locked is true.

ALTER TABLE public.dealers
  ADD COLUMN IF NOT EXISTS etl_locked        boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS etl_locked_at     timestamptz NULL,
  ADD COLUMN IF NOT EXISTS etl_locked_reason text        NULL,
  ADD COLUMN IF NOT EXISTS etl_locked_by     uuid        NULL;  -- auth uuid of the super_admin who set it (audit)

ALTER TABLE public.groups
  ADD COLUMN IF NOT EXISTS etl_locked        boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS etl_locked_at     timestamptz NULL,
  ADD COLUMN IF NOT EXISTS etl_locked_reason text        NULL,
  ADD COLUMN IF NOT EXISTS etl_locked_by     uuid        NULL;

COMMENT ON COLUMN public.dealers.etl_locked IS
  'When true, DA Legacy ETL skips ALL config jobs for this dealer (dealers/groups/profiles/settings/options/addendum-data/logos); only Job 6 Vehicle Print Status runs. Distinct from migration_status=migrated (skips everything). See da-legacy-etl/docs/etl-config-lock.md.';
COMMENT ON COLUMN public.groups.etl_locked IS
  'When true, DA Legacy ETL skips config jobs for this group AND all member dealers; Job 6 Vehicle Print Status still runs. See da-legacy-etl/docs/etl-config-lock.md.';

-- Partial indexes so the ETL fetches just the locked rows cheaply each run.
CREATE INDEX IF NOT EXISTS idx_dealers_etl_locked ON public.dealers (id) WHERE etl_locked;
CREATE INDEX IF NOT EXISTS idx_groups_etl_locked  ON public.groups  (id) WHERE etl_locked;
