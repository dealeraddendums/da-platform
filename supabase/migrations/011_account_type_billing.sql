-- Add account_type to dealers
ALTER TABLE dealers
  ADD COLUMN IF NOT EXISTS account_type text NOT NULL DEFAULT 'Standard';

-- Add billing fields and internal_id to groups
ALTER TABLE groups
  ADD COLUMN IF NOT EXISTS account_type text NOT NULL DEFAULT 'Standard',
  ADD COLUMN IF NOT EXISTS billing_contact text,
  ADD COLUMN IF NOT EXISTS billing_email text,
  ADD COLUMN IF NOT EXISTS billing_phone text,
  ADD COLUMN IF NOT EXISTS internal_id text;

-- Backfill internal_id for existing groups using epoch of created_at
UPDATE groups
  SET internal_id = (EXTRACT(EPOCH FROM created_at) * 1000)::bigint::text
  WHERE internal_id IS NULL;
