-- 158: dealer enrichment findings (Google Places + email-domain inference).
--
-- Self-serve trial signups capture dealership name, contact name/email, zip and
-- a timestamp. Phone and street address are almost always blank, so sales has
-- nothing to dial and HubSpot companies land without an address. This table
-- holds what an automated Google Places lookup found for a dealer, with the
-- confidence it found it at.
--
-- WHY A SEPARATE TABLE (and not columns on `dealers`):
--   * `dealers` is FK'd from a dozen tables and touched by the legacy ETL; every
--     column added there is a column something else can clobber or block.
--   * Enrichment is a FINDING, not a fact. `needs_review` / `no_match` results
--     must be recorded and reviewable WITHOUT ever appearing on the dealer's own
--     record. Keeping them here makes "what did Google say" and "what does the
--     dealer's record say" two separate questions, which is the whole point.
--   * A dealer's own address/phone stays operator/dealer-owned. Enrichment only
--     fills those when it is `confirmed` AND the field was blank (see
--     lib/enrichment/dealerEnrich.ts) — never an overwrite.
--
-- Keyed on dealers.id (the immutable Supabase UUID), NOT the text dealer_id.
-- Deliberate: the text key gets renamed (ss_… → real inventory id) and every FK
-- that hangs off it needs ON UPDATE CASCADE or it blocks the rename outright
-- (migration 156 fixed exactly that class). A UUID FK can't have that problem.
CREATE TABLE IF NOT EXISTS public.dealer_enrichment (
  dealer_uuid             uuid        PRIMARY KEY
                                      REFERENCES public.dealers(id) ON DELETE CASCADE,

  -- ── What Google Places returned (the finding — never authoritative).
  enriched_address_street text,
  enriched_address_city   text,
  enriched_address_state  text,
  enriched_address_zip    text,
  enriched_phone          text,
  google_place_id         text,

  -- ── How much we trust it.
  --    confirmed    → signup zip matched AND name similarity >= 0.80. Safe to
  --                   fill the dealer's blank fields and the HubSpot company.
  --    needs_review → zip matched, name similarity 0.50–0.80. A dealership that
  --                   was bought or renamed looks exactly like this, so a human
  --                   vets it before anyone calls. Written to HubSpot flagged,
  --                   never to the dealer's own record.
  --    no_match     → nothing credible (incl. a same-name store in another zip;
  --                   zip alone is never enough to accept).
  --    error        → the lookup itself failed (no key, quota, network). Kept as
  --                   a row so the backfill can find and retry it.
  enrichment_status       text        NOT NULL CHECK (enrichment_status IN
                                        ('confirmed','needs_review','no_match','error')),
  enrichment_name_score   numeric,

  -- ── Probable group domain from the contact email (free providers ignored).
  group_domain            text,

  -- ── Mirror of dealers.hubspot_company_id at enrichment time: which CRM
  --    record this finding was pushed to (null = not pushed; test/demo dealer,
  --    HubSpot unconfigured, or the company didn't exist yet).
  hubspot_company_id      text,

  -- ── Provenance, so a surprising result can be explained without re-querying.
  search_query            text,
  matched_name            text,
  -- true only when this finding actually wrote to the dealers row.
  applied_to_dealer       boolean     NOT NULL DEFAULT false,
  notes                   text,

  enriched_at             timestamptz NOT NULL DEFAULT now()
);

-- The operator queue reads "show me everything a human still has to vet".
CREATE INDEX IF NOT EXISTS dealer_enrichment_status_idx
  ON public.dealer_enrichment (enrichment_status, enriched_at DESC);

-- Service-role only: every reader/writer is the admin client inside an
-- authenticated route, the signup hook, or the backfill script.
ALTER TABLE public.dealer_enrichment ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.dealer_enrichment IS
  'Google Places / email-domain enrichment FINDINGS per dealer (keyed on dealers.id). Advisory only: confirmed findings may fill blank dealer fields, needs_review/no_match never touch the dealer row.';
