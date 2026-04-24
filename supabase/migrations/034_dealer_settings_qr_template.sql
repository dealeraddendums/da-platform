-- Migration 034: Add QR URL template to dealer_settings
ALTER TABLE public.dealer_settings
  ADD COLUMN IF NOT EXISTS qr_url_template text;
