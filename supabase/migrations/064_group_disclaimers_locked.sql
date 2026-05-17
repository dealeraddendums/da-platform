-- Migration 064: locked flag on group disclaimers
--
-- Mirrors migration 063's locked column on group_options. When locked = true
-- (default), the disclaimer is corporate-managed and cannot be removed or
-- edited by dealer users — it appears on every addendum/infosheet PDF for
-- dealers in that group regardless of dealer-level settings. Existing rows
-- backfill to locked = true since today every group disclaimer already
-- behaves that way (dealers have no UI to manage them).

ALTER TABLE public.group_disclaimers
  ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.group_disclaimers.locked IS
  'When true (default), the disclaimer is corporate-managed and dealers '
  'cannot remove or edit it. When false, dealers may opt out per-dealer '
  '(future dealer-facing UI).';
