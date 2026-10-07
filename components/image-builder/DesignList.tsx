"use client";

import "./image-builder-fonts.css";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { drawDesign, ensureFonts, loadImages } from "@/lib/image-builder/render";
import { IMAGE_TYPES, IMAGE_TYPE_LIST, type DesignDoc, type ImageType } from "@/lib/image-builder/spec";
import { Field, Modal, TypeChip, btn, card, input } from "./ui";

interface Row {
  id: string; name: string; image_type: ImageType; is_template: boolean; updated_at: string;
  exported: { url: string; display_name: string } | null;
  replaces: { url: string; display_name: string } | null;
}

/** Client-rendered thumbnail from the design itself (same renderer as export). */
function Thumb({ id, imageType, q }: { id: string; imageType: ImageType; q: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const spec = IMAGE_TYPES[imageType];
  const boxH = 150;
  const s = Math.min(180 / spec.width, boxH / spec.height);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/admin/image-designs/${id}${q}`, { cache: "no-store" });
      if (!res.ok || cancelled) return;
      const doc = (await res.json()).data.design_json as DesignDoc;
      await ensureFonts(doc);
      const images = await loadImages(doc);
      const c = ref.current;
      if (!c || cancelled) return;
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.round(spec.width * s * dpr);
      c.height = Math.round(spec.height * s * dpr);
      const ctx = c.getContext("2d");
      if (ctx) drawDesign(ctx, doc, spec.width, spec.height, s * dpr, images);
    })();
    return () => { cancelled = true; };
  }, [id, spec.width, spec.height, s, q]);
  return (
    <div style={{ height: boxH + 16, display: "flex", alignItems: "center", justifyContent: "center", background: "#f5f6f7", borderBottom: "1px solid #e0e0e0" }}>
      <canvas ref={ref} style={{ width: spec.width * s, height: spec.height * s, border: "1px solid #e0e0e0", background: "#e0e0e0" }} />
    </div>
  );
}

function DesignCard({ r, onDuplicate, onDelete, q, home }: { r: Row; onDuplicate: (r: Row) => void; onDelete: (r: Row) => void; q: string; home: string }) {
  const spec = IMAGE_TYPES[r.image_type];
  return (
    <div style={{ ...card, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <Thumb id={r.id} imageType={r.image_type} q={q} />
      <div style={{ padding: 10, flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#333" }}>{r.name}</div>
        <div><TypeChip>{spec.label}</TypeChip></div>
        {!r.is_template && (
          <div style={{ fontSize: 11, color: "#666", lineHeight: 1.5 }}>
            Updated {new Date(r.updated_at).toLocaleDateString()}
            {r.exported ? <> · in library as <b>{r.exported.display_name}</b></> : " · not in library yet"}
            {r.replaces && <><br />Recreates <b>{r.replaces.display_name}</b></>}
          </div>
        )}
        <div style={{ display: "flex", gap: 6, marginTop: "auto", paddingTop: 4 }}>
          {r.is_template ? (
            <>
              <button style={btn("primary")} onClick={() => onDuplicate(r)}>Duplicate &amp; edit</button>
              <Link href={`${home}/${r.id}`} style={{ ...btn(), textDecoration: "none" }}>View</Link>
            </>
          ) : (
            <>
              <Link href={`${home}/${r.id}`} style={{ ...btn("primary"), textDecoration: "none" }}>Open</Link>
              <button style={btn()} onClick={() => onDuplicate(r)}>Duplicate</button>
              <button style={btn("danger")} onClick={() => onDelete(r)}>Delete</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** `groupId` = the Group Image Builder (migration 167): that group's designs only,
 *  no starter templates (Allan, 2026-10-07), exports go to the group's library. */
export default function DesignList({ groupId }: { groupId?: string } = {}) {
  const q = groupId ? `?group=${encodeURIComponent(groupId)}` : "";
  const home = groupId ? `/groups/${groupId}/image-builder` : "/admin/image-builder";
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<ImageType | "">("");
  const [creating, setCreating] = useState<null | { fromId?: string; name: string; type: ImageType }>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/image-designs${q}`, { cache: "no-store" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setErr(j.error ?? "Load failed"); return; }
    setRows(j.data);
  }, [q]);
  useEffect(() => { void load(); }, [load]);

  async function create() {
    if (!creating) return;
    setBusy(true);
    const body = creating.fromId
      ? { from_id: creating.fromId, name: creating.name.trim() || undefined }
      : { name: creating.name.trim(), image_type: creating.type };
    const res = await fetch(`/api/admin/image-designs${q}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(j.error ?? "Create failed"); setCreating(null); return; }
    window.location.href = `${home}/${j.data.id}`;
  }

  async function doDelete(r: Row) {
    setBusy(true);
    const res = await fetch(`/api/admin/image-designs/${r.id}${q}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    setDeleting(null);
    if (!res.ok) { setErr(j.error ?? "Delete failed"); return; }
    void load();
  }

  const dup = useCallback((r: Row) => setCreating({ fromId: r.id, name: `${r.name} (copy)`, type: r.image_type }), []);
  const visible = (rows ?? []).filter((r) => !filter || r.image_type === filter);
  const templates = visible.filter((r) => r.is_template);
  const designs = visible.filter((r) => !r.is_template);

  const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 12 } as const;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
        <button style={btn("primary")} onClick={() => setCreating({ name: "", type: "infobox" })}>+ New design</button>
        <select style={{ ...input, width: 260 }} value={filter} onChange={(e) => setFilter(e.target.value as ImageType | "")}>
          <option value="">All image types</option>
          {IMAGE_TYPE_LIST.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
        </select>
        {groupId
          ? <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 13, marginLeft: "auto" }}>Saved images go to your Group Image Library — every store in the group can use them.</span>
          : <Link href="/admin/image-library" style={{ color: "#fff", fontSize: 13, marginLeft: "auto" }}>Open Image Library →</Link>}
      </div>

      {err && <div style={{ ...card, padding: 10, marginBottom: 12, color: "#c62828", fontSize: 13 }}>{err}</div>}
      {!rows && !err && <div style={{ color: "#fff" }}>Loading…</div>}

      {rows && (
        <>
          <h2 style={{ color: "#fff", fontSize: 16, fontWeight: 600, margin: "0 0 10px" }}>My designs</h2>
          {designs.length === 0
            ? <div style={{ ...card, padding: 16, fontSize: 13, color: "#666", marginBottom: 24 }}>{groupId ? "No designs yet — click + New design to start one." : "No designs yet. Start from a template below, or create a blank design."}</div>
            : <div style={{ ...grid, marginBottom: 24 }}>{designs.map((r) => <DesignCard key={r.id} r={r} onDuplicate={dup} onDelete={setDeleting} q={q} home={home} />)}</div>}

          {!groupId && <>
          <h2 style={{ color: "#fff", fontSize: 16, fontWeight: 600, margin: "0 0 10px" }}>Starter templates</h2>
          {templates.length === 0
            ? <div style={{ ...card, padding: 16, fontSize: 13, color: "#666" }}>No starter templates{filter ? " for this image type" : ""}.</div>
            : <div style={grid}>{templates.map((r) => <DesignCard key={r.id} r={r} onDuplicate={dup} onDelete={setDeleting} q={q} home={home} />)}</div>}
          </>}
        </>
      )}

      {creating && (
        <Modal title={creating.fromId ? "Duplicate & edit" : "New design"}
          footer={<>
            <button style={btn()} onClick={() => setCreating(null)} disabled={busy}>Cancel</button>
            <button style={btn("primary", busy || (!creating.fromId && !creating.name.trim()))}
              disabled={busy || (!creating.fromId && !creating.name.trim())} onClick={() => void create()}>
              {busy ? "Creating…" : "Create"}
            </button>
          </>}>
          <Field label="Name">
            <input style={input} autoFocus value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} />
          </Field>
          {creating.fromId ? (
            <div style={{ fontSize: 13, color: "#666" }}>Image type: {IMAGE_TYPES[creating.type].label}</div>
          ) : (
            <Field label="Image type">
              <select style={input} value={creating.type} onChange={(e) => setCreating({ ...creating, type: e.target.value as ImageType })}>
                {IMAGE_TYPE_LIST.map((t) => <option key={t.type} value={t.type}>{t.label} — {t.width}×{t.height}</option>)}
              </select>
            </Field>
          )}
        </Modal>
      )}

      {deleting && (
        <Modal title="Delete design?"
          footer={<>
            <button style={btn()} onClick={() => setDeleting(null)} disabled={busy}>Cancel</button>
            <button style={{ ...btn("primary"), background: "#c62828", borderColor: "#c62828" }} disabled={busy} onClick={() => void doDelete(deleting)}>Delete</button>
          </>}>
          Delete <b>{deleting.name}</b> and its version history? Any image already saved to the Image Library stays there.
        </Modal>
      )}
    </div>
  );
}
