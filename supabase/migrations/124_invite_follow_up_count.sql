-- 124: migration-invite drip sequence — how many automated follow-ups this
-- dealer has received (0 = none yet; max 5). Incremented by
-- /api/migration/send-follow-ups (daily cron); reset to 0 by a manual resend
-- so the drip restarts from the fresh invite.
ALTER TABLE dealers ADD COLUMN IF NOT EXISTS invite_follow_up_count int NOT NULL DEFAULT 0;
