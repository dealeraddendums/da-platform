-- Builder scoped images (Platform / Group / Dealer), mirroring Phase-8 widget
-- scoping. image_library (migration 052) was platform-only (no owner column;
-- any authed user reads). Add a scope + owner so a dealer's uploads are visible
-- only to that dealer, a group_admin's uploads to all dealers in that group, and
-- platform images to everyone.

ALTER TABLE image_library
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'platform'
    CHECK (scope IN ('platform', 'group', 'dealer')),
  ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES groups(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS dealer_id text;  -- dealer's TEXT dealer_id, platform-wide convention

-- Existing rows are platform images.
UPDATE image_library SET scope = 'platform' WHERE scope IS NULL;

CREATE INDEX IF NOT EXISTS image_library_scope_group_idx  ON image_library (scope, group_id);
CREATE INDEX IF NOT EXISTS image_library_scope_dealer_idx ON image_library (scope, dealer_id);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- All app access goes through the service-role client (which bypasses RLS) with
-- scope enforced in the API via getJwtClaims; these policies are defense-in-depth
-- so a row can never be read/written outside its scope even via a user client.

-- Read: platform OR own-group OR own-dealer (own-dealer includes a group_admin's
-- active dealer).
DROP POLICY IF EXISTS image_library_read ON image_library;
CREATE POLICY image_library_read ON image_library
  FOR SELECT
  USING (
    scope = 'platform'
    OR (
      scope = 'group'
      AND group_id IN (
        -- a group_admin's own group …
        SELECT p.group_id FROM profiles p WHERE p.id = auth.uid() AND p.group_id IS NOT NULL
        UNION
        -- … the group of the requester's own dealer …
        SELECT d.group_id FROM profiles p
        JOIN dealers d ON d.dealer_id = p.dealer_id
        WHERE p.id = auth.uid() AND d.group_id IS NOT NULL
        UNION
        -- … or the group of the dealer a group_admin is acting as
        SELECT d.group_id FROM profiles p
        JOIN dealers d ON d.id = p.active_dealer_id
        WHERE p.id = auth.uid() AND d.group_id IS NOT NULL
      )
    )
    OR (
      scope = 'dealer'
      AND dealer_id IN (
        -- the requester's own dealer (dealer roles) …
        SELECT p.dealer_id FROM profiles p WHERE p.id = auth.uid() AND p.dealer_id IS NOT NULL
        UNION
        -- … or the dealer a group_admin is currently acting as
        SELECT d.dealer_id FROM profiles p
        JOIN dealers d ON d.id = p.active_dealer_id
        WHERE p.id = auth.uid()
      )
    )
  );

-- Write: group_admin manages their group's images.
DROP POLICY IF EXISTS image_library_group_admin_write ON image_library;
CREATE POLICY image_library_group_admin_write ON image_library
  FOR ALL
  USING (
    scope = 'group'
    AND EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'group_admin' AND p.group_id = image_library.group_id
    )
  )
  WITH CHECK (
    scope = 'group'
    AND EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'group_admin' AND p.group_id = image_library.group_id
    )
  );

-- Write: dealer_admin manages their own dealer's images.
DROP POLICY IF EXISTS image_library_dealer_admin_write ON image_library;
CREATE POLICY image_library_dealer_admin_write ON image_library
  FOR ALL
  USING (
    scope = 'dealer'
    AND EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'dealer_admin' AND p.dealer_id = image_library.dealer_id
    )
  )
  WITH CHECK (
    scope = 'dealer'
    AND EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.role = 'dealer_admin' AND p.dealer_id = image_library.dealer_id
    )
  );

-- (The existing image_library_super_admin policy already grants super_admin full
--  access across all scopes; left in place.)
