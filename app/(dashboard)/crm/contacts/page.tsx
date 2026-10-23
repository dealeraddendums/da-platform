// DA-CRM contacts list — search name / email / phone. ?company=<id> narrows to
// one company and ?users=1 to its platform users (the company page's CRM Users link).
/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import Pager from "@/components/Pager";
import ClickToCall from "@/components/crm/ClickToCall";
import { requireCrmPage } from "@/lib/crm/page-guard";
import { canDial, companyNames, crmAdmin } from "@/lib/crm/queries";
import { contactName, fmtAgo, ROLE_TAG_LABEL } from "@/lib/crm/format";
import { normalizePhone } from "@/lib/crm/phone";
import { pageHref } from "@/lib/crm/paging";
import { Tag } from "@/components/crm/CrmBadges";
import { platformUserHref } from "@/lib/crm/contact-links";

export const metadata = { title: "Contacts — DA-CRM" };
const PAGE = 50;
const TH: React.CSSProperties = { fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", fontWeight: 600 };

export default async function CrmContactsPage({ searchParams }: { searchParams: { q?: string; page?: string; company?: string; users?: string } }) {
  const { userId } = await requireCrmPage("/crm/contacts");
  const admin = crmAdmin();
  const q = (searchParams.q ?? "").trim().replace(/[%_,()\\]/g, " ").slice(0, 80);
  const page = Math.max(1, Number(searchParams.page) || 1);

  let query = admin.from("crm_contacts")
    .select("id, company_id, user_id, first_name, last_name, email, phone, title, role_tag, updated_at", { count: "exact" })
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .range((page - 1) * PAGE, page * PAGE - 1);
  const company = /^[0-9a-f-]{36}$/i.test(searchParams.company ?? "") ? searchParams.company! : null;
  if (company) query = query.eq("company_id", company);
  if (company && searchParams.users === "1") query = query.not("user_id", "is", null);
  if (q) {
    const ors = [`first_name.ilike.%${q}%`, `last_name.ilike.%${q}%`, `email.ilike.%${q}%`];
    const phone = normalizePhone(q);
    if (phone) ors.push(`phone.eq.${phone}`);
    query = query.or(ors.join(","));
  }
  const [{ data: rows, count }, dial] = await Promise.all([query, canDial(userId, admin)]);
  const contacts: any[] = rows ?? [];

  const ids = contacts.map((c) => c.id);
  const [dName, { data: acts }] = await Promise.all([
    companyNames(contacts.map((c) => c.company_id), admin),
    // Latest activity per contact on this page (bounded: 50 contacts).
    ids.length ? admin.from("crm_activities").select("contact_id, occurred_at").in("contact_id", ids).order("occurred_at", { ascending: false }).limit(500) : Promise.resolve({ data: [] }),
  ]);
  const lastAct: Record<string, string> = {};
  for (const a of acts ?? []) if (!lastAct[a.contact_id]) lastAct[a.contact_id] = a.occurred_at;

  return (
    <div>
      <PageHeader title="Contacts" subtitle="People at dealerships, groups and partners — decision makers, GMs, F&I, admins." />
      <form className="card" style={{ padding: 12, marginBottom: 16, display: "flex", gap: 10 }}>
        <input className="input" name="q" defaultValue={searchParams.q ?? ""} placeholder="Search name, email or phone…" style={{ maxWidth: 360 }} />
        {company && <input type="hidden" name="company" value={company} />}
        {company && searchParams.users === "1" && <input type="hidden" name="users" value="1" />}
        <button className="btn btn-primary" type="submit">Search</button>
      </form>
      <div className="card">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)", textAlign: "left" }}>
              <th className="px-3 py-2" style={TH}>Name</th>
              <th className="px-3 py-2" style={TH}>Company</th>
              <th className="px-3 py-2" style={TH}>Title / role</th>
              <th className="px-3 py-2" style={TH}>Email</th>
              <th className="px-3 py-2" style={TH}>Phone</th>
              <th className="px-3 py-2" style={TH}>Last activity</th>
            </tr>
          </thead>
          <tbody>
            {contacts.map((c) => (
              <tr key={c.id} style={{ borderBottom: "1px solid var(--border)" }}>
                <td className="px-3 py-2">
                  <Link href={`/crm/contacts/${c.id}`} className="crm-link" style={{ fontWeight: 500 }}>{contactName(c)}</Link>
                  {c.user_id && <> <Tag tone="accent" style={{ marginLeft: 6 }}>Platform user</Tag> <a href={platformUserHref(c.email)} target="_blank" rel="noreferrer" className="crm-link" style={{ fontSize: 12, marginLeft: 4 }}>DA Users</a></>}
                </td>
                <td className="px-3 py-2"><Link href={`/crm/companies/${c.company_id}`} style={{ color: "var(--blue)" }}>{dName[c.company_id] ?? "—"}</Link></td>
                <td className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>{[c.title, c.role_tag ? ROLE_TAG_LABEL[c.role_tag] : null].filter(Boolean).join(" · ") || "—"}</td>
                <td className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>{c.email ?? "—"}</td>
                <td className="px-3 py-2"><ClickToCall phone={c.phone} canDial={dial} /></td>
                <td className="px-3 py-2" style={{ whiteSpace: "nowrap", color: "var(--text-secondary)" }}>{fmtAgo(lastAct[c.id])}</td>
              </tr>
            ))}
            {!contacts.length && <tr><td colSpan={6} className="px-3 py-4" style={{ color: "var(--text-muted)" }}>No contacts match.</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager
        page={page}
        totalPages={Math.max(1, Math.ceil((count ?? 0) / PAGE))}
        prevHref={pageHref("/crm/contacts", searchParams, page - 1)}
        nextHref={pageHref("/crm/contacts", searchParams, page + 1)}
        summary={`${count ?? 0} contacts`}
      />
    </div>
  );
}
