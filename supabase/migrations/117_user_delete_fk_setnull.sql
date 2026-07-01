-- Fix "Database error deleting user".
--
-- Deleting an auth user cascades to public.profiles (001, ON DELETE CASCADE),
-- but several actor/audit columns reference profiles(id) / auth.users(id) with
-- the DEFAULT action (RESTRICT/NO ACTION). Any dealer_admin/staff user who
-- placed a label order, edited a vehicle, or uploaded a Builder image therefore
-- cannot be deleted — the FK blocks the cascade and GoTrue returns the generic
-- "Database error deleting user".
--
-- These are historical "who did it" columns: the order/audit/image record must
-- survive, only the actor reference should clear. Convert them to
-- ON DELETE SET NULL (matching invited_by/assigned_by/performed_by elsewhere).
-- Each row keeps its denormalized companion (ordered_by_name, changed_by_email).

ALTER TABLE label_orders
  DROP CONSTRAINT IF EXISTS label_orders_ordered_by_fkey,
  ADD  CONSTRAINT label_orders_ordered_by_fkey
    FOREIGN KEY (ordered_by) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE vehicle_audit_log
  DROP CONSTRAINT IF EXISTS vehicle_audit_log_changed_by_fkey,
  ADD  CONSTRAINT vehicle_audit_log_changed_by_fkey
    FOREIGN KEY (changed_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE image_library
  DROP CONSTRAINT IF EXISTS image_library_uploaded_by_fkey,
  ADD  CONSTRAINT image_library_uploaded_by_fkey
    FOREIGN KEY (uploaded_by) REFERENCES auth.users(id) ON DELETE SET NULL;
