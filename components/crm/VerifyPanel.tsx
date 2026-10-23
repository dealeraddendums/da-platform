"use client";

// Contact page: why a record contact is flagged "Verify" (migration 190) and the two ways out —
// Confirm (this person really is at the company) or Move to… (a group, vendor or other dealer).
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Co = { id: string; kind: string; name: string; dealer_text_id: string | null; city: string | null; state: string | null };
const KIND: Record<string, string> = { dealer: "Dealer", group: "Group", vendor: "Vendor", feed_supplier: "Feed supplier" };

export default function VerifyPanel({ contactId, companyName, explanation, highlight, otherCopies = [] }: {
  contactId: string; companyName: string; explanation: string; highlight: boolean;
  /** The same email flagged at other companies (a vendor on several dealer records). */
  otherCopies?: string[];
}) {
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  const [moving, setMoving] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Co[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [all, setAll] = useState(otherCopies.length > 0);

  useEffect(() => { if (highlight) ref.current?.scrollIntoView({ block: "start" }); }, [highlight]);
  useEffect(() => {
    if (!moving || q.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(() => {
      fetch(`/api/crm/companies/search?q=${encodeURIComponent(q.trim())}`).then((r) => r.json()).then((j) => setHits(j.companies ?? [])).catch(() => setHits([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, moving]);

  async function patch(body: Record<string, unknown>) {
    setBusy(true); setErr(null);
    const r = await fetch(`/api/crm/contacts/${contactId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setErr(j.error ?? "Couldn't save"); return false; }
    router.replace(`/crm/contacts/${contactId}`);
    router.refresh();
    return true;
  }

  return (
    <div ref={ref} className="crm-notice" style={{ marginBottom: 16, padding: "14px 16px", fontSize: 13.5, ...(highlight ? { boxShadow: "0 0 0 3px var(--crm-warn-soft)" } : {}) }}>
      <strong style={{ display: "block", marginBottom: 4 }}>Check this contact</strong>
      <span>{explanation} It came from {companyName}&apos;s dealer record, so email from this address won&apos;t link to {companyName} until it&apos;s confirmed.</span>
      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void patch({ verified: true })}>Confirm — they&apos;re at {companyName}</button>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setMoving(!moving)}>Move to…</button>
        {err && <span style={{ color: "var(--crm-danger)" }}>{err}</span>}
      </div>
      {moving && (
        <div style={{ marginTop: 10, maxWidth: 520 }}>
          {otherCopies.length > 0 && (
            <label style={{ display: "flex", gap: 6, alignItems: "flex-start", marginBottom: 8, fontSize: 13 }}>
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} style={{ marginTop: 3 }} />
              <span>Also move this person from {otherCopies.length} other {otherCopies.length === 1 ? "company" : "companies"} ({otherCopies.slice(0, 4).join(", ")}{otherCopies.length > 4 ? ", …" : ""}) — one contact at the new company</span>
            </label>
          )}
          <input className="input" autoFocus placeholder="Search a dealer, group or vendor…" value={q} onChange={(e) => setQ(e.target.value)} />
          {hits.length > 0 && (
            <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0, border: "1px solid var(--crm-border)", borderRadius: 8, background: "var(--crm-surface)", maxHeight: 260, overflowY: "auto" }}>
              {hits.map((h) => (
                <li key={h.id}>
                  <button type="button" disabled={busy} onClick={() => void patch({ company_id: h.id, all_copies: all })}
                    style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", border: 0, borderBottom: "1px solid var(--crm-border)", background: "none", cursor: "pointer", font: "inherit", color: "var(--crm-ink)" }}>
                    <strong style={{ fontWeight: 600 }}>{h.name}</strong>
                    <span style={{ color: "var(--crm-muted)", fontSize: 12 }}> · {KIND[h.kind] ?? h.kind}{h.dealer_text_id ? ` · ${h.dealer_text_id}` : ""}{h.city ? ` · ${h.city}${h.state ? `, ${h.state}` : ""}` : ""}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {q.trim().length >= 2 && !hits.length && <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--crm-muted)" }}>No matches. Vendors can be added under Dealers → Partners.</p>}
        </div>
      )}
    </div>
  );
}
