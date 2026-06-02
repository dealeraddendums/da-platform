-- Persist the placing user's display name on each label order so the
-- Order History table can show who placed it without re-resolving via
-- profiles on every load. label_orders.ordered_by already stores the
-- user's auth sub (set in app/api/orders/labels/route.ts); this column
-- adds the at-the-time name snapshot.
--
-- Backfill maps existing rows' ordered_by sub → profiles.full_name.
-- Rows where the original placer is gone (deleted profile / pre-account
-- migration ghost) stay null and render "—" in the UI.

ALTER TABLE public.label_orders
  ADD COLUMN IF NOT EXISTS ordered_by_name text;

UPDATE public.label_orders lo
   SET ordered_by_name = p.full_name
  FROM public.profiles p
 WHERE lo.ordered_by = p.id
   AND lo.ordered_by_name IS NULL
   AND p.full_name IS NOT NULL;
