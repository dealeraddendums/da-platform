-- Custom access token hook: promotes app_metadata fields to top-level JWT claims.
-- After running this migration, register the hook in the Supabase dashboard:
--   Authentication > Hooks > Custom Access Token Hook
--   → select public.custom_access_token_hook
--
-- Roles: super_admin | group_admin | dealer_admin | dealer_user

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  claims   jsonb;
  app_meta jsonb;
BEGIN
  claims   := event -> 'claims';
  app_meta := claims -> 'app_metadata';

  IF app_meta IS NOT NULL THEN
    IF app_meta ? 'role' THEN
      claims := jsonb_set(claims, '{role}', app_meta -> 'role');
    END IF;
    IF app_meta ? 'dealer_id' THEN
      claims := jsonb_set(claims, '{dealer_id}', app_meta -> 'dealer_id');
    END IF;
  END IF;

  RETURN jsonb_set(event, '{claims}', claims);
END;
$$;

GRANT EXECUTE ON FUNCTION public.custom_access_token_hook TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook FROM PUBLIC;
