-- 160: Help Center — an INTERNAL (staff-only) article audience.
--
-- The Help Center has always been dealer-facing: `audience` is
-- 'dealer' | 'group' | 'all' (migration 091) and every dealer surface filters
-- with an ALLOWLIST (`.in("audience", [...])`), so a new value is hidden from
-- dealers by construction rather than by remembering to exclude it.
--
-- Support needs somewhere to keep its own cheat sheets — the migrate-vs-signup
-- script, for one — next to the dealer articles they already work in, without
-- those ever reaching a dealer. That is what 'internal' is: same table, same
-- editor, never rendered to a dealer.
--
-- WHY A CHECK CHANGE IS ENOUGH, ALMOST
--   * Browse + search (GET /api/help/articles) already allowlist audiences, so
--     they exclude 'internal' the moment it exists.
--   * The AI assistant's retrieval (lib/help-context.ts) already selects only
--     ['dealer','all'], so internal copy can never be quoted back to a dealer.
--   * GET /api/help/articles/[id] did NOT check audience — any authed user
--     could read any PUBLISHED article by id. That is fixed in the same commit
--     as this migration; it also closes the pre-existing case of a 'group'
--     article being readable by a plain dealer.
--
-- Safe to re-run. No data is rewritten: every existing row keeps its audience.

ALTER TABLE public.help_articles
  DROP CONSTRAINT IF EXISTS help_articles_audience_check;

ALTER TABLE public.help_articles
  ADD CONSTRAINT help_articles_audience_check
  CHECK (audience IN ('dealer', 'group', 'all', 'internal'));

COMMENT ON COLUMN public.help_articles.audience IS
  'Who may READ this article: dealer | group | all | internal. '
  'internal = staff-only (super_admin); every dealer-facing surface allowlists '
  'the non-internal values, and GET /api/help/articles/[id] enforces the same.';
