-- Migration 036: Remove duplicate templates (same dealer_id + name).
-- Keeps the most recently updated row per dealer+name pair.
-- Safe to run multiple times — a no-op once duplicates are gone.
DELETE FROM public.templates
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY dealer_id, name
             ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
           ) AS rn
    FROM public.templates
  ) ranked
  WHERE rn > 1
);
