-- 165: Self-service exports, Phase 2 — optional remote folder for a feed's upload.
-- NULL (every existing feed) = upload into the login's starting directory, which
-- is what pushes have always done. Dealer-owned exports can name a folder.
ALTER TABLE public.feed_companies
  ADD COLUMN IF NOT EXISTS ftp_path text NULL;
