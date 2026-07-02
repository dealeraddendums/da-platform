-- API-key store for the public data API (da-api-service key-gated routes:
-- /search, /getvehicleoptions, /getdealeroptions). Ports the legacy Aurora
-- `KeyOwner` table into Supabase so those routes can authenticate.
--
-- ⚠️ This table must be POPULATED from the legacy Aurora KeyOwner + users tables
-- (username + user_key → the dealer's Supabase dealer_id) before the key-gated
-- routes return data — until then da-api-service fails closed ("Invalid key.").
-- The public widget feeds (/dealerdotcom, /dealeron, generate-*) do NOT use this.
CREATE TABLE IF NOT EXISTS public.key_owners (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  username   text NOT NULL,
  user_key   text NOT NULL,
  dealer_id  text NOT NULL REFERENCES public.dealers(dealer_id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE (user_key)
);

CREATE INDEX IF NOT EXISTS idx_key_owners_user_key ON public.key_owners (user_key);
CREATE INDEX IF NOT EXISTS idx_key_owners_username ON public.key_owners (username);

-- da-api-service reads this with a least-privilege read-only key. RLS on; the
-- read-only role/anon policy is granted separately (out of band with the key setup).
ALTER TABLE public.key_owners ENABLE ROW LEVEL SECURITY;
