"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { api, ERROR_BOX, INFO_BOX, LibraryResponse, Modal, MUTED, PngTile } from "./shared";

// Editor for a LogoForge brand template (schema da-logoforge.brand-template/1 —
// documented in da-logoforge/app/brand/templates.py). The service validates
// everything (fonts installed, ids, numbers, sanitizer on uploaded artwork);
// this form just builds the JSON. Coordinates are the template's own units
// (AutoNation: points on the reference artboard).

type Box = { x: number; y: number; width: number; height: number };
type FixedEl = { id: string; kind: "asset" | "library"; file?: string; asset_id?: string; sha256?: string; box: Box };
type SlotEl = {
  id: string; label: string; required: boolean; aliases?: string[]; font: string; size: number; fill: string;
  x: number; baseline: number; align: "left" | "center" | "right"; case: "as-typed" | "upper" | "lower" | "title";
  tracking?: number; max_width?: number | null; max_chars: number;
};
type Tpl = {
  name: string; description?: string; units?: string; fixed: FixedEl[]; slots: SlotEl[];
  layout?: { padding?: number }; license_note: string; [k: string]: unknown;
};

const EMPTY: Tpl = {
  name: "", description: "", units: "points on the reference artboard",
  fixed: [{ id: "logo", kind: "asset", box: { x: 0, y: 0, width: 300, height: 64 } }],
  slots: [{ id: "make", label: "Make", required: true, font: "", size: 48, fill: "#000000", x: 320, baseline: 48,
    align: "left", case: "as-typed", max_chars: 40 }],
  layout: { padding: 0.02 },
  license_note: "",
};

const NUM: CSSProperties = { width: "100%" };

export default function TemplateEditor({ templateId, fonts, onClose, onSaved }: {
  templateId: string | null; fonts: string[]; onClose: () => void; onSaved: (id: string, created: boolean) => void;
}) {
  const creating = templateId === null;
  const [id, setId] = useState(templateId ?? "");
  const [tpl, setTpl] = useState<Tpl | null>(creating ? { ...EMPTY, slots: EMPTY.slots.map((s) => ({ ...s, font: fonts[0] ?? "" })) } : null);
  const [assetPreviews, setAssetPreviews] = useState<Record<string, string>>({});
  const [uploads, setUploads] = useState<Record<string, string>>({});
  const [uploadNames, setUploadNames] = useState<Record<string, string>>({});
  const [libAssets, setLibAssets] = useState<{ id: string; label: string }[]>([]);
  const [sample, setSample] = useState<Record<string, string>>({});
  const [png, setPng] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"load" | "preview" | "save" | null>(creating ? null : "load");
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState("");

  useEffect(() => {
    api<LibraryResponse>("library").then((l) => setLibAssets(
      l.assets.filter((a) => a.replacement_ok).map((a) => ({ id: a.id, label: `${a.make} — ${a.variant.form}` })),
    )).catch(() => { /* library select just stays empty */ });
    if (creating) return;
    api<{ template: Tpl; asset_previews: Record<string, string> }>(`templates/${templateId}`)
      .then((r) => { setTpl(r.template); setAssetPreviews(r.asset_previews ?? {}); })
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load the template."))
      .finally(() => setBusy(null));
  }, [creating, templateId]);

  const fontOptions = useMemo(() => {
    const used = (tpl?.slots ?? []).map((s) => s.font).filter((f) => f && !fonts.includes(f));
    return [...fonts, ...used];
  }, [fonts, tpl]);

  if (!tpl) {
    return (
      <Modal title={creating ? "New brand template" : `Edit ${templateId}`} onClose={onClose}>
        {error ? <div style={ERROR_BOX}>{error}</div> : <p style={MUTED}>Loading…</p>}
      </Modal>
    );
  }

  const set = (patch: Partial<Tpl>) => { setTpl({ ...tpl, ...patch }); setPng(null); };
  const setFixed = (i: number, patch: Partial<FixedEl>) => set({ fixed: tpl.fixed.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const setBox = (i: number, k: keyof Box, v: string) => setFixed(i, { box: { ...tpl.fixed[i].box, [k]: Number(v) } });
  const setSlot = (i: number, patch: Partial<SlotEl>) => set({ slots: tpl.slots.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  function current(): { template: Tpl } | null {
    if (!jsonMode) return { template: tpl! };
    try {
      return { template: JSON.parse(jsonText) as Tpl };
    } catch {
      setError("The JSON doesn't parse.");
      return null;
    }
  }

  async function onUpload(fid: string, file: File | null) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setError("That SVG is larger than 2 MB."); return; }
    const text = await file.text();
    setUploads((u) => ({ ...u, [fid]: text }));
    setUploadNames((n) => ({ ...n, [fid]: file.name }));
    setPng(null);
  }

  async function preview() {
    const c = current();
    if (!c) return;
    setBusy("preview"); setError(null);
    try {
      const r = await api<{ png_base64: string }>("templates/preview", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: id.trim(), template: c.template, uploads, values: sample }),
      });
      setPng(r.png_base64);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Preview failed.");
    } finally { setBusy(null); }
  }

  async function save() {
    const c = current();
    if (!c) return;
    setBusy("save"); setError(null);
    try {
      if (creating) {
        await api("templates", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: id.trim(), template: c.template, uploads }) });
      } else {
        await api(`templates/${templateId}`, { method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ template: c.template, uploads }) });
      }
      onSaved(id.trim(), creating);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
      setBusy(null);
    }
  }

  function toggleJson() {
    if (!jsonMode) {
      setJsonText(JSON.stringify(tpl, null, 2));
      setJsonMode(true);
      return;
    }
    try {
      setTpl(JSON.parse(jsonText) as Tpl);
      setJsonMode(false);
      setError(null);
    } catch {
      setError("The JSON doesn't parse — fix it or keep editing as JSON.");
    }
  }

  return (
    <Modal title={creating ? "New brand template" : `Edit ${tpl.name || templateId}`} onClose={onClose} width={1080}
      footer={<>
        <button className="btn btn-secondary" onClick={toggleJson}>{jsonMode ? "Back to form" : "Edit as JSON"}</button>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-secondary" disabled={!!busy} onClick={preview}>{busy === "preview" ? "Rendering…" : "Preview"}</button>
        <button className="btn btn-primary" disabled={!!busy} onClick={save}>{busy === "save" ? "Saving…" : creating ? "Create template" : "Save — live now"}</button>
      </>}>
      {error && <div style={{ ...ERROR_BOX, marginBottom: 12 }}>{error}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 20 }}>
        <div>
          {jsonMode ? (
            <textarea className="input" value={jsonText} onChange={(e) => setJsonText(e.target.value)}
              style={{ height: 560, fontFamily: "monospace", fontSize: 12, padding: 10 }} spellCheck={false} />
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 12, marginBottom: 12 }}>
                <div>
                  <label className="label">Template id</label>
                  <input className="input" value={id} onChange={(e) => setId(e.target.value.toLowerCase())} disabled={!creating}
                    placeholder="e.g. lithia" style={{ fontFamily: "monospace" }} maxLength={64} />
                </div>
                <div>
                  <label className="label">Name</label>
                  <input className="input" value={tpl.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Lithia" />
                </div>
              </div>
              <div style={{ marginBottom: 12 }}>
                <label className="label">Description</label>
                <input className="input" value={tpl.description ?? ""} onChange={(e) => set({ description: e.target.value })} />
              </div>

              <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", margin: "16px 0 6px" }}>Fixed artwork</p>
              {tpl.fixed.map((f, i) => (
                <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 10, marginBottom: 8 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "0.8fr 1fr 1.6fr auto", gap: 8, alignItems: "end" }}>
                    <div>
                      <label className="label">Id</label>
                      <input className="input" value={f.id} onChange={(e) => setFixed(i, { id: e.target.value.toLowerCase() })} style={{ fontFamily: "monospace" }} />
                    </div>
                    <div>
                      <label className="label">Source</label>
                      <select className="input" value={f.kind} onChange={(e) => setFixed(i, { kind: e.target.value as FixedEl["kind"] })}>
                        <option value="asset">Uploaded SVG</option>
                        <option value="library">Library emblem</option>
                      </select>
                    </div>
                    <div>
                      {f.kind === "library" ? (
                        <>
                          <label className="label">Library asset</label>
                          <select className="input" value={f.asset_id ?? ""} onChange={(e) => setFixed(i, { asset_id: e.target.value })}>
                            <option value="">Choose…</option>
                            {libAssets.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                          </select>
                        </>
                      ) : (
                        <>
                          <label className="label">SVG {f.file ? `· ${f.file}` : ""}</label>
                          <input type="file" accept=".svg,image/svg+xml" style={{ fontSize: 12 }} onChange={(e) => onUpload(f.id, e.target.files?.[0] ?? null)} />
                          {uploadNames[f.id] && <p style={{ ...MUTED, marginTop: 2 }}>New: {uploadNames[f.id]} (sanitized on save)</p>}
                        </>
                      )}
                    </div>
                    <button className="btn btn-secondary" style={{ height: 36 }} onClick={() => set({ fixed: tpl.fixed.filter((_, j) => j !== i) })}>Remove</button>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr) 90px", gap: 8, marginTop: 8, alignItems: "end" }}>
                    {(["x", "y", "width", "height"] as (keyof Box)[]).map((k) => (
                      <div key={k}>
                        <label className="label">Box {k}</label>
                        <input className="input" type="number" step="any" value={f.box[k]} onChange={(e) => setBox(i, k, e.target.value)} style={NUM} />
                      </div>
                    ))}
                    {f.kind === "asset" && assetPreviews[f.id] && !uploads[f.id]
                      ? <PngTile src={`data:image/png;base64,${assetPreviews[f.id]}`} alt={f.id} height={48} />
                      : <span />}
                  </div>
                </div>
              ))}
              <button className="btn btn-secondary" style={{ height: 30, fontSize: 13 }}
                onClick={() => set({ fixed: [...tpl.fixed, { id: `art${tpl.fixed.length + 1}`, kind: "library", box: { x: 0, y: 0, width: 100, height: 100 } }] })}>
                Add artwork
              </button>

              <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", margin: "16px 0 6px" }}>Text slots</p>
              {tpl.slots.map((s, i) => (
                <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 10, marginBottom: 8 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "0.8fr 1fr 1fr 1.4fr auto", gap: 8, alignItems: "end" }}>
                    <div>
                      <label className="label">Id</label>
                      <input className="input" value={s.id} onChange={(e) => setSlot(i, { id: e.target.value.toLowerCase() })} style={{ fontFamily: "monospace" }} />
                    </div>
                    <div>
                      <label className="label">Label</label>
                      <input className="input" value={s.label} onChange={(e) => setSlot(i, { label: e.target.value })} />
                    </div>
                    <div>
                      <label className="label">Aliases</label>
                      <input className="input" value={(s.aliases ?? []).join(", ")} placeholder="e.g. name"
                        onChange={(e) => setSlot(i, { aliases: e.target.value.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean) })} />
                    </div>
                    <div>
                      <label className="label">Font</label>
                      <select className="input" value={s.font} onChange={(e) => setSlot(i, { font: e.target.value })}>
                        {!s.font && <option value="">Choose…</option>}
                        {fontOptions.map((f) => <option key={f} value={f}>{f}{fonts.includes(f) ? "" : " (not installed)"}</option>)}
                      </select>
                    </div>
                    <button className="btn btn-secondary" style={{ height: 36 }} onClick={() => set({ slots: tpl.slots.filter((_, j) => j !== i) })}>Remove</button>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8, marginTop: 8 }}>
                    <div><label className="label">Size</label><input className="input" type="number" step="any" value={s.size} onChange={(e) => setSlot(i, { size: Number(e.target.value) })} /></div>
                    <div><label className="label">Pen x</label><input className="input" type="number" step="any" value={s.x} onChange={(e) => setSlot(i, { x: Number(e.target.value) })} /></div>
                    <div><label className="label">Baseline</label><input className="input" type="number" step="any" value={s.baseline} onChange={(e) => setSlot(i, { baseline: Number(e.target.value) })} /></div>
                    <div>
                      <label className="label">Align</label>
                      <select className="input" value={s.align} onChange={(e) => setSlot(i, { align: e.target.value as SlotEl["align"] })}>
                        <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
                      </select>
                    </div>
                    <div>
                      <label className="label">Case</label>
                      <select className="input" value={s.case} onChange={(e) => setSlot(i, { case: e.target.value as SlotEl["case"] })}>
                        <option value="as-typed">As typed</option><option value="upper">UPPER</option><option value="lower">lower</option><option value="title">Title</option>
                      </select>
                    </div>
                    <div>
                      <label className="label">Colour</label>
                      <div style={{ display: "flex", gap: 4 }}>
                        <input type="color" value={/^#[0-9a-f]{6}$/i.test(s.fill) ? s.fill : "#000000"} onChange={(e) => setSlot(i, { fill: e.target.value })}
                          style={{ width: 36, height: 36, border: "1px solid var(--border)", borderRadius: 4, padding: 2 }} />
                        <input className="input" value={s.fill} onChange={(e) => setSlot(i, { fill: e.target.value })} style={{ fontFamily: "monospace", padding: "0 6px" }} />
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginTop: 8, alignItems: "end" }}>
                    <div><label className="label">Tracking (1/1000 em)</label><input className="input" type="number" step="any" value={s.tracking ?? 0} onChange={(e) => setSlot(i, { tracking: Number(e.target.value) })} /></div>
                    <div><label className="label">Max width (shrink)</label><input className="input" type="number" step="any" value={s.max_width ?? ""} placeholder="none" onChange={(e) => setSlot(i, { max_width: e.target.value === "" ? null : Number(e.target.value) })} /></div>
                    <div><label className="label">Max chars</label><input className="input" type="number" value={s.max_chars} onChange={(e) => setSlot(i, { max_chars: Number(e.target.value) })} /></div>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-primary)", height: 36 }}>
                      <input type="checkbox" checked={s.required} onChange={(e) => setSlot(i, { required: e.target.checked })} /> Required
                    </label>
                  </div>
                </div>
              ))}
              <button className="btn btn-secondary" style={{ height: 30, fontSize: 13 }}
                onClick={() => set({ slots: [...tpl.slots, { id: `line${tpl.slots.length + 1}`, label: `Line ${tpl.slots.length + 1}`, required: false, font: fonts[0] ?? "", size: 40, fill: "#000000", x: 0, baseline: 120, align: "left", case: "as-typed", max_chars: 60 }] })}>
                Add text slot
              </button>

              <div style={{ marginTop: 16 }}>
                <label className="label">License note (required)</label>
                <textarea className="input" value={tpl.license_note} onChange={(e) => set({ license_note: e.target.value })}
                  style={{ height: 90, padding: 10, fontSize: 13 }}
                  placeholder="Who supplied the mark + font, what DA may use them for, and who receives the result." />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12, marginTop: 12 }}>
                <div>
                  <label className="label">Padding (× long edge)</label>
                  <input className="input" type="number" step="0.005" value={tpl.layout?.padding ?? 0.02}
                    onChange={(e) => set({ layout: { ...(tpl.layout ?? {}), padding: Number(e.target.value) } })} />
                </div>
                <div>
                  <label className="label">Units</label>
                  <input className="input" value={tpl.units ?? ""} onChange={(e) => set({ units: e.target.value })} />
                </div>
              </div>
            </>
          )}
        </div>

        <div>
          <p className="label">Preview text</p>
          {(tpl.slots ?? []).map((s) => (
            <input key={s.id} className="input" style={{ marginBottom: 8 }} placeholder={s.label} value={sample[s.id] ?? ""}
              onChange={(e) => setSample((v) => ({ ...v, [s.id]: e.target.value }))} />
          ))}
          <p style={{ ...MUTED, marginBottom: 8 }}>Empty required slots preview with their label.</p>
          <PngTile src={png ? `data:image/png;base64,${png}` : null} alt="template preview" height={240} />
          <div style={{ ...INFO_BOX, marginTop: 12 }}>
            Preview renders on LogoForge without saving. Save validates the same way (fonts installed, ids, numbers,
            uploaded artwork sanitized and normalized) and the template is live for brand-generate immediately.
          </div>
        </div>
      </div>
    </Modal>
  );
}
