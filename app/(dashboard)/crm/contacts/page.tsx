// DA-CRM contacts list. Search matches name, email, company and phone; every column sorts (server-side,
// crm_contacts_page — migration 193); "Group by person" (default on) collapses contacts that share an email
// into one row with their companies. Sort / group choices persist per user (ContactsViewPrefs).
// ?company=<id> narrows to one company and ?users=1 to its platform users (the company page's CRM Users link).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Suspense } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import Pager from "@/components/Pager";
import { requireCrmPage } from "@/lib/crm/page-guard";
import { canDial, crmAdmin } from "@/lib/crm/queries";
import { fmtAgo, ROLE_TAG_LABEL } from "@/lib/crm/format";
import { pageHref } from "@/lib/crm/paging";
import { Tag } from "@/components/crm/CrmBadges";
import ContactPhone from "@/components/crm/ContactPhone";
import ContactsViewPrefs from "@/components/crm/ContactsViewPrefs";
import { platformUserHref } from "@/lib/crm/contact-links";

export const metadata = { title: "Contacts — DA-CRM" };
const PAGE = 50;
const SORTS = ["name", "company", "title", "email", "phone", "last_activity"] as const;
type Sort = (typeof SORTS)[number];
const COLS: [Sort, string][] = [["name", "Name"], ["company", "Company"], ["title", "Title / role"], ["email", "Email"], ["phone", "Phone"], ["last_activity", "Last activity"]];
type SP = { q?: string; page?: string; company?: string; users?: string; s?: string; d?: string; g?: string };

export default async function CrmContactsPage({ searchParams }: { searchParams: SP }) {
  const { userId } = await requireCrmPage("/crm/contacts");
  const admin = crmAdmin();
  const q = (searchParams.q ?? "").trim().slice(0, 80);
  const page = Math.max(1, Number(searchParams.page) || 1);
  const sort: Sort = (SORTS as readonly string[]).includes(searchParams.s ?? "") ? (searchParams.s as Sort) : "last_activity";
  const desc = searchParams.d ? searchParams.d === "desc" : sort === "last_activity";
  const group = searchParams.g !== "0";
  const company = /^[0-9a-f-]{36}$/i.test(searchParams.company ?? "") ? searchParams.company! : null;

  const [{ data, error }, dial] = await Promise.all([
    admin.rpc("crm_contacts_page", {
      p_q: q || null, p_sort: sort, p_desc: desc, p_group: group, p_company: company,
      p_users: !!company && searchParams.users === "1", p_limit: PAGE, p_offset: (page - 1) * PAGE,
    }),
    canDial(userId, admin),
  ]);
  const rows: any[] = data ?? [];
  const total = Number(rows[0]?.total ?? 0);

  const href = (patch: Partial<SP>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...searchParams, ...patch })) if (v != null && v !== "" && k !== "page") p.set(k, String(v));
    return `/crm/contacts${p.toString() ? `?${p}` : ""}`;
  };
  const sortHref = (k: Sort) => href({ s: k, d: sort === k ? (desc ? "asc" : "desc") : k === "last_activity" ? "desc" : "asc" });

  return (
    <div>
      <Suspense fallback={null}><ContactsViewPrefs userId={userId} /></Suspense>
      <PageHeader title="Contacts" subtitle="People at dealerships, groups and partners — decision makers, GMs, F&I, admins." />
      <form className="card" style={{ padding: 12, marginBottom: 16, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <input className="input" name="q" defaultValue={searchParams.q ?? ""} placeholder="Search name, email, company or phone…" style={{ maxWidth: 360 }} />
        {company && <input type="hidden" name="company" value={company} />}
        {company && searchParams.users === "1" && <input type="hidden" name="users" value="1" />}
        {searchParams.s && <input type="hidden" name="s" value={sort} />}
        {searchParams.d && <input type="hidden" name="d" value={desc ? "desc" : "asc"} />}
        {searchParams.g && <input type="hidden" name="g" value={group ? "1" : "0"} />}
        <button className="btn btn-primary" type="submit">Search</button>
        <Link href={href({ g: group ? "0" : "1" })} className="crm-chip" aria-pressed={group} role="switch" aria-checked={group}
          style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", textDecoration: "none" }}
          title="Contacts that share an email show as one person with all their companies">
          Group by person
        </Link>
      </form>
      <div className="card">
        {error && <p style={{ padding: 16, margin: 0, color: "var(--error)" }}>Couldn&apos;t load: {error.message}</p>}
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)", textAlign: "left" }}>
              {COLS.map(([k, label]) => (
                <th key={k} className="px-3 py-2" aria-sort={sort === k ? (desc ? "descending" : "ascending") : "none"}>
                  <Link href={sortHref(k)} className="crm-sort" data-active={sort === k}>
                    {label}<span aria-hidden="true">{sort === k ? (desc ? " ↓" : " ↑") : " ↕"}</span>
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const cos: any[] = r.companies ?? [];
              const flagged = cos.find((c) => c.needs_verify);
              return (
                <tr key={r.row_key} style={{ borderBottom: "1px solid var(--border)", verticalAlign: "top" }}>
                  <td className="px-3 py-2">
                    <Link href={`/crm/contacts/${r.contact_id}`} className="crm-link" style={{ fontWeight: 500 }}>{r.name ?? r.email ?? "Unnamed"}</Link>
                    {flagged && (
                      <Link href={`/crm/contacts/${flagged.contact_id}?verify=1`} style={{ marginLeft: 6, textDecoration: "none" }} title="Check this contact — opens the explanation">
                        <Tag tone="warn">Verify</Tag>
                      </Link>
                    )}
                    {r.is_user && <> <Tag tone="accent" style={{ marginLeft: 6 }}>Platform user</Tag> <a href={platformUserHref(r.email)} target="_blank" rel="noreferrer" className="crm-link" style={{ fontSize: 12, marginLeft: 4 }}>DA Users</a></>}
                  </td>
                  <td className="px-3 py-2">
                    {cos.length <= 1
                      ? <Link href={`/crm/companies/${cos[0]?.id}`} className="crm-link">{cos[0]?.name ?? "—"}</Link>
                      : (
                        <details className="crm-cos">
                          <summary title={cos.map((c) => c.name).join("\n")}>{r.company_count} companies</summary>
                          <ul>{cos.map((c) => <li key={c.contact_id}><Link href={`/crm/companies/${c.id}`} className="crm-link">{c.name}</Link>{c.needs_verify && <span style={{ marginLeft: 6 }}><Tag tone="warn">Verify</Tag></span>}</li>)}</ul>
                        </details>
                      )}
                  </td>
                  <td className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>{[r.title, r.role_tag ? ROLE_TAG_LABEL[r.role_tag] : null].filter(Boolean).join(" · ") || "—"}</td>
                  <td className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>{r.email ?? "—"}</td>
                  <td className="px-3 py-2"><ContactPhone phone={r.phone} phoneRaw={r.phone_raw} canDial={dial} /></td>
                  <td className="px-3 py-2" style={{ whiteSpace: "nowrap", color: "var(--text-secondary)" }}>{fmtAgo(r.last_activity_at)}</td>
                </tr>
              );
            })}
            {!rows.length && !error && <tr><td colSpan={6} className="px-3 py-4" style={{ color: "var(--text-muted)" }}>No contacts match.</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager
        page={page}
        totalPages={Math.max(1, Math.ceil(total / PAGE))}
        prevHref={pageHref("/crm/contacts", searchParams, page - 1)}
        nextHref={pageHref("/crm/contacts", searchParams, page + 1)}
        summary={`${total} ${group ? "people" : "contacts"}`}
      />
    </div>
  );
}
