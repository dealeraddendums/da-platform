-- 144: per-dealer "Always show cents" price-display toggle (Print Settings).
-- false (default) = current behavior: the whole addendum drops ".00" when
-- every amount on it is a whole dollar, and shows two decimals everywhere as
-- soon as any price has cents (priceSetUsesDecimals). true = every numeric
-- money label on the printed addendum always renders two decimals ($199.00,
-- $27,100.00). Display-only: feed exports, subtotal math, and the price
-- modifier codes (NC/FR/INC/NP/%/^/|/~) are unaffected.
ALTER TABLE public.dealer_settings
  ADD COLUMN IF NOT EXISTS always_show_cents boolean NOT NULL DEFAULT false;
