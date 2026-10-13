"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api, Badge, EditedBadge, ERROR_BOX, INFO_BOX, LibAsset, LibraryResponse, Modal, MUTED, PngTile,
  StatusBadge, WARN_BOX,
} from "./shared";

const thumbUrl = (a: LibAsset, size = 160) =>
  `/api/admin/logoforge/thumb?id=${encodeURIComponent(a.id)}&size=${size}&v=${(a.sha256 ?? "").slice(0, 12)}`;

type Target = { make: string; form: string; era: string; status: string; current: LibAsset | null };

export default function LibraryTab() {
  const [data, setData] = useState<LibraryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [target, setTarget] = useState<Target | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showPolicy, setShowPolicy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api<LibraryResponse>("library"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the library.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const { makes, awaiting } = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const assets = (data?.assets ?? []).filter((a) => !needle || a.make.toLowerCase().includes(needle) || a.id.includes(needle));
    const byMake = new Map<string, LibAsset[]>();
    for (const a of assets) {
      if (a.status === "awaiting_asset") continue;
      byMake.set(a.make, [...(byMake.get(a.make) ?? []), a]);
    }
    return {
      makes: Array.from(byMake.entries()).sort((x, y) => x[0].localeCompare(y[0])),
      awaiting: assets.filter((a) => a.status === "awaiting_asset").sort((x, y) => x.make.localeCompare(y.make)),
    };
  }, [data, q]);

  async function revert(a: LibAsset) {
    if (!confirm(`Revert ${a.make} ${a.variant.form} (${a.variant.era}) to the repo baseline? The dashboard upload stops being used immediately.`)) return;
    try {
      await api("library/revert", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: a.id }) });
      setNotice(`${a.make} ${a.variant.form} reverted to the baseline.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Revert failed.");
    }
  }

  if (error && !data) return <div style={ERROR_BOX}>{error}</div>;
  if (!data) return <p style={{ color: "var(--text-muted)", fontSize: 14 }}>Loading library…</p>;

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <StatusBadge status="replacement_ready" /><span style={MUTED}>{data.counts.replacement_ready ?? 0}</span>
          <StatusBadge status="legacy_reference" /><span style={MUTED}>{data.counts.legacy_reference ?? 0}</span>
          <StatusBadge status="awaiting_asset" /><span style={MUTED}>{data.counts.awaiting_asset ?? 0}</span>
          <button className="btn btn-secondary" style={{ height: 28, padding: "0 10px", fontSize: 12 }} onClick={() => setShowPolicy((v) => !v)}>
            {showPolicy ? "Hide" : "License policy"}
          </button>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input className="input" placeholder="Filter by make…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
          <button className="btn btn-primary" disabled={!data.writable}
            onClick={() => setTarget({ make: "", form: "emblem", era: "current", status: "replacement_ready", current: null })}>
            Add asset
          </button>
        </div>
      </div>

      {showPolicy && <div style={{ ...INFO_BOX, marginBottom: 16 }}>{data.license_policy}</div>}
      {!data.writable && <div style={{ ...WARN_BOX, marginBottom: 16 }}>The service has no data volume configured, so the library is read-only.</div>}
      {data.problems.length > 0 && (
        <div style={{ ...ERROR_BOX, marginBottom: 16 }}>Library verification problems: {data.problems.slice(0, 5).join("; ")}</div>
      )}
      {notice && <div style={{ ...INFO_BOX, marginBottom: 16 }}>{notice}</div>}
      {error && <div style={{ ...ERROR_BOX, marginBottom: 16 }}>{error}</div>}

      {awaiting.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>
            Awaiting artwork · {awaiting.length} {awaiting.length === 1 ? "slot" : "slots"} to draw
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 10 }}>
            {awaiting.map((a) => (
              <div key={a.id} style={{ border: "1px dashed var(--border)", borderRadius: 6, padding: 12, background: "var(--bg-subtle)" }}>
                <p style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>{a.make}</p>
                <p style={{ ...MUTED, margin: "2px 0 8px" }}>{a.variant.form} · {a.variant.era}</p>
                {a.notes && <p style={{ ...MUTED, margin: "0 0 8px" }} title={a.notes}>{a.notes.slice(0, 80)}</p>}
                <button className="btn btn-secondary" style={{ height: 28, fontSize: 12, padding: "0 10px" }} disabled={!data.writable}
                  onClick={() => setTarget({ make: a.make, form: a.variant.form, era: "current", status: "replacement_ready", current: null })}>
                  Upload SVG
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {makes.map(([make, assets]) => (
          <div key={make} className="card" style={{ padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginBottom: 10 }}>
              <p style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>{make}</p>
              <p style={{ ...MUTED, margin: 0, maxWidth: 620, textAlign: "right" }} title={assets[0].license_note}>
                {assets[0].license_note}
              </p>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 10 }}>
              {assets.map((a) => (
                <div key={a.id} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 10 }}>
                  <a href={thumbUrl(a, 640)} target="_blank" rel="noreferrer" title="Open a larger render">
                    <PngTile src={thumbUrl(a)} alt={`${a.make} ${a.variant.form}`} />
                  </a>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", margin: "8px 0 4px" }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>{a.variant.form} · {a.variant.era}</span>
                    <StatusBadge status={a.status} />
                    {a.origin === "admin" && <EditedBadge by={a.updated_by} at={a.updated_at} />}
                  </div>
                  {a.notes && <p style={{ ...MUTED, margin: "0 0 6px" }} title={a.notes}>{a.notes.slice(0, 70)}</p>}
                  <div style={{ display: "flex", gap: 6 }}>
                    <button className="btn btn-secondary" style={{ height: 28, fontSize: 12, padding: "0 10px" }} disabled={!data.writable}
                      onClick={() => setTarget({ make: a.make, form: a.variant.form, era: a.variant.era, status: a.status, current: a })}>
                      Replace
                    </button>
                    {a.origin === "admin" && (
                      <button className="btn btn-secondary" style={{ height: 28, fontSize: 12, padding: "0 10px" }} onClick={() => revert(a)}>
                        Revert
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
        {makes.length === 0 && <p style={MUTED}>No makes match “{q}”.</p>}
      </div>

      {target && (
        <ReplaceModal target={target} onClose={() => setTarget(null)}
          onSaved={async (msg) => { setTarget(null); setNotice(msg); await load(); }} />
      )}
    </div>
  );
}

type Preview = {
  make: string; form: string; era: string; status: string; id: string;
  replaces: string | null; fills_awaiting: boolean; new_make: boolean;
  before_png: string | null; after_png: string;
  sanitizer: { removed_elements: string[]; removed_attrs: string[]; neutralized: string[] };
  normalized: { view_box: number[]; aspect: number; color_mode: string; transparent_background: boolean; removed_background: boolean };
  sha256: string;
  nearest_other_makes: { make?: string; score?: number; error?: string }[];
};

const CONFUSABLE = 0.85; // badge matcher: closest wrong-make CLIP score at calibration was 0.844

function ReplaceModal({ target, onClose, onSaved }: {
  target: Target; onClose: () => void; onSaved: (msg: string) => void;
}) {
  const [make, setMake] = useState(target.make);
  const [form, setForm] = useState(target.form);
  const [era, setEra] = useState(target.era);
  const [status, setStatus] = useState(target.status === "legacy_reference" ? "legacy_reference" : "replacement_ready");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<"preview" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // any change to the inputs invalidates the preview (Save must match what was shown)
  useEffect(() => { setPreview(null); }, [make, form, era, status, file]);

  function body(extra: Record<string, string> = {}) {
    const fd = new FormData();
    fd.append("file", file as Blob);
    fd.append("make", make.trim());
    fd.append("form", form);
    fd.append("era", era);
    fd.append("status", status);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    return fd;
  }

  async function runPreview() {
    if (!file || !make.trim()) { setError("Pick an SVG file and a make."); return; }
    setBusy("preview"); setError(null);
    try {
      setPreview(await api<Preview>("library/preview", { method: "POST", body: body() }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Preview failed.");
    } finally { setBusy(null); }
  }

  async function save() {
    if (!preview) return;
    setBusy("save"); setError(null);
    try {
      const r = await api<{ saved: { id: string } }>("library/save", { method: "POST", body: body({ notes, expect_sha: preview.sha256 }) });
      onSaved(`${r.saved.id} is live — the next vectorize uses it.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
      setBusy(null);
    }
  }

  const confusable = (preview?.nearest_other_makes ?? []).filter((n) => typeof n.score === "number" && n.score >= CONFUSABLE);
  const removed = preview ? [...preview.sanitizer.removed_elements.map((x) => `<${x}>`), ...preview.sanitizer.removed_attrs, ...preview.sanitizer.neutralized] : [];

  return (
    <Modal title={target.current ? `Replace ${target.current.make} ${target.current.variant.form}` : "Add or replace a library asset"}
      onClose={onClose}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-secondary" disabled={!!busy || !file} onClick={runPreview}>{busy === "preview" ? "Checking…" : "Preview"}</button>
        <button className="btn btn-primary" disabled={!!busy || !preview} onClick={save}>
          {busy === "save" ? "Saving…" : preview?.replaces ? "Replace — goes live now" : "Save — goes live now"}
        </button>
      </>}>
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1.3fr", gap: 12, marginBottom: 12 }}>
        <div>
          <label className="label">Make</label>
          <input className="input" value={make} onChange={(e) => setMake(e.target.value)} placeholder="e.g. Mercedes-Benz" maxLength={40}
            disabled={!!target.current} />
        </div>
        <div>
          <label className="label">Form</label>
          <select className="input" value={form} onChange={(e) => setForm(e.target.value)} disabled={!!target.current}>
            <option value="emblem">Emblem</option><option value="wordmark">Wordmark</option><option value="lockup">Lockup</option>
          </select>
        </div>
        <div>
          <label className="label">Era</label>
          <select className="input" value={era} onChange={(e) => setEra(e.target.value)} disabled={!!target.current}>
            <option value="current">Current</option><option value="legacy">Legacy</option>
          </select>
        </div>
        <div>
          <label className="label">Use</label>
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="replacement_ready">Replacement ready (badge swap)</option>
            <option value="legacy_reference">Legacy reference (detect only)</option>
          </select>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
        <div>
          <label className="label">SVG file</label>
          <input type="file" accept=".svg,image/svg+xml" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ fontSize: 13 }} />
          <p style={{ ...MUTED, marginTop: 4 }}>Vector paths only, max 2 MB. It is sanitized and normalized (transparent background, tight viewBox) before it is stored.</p>
        </div>
        <div>
          <label className="label">Notes (optional)</label>
          <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} placeholder="e.g. redrawn 2026 badge" />
        </div>
      </div>

      {error && <div style={{ ...ERROR_BOX, marginBottom: 12 }}>{error}</div>}

      {preview && (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div>
              <p className="label">Before{preview.replaces ? ` · ${preview.replaces}` : ""}</p>
              <PngTile src={preview.before_png ? `data:image/png;base64,${preview.before_png}` : null} alt="current" height={200} />
              {!preview.before_png && (
                <p style={{ ...MUTED, marginTop: 4 }}>
                  {preview.fills_awaiting ? "Fills an awaiting slot." : preview.new_make ? "New make — not in the library yet." : "No asset in this slot yet."}
                </p>
              )}
            </div>
            <div>
              <p className="label">After · {preview.id}</p>
              <PngTile src={`data:image/png;base64,${preview.after_png}`} alt="new" height={200} />
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={removed.length ? WARN_BOX : INFO_BOX}>
              {removed.length
                ? <>Sanitizer removed or neutralized: {removed.slice(0, 12).join(", ")}{removed.length > 12 ? "…" : ""}. Check the After render still looks right.</>
                : <>Sanitizer: clean, nothing removed.</>}
              {" "}Normalized: {preview.normalized.color_mode}, aspect {preview.normalized.aspect}
              {preview.normalized.removed_background ? ", background shape removed" : ""}
              {preview.normalized.transparent_background ? ", transparent" : ", NOT transparent at the corners"}.
            </div>
            {status === "replacement_ready" && confusable.length > 0 && (
              <div style={WARN_BOX}>
                Looks similar to {confusable.map((c) => `${c.make} (${c.score})`).join(", ")}. The badge matcher was calibrated with every
                wrong-make pair under {CONFUSABLE}. If this is a round badge like those, consider saving it as a legacy reference
                (detect only) until it has been checked on real dealer logos.
              </div>
            )}
            {status === "replacement_ready" && confusable.length === 0 && (preview.nearest_other_makes[0]?.make) && (
              <p style={MUTED}>
                Closest other make: {preview.nearest_other_makes.map((c) => `${c.make} ${c.score}`).join(" · ")} (badge-swap safety margin is below {CONFUSABLE}).
              </p>
            )}
            <p style={MUTED}>
              <Badge bg="#e8f5e9" fg="#2e7d32">Live</Badge>{" "}
              Saving writes the asset to the service&apos;s data volume — no deploy. It survives restarts and later deploys, and Revert brings back the repo version.
            </p>
          </div>
        </div>
      )}
    </Modal>
  );
}
