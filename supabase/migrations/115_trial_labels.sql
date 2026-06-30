ALTER TABLE dealers
  ADD COLUMN IF NOT EXISTS trial_labels_claimed_at TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN dealers.trial_labels_claimed_at
  IS 'Timestamp when this Trial dealer claimed their one-time free 25-label sample. NULL = not yet claimed.';
