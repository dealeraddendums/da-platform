-- 113_dealer_id_sync_cascade.sql
--
-- Bug fix: when a dealer's inventory_dealer_id is changed in the admin UI,
-- dealer_id must stay in sync. dealer_id is the text key the whole system uses
-- (vehicles, ghost tokens, profiles, templates, dealer_settings, vehicle_options,
-- print_history, addendum_library). Those five tables FK to dealers(dealer_id),
-- but the constraints were ON DELETE CASCADE only (no ON UPDATE CASCADE) and not
-- deferrable — so a text-id rename couldn't be done with ordered statements.
--
-- 1) Add ON UPDATE CASCADE to the dealer_id FKs so renaming dealers.dealer_id
--    propagates to the child rows in ONE atomic statement. Done dynamically so
--    it's robust to the auto-generated constraint names. profiles.dealer_id has
--    no FK (plain text) — the function below updates it explicitly.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname, cl.relname AS tbl
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid
    JOIN pg_class rf ON rf.oid = con.confrelid
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
    WHERE con.contype = 'f'
      AND rf.relname = 'dealers'
      AND a.attname = 'dealer_id'
      AND cl.relname IN ('templates','dealer_settings','vehicle_options','print_history','addendum_library')
  LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', r.tbl, r.conname);
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (dealer_id) '
      || 'REFERENCES public.dealers(dealer_id) ON UPDATE CASCADE ON DELETE CASCADE',
      r.tbl, r.tbl || '_dealer_id_fkey'
    );
  END LOOP;
END $$;

-- 2) Atomic dealer_id rename. Children follow via the ON UPDATE CASCADE FKs;
--    profiles (no FK) + inventory_dealer_id are set here so all the text ids move
--    together in a single transaction (one RPC call = one transaction).
--    SECURITY DEFINER so the route's service-role call runs it. NOT an
--    arbitrary-SQL RPC — a single fixed, parameterized rename (mirrors the
--    printed_vehicle_count / distinct_vehicle_fuels convention).
CREATE OR REPLACE FUNCTION public.cascade_dealer_id_change(
  p_dealer_uuid uuid,
  p_old text,
  p_new text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- profiles has no FK to dealers(dealer_id) — update explicitly.
  UPDATE profiles SET dealer_id = p_new WHERE dealer_id = p_old;
  -- Renaming dealers.dealer_id cascades to templates / dealer_settings /
  -- vehicle_options / print_history / addendum_library via ON UPDATE CASCADE.
  -- Keep inventory_dealer_id in lock-step. Guard on the old value so a stale or
  -- double-fired call is a harmless no-op.
  UPDATE dealers
     SET dealer_id = p_new, inventory_dealer_id = p_new
   WHERE id = p_dealer_uuid AND dealer_id = p_old;
END;
$$;

-- Only the service role (used by the API route) should invoke this — keep it
-- off the public PostgREST RPC surface.
REVOKE ALL ON FUNCTION public.cascade_dealer_id_change(uuid, text, text) FROM public;
REVOKE ALL ON FUNCTION public.cascade_dealer_id_change(uuid, text, text) FROM anon, authenticated;
