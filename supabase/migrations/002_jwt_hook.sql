-- Custom access token hook: promotes app_metadata fields to top-level JWT claims.
-- After running this migration, register the hook in the Supabase dashboard:
--   Authentication > Hooks > Custom Access Token Hook
--   → select public.custom_access_token_hook
--
-- Once enabled, auth.jwt() ->> 'dealer_id' works directly in RLS and client code.

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  claims        jsonb;
  app_meta      jsonb;
BEGIN
  claims   := event -> 'claims';
  app_meta := claims -> 'app_metadata';

  IF app_meta IS NOT NULL THEN
    IF app_meta ? 'user_type' THEN
      claims := jsonb_set(claims, '{user_type}', app_meta -> 'user_type');
    END IF;
    IF app_meta ? 'dealer_id' THEN
      claims := jsonb_set(claims, '{dealer_id}', app_meta -> 'dealer_id');
    END IF;
    IF (app_meta -> 'impersonating_dealer_id') IS NOT NULL
       AND (app_meta -> 'impersonating_dealer_id') <> 'null'::jsonb THEN
      claims := jsonb_set(claims, '{impersonating_dealer_id}',
                          app_meta -> 'impersonating_dealer_id');
    END IF;
    IF (app_meta -> 'real_user_id') IS NOT NULL
       AND (app_meta -> 'real_user_id') <> 'null'::jsonb THEN
      claims := jsonb_set(claims, '{real_user_id}', app_meta -> 'real_user_id');
    END IF;
  END IF;

  RETURN jsonb_set(event, '{claims}', claims);
END;
$$;

GRANT EXECUTE ON FUNCTION public.custom_access_token_hook TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook FROM PUBLIC;
