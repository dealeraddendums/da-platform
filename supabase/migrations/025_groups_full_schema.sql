-- Migration 025: Expand groups table to match Aurora dealer_group schema.
-- All ADD COLUMN IF NOT EXISTS — safe to re-run.

ALTER TABLE public.groups
  ADD COLUMN IF NOT EXISTS billing_id             varchar(50),
  ADD COLUMN IF NOT EXISTS template_id            varchar(50),
  ADD COLUMN IF NOT EXISTS group_fee              varchar(20)  DEFAULT '0',
  ADD COLUMN IF NOT EXISTS billing_address        varchar(255),
  ADD COLUMN IF NOT EXISTS billing_city           varchar(255),
  ADD COLUMN IF NOT EXISTS billing_state          varchar(255),
  ADD COLUMN IF NOT EXISTS billing_zip            varchar(255),
  ADD COLUMN IF NOT EXISTS billing_country        varchar(255) DEFAULT 'US',
  ADD COLUMN IF NOT EXISTS billing_date           varchar(255),
  ADD COLUMN IF NOT EXISTS email                  varchar(255),
  ADD COLUMN IF NOT EXISTS hubspot_company_id     varchar(100),
  ADD COLUMN IF NOT EXISTS feed_supplier          varchar(100),
  ADD COLUMN IF NOT EXISTS legacy_id              int;

CREATE UNIQUE INDEX IF NOT EXISTS groups_legacy_id_idx
  ON public.groups (legacy_id) WHERE legacy_id IS NOT NULL;
