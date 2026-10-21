// DA-CRM dashboard: calls today, trials expiring this week, unmatched calls,
// open tickets / my tasks (0 until phases 4–5 fill the stub tables).
/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { requireCrmPage } from "@/lib/crm/page-guard";
import { crmAdmin, staffNames } from "@/lib/crm/queries";
import { fmtAgo, fmtDate, startOfTodayPT } from "@/lib/crm/format";
import { pacificDate } from "@/lib/crm/trial";

export const metadata = { title: "DA-CRM — DA Platform" };
const TH: React.CSSProperties = { fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", fontWeight: 600 };

export default async function CrmDashboardPage() {
  const { userId, fullName } = await requireCrmPage("/crm");
  const admin = crmAdmin();
  const since = startOfTodayPT();
  const weekOut = new Date(Date.now() + 7 * 86_400_000);
  const today = pacificDate(new Date());

  const [{ count: callsToday }, { count: missedToday }, { count: unmatched }, { count: openTickets }, { count: myTasks }, { data: expiring }, staff] = await Promise.all([
    admin.from("crm_calls").select("id", { count: "exact", head: true }).gte("started_at", since),
    admin.from("crm_calls").select("id", { count: "exact", head: true }).gte("started_at", since).in("state", ["missed", "voicemail"]),
    admin.from("crm_calls").select("id", { count: "exact", head: true }).is("company_id", null),
    admin.from("crm_tickets").select("id", { count: "exact", head: true }).in("status", ["open", "pending"]),
    admin.from("crm_tasks").select("id", { count: "exact", head: true }).eq("status", "open").eq("assigned_staff_id", userId),
    admin.from("crm_company_directory")
      .select("id, name, dealer_text_id, trial_day, trial_ends_on, owner_staff_id, last_contact_at")
      .eq("kind", "dealer").eq("pipeline_stage", "trial").eq("active", true)
      .gte("trial_ends_on", today).lte("trial_ends_on", pacificDate(weekOut))
      .order("trial_ends_on").limit(50),
    staffNames(admin),
  ]);

  const cards: { label: string; value: number; sub: string; href: string; muted?: boolean }[] = [
    { label: "Calls today", value: callsToday ?? 0, sub: `${missedToday ?? 0} missed / voicemail`, href: "/crm/communications/calls" },
    { label: "Trials expiring this week", value: (expiring ?? []).length, sub: "Ending in the next 7 days", href: "/crm/trials" },
    { label: "Unmatched calls", value: unmatched ?? 0, sub: "Need a company", href: "/crm/communications/calls?unmatched=1" },
    { label: "Open tickets", value: openTickets ?? 0, sub: "Tickets arrive in phase 4", href: "/crm/communications/tickets", muted: true },
    { label: "My tasks", value: myTasks ?? 0, sub: "Tasks arrive in phase 5", href: "/crm/tasks", muted: true },
  ];

  return (
    <div>
      <PageHeader title="DA-CRM" subtitle={fullName ? `Welcome back, ${fullName.split(" ")[0]}.` : "Dealer relationships, communications and follow-ups."} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16, marginBottom: 16 }}>
        {cards.map((c) => (
          <Link key={c.label} href={c.href} className="card" style={{ padding: 16, textDecoration: "none", color: "inherit", display: "block" }}>
            <p className="label" style={{ marginBottom: 4 }}>{c.label}</p>
            <p style={{ margin: 0, fontSize: 28, fontWeight: 700, color: c.muted ? "var(--text-muted)" : "var(--navy)" }}>{c.value}</p>
            <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>{c.sub}</p>
          </Link>
        ))}
      </div>

      <div className="card">
        <p style={{ margin: 0, padding: "12px 16px", fontWeight: 600 }}>Trials expiring this week</p>
        {!(expiring ?? []).length ? (
          <p className="text-sm" style={{ color: "var(--text-muted)", padding: "0 16px 16px", margin: 0 }}>No trials end in the next 7 days.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)", textAlign: "left" }}>
                <th className="px-3 py-2" style={TH}>Dealer</th><th className="px-3 py-2" style={TH}>Trial day</th>
                <th className="px-3 py-2" style={TH}>Ends</th><th className="px-3 py-2" style={TH}>Owner</th><th className="px-3 py-2" style={TH}>Last contact</th>
              </tr>
            </thead>
            <tbody>
              {(expiring ?? []).map((t: any) => (
                <tr key={t.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td className="px-3 py-2"><Link href={`/crm/companies/${t.id}`} style={{ color: "var(--blue)" }}>{t.name}</Link><span style={{ color: "var(--text-muted)", fontSize: 11 }}> · {t.dealer_text_id}</span></td>
                  <td className="px-3 py-2">{t.trial_day ?? "—"}</td>
                  <td className="px-3 py-2">{fmtDate(t.trial_ends_on)}</td>
                  <td className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>{t.owner_staff_id ? staff[t.owner_staff_id] ?? "—" : "Unassigned"}</td>
                  <td className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>{fmtAgo(t.last_contact_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
