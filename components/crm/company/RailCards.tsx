"use client";

// Company page → right column: Owner, Details, Contacts, Links, plus the
// header's Edit panel and the Feed orders panel (both slide-overs).

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import SlideOver from "@/components/crm/SlideOver";
import ClickToCall from "@/components/crm/ClickToCall";
import AddContactForm from "@/components/crm/AddContactForm";
import ContactEditForm from "@/components/crm/ContactEditForm";
import CompanyDetailsForm from "@/components/crm/CompanyDetailsForm";
import CompanyHeaderControls from "@/components/crm/CompanyHeaderControls";
import { STALE_DAYS, type Freshness } from "@/lib/crm/inventory-freshness";
import { platformUserHref } from "@/lib/crm/contact-links";
import { Tag, VerifyTag } from "@/components/crm/CrmBadges";
import ContactPhone from "@/components/crm/ContactPhone";
import CompanyFeedsPanel from "@/components/crm/CompanyFeedsPanel";
import EmailFromTemplate from "@/components/crm/EmailFromTemplate";
import { StagePill } from "@/components/crm/CompanyHeader";
import type { Stage } from "@/lib/crm/format";

type Staff = { id: string; name: string };

// ── Owner ────────────────────────────────────────────────────────────────────

export function OwnerCard({ companyId, ownerId, staff, canChange, meId, trial }: {
  companyId: string; ownerId: string | null; staff: Staff[]; canChange: boolean; meId: string;
  trial: { day: number | null; endsOn: string | null; flag: string | null } | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function setOwner(owner: string | null) {
    setBusy(true); setErr(null);
    const res = await fetch(`/api/crm/companies/${companyId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ owner_staff_id: owner }) });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) setErr(j.error ?? "Couldn't change the owner"); else router.refresh();
  }
  return (
    <section className="crm-rail-card">
      <p className="crm-rail-title">Owner</p>
      {canChange ? (
        <div style={{ display: "flex", gap: 6 }}>
          <select className="input" value={ownerId ?? ""} disabled={busy} onChange={(e) => void setOwner(e.target.value || null)}>
            <option value="">Unassigned</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {ownerId !== meId && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void setOwner(meId)} style={{ flexShrink: 0 }}>Me</button>}
        </div>
      ) : (
        <p style={{ margin: 0, fontSize: 14 }}>{staff.find((s) => s.id === ownerId)?.name ?? "Unassigned"}<span style={{ display: "block", fontSize: 12, color: "var(--crm-muted)" }}>A DA-CRM admin assigns owners.</span></p>
      )}
      {trial?.day != null && (
        <p style={{ margin: "10px 0 0", fontSize: 13, color: trial.flag ? "var(--crm-danger)" : "var(--crm-ink-2)" }}>
          Trial day <strong>{trial.day}</strong> of 30{trial.endsOn ? ` · ends ${new Date(`${trial.endsOn}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}{trial.flag === "expired" ? " · expired" : ""}
        </p>
      )}
      {err && <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--crm-danger)" }}>{err}</p>}
    </section>
  );
}

// ── Details ──────────────────────────────────────────────────────────────────

export type DetailsData = {
  address: string | null; website: string | null; phone: string | null; emails: { address: string; label: string | null }[];
  dms: boolean | null; feedProvider: string | null; feedId: string | null;
  inventory: Freshness | null;
  billing?: { label: string; tone: "success" | "danger" | "muted"; summary: string | null; via: string | null; href: string | null; title: string | null } | null;
  group: { href: string; name: string } | null;
  feedOrder: { label: string; open: boolean } | null;
};

export function DetailsCard({ d, canDial, feeds }: { d: DetailsData; canDial: boolean; feeds: { companyId: string; companyName: string; kind: "dealer" | "group"; meId: string } | null }) {
  const [feedsOpen, setFeedsOpen] = useState(false);
  const site = d.website ? (/^https?:\/\//i.test(d.website) ? d.website : `https://${d.website}`) : null;
  return (
    <section className="crm-rail-card">
      <p className="crm-rail-title">Details</p>
      {d.address && <div className="crm-detail-row"><Icon d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z M12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" />{d.address}</div>}
      {site && <div className="crm-detail-row"><Icon d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M2 12h20 M12 2a15 15 0 0 1 0 20 M12 2a15 15 0 0 0 0 20" /><a className="crm-link" href={site} target="_blank" rel="noreferrer">{d.website!.replace(/^https?:\/\//i, "").replace(/\/$/, "")}</a></div>}
      {d.phone && <div className="crm-detail-row"><ClickToCall phone={d.phone} canDial={canDial} /></div>}
      {d.emails.map((e) => (
        <div key={e.address} className="crm-detail-row"><Icon d="M4 4h16v16H4z M22 6l-10 7L2 6" /><span><a className="crm-link" href={`mailto:${e.address}`}>{e.address}</a>{e.label && <span style={{ color: "var(--crm-muted)" }}> · {e.label}</span>}</span></div>
      ))}
      {(d.feedProvider || d.feedId || d.dms != null) && <div style={{ borderTop: "1px solid var(--crm-border)", margin: "8px 0 4px" }} />}
      {d.feedProvider && <div className="crm-detail-row"><span className="k">{d.dms ? "DMS" : "Feed"}</span><span>{d.feedProvider}</span></div>}
      {!d.feedProvider && d.dms != null && <div className="crm-detail-row"><span className="k">Feed</span><span style={{ color: "var(--crm-muted)" }}>Not set</span></div>}
      {d.feedId && <div className="crm-detail-row"><span className="k">Feed ID</span><span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13 }}>{d.feedId}</span></div>}
      {d.inventory && (
        <div className="crm-detail-row"><span className="k">Newest vehicle</span>
          <span className={d.inventory.stale ? "crm-overdue" : undefined}
            title={d.inventory.newest ? `Added ${new Date(d.inventory.newest).toLocaleString()}${d.inventory.stale ? ` — nothing new in ${STALE_DAYS}+ days; check the feed` : ""}` : undefined}>
            {d.inventory.label}</span></div>
      )}
      {d.billing && (
        <div className="crm-detail-row" title={d.billing.title ?? undefined}><span className="k">Billing</span>
          <span>
            <span style={{ fontWeight: 600, color: d.billing.tone === "danger" ? "var(--crm-danger)" : d.billing.tone === "success" ? "var(--crm-success)" : "var(--crm-muted)" }}>{d.billing.label}</span>
            {d.billing.summary && <span style={{ color: "var(--crm-ink-2)" }}> · {d.billing.summary}</span>}
            {d.billing.via && <span style={{ color: "var(--crm-muted)" }}> · {d.billing.via}</span>}
            {d.billing.href && <> · <a className="crm-link" href={d.billing.href} target="_blank" rel="noreferrer">DA-Billing</a></>}
          </span>
        </div>
      )}
      {d.group && <div className="crm-detail-row"><span className="k">Group</span><Link className="crm-link" href={d.group.href}>{d.group.name}</Link></div>}
      {feeds && (
        <div className="crm-detail-row"><span className="k">Feed order</span>
          <span>{d.feedOrder ? <>{d.feedOrder.label} · </> : <span style={{ color: "var(--crm-muted)" }}>None · </span>}
            <button type="button" className="crm-textlink" onClick={() => setFeedsOpen(true)}>{d.feedOrder?.open ? "Open" : "Feed orders"}</button></span>
        </div>
      )}
      {!d.address && !site && !d.phone && !d.emails.length && !d.feedProvider && !d.group && !feeds && <p style={{ margin: 0, fontSize: 13, color: "var(--crm-muted)" }}>No details yet — add them with Edit.</p>}
      {feeds && (
        <SlideOver open={feedsOpen} title="Feed orders" onClose={() => setFeedsOpen(false)} width={760}>
          {feedsOpen && <CompanyFeedsPanel companyId={feeds.companyId} companyName={feeds.companyName} companyKind={feeds.kind} meId={feeds.meId} />}
        </SlideOver>
      )}
    </section>
  );
}

// ── Contacts (+ a group's member dealers) ───────────────────────────────────

export type ContactRow = { id: string; company_id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null; title: string | null; role_tag: string | null; user_id: string | null; approver_at?: string | null;
  phone_raw?: string | null; verify_reason?: string | null; verified_at?: string | null };
export type MemberDealer = { id: string; name: string; text_id: string | null; stage: Stage | null; stageLabel: string | null };

// Platform users first (they follow DA Users — migration 188), then the team's own contacts, "verify"
// record contacts last; by name.
function byUserThenName(a: ContactRow, b: ContactRow): number {
  if (!!a.user_id !== !!b.user_id) return a.user_id ? -1 : 1;
  const weak = (c: ContactRow) => !!c.verify_reason && !c.verified_at;
  if (weak(a) !== weak(b)) return weak(a) ? 1 : -1;
  const n = (c: ContactRow) => ([c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || "").toLowerCase();
  return n(a).localeCompare(n(b));
}

export function ContactsCard({ companyId, companyName, contacts, canDial, members }: { companyId: string; companyName?: string | null; contacts: ContactRow[]; canDial: boolean; members?: MemberDealer[] }) {
  const router = useRouter();
  async function remove(c: ContactRow) {
    if (!window.confirm(`Delete ${[c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || "this contact"}?`)) return;
    await fetch(`/api/crm/contacts/${c.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deleted: true }) });
    router.refresh();
  }
  return (
    <section className="crm-rail-card">
      <div className="crm-rail-title"><span>Contacts ({contacts.length})</span></div>
      <div style={{ marginBottom: contacts.length ? 10 : 0 }}><AddContactForm companyId={companyId} /></div>
      {!contacts.length && <p style={{ margin: "8px 0 0", fontSize: 13, color: "var(--crm-muted)" }}>No contacts yet.</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {[...contacts].sort(byUserThenName).map((c) => {
          const name = [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || "Unnamed";
          return (
            <div key={c.id} style={{ border: "1px solid var(--crm-border)", borderRadius: 10, padding: "10px 12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
                <div style={{ minWidth: 0 }}>
                  <Link href={`/crm/contacts/${c.id}`} style={{ fontSize: 14, fontWeight: 600, color: "var(--crm-ink)", textDecoration: "none" }}>{name}</Link>
                  {(c.title || c.user_id || (c.verify_reason && !c.verified_at) || c.approver_at || c.role_tag === "approver") && (
                    <div style={{ fontSize: 12, color: "var(--crm-muted)", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 2 }}>
                      {c.user_id && <Tag tone="accent">Platform user</Tag>}
                      {(c.approver_at || c.role_tag === "approver") && <Tag tone="accent">Approver</Tag>}
                      {c.verify_reason && !c.verified_at && <Link href={`/crm/contacts/${c.id}?verify=1`} style={{ textDecoration: "none" }}><VerifyTag reason={c.verify_reason} /></Link>}
                      {c.title && <span>{c.title}</span>}
                      {c.user_id && <a className="crm-link" href={platformUserHref(c.email)} target="_blank" rel="noreferrer">DA Users</a>}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                  <ContactEditForm contact={c} />
                  {!c.user_id && (
                    <button type="button" className="btn btn-ghost" aria-label="Delete contact" title="Delete contact" style={{ width: 30, height: 30, padding: 0 }} onClick={() => void remove(c)}>
                      <Icon d="M3 6h18 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6 M10 11v6 M14 11v6 M9 6V4h6v2" />
                    </button>
                  )}
                </div>
              </div>
              {c.email && <div className="crm-detail-row" style={{ padding: "4px 0 0", fontSize: 13 }}><Icon d="M4 4h16v16H4z M22 6l-10 7L2 6" /><EmailFromTemplate link companyId={companyId} companyName={companyName} contactId={c.id} to={c.email} name={name} linkStyle={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }} /></div>}
              {(c.phone || c.phone_raw) && <div className="crm-detail-row" style={{ padding: "2px 0 0", fontSize: 13 }}><ContactPhone phone={c.phone} phoneRaw={c.phone_raw} canDial={canDial} /></div>}
            </div>
          );
        })}
      </div>
      {members && (
        <>
          <p className="crm-rail-title" style={{ marginTop: 16 }}>Member dealers ({members.length})</p>
          {!members.length && <p style={{ margin: 0, fontSize: 13, color: "var(--crm-muted)" }}>No member dealers.</p>}
          <div className="crm-list" style={{ margin: "0 -4px" }}>
            {members.map((m) => (
              <Link key={m.id} href={`/crm/companies/${m.id}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "8px 4px", textDecoration: "none", color: "var(--crm-ink)", fontSize: 13.5 }}>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
                {m.stage && <StagePill stage={m.stage} label={m.stageLabel ?? undefined} />}
              </Link>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

// ── Links ────────────────────────────────────────────────────────────────────

export type LinksData = {
  crmGroup: string | null; crmUsers: string | null; billing: string | null; daGroup: string | null; daDealer: string | null;
  login: { dealerUuid: string; dealerTextId: string; name: string } | null;
};

export function LinksCard({ l }: { l: LinksData }) {
  const rows: [string, string | null, string?][] = [
    ["CRM Group", l.crmGroup], ["CRM Users", l.crmUsers], ["DA-Billing", l.billing, "Opens this customer in DA-Billing"],
    ["DA Group", l.daGroup], ["DA Dealer", l.daDealer],
  ];
  const login = (mode: "ghost" | "impersonate") => {
    if (!l.login) return;
    const qs = new URLSearchParams({ mode, dealer: l.login.dealerUuid, text_id: l.login.dealerTextId, name: l.login.name });
    window.open(`/crm/login-as?${qs}`, "_blank", "noopener");
  };
  const any = rows.some(([, h]) => h) || l.login;
  if (!any) return null;
  return (
    <section className="crm-rail-card">
      <p className="crm-rail-title">Links</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {rows.filter(([, h]) => h).map(([label, href, title]) => (
          <a key={label} href={href!} target={href!.startsWith("http") ? "_blank" : undefined} rel="noreferrer" title={title} className="crm-detail-row crm-link" style={{ justifyContent: "space-between" }}>
            <span>{label}</span><Icon d="M7 17L17 7 M8 7h9v9" />
          </a>
        ))}
      </div>
      {l.login && (
        <>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={() => login("ghost")}>Ghost</button>
            <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={() => login("impersonate")}>Impersonate</button>
          </div>
          <p style={{ margin: "8px 0 0", fontSize: 11.5, color: "var(--crm-muted)" }}>Opens in a new tab. The switch applies to this whole browser (every tab) until you exit it from the banner.</p>
        </>
      )}
    </section>
  );
}

// ── Header actions ───────────────────────────────────────────────────────────

export function EditCompanyButton({ companyId, kind, isPartner, stage, brands, allBrands, staff, meId, initial }: {
  companyId: string; kind: string; isPartner: boolean; stage: string | null; brands: string[]; allBrands: string[]; staff: Staff[]; meId: string;
  initial: { name: string; notes: string | null; emails: { address: string; label: string | null }[]; phone: string | null; website: string | null };
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-secondary" onClick={() => setOpen(true)}>
        <Icon d="M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /> Edit
      </button>
      <SlideOver open={open} title="Edit company" onClose={() => setOpen(false)} width={640}>
        {open && (
          <div>
            {kind === "dealer" && (
              <div style={{ padding: 16, borderBottom: "1px solid var(--crm-border)" }}>
                <CompanyHeaderControls companyId={companyId} kind={kind} stage={stage} ownerId={null} staff={staff} canChangeOwner={false}
                  brands={brands} allBrands={allBrands} currentUserId={meId} hideOwner />
                <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--crm-muted)" }}>&ldquo;Paying&rdquo; shows as Current, Past Due or Suspended from DA-Billing. Converting clears the owner.</p>
              </div>
            )}
            <CompanyDetailsForm companyId={companyId} isPartner={isPartner} initial={initial} />
          </div>
        )}
      </SlideOver>
    </>
  );
}

function Icon({ d }: { d: string }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d.split(" M").map((seg, i) => <path key={i} d={i ? `M${seg}` : seg} />)}
    </svg>
  );
}
