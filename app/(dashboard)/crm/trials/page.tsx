// DA-CRM Trials — dealers in Trial and Account setup & training, with trial
// day, owner, last activity and days since we last spoke to them.
/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { requireCrmPage } from "@/lib/crm/page-guard";
import { crmAdmin, staffNames } from "@/lib/crm/queries";
import { STAGE_LABEL, daysSince, fmtAgo, fmtDate, type Stage } from "@/lib/crm/format";
import { Tag } from "@/components/crm/CrmBadges";

export const metadata = { title: "Trials — DA-CRM" };
const TH: React.CSSProperties = { fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", fontWeight: 600 };
const SHOWN: Stage[] = ["trial", "setup_training"];

export default async function CrmTrialsPage({ searchParams }: { searchParams: { owner?: string; flag?: string } }) {
  await requireCrmPage("/crm/trials");
  const admin = crmAdmin();
  let q = admin.from("crm_company_directory")
    .select("id, name, dealer_text_id, city, state, pipeline_stage, stage_changed_at, trial_day, trial_ends_on, trial_flag, owner_staff_id, last_activity_at, last_contact_at")
    .eq("kind", "dealer").eq("active", true).in("pipeline_stage", SHOWN)
    .order("trial_day", { ascending: false, nullsFirst: false }).limit(1000);
  if (searchParams.owner === "none") q = q.is("owner_staff_id", null);
  else if (searchParams.owner) q = q.eq("owner_staff_id", searchParams.owner);
  if (searchParams.flag === "expiring" || searchParams.flag === "expired") q = q.eq("trial_flag", searchParams.flag);
  const [{ data, error }, staff] = await Promise.all([q, staffNames(admin)]);
  const rows: any[] = data ?? [];

  return (
    <div>
      <PageHeader title="Trials" subtitle="Trial → Account setup & training → Paying. Trial day is recomputed every morning at 6:00 Pacific." />
      <form className="card" style={{ padding: 12, marginBottom: 16, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <select className="input" name="owner" defaultValue={searchParams.owner ?? ""} style={{ maxWidth: 220 }}>
          <option value="">Any owner</option>
          <option value="none">Unassigned</option>
          {Object.entries(staff).map(([id, n]) => <option key={id} value={id}>{n}</option>)}
        </select>
        <select className="input" name="flag" defaultValue={searchParams.flag ?? ""} style={{ maxWidth: 220 }}>
          <option value="">All trials</option>
          <option value="expiring">Expiring (≤ 7 days left)</option>
          <option value="expired">Expired</option>
        </select>
        <button className="btn btn-primary" type="submit">Filter</button>
      </form>
      {error && <p style={{ color: "#fff" }}>Couldn&apos;t load trials: {error.message}</p>}
      {SHOWN.map((stage) => {
        const list = rows.filter((r) => r.pipeline_stage === stage);
        return (
          <div key={stage} className="card" style={{ marginBottom: 16, overflowX: "auto" }}>
            <p style={{ margin: 0, padding: "12px 16px", fontWeight: 600 }}>{STAGE_LABEL[stage]} <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>({list.length})</span></p>
            {!list.length ? <p className="text-sm" style={{ color: "var(--text-muted)", padding: "0 16px 16px", margin: 0 }}>None.</p> : (
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)", textAlign: "left" }}>
                    <th className="px-3 py-2" style={TH}>Dealer</th>
                    <th className="px-3 py-2" style={TH}>{stage === "trial" ? "Trial day" : "In stage since"}</th>
                    {stage === "trial" && <th className="px-3 py-2" style={TH}>Ends</th>}
                    <th className="px-3 py-2" style={TH}>Owner</th>
                    <th className="px-3 py-2" style={TH}>Last activity</th>
                    <th className="px-3 py-2" style={TH}>Days since last contact</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => {
                    const since = daysSince(r.last_contact_at);
                    return (
                      <tr key={r.id} style={{ borderBottom: "1px solid var(--border)" }}>
                        <td className="px-3 py-2"><Link href={`/crm/companies/${r.id}`} style={{ color: "var(--blue)", fontWeight: 500 }}>{r.name}</Link>
                          <span style={{ color: "var(--text-muted)", fontSize: 11 }}> · {r.dealer_text_id}{r.city ? ` · ${r.city}, ${r.state ?? ""}` : ""}</span></td>
                        <td className="px-3 py-2" style={{ whiteSpace: "nowrap" }}>
                          {stage === "trial" ? (r.trial_day ?? "—") : fmtDate(r.stage_changed_at)}
                          {r.trial_flag && <Tag tone={r.trial_flag === "expired" ? "danger" : "warn"} style={{ marginLeft: 6 }}>{r.trial_flag === "expired" ? "Expired" : "Expiring"}</Tag>}
                        </td>
                        {stage === "trial" && <td className="px-3 py-2" style={{ whiteSpace: "nowrap" }}>{fmtDate(r.trial_ends_on)}</td>}
                        <td className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>{r.owner_staff_id ? staff[r.owner_staff_id] ?? "—" : "Unassigned"}</td>
                        <td className="px-3 py-2" style={{ color: "var(--text-secondary)", whiteSpace: "nowrap" }}>{fmtAgo(r.last_activity_at)}</td>
                        <td className="px-3 py-2" style={{ color: since == null || since > 7 ? "var(--error)" : "var(--text-secondary)" }}>{since == null ? "Never" : since}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
}
