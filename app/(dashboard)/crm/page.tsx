// DA-CRM dashboard: calls today, trials expiring this week, unmatched calls,
// the Inbox per mailbox (unassigned threads, open threads waiting on us for
// 24h+), open tickets / my tasks.
/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { requireCrmPage } from "@/lib/crm/page-guard";
import { crmAdmin, staffNames } from "@/lib/crm/queries";
import { fmtAgo, fmtDate, startOfTodayPT } from "@/lib/crm/format";
import { pacificDate } from "@/lib/crm/trial";
import { queueCounts } from "@/lib/crm/feeds/queue";

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
  const feeds = await queueCounts(admin, userId).catch(() => null);
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const { data: mailboxes } = await admin.from("crm_mailboxes").select("id, address").eq("active", true).order("address");
  const inbox = await Promise.all((mailboxes ?? []).map(async (m: any) => {
    const [{ count: unassigned }, { count: stale }] = await Promise.all([
      admin.from("crm_email_threads").select("id", { count: "exact", head: true }).eq("mailbox_id", m.id).is("company_id", null).eq("internal", false).neq("status", "closed"),
      admin.from("crm_email_threads").select("id", { count: "exact", head: true }).eq("mailbox_id", m.id).eq("status", "open").eq("last_direction", "inbound").lt("last_message_at", dayAgo),
    ]);
    return { ...m, unassigned: unassigned ?? 0, stale: stale ?? 0 };
  }));

  const cards: { label: string; value: number; sub: string; href: string; muted?: boolean }[] = [
    { label: "Calls today", value: callsToday ?? 0, sub: `${missedToday ?? 0} missed / voicemail`, href: "/crm/communications/calls" },
    { label: "Trials expiring this week", value: (expiring ?? []).length, sub: "Ending in the next 7 days", href: "/crm/trials" },
    { label: "Unmatched calls", value: unmatched ?? 0, sub: "Need a company", href: "/crm/communications/calls?unmatched=1" },
    ...inbox.flatMap((m: any) => [
      { label: `Unassigned · ${m.address.split("@")[0]}@`, value: m.unassigned, sub: "Email threads with no company", href: `/crm/communications/inbox?view=unassigned&mailbox=${m.id}` },
      { label: `Open 24h+ · ${m.address.split("@")[0]}@`, value: m.stale, sub: "Last message from them, no reply in 24h", href: `/crm/communications/inbox?view=open&mailbox=${m.id}` },
    ]),
    ...(feeds ? [
      { label: "Stalled feed orders", value: feeds.stalled, sub: "Past their expected time in step", href: "/crm/communications/feeds?view=stalled" },
      { label: "Feed IDs to confirm", value: feeds.awaiting_confirmation, sub: "Supplier sent an ID — confirm it", href: "/crm/communications/feeds?view=awaiting_confirmation" },
    ] : []),
    { label: "Open tickets", value: openTickets ?? 0, sub: "Across all companies", href: "/crm/communications/tickets" },
    { label: "My tasks", value: myTasks ?? 0, sub: "Open and assigned to you", href: "/crm/tasks" },
  ];

  return (
    <div>
      <PageHeader title="DA-CRM" subtitle={fullName ? `Welcome back, ${fullName.split(" ")[0]}.` : "Dealer relationships, communications and follow-ups."} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16, marginBottom: 16 }}>
        {cards.map((c) => (
          <Link key={c.label} href={c.href} className="crm-card crm-stat crm-stat-link">
            <p className="crm-rail-title" style={{ margin: 0 }}>{c.label}</p>
            <p className={`crm-stat-n${c.muted || !c.value ? " muted" : ""}`}>{c.value}</p>
            <p className="crm-stat-sub" style={{ margin: 0 }}>{c.sub}</p>
          </Link>
        ))}
      </div>

      <div className="card">
        <div className="crm-card-head" style={{ borderBottom: 0 }}><h2>Trials expiring this week</h2><Link href="/crm/trials" className="crm-link" style={{ fontSize: 13 }}>All trials</Link></div>
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
                  <td className="px-3 py-2"><Link href={`/crm/companies/${t.id}`} className="crm-link" style={{ fontWeight: 500 }}>{t.name}</Link><span style={{ color: "var(--text-muted)", fontSize: 11 }}> · {t.dealer_text_id}</span></td>
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
