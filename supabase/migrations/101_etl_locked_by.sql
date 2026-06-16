-- 101: add the missing etl_locked_by column to dealers + groups.
--
-- Migration 094 declared etl_locked_by (audit: who froze the ETL), but prod was
-- applied from an earlier copy of 094 that lacked this line, so the column never
-- landed. Effect: PATCH /api/dealers/[id] (and the group equivalent) write
-- patch.etl_locked_by = claims.sub when an operator freezes the ETL, the UPDATE
-- hits a non-existent column, the route 500s, and the Freeze toggle silently
-- reverts to Off. This adds the column so the write succeeds. Idempotent.

ALTER TABLE public.dealers
  ADD COLUMN IF NOT EXISTS etl_locked_by uuid NULL;  -- auth uuid of the super_admin who set the lock (audit)

ALTER TABLE public.groups
  ADD COLUMN IF NOT EXISTS etl_locked_by uuid NULL;
