"use client";

import { useCallback, useEffect, useState } from "react";
import {
  api, downloadBlob, EditedBadge, ERROR_BOX, INFO_BOX, MUTED, PngTile, slugify, TemplateSummary,
} from "./shared";
import TemplateEditor from "./TemplateEditor";

type Listing = { templates: TemplateSummary[]; fonts: string[]; writable: boolean };

export default function TemplatesTab() {
  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [genId, setGenId] = useState<string>("");
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await api<Listing>("templates");
      setData(d);
      setGenId((cur) => cur || d.templates.find((t) => !t.error)?.id || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load templates.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function revert(t: TemplateSummary) {
    if (!confirm(`Revert “${t.name ?? t.id}” to the repo version? Dashboard edits to it stop being used immediately.`)) return;
    try {
      await api(`templates/${t.id}/revert`, { method: "POST" });
      setNotice(`${t.name ?? t.id} reverted to the repo version.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Revert failed.");
    }
  }

  if (error && !data) return <div style={ERROR_BOX}>{error}</div>;
  if (!data) return <p style={{ color: "var(--text-muted)", fontSize: 14 }}>Loading templates…</p>;
  const usable = data.templates.filter((t) => !t.error);

  return (
    <div>
      {notice && <div style={{ ...INFO_BOX, marginBottom: 16 }}>{notice}</div>}
      {error && <div style={{ ...ERROR_BOX, marginBottom: 16 }}>{error}</div>}

      <GenerateCard templates={usable} templateId={genId} setTemplateId={setGenId} />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "24px 0 10px" }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>Templates · {data.templates.length}</p>
        <button className="btn btn-primary" disabled={!data.writable} onClick={() => setEditing({ id: null })}>New template</button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {data.templates.map((t) => (
          <div key={t.id} className="card" style={{ padding: 14 }}>
            {t.error ? (
              <div style={ERROR_BOX}><strong>{t.id}</strong> can&apos;t load: {t.error}</div>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                  <div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <p style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>{t.name}</p>
                      <span style={{ ...MUTED, fontFamily: "monospace" }}>{t.id}</span>
                      {t.origin === "admin" && <EditedBadge by={t.updated_by} at={t.updated_at} />}
                    </div>
                    {t.description && <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "4px 0 0" }}>{t.description}</p>}
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <button className="btn btn-secondary" style={{ height: 30, fontSize: 13 }} onClick={() => setGenId(t.id)}>Generate</button>
                    <button className="btn btn-secondary" style={{ height: 30, fontSize: 13 }} disabled={!data.writable}
                      onClick={() => setEditing({ id: t.id })}>Edit</button>
                    {t.origin === "admin" && (
                      <button className="btn btn-secondary" style={{ height: 30, fontSize: 13 }} onClick={() => revert(t)}>Revert</button>
                    )}
                  </div>
                </div>
                <table style={{ width: "100%", fontSize: 13, marginTop: 10, borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ background: "var(--bg-subtle)" }}>
                      {["Slot", "Request key", "Font", "Max chars", "Required"].map((h) => (
                        <th key={h} style={{ textAlign: "left", padding: "6px 10px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "var(--text-muted)" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(t.slots ?? []).map((s) => (
                      <tr key={s.id} style={{ borderTop: "1px solid var(--border)" }}>
                        <td style={{ padding: "6px 10px", color: "var(--text-primary)" }}>{s.label}</td>
                        <td style={{ padding: "6px 10px", fontFamily: "monospace", color: "var(--text-secondary)" }}>
                          {[s.id, ...s.aliases].join(" / ")}
                        </td>
                        <td style={{ padding: "6px 10px", color: "var(--text-secondary)" }}>{s.font}</td>
                        <td style={{ padding: "6px 10px", color: "var(--text-secondary)" }}>{s.max_chars}</td>
                        <td style={{ padding: "6px 10px", color: "var(--text-secondary)" }}>{s.required ? "Yes" : "No"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p style={{ ...MUTED, margin: "8px 0 0" }}>
                  Fixed artwork: {(t.fixed ?? []).map((f) => `${f.id} (${f.kind === "library" ? `library ${f.source}` : "uploaded"})`).join(", ") || "none"}
                </p>
                <p style={{ ...MUTED, margin: "6px 0 0" }}><strong>License:</strong> {t.license_note}</p>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="card" style={{ padding: 14, marginTop: 16 }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 6px" }}>Brand fonts installed on LogoForge · {data.fonts.length}</p>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0, fontFamily: "monospace" }}>{data.fonts.join(" · ") || "none"}</p>
        <p style={{ ...MUTED, margin: "6px 0 0" }}>
          A template can only use these. Adding a brand font (e.g. Lithia&apos;s Corporate A) is a LogoForge deploy: font file in the repo&apos;s fonts/ folder plus its license note.
        </p>
      </div>

      {editing && (
        <TemplateEditor templateId={editing.id} fonts={data.fonts} onClose={() => setEditing(null)}
          onSaved={async (id, created) => {
            setEditing(null);
            setNotice(`${id} ${created ? "created" : "saved"} — live for brand-generate now.`);
            setGenId(id);
            await load();
          }} />
      )}
    </div>
  );
}

type Generated = { svg: string; png_base64: string; slots: Record<string, { text: string; shrunk: boolean; size: number }>; license_note: string };

function GenerateCard({ templates, templateId, setTemplateId }: {
  templates: TemplateSummary[]; templateId: string; setTemplateId: (id: string) => void;
}) {
  const t = templates.find((x) => x.id === templateId);
  const [values, setValues] = useState<Record<string, string>>({});
  const [out, setOut] = useState<Generated | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setOut(null); setError(null); }, [templateId]);

  async function generate() {
    if (!t) return;
    setBusy(true); setError(null); setOut(null);
    try {
      const slots: Record<string, string> = {};
      for (const s of t.slots ?? []) if (values[`${t.id}:${s.id}`]) slots[s.id] = values[`${t.id}:${s.id}`];
      setOut(await api<Generated>("generate", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ template: t.id, slots }),
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generate failed.");
    } finally { setBusy(false); }
  }

  const fileBase = t ? slugify([t.id, ...(t.slots ?? []).map((s) => values[`${t.id}:${s.id}`] ?? "")].filter(Boolean).join(" ")) : "logo";

  function downloadPng() {
    if (!out) return;
    const bin = atob(out.png_base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    downloadBlob(bytes, "image/png", `${fileBase}.png`);
  }

  return (
    <div className="card" style={{ padding: 16 }}>
      <p style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 12px" }}>Generate a logo</p>
      {templates.length === 0 ? <p style={MUTED}>No usable templates.</p> : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 1fr) 1.4fr", gap: 20 }}>
          <div>
            <label className="label">Template</label>
            <select className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)} style={{ marginBottom: 12 }}>
              {templates.map((x) => <option key={x.id} value={x.id}>{x.name ?? x.id}</option>)}
            </select>
            {(t?.slots ?? []).map((s) => {
              const key = `${t!.id}:${s.id}`;
              const v = values[key] ?? "";
              return (
                <div key={key} style={{ marginBottom: 12 }}>
                  <label className="label">{s.label}{s.required ? "" : " (optional)"}</label>
                  <input className="input" value={v} maxLength={s.max_chars + 20}
                    onChange={(e) => setValues((cur) => ({ ...cur, [key]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === "Enter") void generate(); }}
                    placeholder={s.id === "make" ? "e.g. Chevrolet" : s.id === "location" ? "e.g. North Corpus Christi" : ""} />
                  <p style={{ ...MUTED, marginTop: 3, color: v.length > s.max_chars ? "#c62828" : "var(--text-muted)" }}>
                    {v.length}/{s.max_chars} · {s.font}
                  </p>
                </div>
              );
            })}
            <button className="btn btn-primary" onClick={generate} disabled={busy || !t}>{busy ? "Generating…" : "Generate"}</button>
            {error && <div style={{ ...ERROR_BOX, marginTop: 12 }}>{error}</div>}
          </div>
          <div>
            <label className="label">Preview</label>
            <PngTile src={out ? `data:image/png;base64,${out.png_base64}` : null} alt="generated logo" height={220} />
            {out && (
              <>
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button className="btn btn-primary" onClick={() => downloadBlob(out.svg, "image/svg+xml", `${fileBase}.svg`)}>Download SVG</button>
                  <button className="btn btn-secondary" onClick={downloadPng}>Download PNG</button>
                </div>
                {Object.values(out.slots).some((s) => s.shrunk) && (
                  <p style={{ ...MUTED, marginTop: 6 }}>A line was set smaller to fit its width.</p>
                )}
                <p style={{ ...MUTED, marginTop: 6 }}>Text is outlined to vector paths: the SVG needs no font. {out.license_note}</p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
