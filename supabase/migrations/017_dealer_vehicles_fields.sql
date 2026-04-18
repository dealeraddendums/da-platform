-- Migration 017: add description, options, created_by to dealer_vehicles
ALTER TABLE public.dealer_vehicles
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS options text,
  ADD COLUMN IF NOT EXISTS created_by text;
  -- created_by values: 'vin_decoder' | 'csv_import' | 'manual'
  --   | 'automatic0' | 'automatic1' ... 'automaticX' (ETL job names)
  -- Set at creation; never overwritten by user edits or PATCH endpoint.
