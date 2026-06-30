ALTER TABLE dealers
  ADD COLUMN IF NOT EXISTS feed_authorized_name  TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS feed_authorized_email TEXT DEFAULT NULL;

COMMENT ON COLUMN dealers.feed_authorized_name  IS 'Name of person at the dealership authorized to approve feed/DMS integration (collected at subscription)';
COMMENT ON COLUMN dealers.feed_authorized_email IS 'Email of person authorized to approve feed/DMS integration';
