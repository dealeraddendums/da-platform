-- 151_vin_decode_log.sql
-- Decoder usage logging for the /admin/decoder Usage tab.
-- Stats accrue from deploy forward — there is no historical decode data to backfill.
--
-- source values:
--   override        — nhtsa_overrides prefix match (highest priority)
--   pattern         — local nhtsa_vin_patterns cache hit
--   vpic            — live NHTSA vPIC API call (via lib/vin-decoder chain)
--   dealer_vehicles — prior inventory row fallback
--   wmi_partial     — WMI manufacturer-only partial decode
--   failed          — nothing found
--   vpic_direct     — /api/decode-vin mobile route (hits vPIC directly, chain not wired)

CREATE TABLE IF NOT EXISTS vin_decode_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at timestamptz NOT NULL DEFAULT now(),
  dealer_id text,            -- nullable: admin/non-dealer-context decodes
  user_id uuid,
  role text,
  vin text NOT NULL,
  source text NOT NULL,
  success boolean NOT NULL,
  duration_ms integer
);

-- Service-role only: RLS enabled with no policies.
ALTER TABLE vin_decode_log ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS vin_decode_log_at_idx ON vin_decode_log (at);
CREATE INDEX IF NOT EXISTS vin_decode_log_dealer_at_idx ON vin_decode_log (dealer_id, at);

-- Aggregation RPC for the Usage tab. All grouping happens in SQL so the
-- PostgREST 1000-row clamp never applies (the client only ever sees
-- pre-aggregated daily buckets + a top-5 list).
-- p_days drives the daily time series; summary + top dealers are fixed 30-day.
CREATE OR REPLACE FUNCTION vin_decode_usage_stats(p_days int DEFAULT 60)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'daily', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'day', to_char(d.day, 'YYYY-MM-DD'),
               'count', d.cnt,
               'successes', d.succ
             ) ORDER BY d.day), '[]'::jsonb)
      FROM (
        SELECT date_trunc('day', at) AS day,
               count(*) AS cnt,
               count(*) FILTER (WHERE success) AS succ
        FROM vin_decode_log
        WHERE at >= now() - make_interval(days => GREATEST(LEAST(p_days, 365), 1))
        GROUP BY 1
      ) d
    ),
    'summary', (
      SELECT jsonb_build_object(
        'last7',      count(*) FILTER (WHERE at >= now() - interval '7 days'),
        'last30',     count(*) FILTER (WHERE at >= now() - interval '30 days'),
        'success30',  count(*) FILTER (WHERE at >= now() - interval '30 days' AND success),
        'top_source_30', (
          SELECT source FROM vin_decode_log
          WHERE at >= now() - interval '30 days'
          GROUP BY source ORDER BY count(*) DESC, source LIMIT 1
        ),
        'first_at', min(at)
      )
      FROM vin_decode_log
    ),
    'top_dealers', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'dealer_id', t.dealer_id,
               'decode_count', t.decode_count,
               'success_count', t.success_count,
               'top_source', t.top_source,
               'last_decode_at', t.last_decode_at
             ) ORDER BY t.decode_count DESC, t.dealer_id), '[]'::jsonb)
      FROM (
        SELECT dealer_id,
               count(*) AS decode_count,
               count(*) FILTER (WHERE success) AS success_count,
               mode() WITHIN GROUP (ORDER BY source) AS top_source,
               max(at) AS last_decode_at
        FROM vin_decode_log
        WHERE at >= now() - interval '30 days' AND dealer_id IS NOT NULL
        GROUP BY dealer_id
        ORDER BY count(*) DESC, dealer_id
        LIMIT 5
      ) t
    )
  );
$$;

REVOKE ALL ON FUNCTION vin_decode_usage_stats(int) FROM PUBLIC, anon, authenticated;
