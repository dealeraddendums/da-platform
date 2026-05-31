-- 082_hubspot_sync_errors.sql
-- Phase 14 — HubSpot one-way sync (DA Platform → HubSpot).
--
-- Mirrors billing_sync_errors. Fire-and-forget upserts to /crm/v3/objects
-- write a row here on failure so a transient HubSpot outage or bad token
-- never bubbles up to the request path. super_admin can review + retry.

CREATE TABLE IF NOT EXISTS public.hubspot_sync_errors (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  object_type  text        NOT NULL CHECK (object_type IN ('company', 'contact')),
  object_id    text        NOT NULL,                  -- our Supabase id (dealer.id, group.id, profile.id)
  hubspot_id   text        NULL,                       -- HubSpot's id if we got that far
  op           text        NOT NULL CHECK (op IN ('create', 'update', 'search')),
  error_message text       NOT NULL,
  payload      jsonb       NULL                        -- request body that failed, for debugging
);

CREATE INDEX IF NOT EXISTS hubspot_sync_errors_created_at_idx
  ON public.hubspot_sync_errors (created_at DESC);

CREATE INDEX IF NOT EXISTS hubspot_sync_errors_object_idx
  ON public.hubspot_sync_errors (object_type, object_id);
