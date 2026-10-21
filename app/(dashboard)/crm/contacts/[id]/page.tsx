// DA-CRM contact record: details, click-to-call, timeline + note, calls.
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import ClickToCall from "@/components/crm/ClickToCall";
import Timeline from "@/components/crm/Timeline";
import AddNoteForm from "@/components/crm/AddNoteForm";
import CallsTable from "@/components/crm/CallsTable";
import ContactEditForm from "@/components/crm/ContactEditForm";
import EmailFromTemplate from "@/components/crm/EmailFromTemplate";
import { requireCrmPage } from "@/lib/crm/page-guard";
import { CALL_COLUMNS, canDial, crmAdmin, decorateCalls, staffNames, timeline } from "@/lib/crm/queries";
import { contactName, fmtDate, ROLE_TAG_LABEL } from "@/lib/crm/format";

export const metadata = { title: "Contact — DA-CRM" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function CrmContactPage({ params }: { params: { id: string } }) {
  if (!UUID.test(params.id)) notFound();
  const { userId } = await requireCrmPage(`/crm/contacts/${params.id}`);
  const admin = crmAdmin();

  const { data: c } = await admin.from("crm_contacts").select("*").eq("id", params.id).is("deleted_at", null).maybeSingle();
  if (!c) notFound();

  const [{ data: company }, items, staff, dial, callsRes] = await Promise.all([
    admin.from("crm_company_directory").select("id, name, kind").eq("id", c.company_id).maybeSingle(),
    timeline({ contact_id: c.id }, 100, admin),
    staffNames(admin),
    canDial(userId, admin),
    admin.from("crm_calls").select(CALL_COLUMNS).eq("contact_id", c.id).order("started_at", { ascending: false, nullsFirst: false }).limit(25),
  ]);
  const calls = await decorateCalls(callsRes.data ?? [], admin);

  return (
    <div>
      <PageHeader
        title={contactName(c)}
        subtitle={[c.title, c.role_tag ? ROLE_TAG_LABEL[c.role_tag] : null, company?.name].filter(Boolean).join(" · ")}
        action={company ? <Link href={`/crm/companies/${company.id}`} className="btn btn-secondary" style={{ background: "#fff" }}>← {company.name}</Link> : undefined}
      />
      <div className="card" style={{ padding: 16, marginBottom: 16, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12, fontSize: 13 }}>
        <div><p className="label">Phone</p><ClickToCall phone={c.phone} canDial={dial} /></div>
        <div><p className="label">Email</p>{c.email ? <a href={`mailto:${c.email}`} style={{ color: "var(--blue)" }}>{c.email}</a> : "—"}</div>
        <div><p className="label">Platform user</p>{c.user_id ? "Yes" : "No"}</div>
        <div><p className="label">Source</p>{c.source} · added {fmtDate(c.created_at)}</div>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
        <ContactEditForm contact={c} />
        <EmailFromTemplate companyId={c.company_id} contactId={c.id} to={c.email} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        <div className="card">
          <p style={{ margin: 0, padding: "12px 16px", fontWeight: 600 }}>Timeline</p>
          <AddNoteForm contactId={c.id} />
          <Timeline items={items} staff={staff} showContact={false} />
        </div>
        <div className="card">
          <p style={{ margin: 0, padding: "12px 16px", fontWeight: 600 }}>Calls</p>
          <CallsTable rows={calls} showCompany={false} />
        </div>
      </div>
    </div>
  );
}
