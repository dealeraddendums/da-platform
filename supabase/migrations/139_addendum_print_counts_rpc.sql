-- Migration 139: fleet-wide per-dealer addendum print counts, for sorting the
-- admin Dealers list by Lifetime / Last-30 / 5-4-split across ALL pages.
--
-- The list is server-paged; computed-column sorts used to apply only within
-- the fetched page (getPrintCounts is scoped to the page's 25 dealers), so
-- clicking Lifetime/Last 30/Group/Status toggled the arrow without any real
-- reordering. The route now computes full-dataset sort keys; print counts
-- come from this one GROUP BY instead of pulling print_history rows.
--
-- Same definition as the canonical display counts (7b82dbc): DISTINCT
-- vehicles with an ADDENDUM printed, optional trailing window.

create or replace function addendum_print_counts(p_since timestamptz default null)
returns table(dealer_id text, vehicles integer)
language sql
stable
as $$
  select ph.dealer_id, count(distinct ph.vehicle_id)::integer as vehicles
  from print_history ph
  where ph.document_type = 'addendum'
    and (p_since is null or ph.created_at >= p_since)
  group by ph.dealer_id
$$;

-- Service-role-only surface (the admin API calls it); keep it out of anon/authed.
revoke execute on function addendum_print_counts(timestamptz) from public, anon, authenticated;
