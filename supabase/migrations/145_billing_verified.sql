-- 145 — Billing verified checkbox (Migration Console, 2026-08-17).
--
-- Replaces the auto-detected "billing staged" readiness gate with an explicit
-- operator attestation: "we have verified DA-Billing is correctly configured
-- for this dealer." The migration invite for a self-billed, billing-relevant
-- dealer is BLOCKED until this is ticked, because sending the invite now fires
-- the billing cutover (da-billing go-live + FreshBooks recurring pause).
--
-- Apply via Supabase SQL editor (Dashboard -> SQL editor -> Run).

ALTER TABLE dealers
  ADD COLUMN IF NOT EXISTS billing_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS billing_verified_by uuid,
  ADD COLUMN IF NOT EXISTS billing_verified_at timestamptz;

COMMENT ON COLUMN dealers.billing_verified IS
  'Operator attestation that da-billing is verified correct for this dealer. Hard readiness gate + invite gate (invite fires the billing cutover). Set via PATCH /api/migration/billing-verified.';
