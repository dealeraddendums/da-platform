// DA-CRM company record (dealer, group, vendor or feed supplier).
// Three columns: the CRM sidebar | main | right column (sticky).
//   Header   name, stage pill (paying dealers: Current / Past Due / Suspended
//            from DA-Billing), brands; kind pill for partners only; Edit.
//   Main     Communications (Email | Chat | Calls) · Tasks & Tickets · Activity · Documents
//   Right    Owner (Trial / Setup & training only) · Details · Summary (AI) ·
//            Contacts (+ member dealers on a group) · Links
// A feed supplier's settings open with ?panel=settings.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { notFound } from "next/navigation";
import CompanyHeader, { stageDisplay } from "@/components/crm/CompanyHeader";
import CompanyFilesPanel from "@/components/crm/CompanyFilesPanel";
import FeedSupplierSettings from "@/components/crm/FeedSupplierSettings";
import CommunicationsCard from "@/components/crm/company/CommunicationsCard";
import WorkCard, { type WorkTask, type WorkTicket } from "@/components/crm/company/WorkCard";
import ActivityCard from "@/components/crm/company/ActivityCard";
import SummaryCard from "@/components/crm/company/SummaryCard";
import { ContactsCard, DetailsCard, EditCompanyButton, LinksCard, OwnerCard, type MemberDealer } from "@/components/crm/company/RailCards";
import { requireCrmPage } from "@/lib/crm/page-guard";
import { CALL_COLUMNS, canDial, crmAdmin, decorateCalls, staffNames, timeline } from "@/lib/crm/queries";
import { contactName, type Stage } from "@/lib/crm/format";
import { billingPayer, dealerBillingState, type BillingRead } from "@/lib/crm/billing-status";
import { feedName, inventoryFreshness, isFed } from "@/lib/crm/inventory-freshness";
import { OPEN_STATUSES, STATUS_LABEL as FEED_STATUS_LABEL, type OrderStatus } from "@/lib/crm/feeds/state";
import { OWNED_STAGES } from "@/lib/crm/companies";

export const metadata = { title: "Company — DA-CRM" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BILLING_APP = "https://billing.dealeraddendums.com/";

export default async function CrmCompanyPage({ params, searchParams }: { params: { id: string }; searchParams: { panel?: string } }) {
  if (!UUID.test(params.id)) notFound();
  const { userId, perms } = await requireCrmPage(`/crm/companies/${params.id}`);
  const admin = crmAdmin();

  const [{ data: dir }, { data: co }] = await Promise.all([
    admin.from("crm_company_directory").select("*").eq("id", params.id).maybeSingle(),
    admin.from("crm_companies").select("id, kind, name, emails, phone, website, notes, dealer_id, group_id").eq("id", params.id).maybeSingle(),
  ]);
  if (!dir || !co) notFound();
  const isDealer = co.kind === "dealer", isGroup = co.kind === "group", isPartner = !isDealer && !isGroup;
  const stage: Stage | null = isDealer ? (dir.pipeline_stage as Stage | null) : null;

  const [staff, dial, brandsRes, allBrandsRes, source, parentRes, billing] = await Promise.all([
    staffNames(admin),
    canDial(userId, admin),
    isDealer ? admin.from("crm_company_brands").select("brand").eq("company_id", co.id) : Promise.resolve({ data: [] }),
    isDealer ? admin.from("crm_brands").select("brand").order("sort") : Promise.resolve({ data: [] }),
    isDealer ? admin.from("dealers").select("dealer_id, name, address, city, state, zip, website_url, inventory_provider, inventory_provider_is_dms, inventory_dealer_id, feed_source, group_id").eq("id", co.dealer_id).maybeSingle().then((r: any) => r.data)
      : isGroup ? admin.from("groups").select("name, address, city, state, zip, billing_customer_id").eq("id", co.group_id).maybeSingle().then((r: any) => r.data)
      : Promise.resolve(null),
    dir.parent_group_id ? admin.from("crm_companies").select("id, group_id, grp:groups(name)").eq("group_id", dir.parent_group_id).maybeSingle() : Promise.resolve({ data: null }),
    isDealer && stage === "paying" ? dealerBillingState(admin, co.dealer_id) : Promise.resolve(null as BillingRead | null),
  ]);
  const feed = isDealer ? feedName(source?.inventory_provider, source?.feed_source) : null;
  const [newestVehicle, payer] = await Promise.all([
    isDealer && source?.dealer_id
      ? admin.from("dealer_vehicles").select("date_added").eq("dealer_id", source.dealer_id).not("date_added", "is", null).order("date_added", { ascending: false }).limit(1).maybeSingle().then((r: any) => (r.data?.date_added as string | undefined) ?? null)
      : Promise.resolve(null),
    isDealer && !billing ? billingPayer(admin, co.dealer_id) : Promise.resolve(null),
  ]);
  // DA-Billing deep link: /?customer={UUID} opens that customer (da-billing reads it after login).
  const billingCustomerId = isDealer ? billing?.customerId ?? payer?.customerId ?? null : isGroup ? source?.billing_customer_id ?? null : null;
  const brands = (brandsRes.data ?? []).map((b: any) => b.brand).sort();
  const staffList = Object.entries(staff).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  const firstEmail = (co.emails ?? [])[0]?.address ?? null;

  const [contactsRes, callsRes, threadCount, openThreadCount, tasksRes, ticketsRes, items, filesRes, orderRes, membersRes] = await Promise.all([
    admin.from("crm_contacts").select("id, company_id, first_name, last_name, email, phone, title, role_tag, user_id").eq("company_id", co.id).is("deleted_at", null).order("first_name"),
    admin.from("crm_calls").select(CALL_COLUMNS).eq("company_id", co.id).order("started_at", { ascending: false, nullsFirst: false }).limit(50),
    admin.from("crm_email_threads").select("id", { count: "exact", head: true }).eq("company_id", co.id),
    admin.from("crm_email_threads").select("id", { count: "exact", head: true }).eq("company_id", co.id).neq("status", "closed"),
    admin.from("crm_tasks").select("id, title, description, status, due_at, assigned_staff_id, created_at, source_activity_id, kind").eq("company_id", co.id).order("created_at", { ascending: false }).limit(60),
    admin.from("crm_tickets").select("id, title, description, status, priority, assigned_staff_id, created_at").eq("company_id", co.id).order("created_at", { ascending: false }).limit(60),
    timeline({ company_id: co.id }, 150, admin),
    admin.from("crm_company_files").select("id, filename, label, size, created_at, uploaded_by").eq("company_id", co.id).is("deleted_at", null).order("created_at", { ascending: false }),
    isDealer || isGroup ? admin.from("crm_feed_orders").select("id, status").eq("dealer_company_id", co.id).order("created_at", { ascending: false }).limit(1).maybeSingle() : Promise.resolve({ data: null }),
    isGroup ? admin.from("crm_company_directory").select("id, name, dealer_id, dealer_text_id, pipeline_stage").eq("kind", "dealer").eq("parent_group_id", co.group_id).order("name").limit(200) : Promise.resolve({ data: null }),
  ]);

  // Tasks that came from a chat get "Open chat to reply".
  const sourceIds = Array.from(new Set((tasksRes.data ?? []).map((t: any) => t.source_activity_id).filter(Boolean)));
  const { data: chatSources } = sourceIds.length ? await admin.from("crm_activities").select("id").in("id", sourceIds).eq("type", "chat") : { data: [] };
  const chatIds = new Set((chatSources ?? []).map((a: any) => a.id));
  const tasks: WorkTask[] = (tasksRes.data ?? []).map((t: any) => ({ ...t, from_chat: chatIds.has(t.source_activity_id) }));
  const tickets: WorkTicket[] = ticketsRes.data ?? [];

  const contactIds = Array.from(new Set(items.map((i) => i.contact_id).filter(Boolean))) as string[];
  const { data: cs } = contactIds.length ? await admin.from("crm_contacts").select("id, first_name, last_name, email").in("id", contactIds) : { data: [] };

  // A group's member dealers, with their stage (paying ones read from DA-Billing; a
  // group-billed rooftop shares the group's customer, so this is mostly one cached read).
  let members: MemberDealer[] | undefined;
  if (isGroup) {
    const rows: any[] = membersRes.data ?? [];
    const reads = await Promise.all(rows.map((m) => (m.pipeline_stage === "paying" ? dealerBillingState(admin, m.dealer_id) : Promise.resolve(null))));
    members = rows.map((m, i) => ({
      id: m.id, name: m.name, text_id: m.dealer_text_id, stage: m.pipeline_stage ?? null,
      stageLabel: m.pipeline_stage ? stageDisplay(m.pipeline_stage, reads[i]?.state ?? null).label : null,
    }));
  }

  const address = source ? [source.address, source.city, [source.state, source.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ") || null : null;
  const order = orderRes.data as { id: string; status: OrderStatus } | null;
  const groupCompany = parentRes.data as { id: string; group_id: string; grp?: { name?: string } } | null;
  const showOwner = isDealer && !!stage && (OWNED_STAGES as readonly string[]).includes(stage);
  const billingNote = billing && !billing.state ? `Billing status unavailable — ${billing.error ?? "no DA-Billing read"}` : billing?.billedBy === "group" ? "Billed through the group (DA-Billing)" : billing ? "From DA-Billing" : null;
  const backTab = isDealer ? "dealers" : isGroup ? "groups" : "partners";

  return (
    <div>
      <CompanyHeader
        name={dir.name ?? "Company"} kind={co.kind} stage={stage} billing={billing?.state ?? null} billingNote={billingNote} brands={brands}
        backHref={`/crm/dealers?tab=${backTab}`} backLabel={isDealer ? "Dealers" : isGroup ? "Groups" : "Partners"}
        meta={[dir.dealer_text_id, dir.active === false ? "Inactive" : null].filter(Boolean).join(" · ") || null}
        actions={
          <>
            {co.kind === "feed_supplier" && <a href={`/crm/companies/${co.id}?panel=settings`} className="btn btn-ghost" style={{ textDecoration: "none" }}>Settings</a>}
            <EditCompanyButton companyId={co.id} kind={co.kind} isPartner={isPartner} stage={stage} brands={brands}
              allBrands={(allBrandsRes.data ?? []).map((b: any) => b.brand)} staff={staffList} meId={userId}
              initial={{ name: co.name ?? dir.name ?? "", notes: co.notes, emails: co.emails ?? [], phone: co.phone, website: co.website }} />
          </>
        } />

      <div className="crm-company-grid">
        <div className="crm-company-main">
          {co.kind === "feed_supplier" && searchParams.panel === "settings" && (
            <section className="crm-card"><div className="crm-card-head"><h2>Supplier settings</h2><a href={`/crm/companies/${co.id}`} className="crm-textlink" style={{ fontSize: 13 }}>Close</a></div>
              <FeedSupplierSettings supplierId={co.id} supplierName={dir.name ?? "Supplier"} canEdit={perms.crmAdmin} />
            </section>
          )}
          <CommunicationsCard companyId={co.id} meId={userId} to={firstEmail ? [{ email: firstEmail }] : []}
            calls={await decorateCalls(callsRes.data ?? [], admin)} emailCounts={{ active: openThreadCount.count ?? 0, all: threadCount.count ?? 0 }}
            phone={dir.phone ?? co.phone ?? null} canDial={dial} />
          <WorkCard companyId={co.id} tasks={tasks} tickets={tickets} staff={staffList} meId={userId} />
          <ActivityCard companyId={co.id} items={items} staff={staff}
            contactNames={Object.fromEntries((cs ?? []).map((c: any) => [c.id, contactName(c)]))} />
          <section className="crm-card">
            <div className="crm-card-head"><h2>Documents</h2></div>
            <CompanyFilesPanel companyId={co.id} files={(filesRes.data ?? []).map((f: any) => ({ ...f, uploaded_by_name: f.uploaded_by ? staff[f.uploaded_by] ?? null : null }))} />
          </section>
        </div>

        <aside className="crm-company-rail" aria-label="Company details">
          {showOwner && (
            <OwnerCard companyId={co.id} ownerId={dir.owner_staff_id ?? null} staff={staffList} canChange={perms.crmAdmin} meId={userId}
              trial={stage === "trial" ? { day: dir.trial_day ?? null, endsOn: dir.trial_ends_on ?? null, flag: dir.trial_flag ?? null } : null} />
          )}
          {isDealer && stage === "paying" && (
            <p style={{ margin: 0, padding: "0 4px", fontSize: 13, color: "var(--crm-muted)" }}>Current customer — no owner.</p>
          )}
          <DetailsCard canDial={dial}
            d={{
              address, website: (isDealer ? source?.website_url : null) ?? co.website ?? null, phone: dir.phone ?? co.phone ?? null, emails: co.emails ?? [],
              dms: isDealer ? !!source?.inventory_provider_is_dms : null, feedProvider: feed, feedId: isDealer ? source?.inventory_dealer_id ?? null : null,
              inventory: isDealer ? inventoryFreshness(newestVehicle, isFed(feed, source?.inventory_dealer_id), new Date()) : null,
              group: groupCompany ? { href: `/crm/companies/${groupCompany.id}`, name: groupCompany.grp?.name ?? "Group" } : null,
              feedOrder: order ? { label: FEED_STATUS_LABEL[order.status] ?? order.status, open: (OPEN_STATUSES as readonly string[]).includes(order.status) } : null,
            }}
            feeds={isDealer || isGroup ? { companyId: co.id, companyName: dir.name ?? "Dealer", kind: isGroup ? "group" : "dealer", meId: userId } : null} />
          <SummaryCard companyId={co.id} />
          <ContactsCard companyId={co.id} contacts={contactsRes.data ?? []} canDial={dial} members={members} />
          <LinksCard l={{
            crmGroup: groupCompany ? `/crm/companies/${groupCompany.id}` : null,
            crmUsers: isDealer || isGroup ? `/crm/contacts?company=${co.id}&users=1` : null,
            billing: isDealer || isGroup ? (billingCustomerId ? `${BILLING_APP}?customer=${billingCustomerId}` : BILLING_APP) : null,
            daGroup: isGroup ? `/groups/${co.group_id}` : groupCompany ? `/groups/${groupCompany.group_id}` : null,
            daDealer: isDealer ? `/dealers/${co.dealer_id}` : null,
            login: isDealer && source?.dealer_id ? { dealerUuid: co.dealer_id, dealerTextId: source.dealer_id, name: dir.name ?? source.name ?? source.dealer_id } : null,
          }} />
        </aside>
      </div>
    </div>
  );
}
