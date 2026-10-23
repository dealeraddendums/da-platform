// DA-CRM Calls — every Dialpad call. Filters: staff, direction, state, date
// range, Unmatched bucket. Click a row for recording, summary, transcript and
// (Unmatched) assignment.
import { PageHeader } from "@/components/PageHeader";
import Pager from "@/components/Pager";
import CallsTable from "@/components/crm/CallsTable";
import { requireCrmPage } from "@/lib/crm/page-guard";
import { CALL_COLUMNS, crmAdmin, decorateCalls, staffNames } from "@/lib/crm/queries";
import { pageHref } from "@/lib/crm/paging";

export const metadata = { title: "Calls — DA-CRM" };
const PAGE = 50;
const STATES = ["completed", "missed", "voicemail", "connected", "ringing"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type SP = { staff?: string; direction?: string; state?: string; from?: string; to?: string; unmatched?: string; page?: string; call?: string };

export default async function CrmCallsPage({ searchParams }: { searchParams: SP }) {
  await requireCrmPage("/crm/communications/calls");
  const admin = crmAdmin();
  const page = Math.max(1, Number(searchParams.page) || 1);

  let q = admin.from("crm_calls").select(CALL_COLUMNS, { count: "exact" })
    .order("started_at", { ascending: false, nullsFirst: false })
    .range((page - 1) * PAGE, page * PAGE - 1);
  if (searchParams.call) q = q.eq("id", searchParams.call);
  if (searchParams.staff === "none") q = q.is("staff_id", null);
  else if (searchParams.staff) q = q.eq("staff_id", searchParams.staff);
  if (searchParams.direction === "inbound" || searchParams.direction === "outbound") q = q.eq("direction", searchParams.direction);
  if (searchParams.state && STATES.includes(searchParams.state)) q = q.eq("state", searchParams.state);
  // Dates are Pacific calendar days.
  if (searchParams.from && DAY.test(searchParams.from)) q = q.gte("started_at", `${searchParams.from}T00:00:00-08:00`);
  if (searchParams.to && DAY.test(searchParams.to)) q = q.lt("started_at", `${nextDay(searchParams.to)}T00:00:00-08:00`);
  if (searchParams.unmatched === "1") q = q.is("company_id", null);

  const [{ data, count, error }, staff, { count: unmatchedCount }] = await Promise.all([
    q,
    staffNames(admin),
    admin.from("crm_calls").select("id", { count: "exact", head: true }).is("company_id", null),
  ]);
  const rows = await decorateCalls(data ?? [], admin);

  return (
    <div>
      <PageHeader title="Calls" subtitle="Dialpad calls, matched to companies and contacts by phone number." />

      {(unmatchedCount ?? 0) > 0 && searchParams.unmatched !== "1" && (
        <a href="/crm/communications/calls?unmatched=1" className="card" style={{ display: "block", padding: "10px 16px", marginBottom: 16, textDecoration: "none", color: "var(--text-primary)", borderLeft: "4px solid var(--orange)" }}>
          <strong>{unmatchedCount}</strong> unmatched call{unmatchedCount === 1 ? "" : "s"} need a company — <span style={{ color: "var(--blue)" }}>review the Unmatched bucket →</span>
        </a>
      )}

      <form className="card" style={{ padding: 12, marginBottom: 16, display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
        <Field label="Staff">
          <select className="input" name="staff" defaultValue={searchParams.staff ?? ""}>
            <option value="">All staff</option>
            {Object.entries(staff).sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            <option value="none">No staff (unmapped)</option>
          </select>
        </Field>
        <Field label="Direction">
          <select className="input" name="direction" defaultValue={searchParams.direction ?? ""}>
            <option value="">Both</option>
            <option value="inbound">Inbound</option>
            <option value="outbound">Outbound</option>
          </select>
        </Field>
        <Field label="State">
          <select className="input" name="state" defaultValue={searchParams.state ?? ""}>
            <option value="">Any</option>
            {STATES.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
          </select>
        </Field>
        <Field label="From"><input className="input" type="date" name="from" defaultValue={searchParams.from ?? ""} /></Field>
        <Field label="To"><input className="input" type="date" name="to" defaultValue={searchParams.to ?? ""} /></Field>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-secondary)", height: 36 }}>
          <input type="checkbox" name="unmatched" value="1" defaultChecked={searchParams.unmatched === "1"} /> Unmatched only
        </label>
        <button className="btn btn-primary" type="submit">Filter</button>
        <a className="btn btn-secondary" href="/crm/communications/calls">Reset</a>
      </form>

      <div className="card">
        {error
          ? <p style={{ padding: 16, margin: 0, color: "var(--error)" }}>Couldn&apos;t load calls: {error.message}</p>
          : <CallsTable rows={rows} openId={searchParams.call ?? null} />}
      </div>
      <Pager
        page={page}
        totalPages={Math.max(1, Math.ceil((count ?? 0) / PAGE))}
        prevHref={pageHref("/crm/communications/calls", searchParams, page - 1)}
        nextHref={pageHref("/crm/communications/calls", searchParams, page + 1)}
        summary={`${count ?? 0} calls`}
      />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={{ minWidth: 150 }}><label className="label">{label}</label>{children}</div>;
}

function nextDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
