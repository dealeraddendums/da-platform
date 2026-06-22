-- 110_white_label.sql — Phase 12a: reseller white-label branding (app-side)
--
-- A group/reseller can be given a custom domain + a branding theme (logo, name,
-- colors). When a request arrives on an ACTIVE custom_domain, the app resolves
-- that group's branding (host-driven, not user-driven). Canonical / unknown
-- hosts render default DA branding. See docs/white-label-phase12.md.
--
-- 12a is testable without real reseller DNS/TLS by pointing a DA-controlled test
-- host (e.g. a *.dealeraddendums.com subdomain) at a group's custom_domain.
-- Real DNS/cert provisioning + reseller-domain auth are Phase 12b.
--
-- RLS unchanged — `groups` is already gated; these columns are written only
-- through the super_admin-gated PATCH /api/groups/[id] (admin client).

alter table public.groups
  add column if not exists custom_domain        text,
  add column if not exists branding             jsonb,
  add column if not exists custom_domain_status text not null default 'pending';

-- One group per domain (case-insensitive); many groups may have NULL (no domain).
create unique index if not exists groups_custom_domain_uniq
  on public.groups (lower(custom_domain))
  where custom_domain is not null;

-- Fast host→group lookup for active branded domains.
create index if not exists groups_custom_domain_active_idx
  on public.groups (lower(custom_domain))
  where custom_domain is not null and custom_domain_status = 'active';
