// DA-CRM contact record: details, click-to-call, timeline + note, calls.
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import ActivityCard from "@/components/crm/company/ActivityCard";
import CallsTable from "@/components/crm/CallsTable";
import ContactEditForm from "@/components/crm/ContactEditForm";
import EmailFromTemplate from "@/components/crm/EmailFromTemplate";
import EmailThreadsPanel from "@/components/crm/EmailThreadsPanel";
import { requireCrmPage } from "@/lib/crm/page-guard";
import { CALL_COLUMNS, canDial, companyNames, crmAdmin, decorateCalls } from "@/lib/crm/queries";
import { contactName, fmtDate, ROLE_TAG_LABEL } from "@/lib/crm/format";
import { Tag, VerifyTag } from "@/components/crm/CrmBadges";
import ContactPhone from "@/components/crm/ContactPhone";
import { platformUserHref } from "@/lib/crm/contact-links";
import VerifyPanel from "@/components/crm/VerifyPanel";

export const metadata = { title: "Contact — DA-CRM" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function CrmContactPage({ params, searchParams }: { params: { id: string }; searchParams: { verify?: string } }) {
  if (!UUID.test(params.id)) notFound();
  const { userId } = await requireCrmPage(`/crm/contacts/${params.id}`);
  const admin = crmAdmin();

  const { data: c } = await admin.from("crm_contacts").select("*").eq("id", params.id).is("deleted_at", null).maybeSingle();
  if (!c) notFound();

  const [{ data: company }, dial, callsRes] = await Promise.all([
    admin.from("crm_company_directory").select("id, name, kind").eq("id", c.company_id).maybeSingle(),
    canDial(userId, admin),
    admin.from("crm_calls").select(CALL_COLUMNS).eq("contact_id", c.id).order("started_at", { ascending: false, nullsFirst: false }).limit(25),
  ]);
  const calls = await decorateCalls(callsRes.data ?? [], admin);

  // "Verify" explanation: the email's domain vs the company's own (crm_company_domains, migration 190).
  let verifyText: string | null = null;
  let otherCopies: string[] = [];
  if (c.verify_reason && !c.verified_at) {
    const { data: doms } = await admin.from("crm_company_domains").select("domain, source").eq("company_id", c.company_id);
    const rank: Record<string, number> = { website: 0, vdp: 1, users: 2, group: 3, members: 4 };
    const own = (doms ?? []).sort((a: any, b: any) => (rank[a.source] ?? 9) - (rank[b.source] ?? 9) || a.domain.localeCompare(b.domain)).map((d: any) => d.domain);
    const shown = own.slice(0, 3).join(", ") + (own.length > 3 ? ` and ${own.length - 3} more` : "");
    const edom = String(c.email ?? "").split("@")[1] ?? "";
    const { data: copies } = await admin.from("crm_contacts").select("company_id").eq("email", c.email ?? "").is("deleted_at", null)
      .is("user_id", null).neq("id", c.id).not("verify_reason", "is", null).is("verified_at", null);
    const names = await companyNames((copies ?? []).map((x: any) => x.company_id), admin);
    otherCopies = (copies ?? []).map((x: any) => names[x.company_id] ?? "another company");
    verifyText = c.verify_reason === "freemail"
      ? `Email ${c.email} is a personal address, not ${shown || "the dealership's domain"}.`
      : `Email domain ${edom} doesn't match ${shown || "the dealership's domain"}.`;
  }

  return (
    <div>
      <PageHeader
        title={contactName(c)}
        subtitle={[c.title, c.role_tag ? ROLE_TAG_LABEL[c.role_tag] : null, company?.name].filter(Boolean).join(" · ")}
        action={company ? <Link href={`/crm/companies/${company.id}`} className="btn btn-secondary" style={{ background: "#fff" }}>← {company.name}</Link> : undefined}
      />
      {verifyText && <VerifyPanel contactId={c.id} companyName={company?.name ?? "this company"} explanation={verifyText} highlight={searchParams.verify === "1"} otherCopies={otherCopies} />}
      <div className="card" style={{ padding: 16, marginBottom: 16, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12, fontSize: 13 }}>
        <div><p className="label">Phone</p><ContactPhone phone={c.phone} phoneRaw={c.phone_raw} canDial={dial} /></div>
        <div><p className="label">Email</p>{c.email ? <a href={`mailto:${c.email}`} style={{ color: "var(--blue)" }}>{c.email}</a> : "—"}</div>
        <div><p className="label">Platform user</p>{c.user_id
          ? <><Tag tone="accent">Platform user</Tag> <a href={platformUserHref(c.email)} target="_blank" rel="noreferrer" className="crm-link" style={{ marginLeft: 6 }}>Open in DA Users</a></>
          : "No"}</div>
        <div><p className="label">Source</p>{c.source} · added {fmtDate(c.created_at)}
          {c.verify_reason && !c.verified_at && <div style={{ marginTop: 4 }}><VerifyTag reason={c.verify_reason} /></div>}
          {c.verified_at && <div style={{ marginTop: 4, fontSize: 12, color: "var(--text-muted)" }}>Verified {fmtDate(c.verified_at)}</div>}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
        <ContactEditForm contact={c} hideVerify={!!verifyText} />
        <EmailFromTemplate companyId={c.company_id} contactId={c.id} to={c.email} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        <ActivityCard contactId={c.id} title="Timeline" />
        <div className="card">
          <p style={{ margin: 0, padding: "12px 16px", fontWeight: 600 }}>Calls</p>
          <CallsTable rows={calls} showCompany={false} />
        </div>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <p style={{ margin: 0, padding: "12px 16px 0", fontWeight: 600 }}>Email</p>
        <EmailThreadsPanel contactId={c.id} meId={userId} to={c.email ? [{ email: c.email, name: contactName(c) }] : []} />
      </div>
    </div>
  );
}
