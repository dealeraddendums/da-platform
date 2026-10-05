-- 166: Self-service exports, Phase 3 — group exports that cover EVERY member.
--
-- covers_all_members = true: the export includes the owning group's dealers as
-- they are AT PUSH TIME, so a dealer added to the group later is covered
-- automatically. feed_company_dealers rows on such a feed are only per-dealer
-- Feed Dealer ID overrides (a member without a row uses its
-- inventory_dealer_id). Only meaningful for owner_scope='group'.
ALTER TABLE public.feed_companies
  ADD COLUMN IF NOT EXISTS covers_all_members boolean NOT NULL DEFAULT false;

ALTER TABLE public.feed_companies
  ADD CONSTRAINT feed_companies_covers_all_members_check
  CHECK (covers_all_members = false OR owner_scope = 'group');
