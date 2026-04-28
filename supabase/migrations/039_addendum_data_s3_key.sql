-- Migration 039: add s3_key column to addendum_data
-- Stores the permanent S3 object key for each printed document.
-- Path format: {internal_dealer_id}/{vehicle_uuid}/{doc_type}_{timestamp}.pdf

alter table public.addendum_data
  add column if not exists s3_key text;

comment on column public.addendum_data.s3_key is
  'S3 object key for the PDF generated at print time. '
  'Format: {dealers.internal_id}/{dealer_vehicles.id}/{doc_type}_{timestamp}.pdf';
