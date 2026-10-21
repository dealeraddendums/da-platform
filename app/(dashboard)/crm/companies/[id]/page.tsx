// DA-CRM company record (dealer, group, vendor or feed supplier).
// Header: kind, brands, pipeline stage, owner, trial day, open ticket / task
// counts. Tabs: Timeline · Contacts · Calls · Files · Notes (+ Dealers on a group).
/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import ClickToCall from "@/components/crm/ClickToCall";
import Timeline from "@/components/crm/Timeline";
import AddNoteForm from "@/components/crm/AddNoteForm";
import AddContactForm from "@/components/crm/AddContactForm";
import CallsTable from "@/components/crm/CallsTable";
import CompanyHeaderControls from "@/components/crm/CompanyHeaderControls";
import CompanyFilesPanel from "@/components/crm/CompanyFilesPanel";
import CompanyDetailsForm from "@/components/crm/CompanyDetailsForm";
import EmailFromTemplate from "@/components/crm/EmailFromTemplate";
import { requireCrmPage } from "@/lib/crm/page-guard";
import { CALL_COLUMNS, canDial, crmAdmin, decorateCalls, staffNames, timeline } from "@/lib/crm/queries";
import { KIND_LABEL, STAGE_LABEL, contactName, fmtAgo, fmtDate, ROLE_TAG_LABEL, type Stage } from "@/lib/crm/format";

export const metadata = { title: "Company — DA-CRM" };
const TH: React.CSSProperties = { fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", fontWeight: 600 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function CrmCompanyPage({ params, searchParams }: { params: { id: string }; searchParams: { tab?: string } }) {
  if (!UUID.test(params.id)) notFound();
  const { userId, perms } = await requireCrmPage(`/crm/companies/${params.id}`);
  const admin = crmAdmin();

  const [{ data: dir }, { data: co }] = await Promise.all([
    admin.from("crm_company_directory").select("*").eq("id", params.id).maybeSingle(),
    admin.from("crm_companies").select("id, kind, name, emails, phone, website, notes, dealer_id, group_id").eq("id", params.id).maybeSingle(),
  ]);
  if (!dir || !co) notFound();
  const isDealer = co.kind === "dealer", isGroup = co.kind === "group", isPartner = !isDealer && !isGroup;

  const tabs = [
    { key: "timeline", label: "Timeline" },
    ...(isGroup ? [{ key: "dealers", label: "Dealers" }] : []),
    { key: "contacts", label: `Contacts (${dir.contact_count})` },
    { key: "calls", label: "Calls" },
    { key: "files", label: "Files" },
    { key: "notes", label: "Notes" },
  ];
  const tab = tabs.find((t) => t.key === searchParams.tab)?.key ?? "timeline";

  const [staff, dial, brandsRes, allBrandsRes, source, parentRes] = await Promise.all([
    staffNames(admin),
    canDial(userId, admin),
    isDealer ? admin.from("crm_company_brands").select("brand").eq("company_id", co.id) : Promise.resolve({ data: [] }),
    isDealer ? admin.from("crm_brands").select("brand").order("sort") : Promise.resolve({ data: [] }),
    isDealer ? admin.from("dealers").select("address, city, state, zip, primary_contact, primary_contact_email, account_type").eq("id", co.dealer_id).maybeSingle().then((r: any) => r.data)
      : isGroup ? admin.from("groups").select("address, city, state, zip, primary_contact, primary_contact_email").eq("id", co.group_id).maybeSingle().then((r: any) => r.data)
      : Promise.resolve(null),
    dir.parent_group_id ? admin.from("crm_companies").select("id, grp:groups(name)").eq("group_id", dir.parent_group_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const brands = (brandsRes.data ?? []).map((b: any) => b.brand).sort();
  const staffList = Object.entries(staff).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  const portal = process.env.HUBSPOT_PORTAL_ID || "23896347";

  const subtitle = [KIND_LABEL[co.kind], dir.dealer_text_id, dir.account_type, dir.active ? null : "Inactive"].filter(Boolean).join(" · ");

  return (
    <div>
      <PageHeader title={dir.name ?? "Company"} subtitle={subtitle}
        action={<Link href={`/crm/dealers?tab=${isDealer ? "dealers" : isGroup ? "groups" : "partners"}`} className="btn btn-secondary" style={{ background: "#fff" }}>← Back</Link>} />

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 14, fontSize: 13 }}>
          <Stat label="Open tickets" value={dir.open_tickets} />
          <Stat label="Open tasks" value={dir.open_tasks} />
          {isDealer && dir.pipeline_stage === "trial" && (
            <Stat label="Trial day" value={dir.trial_day ?? "—"} note={dir.trial_flag === "expired" ? "Expired" : dir.trial_flag === "expiring" ? `Ends ${fmtDate(dir.trial_ends_on)}` : dir.trial_ends_on ? `Ends ${fmtDate(dir.trial_ends_on)}` : undefined} warn={!!dir.trial_flag} />
          )}
          {isDealer && dir.pipeline_stage && dir.pipeline_stage !== "trial" && <Stat label="Stage since" value={fmtDate(dir.stage_changed_at)} />}
          <Stat label="Last activity" value={fmtAgo(dir.last_activity_at)} />
          <div>
            <p className="label">Phone</p>
            {dir.phone ? <ClickToCall phone={dir.phone} canDial={dial} /> : <span style={{ color: "var(--text-muted)" }}>—</span>}
          </div>
          {parentRes.data && (
            <div><p className="label">Group</p><Link href={`/crm/companies/${parentRes.data.id}`} style={{ color: "var(--blue)" }}>{parentRes.data.grp?.name ?? "Group"}</Link></div>
          )}
          <div>
            <p className="label">Links</p>
            {isDealer && <Link href={`/dealers/${co.dealer_id}`} style={{ color: "var(--blue)" }}>Platform record</Link>}
            {isGroup && <Link href={`/groups/${co.group_id}`} style={{ color: "var(--blue)" }}>Platform record</Link>}
            {dir.hubspot_company_id && <>{isPartner ? "" : " · "}<a href={`https://app.hubspot.com/contacts/${portal}/record/0-2/${dir.hubspot_company_id}`} target="_blank" rel="noreferrer" style={{ color: "var(--blue)" }}>HubSpot</a></>}
            {isPartner && !dir.hubspot_company_id && "—"}
          </div>
        </div>
        <CompanyHeaderControls
          companyId={co.id} kind={co.kind} stage={dir.pipeline_stage} ownerId={dir.owner_staff_id}
          staff={staffList} canChangeOwner={perms.crmAdmin} brands={brands}
          allBrands={(allBrandsRes.data ?? []).map((b: any) => b.brand)} currentUserId={userId}
        />
        {!perms.crmAdmin && <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--text-muted)" }}>A DA-CRM admin assigns company owners.</p>}
        <div style={{ marginTop: 12 }}>
          <EmailFromTemplate companyId={co.id} to={(co.emails ?? [])[0]?.address ?? null} />
        </div>
      </div>

      <div style={{ display: "flex", gap: 4 }}>
        {tabs.map((t) => (
          <Link key={t.key} href={`/crm/companies/${co.id}?tab=${t.key}`}
            style={{
              padding: "8px 16px", borderRadius: "6px 6px 0 0", fontWeight: 600, fontSize: 13, textDecoration: "none",
              background: t.key === tab ? "#fff" : "rgba(255,255,255,0.12)", color: t.key === tab ? "var(--navy)" : "#fff",
              borderBottom: t.key === tab ? "2px solid var(--orange)" : "2px solid transparent",
            }}>{t.label}</Link>
        ))}
      </div>
      <div className="card" style={{ borderTopLeftRadius: 0 }}>
        {tab === "timeline" && <TimelineTab companyId={co.id} staff={staff} admin={admin} />}
        {tab === "dealers" && isGroup && <GroupDealersTab groupId={co.group_id} admin={admin} staff={staff} />}
        {tab === "contacts" && <ContactsTab companyId={co.id} dial={dial} admin={admin} />}
        {tab === "calls" && <CallsTab companyId={co.id} admin={admin} />}
        {tab === "files" && <FilesTab companyId={co.id} admin={admin} staff={staff} />}
        {tab === "notes" && (
          <>
            <CompanyDetailsForm companyId={co.id} isPartner={isPartner}
              initial={{ name: co.name ?? dir.name ?? "", notes: co.notes, emails: co.emails ?? [], phone: co.phone, website: co.website }} />
            {source && (
              <div style={{ padding: "0 16px 16px", fontSize: 13, color: "var(--text-secondary)" }}>
                <p className="label">From the platform record</p>
                {[source.address, source.city, [source.state, source.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ") || "No address"}
                {source.primary_contact && <> · {source.primary_contact}</>}{source.primary_contact_email && <> · {source.primary_contact_email}</>}
              </div>
            )}
            <NotesTimeline companyId={co.id} staff={staff} admin={admin} />
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, note, warn }: { label: string; value: React.ReactNode; note?: string; warn?: boolean }) {
  return (
    <div>
      <p className="label">{label}</p>
      <p style={{ margin: 0, fontSize: 18, fontWeight: 700, color: warn ? "var(--error)" : "var(--navy)" }}>{value}</p>
      {note && <p style={{ margin: 0, fontSize: 11, color: warn ? "var(--error)" : "var(--text-muted)" }}>{note}</p>}
    </div>
  );
}

async function TimelineTab({ companyId, staff, admin }: { companyId: string; staff: Record<string, string>; admin: any }) {
  const items = await timeline({ company_id: companyId }, 150, admin);
  const ids = Array.from(new Set(items.map((i) => i.contact_id).filter(Boolean))) as string[];
  const { data: cs } = ids.length ? await admin.from("crm_contacts").select("id, first_name, last_name, email").in("id", ids) : { data: [] };
  return (
    <>
      <AddNoteForm companyId={companyId} />
      <Timeline items={items} staff={staff} contactNames={Object.fromEntries((cs ?? []).map((c: any) => [c.id, contactName(c)]))} />
    </>
  );
}

async function NotesTimeline({ companyId, staff, admin }: { companyId: string; staff: Record<string, string>; admin: any }) {
  const items = await timeline({ company_id: companyId, types: ["note"] }, 100, admin);
  return (
    <div style={{ borderTop: "1px solid var(--border)" }}>
      <p style={{ margin: 0, padding: "12px 16px 0", fontWeight: 600 }}>Notes on the timeline</p>
      <AddNoteForm companyId={companyId} />
      <Timeline items={items} staff={staff} />
    </div>
  );
}

async function ContactsTab({ companyId, dial, admin }: { companyId: string; dial: boolean; admin: any }) {
  const { data } = await admin.from("crm_contacts").select("id, first_name, last_name, email, phone, title, role_tag, user_id")
    .eq("company_id", companyId).is("deleted_at", null).order("first_name");
  const contacts: any[] = data ?? [];
  return (
    <>
      <div style={{ padding: "12px 16px", display: "flex", justifyContent: "flex-end" }}><AddContactForm companyId={companyId} /></div>
      {!contacts.length ? <p className="text-sm" style={{ color: "var(--text-muted)", padding: "0 16px 16px", margin: 0 }}>No contacts yet.</p> : (
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)", textAlign: "left" }}>
              <th className="px-3 py-2" style={TH}>Name</th><th className="px-3 py-2" style={TH}>Title / role</th>
              <th className="px-3 py-2" style={TH}>Email</th><th className="px-3 py-2" style={TH}>Phone</th>
            </tr>
          </thead>
          <tbody>
            {contacts.map((c) => (
              <tr key={c.id} style={{ borderBottom: "1px solid var(--border)" }}>
                <td className="px-3 py-2">
                  <Link href={`/crm/contacts/${c.id}`} style={{ color: "var(--blue)" }}>{contactName(c)}</Link>
                  {c.user_id && <span style={{ color: "var(--text-muted)", fontSize: 11 }}> · platform user</span>}
                </td>
                <td className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>{[c.title, c.role_tag ? ROLE_TAG_LABEL[c.role_tag] : null].filter(Boolean).join(" · ") || "—"}</td>
                <td className="px-3 py-2" style={{ fontSize: 12 }}>{c.email ? <a href={`mailto:${c.email}`} style={{ color: "var(--blue)" }}>{c.email}</a> : "—"}</td>
                <td className="px-3 py-2"><ClickToCall phone={c.phone} canDial={dial} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

async function CallsTab({ companyId, admin }: { companyId: string; admin: any }) {
  const { data } = await admin.from("crm_calls").select(CALL_COLUMNS).eq("company_id", companyId).order("started_at", { ascending: false, nullsFirst: false }).limit(50);
  return <CallsTable rows={await decorateCalls(data ?? [], admin)} showCompany={false} />;
}

async function FilesTab({ companyId, admin, staff }: { companyId: string; admin: any; staff: Record<string, string> }) {
  const { data } = await admin.from("crm_company_files").select("id, filename, label, size, created_at, uploaded_by")
    .eq("company_id", companyId).is("deleted_at", null).order("created_at", { ascending: false });
  return <CompanyFilesPanel companyId={companyId} files={(data ?? []).map((f: any) => ({ ...f, uploaded_by_name: f.uploaded_by ? staff[f.uploaded_by] ?? null : null }))} />;
}

async function GroupDealersTab({ groupId, admin, staff }: { groupId: string; admin: any; staff: Record<string, string> }) {
  const { data } = await admin.from("crm_company_directory")
    .select("id, name, dealer_text_id, active, city, state, pipeline_stage, owner_staff_id, last_activity_at")
    .eq("kind", "dealer").eq("parent_group_id", groupId).order("name");
  const rows: any[] = data ?? [];
  if (!rows.length) return <p className="text-sm" style={{ color: "var(--text-muted)", padding: 16, margin: 0 }}>No member dealers.</p>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr style={{ borderBottom: "1px solid var(--border)", textAlign: "left" }}>
          <th className="px-3 py-2" style={TH}>Dealer</th><th className="px-3 py-2" style={TH}>Location</th>
          <th className="px-3 py-2" style={TH}>Stage</th><th className="px-3 py-2" style={TH}>Owner</th><th className="px-3 py-2" style={TH}>Last activity</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((d) => (
          <tr key={d.id} style={{ borderBottom: "1px solid var(--border)" }}>
            <td className="px-3 py-2"><Link href={`/crm/companies/${d.id}`} style={{ color: "var(--blue)" }}>{d.name}</Link>
              <span style={{ color: "var(--text-muted)", fontSize: 11 }}> · {d.dealer_text_id}{d.active ? "" : " · inactive"}</span></td>
            <td className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>{[d.city, d.state].filter(Boolean).join(", ") || "—"}</td>
            <td className="px-3 py-2">{d.pipeline_stage ? STAGE_LABEL[d.pipeline_stage as Stage] : "—"}</td>
            <td className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>{d.owner_staff_id ? staff[d.owner_staff_id] ?? "—" : "—"}</td>
            <td className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>{fmtAgo(d.last_activity_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
