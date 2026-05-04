-- Migration 050: Add invited_at to dealers for migration invite tracking
-- migration_status column already exists (added in migration 045)

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'dealers' AND column_name = 'invited_at'
  ) THEN
    ALTER TABLE dealers ADD COLUMN invited_at timestamptz;
    COMMENT ON COLUMN dealers.invited_at IS
      'Timestamp when DA Platform 5.0 invitations were sent to all dealer users';
  END IF;
END $$;
