-- Migration 023: Fix addendum_history unique constraint on legacy_id.
-- The partial unique index created in 022 cannot be used with ON CONFLICT.
-- Replace with a real unique constraint so upsert dedup works correctly.
-- PostgreSQL allows multiple NULLs in a unique constraint (NULL != NULL),
-- so platform rows (legacy_id IS NULL) are unaffected.

DROP INDEX IF EXISTS public.addendum_history_legacy_id_unique;

ALTER TABLE public.addendum_history
  ADD CONSTRAINT addendum_history_legacy_id_key UNIQUE (legacy_id);
