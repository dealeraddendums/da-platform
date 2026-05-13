-- Migration 060: is_test flag for dealers
--
-- Marks a dealer as a test account, which is the *only* condition under
-- which DELETE /api/dealers/[id] will hard-delete the dealer and cascade
-- its rows. Real dealerships must use the Active/Inactive toggle (data
-- preserved) instead. Setting / unsetting is_test is super_admin only.
--
-- Defaults to false on every row so existing dealers are immediately
-- protected from accidental deletion.

ALTER TABLE public.dealers
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.dealers.is_test IS
  'When true, this dealer can be hard-deleted via the Delete Dealer button '
  '(super_admin only). Real dealerships should never have is_test=true.';

-- Partial index so the (rare) "list all test dealers" lookup is cheap.
CREATE INDEX IF NOT EXISTS dealers_is_test_idx
  ON public.dealers (is_test) WHERE is_test = true;
