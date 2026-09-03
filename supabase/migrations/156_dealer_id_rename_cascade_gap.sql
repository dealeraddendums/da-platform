-- 156: Close the two gaps that break a dealer_id rename.
--
-- Changing a dealer's Inventory Dealer ID cascades to dealers.dealer_id (the
-- platform's text key) via cascade_dealer_id_change() (migration 113). Two
-- things could leave that rename half-done or block it outright:
--
--   PART 1 — Two FKs to dealers(dealer_id) were created WITHOUT ON UPDATE
--   CASCADE, so a dealer holding rows in either could not be renamed at all:
--     update or delete on table "dealers" violates foreign key constraint
--     "dealer_website_integrations_dealer_id_fkey" on table "dealer_website_integrations"
--   (Riverside Ford Lincoln, ss_1788270257880 -> MP2621, 2026-09-03.)
--   Every other dealer_id FK (addendum_library, dealer_settings, print_history,
--   template_make_overrides, templates, vehicle_options) already cascades.
--
--   PART 2 — Several tables carry the text dealer_id with NO foreign key at
--   all ("soft references"). Nothing moved them, so a rename silently orphaned
--   the dealer's Builder images, custom paper sizes, in-flight prints, feed
--   roster row, and reporting history. Only profiles was handled.
--
-- Both parts are idempotent and safe to re-run.

-- ---------------------------------------------------------------------------
-- PART 1: give the two lagging FKs ON UPDATE CASCADE (ON DELETE CASCADE kept).
-- ---------------------------------------------------------------------------

ALTER TABLE public.dealer_website_integrations
  DROP CONSTRAINT IF EXISTS dealer_website_integrations_dealer_id_fkey;
ALTER TABLE public.dealer_website_integrations
  ADD CONSTRAINT dealer_website_integrations_dealer_id_fkey
  FOREIGN KEY (dealer_id) REFERENCES public.dealers(dealer_id)
  ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE public.key_owners
  DROP CONSTRAINT IF EXISTS key_owners_dealer_id_fkey;
ALTER TABLE public.key_owners
  ADD CONSTRAINT key_owners_dealer_id_fkey
  FOREIGN KEY (dealer_id) REFERENCES public.dealers(dealer_id)
  ON UPDATE CASCADE ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- PART 2: move the soft (FK-less) text references in the same transaction.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cascade_dealer_id_change(
  p_dealer_uuid uuid, p_old text, p_new text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Soft references: text dealer_id, no FK, so nothing moves them automatically.
  -- Live config + data the dealer would otherwise lose on rename.
  UPDATE profiles            SET dealer_id = p_new WHERE dealer_id = p_old;
  UPDATE image_library       SET dealer_id = p_new WHERE dealer_id = p_old;
  UPDATE dealer_custom_sizes SET dealer_id = p_new WHERE dealer_id = p_old;
  UPDATE pending_prints      SET dealer_id = p_new WHERE dealer_id = p_old;
  UPDATE ai_content_cache    SET dealer_id = p_new WHERE dealer_id = p_old;
  UPDATE fortellis_dealers   SET dealer_id = p_new WHERE dealer_id = p_old;
  -- addendum_data.legacy_dealer_id is NOT legacy-only despite the name: it is
  -- the table's text-dealer lookup key (dealer_id there is the UUID), written by
  -- record-print.ts as dealerTextId and read by the options editor, the widget
  -- options routes, and the option-count routes. It must follow the rename.
  UPDATE addendum_data       SET legacy_dealer_id = p_new WHERE legacy_dealer_id = p_old;
  -- History the dealer's own reports/UI read back by dealer_id.
  UPDATE addendum_history          SET dealer_id = p_new WHERE dealer_id = p_old;
  UPDATE help_conversations        SET dealer_id = p_new WHERE dealer_id = p_old;
  UPDATE vin_decode_log            SET dealer_id = p_new WHERE dealer_id = p_old;
  UPDATE vehicle_audit_log         SET dealer_id = p_new WHERE dealer_id = p_old;
  UPDATE vehicle_audit_log_archive SET dealer_id = p_new WHERE dealer_id = p_old;

  -- Deliberately NOT moved:
  --   dealer_vehicles / dealer_vehicles_archive — the caller deactivates the
  --     old-id inventory instead; the feed re-ingests under the new id. Moving
  --     them here would make that deactivation match zero rows.
  --   admin_audit.target_dealer_id — audit trail; it records the id as it was.
  --   print_history.legacy_dealer_id — inert: NULL on all 3,945 rows fleet-wide
  --     and read by nothing; reserved for the Aurora id, a different namespace.
  --   tekion_dealers.dealer_id — the Tekion-side id, not ours.
  --   feed_company_dealers.feed_dealer_id — the provider's feed id, not ours.
  --   self_serve_signups, invitations.scope_dealer_ids — linked by UUID, stable.

  -- Renaming dealers.dealer_id cascades to templates / dealer_settings /
  -- vehicle_options / print_history / addendum_library / template_make_overrides
  -- / dealer_website_integrations / key_owners via ON UPDATE CASCADE.
  -- Keep inventory_dealer_id in lock-step. Guard on the old value so a stale or
  -- double-fired call is a harmless no-op.
  UPDATE dealers
     SET dealer_id = p_new, inventory_dealer_id = p_new
   WHERE id = p_dealer_uuid AND dealer_id = p_old;
END;
$function$;
