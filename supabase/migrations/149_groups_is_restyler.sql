-- Migration 149: Restyler/Upfitter account type (Phase 1)
--
-- A restyler/upfitter services many client stores (~40) with a few vehicles a
-- month each — one GROUP account operated solely by the restyler (service-
-- provider shape, like Dealer General), member stores are lightweight feed-less
-- "dealers" with per-store templates. The flag:
--   * labels the group a Restyler in console/lists,
--   * forces the locked "created using dealeraddendums.com" attribution line on
--     every render from its stores (canvas + PDF),
--   * skips per-store billing provisioning at store creation (Phase 2 wires the
--     single metered group plan),
--   * excludes the group's stores from per-dealer subscription metrics and both
--     trial funnels (its own business model, like the group-billed exclusion).
-- super_admin-only toggle via PATCH /api/groups/[id].

ALTER TABLE public.groups
  ADD COLUMN IF NOT EXISTS is_restyler boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.groups.is_restyler IS
  'Restyler/Upfitter service-provider account: locked print attribution, no per-store billing (one metered group plan), excluded from trial funnels + per-dealer subscription metrics.';
