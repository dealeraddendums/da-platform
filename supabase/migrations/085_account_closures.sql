-- Dealer self-close: persist the soft "why are you leaving" reason at the
-- moment the dealer downgrades from a paid plan to Free.
--
-- Rows are written by POST /api/billing/me/close after the $0-balance
-- gate passes — one row per close event. dealer_id is the dealers.id
-- UUID (not the text slug) so the FK enforces referential integrity;
-- the close flow already has the resolved UUID on hand from the dealer
-- lookup.
--
-- Re-opens (re-subscribing within the 60-day grace window) DO NOT
-- delete prior closures — they stay as a history trail for churn
-- analytics. A dealer who closes twice will have two rows.

CREATE TABLE IF NOT EXISTS public.account_closures (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id   uuid NOT NULL REFERENCES public.dealers(id) ON DELETE CASCADE,
  reason      text,
  detail      text,
  closed_by   text,
  closed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_closures_dealer_id_idx
  ON public.account_closures (dealer_id);

CREATE INDEX IF NOT EXISTS account_closures_closed_at_idx
  ON public.account_closures (closed_at DESC);

ALTER TABLE public.account_closures ENABLE ROW LEVEL SECURITY;
-- No policies — admin client only (route is server-only with auth).
