-- Adds a per-row document type to dealer_custom_sizes so a custom size
-- (e.g. landscape 11"×8.5") can be classified as an infosheet — surfacing
-- the Description + Features widgets in the builder and routing the
-- correct background bucket + AI fetch at PDF-render time.
--
-- Existing rows default to 'addendum' to preserve current behavior.
-- The CHECK constraint mirrors the saved_templates.document_type values.

ALTER TABLE public.dealer_custom_sizes
  ADD COLUMN IF NOT EXISTS doc_type text NOT NULL DEFAULT 'addendum'
    CHECK (doc_type IN ('addendum', 'infosheet'));
