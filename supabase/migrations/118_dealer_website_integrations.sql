-- Website Integrations (Magic Button / pricing widget) per-dealer config.
-- (Spec numbers this "117", but 117 was already used for user_delete_fk_setnull —
--  renumbered to 118. The SQL is otherwise identical to the spec.)
CREATE TABLE IF NOT EXISTS dealer_website_integrations (
  id           uuid    DEFAULT gen_random_uuid() PRIMARY KEY,
  dealer_id    text    NOT NULL REFERENCES dealers(dealer_id) ON DELETE CASCADE,
  provider     text    NOT NULL,                   -- 'dealer_com' | future: 'cargurus', etc.
  button_label text    NOT NULL DEFAULT 'Download Addendum',
  button_css   text,                               -- NULL = use platform default CSS
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now(),
  UNIQUE (dealer_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_dwi_dealer_provider ON dealer_website_integrations (dealer_id, provider);
