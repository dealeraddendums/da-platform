-- Migration 024: Expand dealers table to match Aurora dealer_dim schema.
-- All ADD COLUMN IF NOT EXISTS — safe to re-run. Existing columns are skipped.

ALTER TABLE public.dealers
  ADD COLUMN IF NOT EXISTS billing_id             text,
  ADD COLUMN IF NOT EXISTS template_id            text,
  ADD COLUMN IF NOT EXISTS dealer_group_legacy    varchar(50),
  ADD COLUMN IF NOT EXISTS feed_source            varchar(255),
  ADD COLUMN IF NOT EXISTS etl_job                varchar(50),
  ADD COLUMN IF NOT EXISTS billing_street         varchar(100),
  ADD COLUMN IF NOT EXISTS billing_city           varchar(100),
  ADD COLUMN IF NOT EXISTS billing_state          varchar(100),
  ADD COLUMN IF NOT EXISTS billing_zip            varchar(100),
  ADD COLUMN IF NOT EXISTS billing_country        varchar(300) DEFAULT 'USA',
  ADD COLUMN IF NOT EXISTS sub_billing_to         varchar(20)  DEFAULT 'Dealer',
  ADD COLUMN IF NOT EXISTS billing_to             varchar(20)  DEFAULT 'Dealer',
  ADD COLUMN IF NOT EXISTS referred_by            varchar(100),
  ADD COLUMN IF NOT EXISTS make1                  varchar(20),
  ADD COLUMN IF NOT EXISTS make2                  varchar(20),
  ADD COLUMN IF NOT EXISTS make3                  varchar(20),
  ADD COLUMN IF NOT EXISTS make4                  varchar(20),
  ADD COLUMN IF NOT EXISTS make5                  varchar(20),
  ADD COLUMN IF NOT EXISTS lat                    varchar(50),
  ADD COLUMN IF NOT EXISTS lng                    varchar(50),
  ADD COLUMN IF NOT EXISTS hubspot_company_id     varchar(100),
  ADD COLUMN IF NOT EXISTS agent_name             varchar(255),
  ADD COLUMN IF NOT EXISTS email_report           int          DEFAULT 0,
  ADD COLUMN IF NOT EXISTS report_send_to         varchar(100),
  ADD COLUMN IF NOT EXISTS last30                 int,
  ADD COLUMN IF NOT EXISTS legacy_id              bigint;

CREATE UNIQUE INDEX IF NOT EXISTS dealers_legacy_id_idx
  ON public.dealers (legacy_id) WHERE legacy_id IS NOT NULL;
