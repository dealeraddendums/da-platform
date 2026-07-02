-- Per-dealer feature selector for the Website Integrations widget.
-- 'button' = Magic Button only, 'pricing' = Pricing Stack only, 'both' = both.
-- Stored per dealer so the platform knows what each dealer enabled without
-- having to ask Dealer.com what integration they configured on their side.
ALTER TABLE dealer_website_integrations
  ADD COLUMN IF NOT EXISTS feature text NOT NULL DEFAULT 'both';
