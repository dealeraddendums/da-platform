"use client";

// DA-CRM calls table: click a row for playback, AI summary and transcript;
// Unmatched rows (no company) get an Assign panel.

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { CallListRow } from "@/lib/crm/queries";
import { CallStateBadge, DirectionLabel, Tag } from "./CrmBadges";
import { KIND_LABEL, fmtDateTime, formatDuration } from "@/lib/crm/format";
import { formatPhone } from "@/lib/crm/phone";

const TH: React.CSSProperties = { fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", fontWeight: 600 };

export default function CallsTable({ rows, openId = null, showCompany = true }: { rows: CallListRow[]; openId?: string | null; showCompany?: boolean }) {
  const [open, setOpen] = useState<string | null>(openId);
  if (!rows.length) return <p className="text-sm" style={{ color: "var(--text-muted)", padding: 16, margin: 0 }}>No calls match.</p>;
  const cols = showCompany ? 7 : 6;
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="w-full text-sm">
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border)", textAlign: "left" }}>
            <th className="px-3 py-2" style={TH}>When</th>
            <th className="px-3 py-2" style={TH}>Direction</th>
            <th className="px-3 py-2" style={TH}>Number</th>
            {showCompany && <th className="px-3 py-2" style={TH}>Company / contact</th>}
            <th className="px-3 py-2" style={TH}>Staff</th>
            <th className="px-3 py-2" style={TH}>State</th>
            <th className="px-3 py-2" style={TH}>Duration</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const other = r.direction === "inbound" ? r.from_number : r.to_number;
            const isOpen = open === r.id;
            return (
              <Fragment key={r.id}>
                <tr
                  onClick={() => setOpen(isOpen ? null : r.id)}
                  style={{ borderBottom: "1px solid var(--border)", cursor: "pointer", background: isOpen ? "var(--bg-subtle)" : undefined }}
                >
                  <td className="px-3 py-2" style={{ whiteSpace: "nowrap", color: "var(--text-secondary)" }}>{fmtDateTime(r.started_at)}</td>
                  <td className="px-3 py-2"><DirectionLabel direction={r.direction} /></td>
                  <td className="px-3 py-2" style={{ whiteSpace: "nowrap" }}>{formatPhone(other) || "—"}</td>
                  {showCompany && (
                    <td className="px-3 py-2">
                      {r.company_id ? (
                        <>
                          <Link href={`/crm/companies/${r.company_id}`} onClick={(e) => e.stopPropagation()} style={{ color: "var(--blue)" }}>{r.company_name ?? "Company"}</Link>
                          {r.contact_id && <span style={{ color: "var(--text-muted)" }}> · <Link href={`/crm/contacts/${r.contact_id}`} onClick={(e) => e.stopPropagation()} style={{ color: "var(--blue)" }}>{r.contact_name ?? "Contact"}</Link></span>}
                        </>
                      ) : (
                        <Tag tone="warn">Unmatched</Tag>
                      )}
                    </td>
                  )}
                  <td className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>{r.staff_name ?? "—"}</td>
                  <td className="px-3 py-2"><CallStateBadge state={r.state} /></td>
                  <td className="px-3 py-2" style={{ whiteSpace: "nowrap", color: "var(--text-secondary)" }}>{r.duration_sec ? formatDuration(r.duration_sec) : "—"}</td>
                </tr>
                {isOpen && (
                  <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
                    <td colSpan={cols} className="px-3 py-3"><CallDetail row={r} /></td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CallDetail({ row }: { row: CallListRow }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {!row.company_id && <AssignPanel callId={row.id} />}
      {row.has_recording ? (
        <audio controls preload="metadata" src={`/api/crm/calls/${row.id}/recording`} style={{ width: "100%", maxWidth: 520 }} />
      ) : (
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>No recording.</p>
      )}
      {row.summary && (
        <div>
          <p className="label" style={{ marginBottom: 4 }}>AI summary</p>
          <p style={{ margin: 0, fontSize: 13, whiteSpace: "pre-wrap" }}>{row.summary}</p>
        </div>
      )}
      {row.transcript ? (
        <div>
          <p className="label" style={{ marginBottom: 4 }}>Transcript</p>
          <pre style={{ margin: 0, fontSize: 12, fontFamily: "inherit", whiteSpace: "pre-wrap", maxHeight: 280, overflowY: "auto", background: "#fff", border: "1px solid var(--border)", borderRadius: 4, padding: 10 }}>
            {row.transcript}
          </pre>
        </div>
      ) : (
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>No transcript.</p>
      )}
    </div>
  );
}

type CompanyOpt = { id: string; kind: string; name: string; dealer_text_id: string | null; city: string | null; state: string | null; active: boolean };
type ContactOpt = { id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null };

function AssignPanel({ callId }: { callId: string }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [companies, setCompanies] = useState<CompanyOpt[]>([]);
  const [company, setCompany] = useState<CompanyOpt | null>(null);
  const [contacts, setContacts] = useState<ContactOpt[]>([]);
  const [contactChoice, setContactChoice] = useState<string>(""); // "" none | "new" | contact id
  const [newFirst, setNewFirst] = useState("");
  const [newLast, setNewLast] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (company || q.trim().length < 2) { setCompanies([]); return; }
    const t = setTimeout(async () => {
      const r = await fetch(`/api/crm/companies/search?q=${encodeURIComponent(q.trim())}`);
      const j = await r.json().catch(() => ({}));
      setCompanies(j.companies ?? []);
    }, 250);
    return () => clearTimeout(t);
  }, [q, company]);

  useEffect(() => {
    if (!company) { setContacts([]); return; }
    fetch(`/api/crm/companies/search?contacts_for=${company.id}`).then((r) => r.json()).then((j) => setContacts(j.contacts ?? [])).catch(() => setContacts([]));
  }, [company]);

  async function assign() {
    if (!company) return;
    setSaving(true);
    setErr(null);
    const body: Record<string, unknown> = { company_id: company.id };
    if (contactChoice === "new") body.new_contact = { first_name: newFirst, last_name: newLast };
    else if (contactChoice) { body.contact_id = contactChoice; body.save_phone = true; }
    const res = await fetch(`/api/crm/calls/${callId}/assign`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) { setErr(j.error ?? "Couldn't assign"); return; }
    router.refresh();
  }

  return (
    <div className="card" style={{ padding: 12 }} onClick={(e) => e.stopPropagation()}>
      <p className="label" style={{ marginBottom: 6 }}>Assign to company</p>
      {!company ? (
        <>
          <input className="input" placeholder="Search dealer, group or partner…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 360 }} />
          {companies.length > 0 && (
            <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0, maxWidth: 360, border: "1px solid var(--border)", borderRadius: 4 }}>
              {companies.map((d) => (
                <li key={d.id}>
                  <button type="button" onClick={() => setCompany(d)} style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 10px", background: "#fff", border: "none", borderBottom: "1px solid var(--border)", cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>
                    {d.name} <span style={{ color: "var(--text-muted)", fontSize: 11 }}>· {KIND_LABEL[d.kind] ?? d.kind}{d.dealer_text_id ? ` · ${d.dealer_text_id}` : ""}{d.city ? ` · ${d.city}, ${d.state ?? ""}` : ""}{d.active ? "" : " · inactive"}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 13 }}>
            <strong>{company.name}</strong> <span style={{ color: "var(--text-muted)" }}>· {KIND_LABEL[company.kind] ?? company.kind}</span>{" "}
            <button type="button" onClick={() => { setCompany(null); setContactChoice(""); }} style={{ background: "none", border: "none", color: "var(--blue)", cursor: "pointer", fontSize: 12 }}>change</button>
          </div>
          <select className="input" style={{ maxWidth: 360 }} value={contactChoice} onChange={(e) => setContactChoice(e.target.value)}>
            <option value="">No contact (company only)</option>
            {contacts.map((c) => <option key={c.id} value={c.id}>{[c.first_name, c.last_name].filter(Boolean).join(" ") || c.email}{c.phone ? "" : " (save this number)"}</option>)}
            <option value="new">+ New contact with this number…</option>
          </select>
          {contactChoice === "new" && (
            <div style={{ display: "flex", gap: 8, maxWidth: 360 }}>
              <input className="input" placeholder="First name" value={newFirst} onChange={(e) => setNewFirst(e.target.value)} />
              <input className="input" placeholder="Last name" value={newLast} onChange={(e) => setNewLast(e.target.value)} />
            </div>
          )}
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button type="button" className="btn btn-primary" onClick={assign} disabled={saving || (contactChoice === "new" && !newFirst.trim())}>{saving ? "Assigning…" : "Assign call"}</button>
            {err && <span style={{ fontSize: 12, color: "var(--error)" }}>{err}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
