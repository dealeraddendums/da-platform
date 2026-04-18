-- Migration 009: Add pdf_url to print_history
ALTER TABLE public.print_history
  ADD COLUMN IF NOT EXISTS pdf_url text;

COMMENT ON COLUMN public.print_history.pdf_url IS 'S3 signed URL or path to generated PDF; updated after successful PDF generation';
