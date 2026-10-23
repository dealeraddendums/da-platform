"use client";

// Team → Signature (crm_admin): the ONE company email signature (lib/crm/signature.ts, migration 196).
// HTML template with {{staff.full_name}} {{staff.title}} {{staff.phone}} {{cta}} {{logo_url}}, a live preview
// as any team member, the team-wide CTA line (text, link, dates), and Publish — until it's published,
// emails keep the old per-person signatures.
import { useCallback, useEffect, useState } from "react";
import SignatureBlock from "./SignatureBlock";

type Cta = { text: string | null; url: string | null; starts_on: string | null; ends_on: string | null };
type State = { template: string; is_default: boolean; default_template: string; published_at: string | null; cta: Cta };

export default function SignatureSettings({ members, meId }: { members: { id: string; name: string }[]; meId: string }) {
  const [s, setS] = useState<State | null>(null);
  const [tpl, setTpl] = useState("");
  const [cta, setCta] = useState<Cta>({ text: null, url: null, starts_on: null, ends_on: null });
  const [who, setWho] = useState(meId);
  const [preview, setPreview] = useState<string | null | undefined>(undefined);
  const [showHtml, setShowHtml] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    fetch("/api/crm/signature").then((r) => r.json()).then((j: State) => { setS(j); setTpl(j.template); setCta(j.cta); }).catch(() => {});
  }, []);

  const renderPreview = useCallback(async () => {
    const r = await fetch("/api/crm/signature/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ staff_id: who, template: tpl, cta }) });
    const j = await r.json().catch(() => ({}));
    setPreview(j.html ?? null);
  }, [who, tpl, cta]);
  useEffect(() => { if (s) { const t = setTimeout(() => void renderPreview(), 250); return () => clearTimeout(t); } }, [s, renderPreview]);

  async function save(extra: Record<string, unknown> = {}) {
    setBusy(true); setMsg(null);
    const r = await fetch("/api/crm/signature", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ template: tpl, cta, ...extra }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: j.error ?? "Couldn't save" }); return; }
    setS(j); setTpl(j.template); setCta(j.cta);
    setMsg({ ok: true, text: "publish" in extra ? (extra.publish ? "Published — every DA-CRM email now uses this signature." : "Unpublished — emails use per-person signatures again.") : "Saved." });
  }

  if (!s) return null;
  const set = (k: keyof Cta) => (e: React.ChangeEvent<HTMLInputElement>) => setCta({ ...cta, [k]: e.target.value || null });
  return (
    <section className="card" style={{ padding: 16, marginTop: 16 }} id="signature">
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>Signature</h3>
        <span className={`crm-tag`} data-tone={s.published_at ? "success" : "warn"}>{s.published_at ? `Published ${new Date(s.published_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "Not published — per-person signatures in use"}</span>
      </div>
      <p style={{ margin: "6px 0 14px", fontSize: 13, color: "var(--text-muted)" }}>
        One signature for every DA-CRM email — replies, new emails, feed requests. Each sender&apos;s name, title and phone
        come from their staff profile; with no direct line it shows 801-415-9435.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <label className="label" style={{ margin: 0 }}>Preview as</label>
            <select className="input" style={{ height: 32, maxWidth: 240 }} value={who} onChange={(e) => setWho(e.target.value)}>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <SignatureBlock html={preview} label="Preview — exactly what's sent" />

          <h4 style={{ margin: "18px 0 8px", fontSize: 14 }}>Signature CTA</h4>
          <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--text-muted)" }}>An optional line under the phone, team-wide, shown only between its dates. Leave the text empty for no line.</p>
          <div style={{ display: "grid", gap: 8 }}>
            <input className="input" placeholder="e.g. Come see us at NADA 2028 · Booth 1234" value={cta.text ?? ""} onChange={set("text")} maxLength={140} />
            <input className="input" placeholder="Link (optional) — https://…" value={cta.url ?? ""} onChange={set("url")} />
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <label style={{ fontSize: 12, color: "var(--text-muted)" }}>From</label>
              <input className="input" type="date" value={cta.starts_on ?? ""} onChange={set("starts_on")} style={{ maxWidth: 170 }} />
              <label style={{ fontSize: 12, color: "var(--text-muted)" }}>to</label>
              <input className="input" type="date" value={cta.ends_on ?? ""} onChange={set("ends_on")} style={{ maxWidth: 170 }} />
            </div>
          </div>
        </div>

        <div>
          <button type="button" className="crm-textlink" style={{ fontSize: 13 }} onClick={() => setShowHtml(!showHtml)}>{showHtml ? "Hide" : "Edit"} template HTML</button>
          {showHtml && (
            <>
              <p style={{ margin: "6px 0", fontSize: 12, color: "var(--text-muted)" }}>
                Outlook-safe table layout. Placeholders: {"{{staff.full_name}}"} {"{{staff.title}}"} {"{{staff.phone}}"} {"{{cta}}"} (a whole row) {"{{logo_url}}"}.
                Inline styles only; images must be https with a fixed width.
              </p>
              <textarea className="input" spellCheck={false} value={tpl} onChange={(e) => setTpl(e.target.value)}
                style={{ height: 320, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11.5, lineHeight: 1.45, padding: 10, resize: "vertical" }} />
              <button type="button" className="crm-textlink" style={{ fontSize: 12 }} onClick={() => setTpl(s.default_template)}>Reset to the default layout</button>
            </>
          )}
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 16, flexWrap: "wrap" }}>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void save()}>Save</button>
        {s.published_at
          ? <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void save({ publish: false })}>Unpublish</button>
          : <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { if (window.confirm("Publish? Every DA-CRM email will use this signature instead of each person's own.")) void save({ publish: true }); }}>Save & publish</button>}
        {msg && <span style={{ fontSize: 12, color: msg.ok ? "var(--success)" : "var(--error)" }}>{msg.text}</span>}
      </div>
    </section>
  );
}
