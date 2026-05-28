-- Migration 078: fix truncated QA login emails in qa_test_items.steps
--
-- Migrations 074 and 075 seeded the qa_test_items table with step strings
-- containing the truncated address `qa-*@test` (e.g. `qa-dealer-admin@test`
-- — no domain suffix). Testers reading the in-app QA runner copied the
-- literal string into the login form and got "Invalid email" because the
-- address is incomplete.
--
-- The right format everywhere is the full `@test.dealeraddendums.com`. This
-- migration rewrites every occurrence of `@test ` (followed by a space) and
-- `@test!` (followed by an exclamation) inside the jsonb `steps` column to
-- the full domain. Both contexts come straight from the seed strings — the
-- only places `@test` appears with a non-domain suffix in this table — so
-- the targeted text replace is safe and idempotent.
--
-- Migrations 074 and 075 in-tree have also been fixed in the same commit so
-- a fresh cold-start of the schema is correct from the first apply.

UPDATE public.qa_test_items
SET steps = REPLACE(REPLACE(steps::text, '@test /', '@test.dealeraddendums.com /'), '@test!', '@test.dealeraddendums.com!')::jsonb,
    updated_at = now()
WHERE steps::text LIKE '%@test /%'
   OR steps::text LIKE '%@test!%';
