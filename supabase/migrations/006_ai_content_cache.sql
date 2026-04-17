-- Migration 006: AI content cache table
-- Caches Claude-generated vehicle descriptions and features per VIN + dealer

CREATE TABLE IF NOT EXISTS ai_content_cache (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  vin           text        NOT NULL,
  dealer_id     text        NOT NULL,
  description   text,
  features      jsonb,      -- [string, string][] pairs for 2-col widget
  generated_at  timestamptz DEFAULT now(),
  model_version text,
  CONSTRAINT ai_content_cache_vin_dealer_key UNIQUE (vin, dealer_id)
);

ALTER TABLE ai_content_cache ENABLE ROW LEVEL SECURITY;

-- super_admin: full access
CREATE POLICY "ai_cache_super_admin_all" ON ai_content_cache
  FOR ALL TO authenticated
  USING ( (auth.jwt() ->> 'role') = 'super_admin' )
  WITH CHECK ( (auth.jwt() ->> 'role') = 'super_admin' );

-- dealer_admin / dealer_user: read their own dealer's cached content
CREATE POLICY "ai_cache_dealer_read" ON ai_content_cache
  FOR SELECT TO authenticated
  USING ( dealer_id = (auth.jwt() ->> 'dealer_id') );

-- API routes write via service role key (bypasses RLS)
