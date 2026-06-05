-- Scanner-proof invite acceptance: store a one-time setup code (hashed) on each
-- invitation. The code is emailed to the invitee; the invitation is consumed
-- only when the human submits the code (verified server-side). This removes the
-- consumable-link surface that aggressive mail scanners (Barracuda / Safe Links)
-- were tripping by pre-fetching the invite URL.

ALTER TABLE public.invitations
  ADD COLUMN IF NOT EXISTS setup_code_hash       text,
  ADD COLUMN IF NOT EXISTS setup_code_expires_at timestamptz;

COMMENT ON COLUMN public.invitations.setup_code_hash IS
  'SHA-256 hex of the 8-digit setup code emailed to the invitee. Cleared on successful accept. Never store the plaintext code.';
COMMENT ON COLUMN public.invitations.setup_code_expires_at IS
  'When the current setup code stops being valid (tracks the invitation expiry; refreshed on resend).';
