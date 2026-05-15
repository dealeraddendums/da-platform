-- Migration 063: locked flag on corporate products + per-vehicle dismissals
--
-- Today every corporate (group_options) product behaves as locked — it
-- renders on assigned dealers' addendums with a lock icon and no remove
-- button. This migration makes the lock configurable per product:
--
--   locked = true  (default): unchanged — dealer cannot remove the product
--                  from a specific vehicle's addendum.
--   locked = false:           dealer can dismiss the product on one vehicle.
--                  The product still exists in the group library and still
--                  applies to other vehicles for the same dealer; the
--                  dismissal is scoped to (vehicle_id, group_option_id).
--
-- Dismissals live in a separate table so the dealer's vehicle_options save
-- path stays unchanged. getGroupOptionsForDealer joins against this table
-- to drop dismissed group options at render time.

ALTER TABLE public.group_options
  ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.group_options.locked IS
  'When true (default), the dealer cannot remove this corporate product '
  'from a specific vehicle''s addendum. When false, dealer may dismiss '
  'per-vehicle via dealer_dismissed_group_options.';

CREATE TABLE IF NOT EXISTS public.dealer_dismissed_group_options (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id      uuid NOT NULL REFERENCES public.dealer_vehicles(id) ON DELETE CASCADE,
  group_option_id uuid NOT NULL REFERENCES public.group_options(id) ON DELETE CASCADE,
  dismissed_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vehicle_id, group_option_id)
);

CREATE INDEX IF NOT EXISTS dealer_dismissed_group_options_vehicle_idx
  ON public.dealer_dismissed_group_options (vehicle_id);
CREATE INDEX IF NOT EXISTS dealer_dismissed_group_options_option_idx
  ON public.dealer_dismissed_group_options (group_option_id);

ALTER TABLE public.dealer_dismissed_group_options ENABLE ROW LEVEL SECURITY;

-- Service-role writes from the API route handler; super_admin can also see them.
CREATE POLICY "dealer_dismissed_group_options_super_admin"
  ON public.dealer_dismissed_group_options FOR ALL
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'super_admin');
