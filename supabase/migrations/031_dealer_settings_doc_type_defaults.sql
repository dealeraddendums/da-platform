-- Migration 031: Expand dealer_settings default template columns per doc type
-- Adds 9 columns (addendum/infosheet/buyersguide × new/used/cpo)
-- Also expands templates.document_type CHECK to include 'buyers_guide'

ALTER TABLE public.dealer_settings
  ADD COLUMN IF NOT EXISTS default_addendum_new     uuid NULL REFERENCES public.templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_addendum_used    uuid NULL REFERENCES public.templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_addendum_cpo     uuid NULL REFERENCES public.templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_infosheet_new    uuid NULL REFERENCES public.templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_infosheet_used   uuid NULL REFERENCES public.templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_infosheet_cpo    uuid NULL REFERENCES public.templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_buyersguide_new  uuid NULL REFERENCES public.templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_buyersguide_used uuid NULL REFERENCES public.templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_buyersguide_cpo  uuid NULL REFERENCES public.templates(id) ON DELETE SET NULL;

-- Expand templates.document_type to accept 'buyers_guide'
ALTER TABLE public.templates DROP CONSTRAINT IF EXISTS templates_document_type_check;
ALTER TABLE public.templates ADD CONSTRAINT templates_document_type_check
  CHECK (document_type IN ('addendum', 'infosheet', 'buyers_guide'));
