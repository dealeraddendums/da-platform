// DA-CRM directory: Dealers · Groups · Partners (vendors + feed suppliers).
/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import Pager from "@/components/Pager";
import PartnerForm from "@/components/crm/PartnerForm";
import { StagePill } from "@/components/crm/CompanyHeader";
import { Tag } from "@/components/crm/CrmBadges";
import { dealersBillingStates } from "@/lib/crm/billing-status";
import { requireCrmPage } from "@/lib/crm/page-guard";
import { crmAdmin, staffNames } from "@/lib/crm/queries";
import { KIND_LABEL, STAGES, STAGE_LABEL, fmtAgo, type Stage } from "@/lib/crm/format";
import { formatPhone } from "@/lib/crm/phone";
import { pageHref } from "@/lib/crm/paging";

export const metadata = { title: "Dealers — DA-CRM" };
const PAGE = 50;
const TH: React.CSSProperties = { fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", fontWeight: 600 };
const TABS = [
  { key: "dealers", label: "Dealers", kinds: ["dealer"] },
  { key: "groups", label: "Groups", kinds: ["group"] },
  { key: "partners", label: "Partners", kinds: ["vendor", "feed_supplier"] },
] as const;

type SP = { tab?: string; q?: string; page?: string; inactive?: string; stage?: string; owner?: string; review?: string };

export default async function CrmDirectoryPage({ searchParams }: { searchParams: SP }) {
  await requireCrmPage("/crm/dealers");
  const admin = crmAdmin();
  const tab = TABS.find((t) => t.key === searchParams.tab) ?? TABS[0];
  const q = (searchParams.q ?? "").trim().replace(/[%_,()\\]/g, " ").slice(0, 80);
  const page = Math.max(1, Number(searchParams.page) || 1);
  const showInactive = searchParams.inactive === "1";
  // Partners: feed suppliers whose settings still need a human look (crm_feed_supplier_settings.needs_review).
  const reviewIds: string[] = tab.key === "partners"
    ? ((await admin.from("crm_feed_supplier_settings").select("company_id").eq("needs_review", true)).data ?? []).map((r: any) => r.company_id)
    : [];
  const reviewSet = new Set(reviewIds);
  const onlyReview = tab.key === "partners" && searchParams.review === "1";

  let query = admin.from("crm_company_directory")
    .select("id, kind, name, dealer_text_id, active, city, state, phone, account_type, pipeline_stage, owner_staff_id, trial_day, last_activity_at, contact_count, open_tickets, open_tasks", { count: "exact" })
    .in("kind", tab.kinds as unknown as string[])
    .order("last_activity_at", { ascending: false, nullsFirst: false })
    .order("name")
    .range((page - 1) * PAGE, page * PAGE - 1);
  if (q) query = query.or(`name.ilike.%${q}%,dealer_text_id.ilike.%${q}%,city.ilike.%${q}%`);
  if (!showInactive && tab.key !== "partners") query = query.eq("active", true);
  if (tab.key === "dealers" && searchParams.stage && (STAGES as readonly string[]).includes(searchParams.stage)) query = query.eq("pipeline_stage", searchParams.stage);
  if (onlyReview) query = query.in("id", reviewIds.length ? reviewIds : ["00000000-0000-0000-0000-000000000000"]);
  if (searchParams.owner === "none") query = query.is("owner_staff_id", null);
  else if (searchParams.owner) query = query.eq("owner_staff_id", searchParams.owner);
  const [{ data: rows, count, error }, staff] = await Promise.all([query, staffNames(admin)]);
  // Paying dealers show DA-Billing's status (stored copy, refreshed in one batch when stale).
  const dealerIds: string[] = (rows ?? []).filter((d: any) => d.kind === "dealer" && d.pipeline_stage === "paying").map((d: any) => d.id);
  const { data: dealerRefs } = dealerIds.length ? await admin.from("crm_companies").select("id, dealer_id").in("id", dealerIds) : { data: [] };
  const billingStates = await dealersBillingStates(admin, (dealerRefs ?? []).map((r: any) => r.dealer_id)).catch(() => new Map());
  const billingFor = new Map<string, any>((dealerRefs ?? []).map((r: any) => [r.id, billingStates.get(r.dealer_id) ?? null]));
  const base = { ...searchParams, tab: tab.key };

  return (
    <div>
      <PageHeader title="Dealers" subtitle="Dealerships, dealer groups and partners — contacts, owners and communication history." />
      <nav className="crm-tabs" aria-label="Directory" style={{ marginBottom: 16 }}>
        {TABS.map((t) => (
          <Link key={t.key} href={`/crm/dealers?tab=${t.key}`} className="crm-tab" aria-current={t.key === tab.key ? "page" : undefined}>{t.label}</Link>
        ))}
      </nav>
      {tab.key === "partners" && <PartnerForm />}
      <form className="card" style={{ padding: 12, marginBottom: 16, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <input type="hidden" name="tab" value={tab.key} />
        <input className="input" name="q" defaultValue={searchParams.q ?? ""} placeholder={tab.key === "dealers" ? "Search name, dealer ID or city…" : "Search name or city…"} style={{ maxWidth: 320 }} />
        {tab.key === "dealers" && (
          <select className="input" name="stage" defaultValue={searchParams.stage ?? ""} style={{ maxWidth: 220 }}>
            <option value="">All stages</option>
            {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
          </select>
        )}
        <select className="input" name="owner" defaultValue={searchParams.owner ?? ""} style={{ maxWidth: 200 }}>
          <option value="">Any owner</option>
          <option value="none">Unassigned</option>
          {Object.entries(staff).map(([id, n]) => <option key={id} value={id}>{n}</option>)}
        </select>
        {tab.key !== "partners" && (
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-secondary)" }}>
            <input type="checkbox" name="inactive" value="1" defaultChecked={showInactive} /> Include inactive
          </label>
        )}
        {tab.key === "partners" && (
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-secondary)" }}>
            <input type="checkbox" name="review" value="1" defaultChecked={onlyReview} /> Needs review ({reviewIds.length})
          </label>
        )}
        <button className="btn btn-primary" type="submit">Search</button>
      </form>

      <div className="card" style={{ overflowX: "auto" }}>
        {error ? (
          <p style={{ padding: 16, margin: 0, color: "var(--error)" }}>Couldn&apos;t load: {error.message}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", textAlign: "left" }}>
                <th className="px-3 py-2" style={TH}>Name</th>
                {tab.key === "partners" && <th className="px-3 py-2" style={TH}>Type</th>}
                <th className="px-3 py-2" style={TH}>Location</th>
                <th className="px-3 py-2" style={TH}>Phone</th>
                {tab.key === "dealers" && <th className="px-3 py-2" style={TH}>Stage</th>}
                <th className="px-3 py-2" style={TH}>Owner</th>
                <th className="px-3 py-2" style={TH}>Contacts</th>
                <th className="px-3 py-2" style={TH}>Last activity</th>
                <th className="px-3 py-2" style={TH}>Open items</th>
              </tr>
            </thead>
            <tbody>
              {(rows ?? []).map((d: any) => (
                <tr key={d.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td className="px-3 py-2">
                    <Link href={`/crm/companies/${d.id}${reviewSet.has(d.id) ? "?panel=settings" : ""}`} className="crm-link" style={{ fontWeight: 500 }}>{d.name}</Link>
                    {reviewSet.has(d.id) && <Tag tone="warn" style={{ marginLeft: 6 }} title="Feed supplier settings need review — opens Settings">Needs review</Tag>}
                    {d.dealer_text_id && <span style={{ color: "var(--text-muted)", fontSize: 11 }}> · {d.dealer_text_id}</span>}
                    {!d.active && <span style={{ color: "var(--text-muted)", fontSize: 11 }}> · inactive</span>}
                  </td>
                  {tab.key === "partners" && <td className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>{KIND_LABEL[d.kind]}</td>}
                  <td className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>{[d.city, d.state].filter(Boolean).join(", ") || "—"}</td>
                  <td className="px-3 py-2" style={{ whiteSpace: "nowrap", color: "var(--text-secondary)" }}>{formatPhone(d.phone) || "—"}</td>
                  {tab.key === "dealers" && (
                    <td className="px-3 py-2" style={{ whiteSpace: "nowrap" }}>
                      {d.pipeline_stage
                        ? <StagePill stage={d.pipeline_stage as Stage} billing={billingFor.get(d.id)?.state ?? null}
                            title={d.pipeline_stage === "paying" ? "From DA-Billing" : undefined} />
                        : "—"}
                      {d.pipeline_stage === "trial" && d.trial_day && <span style={{ color: "var(--text-muted)", fontSize: 12 }}> · day {d.trial_day}</span>}
                    </td>
                  )}
                  <td className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>{d.owner_staff_id ? staff[d.owner_staff_id] ?? "—" : "—"}</td>
                  <td className="px-3 py-2">{d.contact_count}</td>
                  <td className="px-3 py-2" style={{ whiteSpace: "nowrap", color: "var(--text-secondary)" }}>{fmtAgo(d.last_activity_at)}</td>
                  <td className="px-3 py-2" style={{ color: d.open_tickets + d.open_tasks ? "var(--text-primary)" : "var(--text-muted)" }}>{d.open_tickets + d.open_tasks}</td>
                </tr>
              ))}
              {!(rows ?? []).length && (
                <tr><td colSpan={9} className="px-3 py-4" style={{ color: "var(--text-muted)" }}>Nothing matches.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      <Pager
        page={page}
        totalPages={Math.max(1, Math.ceil((count ?? 0) / PAGE))}
        prevHref={pageHref("/crm/dealers", base, page - 1)}
        nextHref={pageHref("/crm/dealers", base, page + 1)}
        summary={`${count ?? 0} ${tab.label.toLowerCase()}`}
      />
    </div>
  );
}
