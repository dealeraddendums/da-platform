-- 189_profiles_rls_no_recursion.sql — profiles RLS: remove the self-referencing policy.
--
-- profiles_dealer_read (001) read profiles inside a profiles policy, so Postgres raised
-- "infinite recursion detected in policy for relation profiles" for EVERY anon / authenticated query that
-- touched profiles — directly or through the ~40 other tables' policies that look up the caller's profile
-- (dealers, groups, templates, dealer_settings, …) and the security_invoker CRM views. The app reads
-- profiles with the service role, so nothing depended on it; the effective access was "none, via an error".
--
-- Least privilege: users read only their own profile (profiles_self_read, unchanged). The dealer-wide read
-- is dropped rather than rebuilt — colleague lists go through /api/users (service role, role-checked), and
-- re-enabling it would newly expose colleagues' emails / phones to the public API. Other tables' policies
-- only look up the caller's own row, so they work again with self-read alone.
drop policy if exists "profiles_dealer_read" on public.profiles;

-- Found by the same anon / authenticated sweep (scripts/sql/rls-recursion-verify.sql): two public tables
-- had RLS off, so the anon key could read them — a 100k-row dealer_vehicles backup and the QA environment
-- table. Neither is read by the app (service role only). RLS on with no policies = service role only.
alter table public.dealer_vehicles_phantom_backup_20260924 enable row level security;
alter table public.qa_test_environment enable row level security;
