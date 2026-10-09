-- 172: staff headshots for the chat takeover header (2026-10-09).
-- profiles.headshot_url — a square, user-cropped photo (public S3 URL) shown in a
-- circle when that person takes over a Steven chat. Uploaded on Edit User or
-- the person's own profile (POST /api/users/[id]/headshot).
-- help_messages.sender_email — the HubSpot agent's email on relayed agent
-- replies, so the widget can find the matching staff headshot. Never sent to
-- the browser; only the resolved photo URL is.
alter table public.profiles add column if not exists headshot_url text;
alter table public.help_messages add column if not exists sender_email text;
