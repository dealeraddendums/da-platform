-- 099_pending_prints.sql
-- Print recording moves from PDF GENERATION to the actual Send-to-Printer /
-- Download action. Previously every preview-modal open logged print_history +
-- flipped dealer_vehicles print flags — even for cancelled previews — which
-- polluted per-vehicle History and event metrics (multiprint-qa-2026-06-11,
-- secondary item).
--
-- Flow: the PDF routes stash the full logging payload here and return a
-- one-time token; POST /api/print/confirm claims the row (atomic delete) and
-- runs the logging pipeline. Cancelled previews leave an orphan row that the
-- confirm endpoint garbage-collects after 48h.
CREATE TABLE IF NOT EXISTS public.pending_prints (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id  text NOT NULL,                 -- dealers.dealer_id (text id) — authz check at confirm
  created_by text NOT NULL,                 -- auth sub at generation time
  payload    jsonb NOT NULL,                -- PrintRecordPayload[] (lib/record-print.ts)
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pending_prints_created_at_idx ON public.pending_prints (created_at);

-- RLS on with no policies → anon/authenticated PostgREST surface is blocked;
-- only the service-role server client reads/writes.
ALTER TABLE public.pending_prints ENABLE ROW LEVEL SECURITY;
