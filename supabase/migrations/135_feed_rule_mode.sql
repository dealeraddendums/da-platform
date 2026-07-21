-- Migration 135: Feed product rules gain a MODE + MATCH TYPE.
--
-- Rules now include as well as exclude, so the rule builder is full-featured:
--   mode:
--     'exclude' (default, existing behavior) — matched products are DROPPED
--       from the rule's output; the built-in markup/discount (negative-line)
--       exclusion ALSO applies.
--     'include' — the output contains ONLY products matching the patterns;
--       the built-in negative-line exclusion is BYPASSED (so an "only Dealer
--       Discounts" rule can surface negative lines). Patterns alone define the
--       capture.
--   match_type:
--     'contains' (default) — case-insensitive substring match.
--     'exact'             — case-insensitive whole-name match.
--
-- All existing rules default to exclude/contains → unchanged behavior.

alter table feed_exclusion_rules
  add column if not exists mode text not null default 'exclude'
    check (mode in ('exclude', 'include')),
  add column if not exists match_type text not null default 'contains'
    check (match_type in ('contains', 'exact'));
