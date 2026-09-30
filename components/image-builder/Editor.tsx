"use client";

// Image Builder editor. Preview = the export renderer (lib/image-builder/render)
// drawn at screen scale onto a <canvas>; an SVG overlay at exact document
// pixel coordinates handles hit-testing, drag, and the 8 resize handles.
// Designing + saving only — never in the print path.

import "./image-builder-fonts.css";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { drawDesign, ensureFonts, loadImages, renderDesignPng, type ImageCache } from "@/lib/image-builder/render";
import {
  FONTS, IMAGE_TYPES, MAX_EMBEDDED_IMAGE_BYTES,
  type DesignDoc, type DesignElement, type ElementType, type FontKey, type ImageType,
} from "@/lib/image-builder/spec";
import {
  HANDLES, createElement, duplicateElement, removeElement, reorder, resizeRect, sameDoc, updateElement,
  type Handle, type Rect,
} from "@/lib/image-builder/ops";
import { BLUE, Field, Modal, NAVY, ORANGE, TypeChip, btn, card, input } from "./ui";

interface LibImage { id: string; url: string; display_name: string; bucket?: string }
interface Meta {
  id: string; name: string; image_type: ImageType; is_template: boolean;
  exported: LibImage | null; replaces: LibImage | null; replaces_image_id: string | null;
  latest_version: number | null; updated_at: string;
}
interface Version { id: string; version_no: number; saved_at: string; saved_by_name: string | null }

type Drag =
  | { mode: "move"; id: string; startX: number; startY: number; orig: Rect; before: DesignDoc }
  | { mode: "resize"; id: string; handle: Handle; startX: number; startY: number; orig: Rect; before: DesignDoc };

const HISTORY_CAP = 100;

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

function fmtDate(s: string): string {
  try { return new Date(s).toLocaleString(); } catch { return s; }
}

export default function ImageBuilderEditor({ id }: { id: string }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [doc, setDoc] = useState<DesignDoc | null>(null);
  const [savedDoc, setSavedDoc] = useState<DesignDoc | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [past, setPast] = useState<DesignDoc[]>([]);
  const [future, setFuture] = useState<DesignDoc[]>([]);
  const lastCoalesce = useRef<{ key: string; at: number } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [zoom, setZoom] = useState<number | null>(null); // null = fit
  const [fitScale, setFitScale] = useState(0.2);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [exportResult, setExportResult] = useState<LibImage | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [versions, setVersions] = useState<Version[]>([]);
  const [restoreTarget, setRestoreTarget] = useState<number | null>(null);
  const [showDuplicate, setShowDuplicate] = useState(false);
  const [dupName, setDupName] = useState("");
  const [libImages, setLibImages] = useState<LibImage[]>([]);
  const [imgVersion, setImgVersion] = useState(0);

  const images = useRef<ImageCache>(new Map());
  const docRef = useRef<DesignDoc | null>(null);
  docRef.current = doc;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const replaceFileRef = useRef<HTMLInputElement>(null);

  const spec = meta ? IMAGE_TYPES[meta.image_type] : null;
  const W = spec?.width ?? 1, H = spec?.height ?? 1;
  const readOnly = !!meta?.is_template;
  const dirty = !!doc && !!savedDoc && !sameDoc(doc, savedDoc);
  const scale = zoom ?? fitScale;
  const selected = doc?.elements.find((e) => e.id === selectedId) ?? null;

  // ── load ───────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/image-designs/${id}`, { cache: "no-store" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setLoadError(j.error ?? `Load failed (${res.status})`); return; }
    const d = j.data;
    setMeta({
      id: d.id, name: d.name, image_type: d.image_type, is_template: d.is_template,
      exported: d.exported ?? null, replaces: d.replaces ?? null, replaces_image_id: d.replaces_image_id,
      latest_version: d.latest_version, updated_at: d.updated_at,
    });
    setDoc(d.design_json);
    setSavedDoc(d.design_json);
    setPast([]); setFuture([]);
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!meta) return;
    const bucket = IMAGE_TYPES[meta.image_type].bucket;
    fetch(`/api/admin/image-library/${bucket}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        const list = (j.images ?? j.data ?? []) as Array<{ id: string | null; url: string; display_name: string }>;
        setLibImages(list.filter((x) => x.id).map((x) => ({ id: x.id as string, url: x.url, display_name: x.display_name })));
      })
      .catch(() => setLibImages([]));
  }, [meta]);

  // unsaved-changes guard
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  // ── fit-to-stage scale ───────────────────────────────────────────────────
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !spec) return;
    const measure = () => {
      const pad = 48;
      const s = Math.min((el.clientWidth - pad) / W, (el.clientHeight - pad) / H);
      setFitScale(Math.max(0.02, s));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [spec, W, H]);

  // ── paint preview (same renderer as export) ──────────────────────────────
  useEffect(() => {
    if (!doc || !canvasRef.current) return;
    let cancelled = false;
    const canvas = canvasRef.current;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const px = scale * dpr;
    canvas.width = Math.max(1, Math.round(W * px));
    canvas.height = Math.max(1, Math.round(H * px));
    const paint = () => {
      const ctx = canvas.getContext("2d");
      if (ctx && !cancelled) drawDesign(ctx, doc, W, H, px, images.current);
    };
    paint();
    // fonts/images may land after first paint — repaint once they're ready
    Promise.all([ensureFonts(doc), loadImages(doc, images.current)]).then(() => { if (!cancelled) paint(); });
    return () => { cancelled = true; };
  }, [doc, scale, W, H, imgVersion]);

  // ── history ──────────────────────────────────────────────────────────────
  /** Apply a change. Same `coalesceKey` within 800 ms folds into one undo step.
   *  `before` overrides the undo snapshot (used when a drag ends). */
  const apply = useCallback((next: DesignDoc, coalesceKey?: string, before?: DesignDoc) => {
    const cur = docRef.current;
    if (readOnly || !cur) return;
    const base = before ?? cur;
    if (sameDoc(base, next)) { setDoc(next); return; }
    const now = Date.now();
    const lc = lastCoalesce.current;
    const coalesce = !!coalesceKey && !!lc && lc.key === coalesceKey && now - lc.at < 800;
    lastCoalesce.current = coalesceKey ? { key: coalesceKey, at: now } : null;
    if (!coalesce) {
      setPast((p) => [...p.slice(-(HISTORY_CAP - 1)), base]);
      setFuture([]);
    }
    docRef.current = next;
    setDoc(next);
  }, [readOnly]);

  const undo = useCallback(() => {
    if (!doc || past.length === 0) return;
    const prev = past[past.length - 1];
    setPast((p) => p.slice(0, -1));
    setFuture((f) => [doc, ...f]);
    lastCoalesce.current = null;
    setDoc(prev);
    if (selectedId && !prev.elements.some((e) => e.id === selectedId)) setSelectedId(null);
  }, [doc, past, selectedId]);

  const redo = useCallback(() => {
    if (!doc || future.length === 0) return;
    const nxt = future[0];
    setFuture((f) => f.slice(1));
    setPast((p) => [...p, doc]);
    lastCoalesce.current = null;
    setDoc(nxt);
  }, [doc, future]);

  const patchSelected = useCallback((patch: Partial<DesignElement>, key?: string) => {
    if (!doc || !selectedId) return;
    apply(updateElement(doc, selectedId, patch), key ? `${selectedId}:${key}` : undefined);
  }, [doc, selectedId, apply]);

  const duplicateSelected = useCallback(() => {
    if (!doc || !selectedId) return;
    const r = duplicateElement(doc, selectedId, Math.max(4, Math.round(Math.min(W, H) / 50)));
    if (r.id) { apply(r.doc); setSelectedId(r.id); }
  }, [doc, selectedId, apply, W, H]);

  const deleteSelected = useCallback(() => {
    if (!doc || !selectedId) return;
    apply(removeElement(doc, selectedId));
    setSelectedId(null);
  }, [doc, selectedId, apply]);

  // ── save ─────────────────────────────────────────────────────────────────
  const save = useCallback(async () => {
    if (!doc || readOnly || saving) return;
    setSaving(true); setNotice(null);
    try {
      const res = await fetch(`/api/admin/image-designs/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ design_json: doc }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `Save failed (${res.status})`);
      setSavedDoc(doc);
      setMeta((m) => (m ? { ...m, latest_version: j.version_no ?? m.latest_version, updated_at: j.data?.updated_at ?? m.updated_at } : m));
      setNotice({ kind: "ok", text: `Design saved — version ${j.version_no}` });
      if (showHistory) void loadVersions();
    } catch (e) {
      setNotice({ kind: "err", text: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setSaving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, readOnly, saving, id, showHistory]);

  async function patchMeta(body: Record<string, unknown>) {
    const res = await fetch(`/api/admin/image-designs/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setNotice({ kind: "err", text: j.error ?? "Update failed" }); return false; }
    return true;
  }

  // ── export ───────────────────────────────────────────────────────────────
  async function exportToLibrary() {
    if (!doc || !meta || !spec || readOnly) return;
    if (dirty) { setNotice({ kind: "err", text: "Save the design first — the library image is rendered from the saved design." }); return; }
    setExporting(true); setNotice(null); setExportResult(null);
    try {
      const png = await renderDesignPng(doc, meta.image_type);
      if (png.length > spec.maxBytes) {
        throw new Error(`Rendered PNG is ${(png.length / 1048576).toFixed(1)} MB — over the ${spec.maxBytes / 1048576} MB limit. Use smaller embedded images.`);
      }
      const fd = new FormData();
      fd.append("file", new Blob([png as BlobPart], { type: "image/png" }), `${meta.name}.png`);
      const res = await fetch(`/api/admin/image-designs/${id}/export`, { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `Export failed (${res.status})`);
      setExportResult(j.data);
      setMeta((m) => (m ? { ...m, exported: j.data } : m));
    } catch (e) {
      setNotice({ kind: "err", text: e instanceof Error ? e.message : "Export failed" });
    } finally {
      setExporting(false);
    }
  }

  // ── versions ─────────────────────────────────────────────────────────────
  async function loadVersions() {
    const res = await fetch(`/api/admin/image-designs/${id}/versions`, { cache: "no-store" });
    const j = await res.json().catch(() => ({}));
    if (res.ok) setVersions(j.data ?? []);
  }
  useEffect(() => { if (showHistory) void loadVersions(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [showHistory]);

  async function doRestore(n: number) {
    const res = await fetch(`/api/admin/image-designs/${id}/restore`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version_no: n }),
    });
    const j = await res.json().catch(() => ({}));
    setRestoreTarget(null);
    if (!res.ok) { setNotice({ kind: "err", text: j.error ?? "Restore failed" }); return; }
    setDoc(j.design_json); setSavedDoc(j.design_json);
    setPast([]); setFuture([]); setSelectedId(null);
    setMeta((m) => (m ? { ...m, latest_version: j.version_no } : m));
    setNotice({ kind: "ok", text: `Restored version ${n} (saved as version ${j.version_no})` });
    void loadVersions();
  }

  async function duplicateAndEdit() {
    const res = await fetch(`/api/admin/image-designs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_id: id, name: dupName.trim() || undefined }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setNotice({ kind: "err", text: j.error ?? "Duplicate failed" }); setShowDuplicate(false); return; }
    window.location.href = `/admin/image-builder/${j.data.id}`;
  }

  // ── add elements ─────────────────────────────────────────────────────────
  function add(type: ElementType) {
    if (!doc || readOnly) return;
    if (type === "image") { fileRef.current?.click(); return; }
    const el = createElement(doc, type, W, H);
    apply({ ...doc, elements: [...doc.elements, el] });
    setSelectedId(el.id);
  }

  function readImageFile(file: File): Promise<{ src: string; naturalWidth: number; naturalHeight: number }> {
    return new Promise((resolve, reject) => {
      if (!/^image\/(png|jpeg)$/.test(file.type)) { reject(new Error("PNG or JPG only")); return; }
      if (file.size > MAX_EMBEDDED_IMAGE_BYTES) { reject(new Error(`Image must be under ${MAX_EMBEDDED_IMAGE_BYTES / 1048576} MB`)); return; }
      const fr = new FileReader();
      fr.onload = () => {
        const src = String(fr.result);
        const img = new Image();
        img.onload = () => { images.current.set(src, img); resolve({ src, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight }); };
        img.onerror = () => reject(new Error("Could not read image"));
        img.src = src;
      };
      fr.onerror = () => reject(new Error("Could not read file"));
      fr.readAsDataURL(file);
    });
  }

  async function onImagePicked(file: File | undefined, replace: boolean) {
    if (!file || !doc) return;
    try {
      const im = await readImageFile(file);
      if (replace && selected?.type === "image") {
        patchSelected({ src: im.src } as Partial<DesignElement>);
      } else {
        const el = createElement(doc, "image", W, H, im);
        apply({ ...doc, elements: [...doc.elements, el] });
        setSelectedId(el.id);
      }
      setImgVersion((v) => v + 1);
    } catch (e) {
      setNotice({ kind: "err", text: e instanceof Error ? e.message : "Image failed" });
    }
  }

  // ── keyboard ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); return; }
      if (isTypingTarget(e.target)) return;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
      if (readOnly || !doc || !selectedId) return;
      if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); duplicateSelected(); return; }
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelected(); return; }
      if (e.key === "Escape") { setSelectedId(null); return; }
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (d && selected) {
        e.preventDefault();
        apply(updateElement(doc, selectedId, { x: selected.x + d[0], y: selected.y + d[1] }), `${selectedId}:nudge`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doc, selectedId, selected, readOnly, apply, undo, redo, save, duplicateSelected, deleteSelected]);

  // ── pointer: drag + resize ───────────────────────────────────────────────
  const toDoc = useCallback((clientX: number, clientY: number) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: ((clientX - r.left) / r.width) * W, y: ((clientY - r.top) / r.height) * H };
  }, [W, H]);

  function startMove(e: RPointerEvent, el: DesignElement) {
    e.stopPropagation();
    setSelectedId(el.id);
    if (readOnly || !doc) return;
    const p = toDoc(e.clientX, e.clientY);
    setDrag({ mode: "move", id: el.id, startX: p.x, startY: p.y, orig: { x: el.x, y: el.y, w: el.w, h: el.h }, before: doc });
  }
  function startResize(e: RPointerEvent, el: DesignElement, handle: Handle) {
    e.stopPropagation();
    if (readOnly || !doc) return;
    const p = toDoc(e.clientX, e.clientY);
    setDrag({ mode: "resize", id: el.id, handle, startX: p.x, startY: p.y, orig: { x: el.x, y: el.y, w: el.w, h: el.h }, before: doc });
  }

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const p = toDoc(e.clientX, e.clientY);
      const dx = p.x - drag.startX, dy = p.y - drag.startY;
      const rect = drag.mode === "move"
        ? { x: Math.round(drag.orig.x + dx), y: Math.round(drag.orig.y + dy), w: drag.orig.w, h: drag.orig.h }
        : resizeRect(drag.orig, drag.handle, dx, dy);
      const next = updateElement(drag.before, drag.id, rect);
      docRef.current = next;
      setDoc(next);
    };
    const up = () => {
      const cur = docRef.current;
      setDrag(null);
      if (cur) apply(cur, undefined, drag.before);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [drag, toDoc, apply]);

  // ── helpers panel ────────────────────────────────────────────────────────
  const align = useMemo(() => ({
    centerH: () => selected && patchSelected({ x: Math.round((W - selected.w) / 2) }),
    centerV: () => selected && patchSelected({ y: Math.round((H - selected.h) / 2) }),
    fullWidth: () => selected && patchSelected({ x: 0, w: W }),
  }), [selected, patchSelected, W, H]);

  // ── render ───────────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <div style={{ ...card, padding: 24 }}>
        <div style={{ color: "#c62828", marginBottom: 12 }}>{loadError}</div>
        <Link href="/admin/image-builder" style={{ color: BLUE }}>← Back to Image Builder</Link>
      </div>
    );
  }
  if (!doc || !meta || !spec) return <div style={{ color: "#fff", padding: 24 }}>Loading…</div>;

  const handleSize = 9 / scale; // 9 screen px in document units
  const outline = 1.5 / scale;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 110px)", minHeight: 560 }}>
      {/* toolbar */}
      <div style={{ ...card, padding: "8px 12px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <Link href="/admin/image-builder" style={{ color: BLUE, fontSize: 13, textDecoration: "none", marginRight: 4 }}>← Designs</Link>
        <NameEditor name={meta.name} disabled={readOnly} onSave={async (n) => {
          if (await patchMeta({ name: n })) setMeta((m) => (m ? { ...m, name: n } : m));
        }} />
        <TypeChip>{spec.label} · {spec.width}×{spec.height}</TypeChip>
        {meta.latest_version && <span style={{ fontSize: 12, color: "#666" }}>v{meta.latest_version}{dirty ? " · unsaved changes" : ""}</span>}
        <div style={{ flex: 1 }} />
        {!readOnly && (
          <>
            <span style={{ fontSize: 12, color: "#666" }}>Add:</span>
            <button style={btn()} onClick={() => add("frame")}>Frame</button>
            <button style={btn()} onClick={() => add("box")}>Box</button>
            <button style={btn()} onClick={() => add("text")}>Text</button>
            <button style={btn()} onClick={() => add("image")}>Image</button>
            <span style={{ width: 1, height: 22, background: "#e0e0e0", margin: "0 4px" }} />
            <button style={btn("secondary", past.length === 0)} disabled={past.length === 0} onClick={undo} title="Undo (⌘Z)">Undo</button>
            <button style={btn("secondary", future.length === 0)} disabled={future.length === 0} onClick={redo} title="Redo (⇧⌘Z)">Redo</button>
            <span style={{ width: 1, height: 22, background: "#e0e0e0", margin: "0 4px" }} />
          </>
        )}
        <button style={btn()} onClick={() => setShowHistory((s) => !s)}>{showHistory ? "Hide history" : "History"}</button>
        {readOnly ? (
          <button style={btn("primary")} onClick={() => { setDupName(`${meta.name} (copy)`); setShowDuplicate(true); }}>Duplicate &amp; edit</button>
        ) : (
          <>
            <button style={btn("primary", !dirty || saving)} disabled={!dirty || saving} onClick={() => void save()} title="⌘S">
              {saving ? "Saving…" : "Save design"}
            </button>
            <button style={btn("secondary", dirty || exporting)} disabled={dirty || exporting} onClick={() => void exportToLibrary()}
              title={dirty ? "Save the design first" : "Render the saved design and add it to the Image Library"}>
              {exporting ? "Rendering…" : "Save to Image Library"}
            </button>
          </>
        )}
      </div>

      {readOnly && (
        <div style={{ ...card, padding: "8px 12px", marginBottom: 8, fontSize: 13, borderLeft: `4px solid ${ORANGE}` }}>
          This is a starter template and can&apos;t be changed. Use <b>Duplicate &amp; edit</b> to make your own copy.
        </div>
      )}
      {notice && (
        <div style={{ ...card, padding: "8px 12px", marginBottom: 8, fontSize: 13, display: "flex", alignItems: "center",
          borderLeft: `4px solid ${notice.kind === "ok" ? "#2e7d32" : "#c62828"}`, color: notice.kind === "ok" ? "#2e7d32" : "#c62828" }}>
          <span style={{ flex: 1 }}>{notice.text}</span>
          <button style={{ ...btn(), height: 24 }} onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flex: 1, minHeight: 0 }}>
        {/* layers */}
        <div style={{ ...card, width: 210, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <PanelTitle>Layers</PanelTitle>
          <div style={{ overflowY: "auto", flex: 1 }}>
            {doc.elements.length === 0 && <div style={{ padding: 12, fontSize: 12, color: "#888" }}>No elements yet. Use Add in the toolbar.</div>}
            {[...doc.elements].reverse().map((el, idx, arr) => {
              const isSel = el.id === selectedId;
              return (
                <div key={el.id} onClick={() => setSelectedId(el.id)} style={{
                  display: "flex", alignItems: "center", gap: 4, padding: "6px 8px", cursor: "pointer", fontSize: 12,
                  background: isSel ? "#e3f2fd" : "transparent", borderBottom: "1px solid #f0f0f0",
                  color: el.hidden ? "#999" : "#333",
                }}>
                  <span style={{ fontSize: 10, color: "#888", width: 34, textTransform: "uppercase" }}>{el.type}</span>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{el.name}</span>
                  {!readOnly && (
                    <>
                      <IconBtn title="Show/hide" onClick={() => apply(updateElement(doc, el.id, { hidden: !el.hidden }))}>{el.hidden ? "○" : "●"}</IconBtn>
                      <IconBtn title="Bring forward" disabled={idx === 0} onClick={() => apply(reorder(doc, el.id, "up"))}>▲</IconBtn>
                      <IconBtn title="Send backward" disabled={idx === arr.length - 1} onClick={() => apply(reorder(doc, el.id, "down"))}>▼</IconBtn>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* stage */}
        <div ref={stageRef} onPointerDown={() => setSelectedId(null)} style={{
          flex: 1, minWidth: 0, overflow: zoom ? "auto" : "hidden", position: "relative",
          border: "1px solid rgba(255,255,255,0.3)", borderRadius: 6, display: "flex", alignItems: zoom ? "flex-start" : "center",
          justifyContent: zoom ? "flex-start" : "center", padding: zoom ? 24 : 0,
        }}>
          <div style={{ position: "relative", width: W * scale, height: H * scale, flex: "none",
            background: "#e0e0e0", outline: "1px solid rgba(0,0,0,0.25)" }}>
            <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
            <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width={W * scale} height={H * scale}
              style={{ position: "absolute", inset: 0, overflow: "visible", touchAction: "none" }}>
              {doc.elements.map((el) => el.hidden ? null : (
                <rect key={el.id} x={el.x} y={el.y} width={el.w} height={el.h} fill="transparent"
                  style={{ cursor: readOnly ? "default" : "move" }}
                  onPointerDown={(e) => startMove(e, el)} />
              ))}
              {selected && !selected.hidden && (
                <g>
                  <rect x={selected.x} y={selected.y} width={selected.w} height={selected.h}
                    fill="none" stroke={BLUE} strokeWidth={outline} pointerEvents="none" />
                  {!readOnly && HANDLES.map((h) => {
                    const cx = selected.x + (h.includes("w") ? 0 : h.includes("e") ? selected.w : selected.w / 2);
                    const cy = selected.y + (h.includes("n") ? 0 : h.includes("s") ? selected.h : selected.h / 2);
                    return (
                      <rect key={h} x={cx - handleSize / 2} y={cy - handleSize / 2} width={handleSize} height={handleSize}
                        fill="#fff" stroke={BLUE} strokeWidth={outline}
                        style={{ cursor: `${h}-resize` }} onPointerDown={(e) => startResize(e, selected, h)} />
                    );
                  })}
                </g>
              )}
            </svg>
          </div>
          <div onPointerDown={(e) => e.stopPropagation()} style={{
            position: "absolute", right: 10, bottom: 10, display: "flex", gap: 4, alignItems: "center",
            background: "#fff", border: "1px solid #e0e0e0", borderRadius: 4, padding: 4,
          }}>
            <button style={{ ...btn(), height: 24, padding: "0 8px" }} onClick={() => setZoom(Math.max(0.05, (zoom ?? fitScale) / 1.25))}>−</button>
            <span style={{ fontSize: 12, width: 44, textAlign: "center" }}>{Math.round(scale * 100)}%</span>
            <button style={{ ...btn(), height: 24, padding: "0 8px" }} onClick={() => setZoom(Math.min(4, (zoom ?? fitScale) * 1.25))}>+</button>
            <button style={{ ...btn(), height: 24, padding: "0 8px" }} onClick={() => setZoom(null)}>Fit</button>
            <button style={{ ...btn(), height: 24, padding: "0 8px" }} onClick={() => setZoom(1)}>100%</button>
          </div>
        </div>

        {/* properties */}
        <div style={{ ...card, width: 260, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {showHistory ? (
            <>
              <PanelTitle>Version history</PanelTitle>
              <div style={{ overflowY: "auto", flex: 1 }}>
                {versions.map((v) => (
                  <div key={v.id} style={{ padding: "8px 12px", borderBottom: "1px solid #f0f0f0", fontSize: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <b>v{v.version_no}</b>
                      {v.version_no === meta.latest_version && <TypeChip>current</TypeChip>}
                      <div style={{ flex: 1 }} />
                      {!readOnly && v.version_no !== meta.latest_version && (
                        <button style={{ ...btn(), height: 24 }} onClick={() => setRestoreTarget(v.version_no)}>Restore</button>
                      )}
                    </div>
                    <div style={{ color: "#666", marginTop: 2 }}>{fmtDate(v.saved_at)}{v.saved_by_name ? ` · ${v.saved_by_name}` : ""}</div>
                  </div>
                ))}
                {versions.length === 0 && <div style={{ padding: 12, fontSize: 12, color: "#888" }}>No versions yet.</div>}
              </div>
            </>
          ) : (
            <>
              <PanelTitle>{selected ? `${selected.type[0].toUpperCase()}${selected.type.slice(1)} properties` : "Document"}</PanelTitle>
              <fieldset disabled={readOnly} style={{ border: 0, margin: 0, padding: 12, overflowY: "auto", flex: 1, minHeight: 0 }}>
                {selected ? (
                  <ElementProps el={selected} patch={patchSelected} align={align}
                    onReplaceImage={() => replaceFileRef.current?.click()}
                    onDuplicate={duplicateSelected} onDelete={deleteSelected} />
                ) : (
                  <DocumentProps doc={doc} spec={spec} meta={meta} libImages={libImages}
                    onBackground={(bg) => apply({ ...doc, background: bg }, "doc:bg")}
                    onReplaces={async (imgId) => {
                      if (await patchMeta({ replaces_image_id: imgId })) {
                        setMeta((m) => (m ? { ...m, replaces_image_id: imgId, replaces: libImages.find((x) => x.id === imgId) ?? null } : m));
                      }
                    }} />
                )}
              </fieldset>
            </>
          )}
        </div>
      </div>

      <input ref={fileRef} type="file" accept="image/png,image/jpeg" style={{ display: "none" }}
        onChange={(e) => { void onImagePicked(e.target.files?.[0], false); e.target.value = ""; }} />
      <input ref={replaceFileRef} type="file" accept="image/png,image/jpeg" style={{ display: "none" }}
        onChange={(e) => { void onImagePicked(e.target.files?.[0], true); e.target.value = ""; }} />

      {exportResult && (
        <Modal title="Saved to Image Library" width={480}
          footer={<>
            <a href="/admin/image-library" style={{ ...btn(), textDecoration: "none" }}>Open Image Library</a>
            <button style={btn("primary")} onClick={() => setExportResult(null)}>Done</button>
          </>}>
          <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={exportResult.url} alt="" style={{ width: 150, maxHeight: 220, objectFit: "contain", border: "1px solid #e0e0e0", background: "#f5f6f7" }} />
            <div style={{ fontSize: 13, lineHeight: 1.6 }}>
              <div><b>{exportResult.display_name}</b></div>
              <div>Tab: {tabLabel(meta.image_type)}</div>
              <div>{spec.width} × {spec.height} px · 150 DPI · PNG</div>
              <div style={{ marginTop: 6, color: "#666" }}>Added as a new library image. Existing library images were not changed.</div>
            </div>
          </div>
        </Modal>
      )}

      {restoreTarget !== null && (
        <Modal title={`Restore version ${restoreTarget}?`}
          footer={<>
            <button style={btn()} onClick={() => setRestoreTarget(null)}>Cancel</button>
            <button style={btn("primary")} onClick={() => void doRestore(restoreTarget)}>Restore</button>
          </>}>
          The design will go back to version {restoreTarget}. This is saved as a new version, so nothing in the history is lost.
          {dirty && <div style={{ marginTop: 10, color: "#c62828" }}>Your unsaved changes will be discarded.</div>}
        </Modal>
      )}

      {showDuplicate && (
        <Modal title="Duplicate & edit"
          footer={<>
            <button style={btn()} onClick={() => setShowDuplicate(false)}>Cancel</button>
            <button style={btn("primary")} onClick={() => void duplicateAndEdit()}>Create copy</button>
          </>}>
          <Field label="Name for your copy">
            <input style={input} value={dupName} autoFocus onChange={(e) => setDupName(e.target.value)} />
          </Field>
        </Modal>
      )}
    </div>
  );
}

function tabLabel(t: ImageType): string {
  return t === "infobox" ? "Infobox Images" : t === "infosheet_bg" ? "Infosheet Backgrounds" : "Addendum Backgrounds";
}

function PanelTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: "10px 12px", borderBottom: "1px solid #e0e0e0", fontSize: 13, fontWeight: 600, color: NAVY }}>{children}</div>;
}

function IconBtn({ children, onClick, title, disabled }: { children: React.ReactNode; onClick: () => void; title: string; disabled?: boolean }) {
  return (
    <button title={title} disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{ border: 0, background: "transparent", cursor: disabled ? "default" : "pointer", fontSize: 10,
        color: disabled ? "#ccc" : "#666", padding: "0 3px", fontFamily: "inherit" }}>{children}</button>
  );
}

function NameEditor({ name, disabled, onSave }: { name: string; disabled: boolean; onSave: (n: string) => void }) {
  const [v, setV] = useState(name);
  useEffect(() => setV(name), [name]);
  return (
    <input value={v} disabled={disabled} onChange={(e) => setV(e.target.value)}
      onBlur={() => { const t = v.trim(); if (t && t !== name) onSave(t); else setV(name); }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      style={{ ...input, width: 240, fontWeight: 600 }} />
  );
}

function NumberField({ label, value, onChange, step = 1, min, max }: {
  label: string; value: number; onChange: (n: number) => void; step?: number; min?: number; max?: number;
}) {
  return (
    <Field label={label}>
      <input type="number" style={input} value={Number.isFinite(value) ? value : 0} step={step} min={min} max={max}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (e.target.value !== "" && Number.isFinite(n)) onChange(min !== undefined ? Math.max(min, max !== undefined ? Math.min(max, n) : n) : n);
        }} />
    </Field>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (c: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <Field label={label}>
      <div style={{ display: "flex", gap: 6 }}>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)}
          style={{ width: 36, height: 30, padding: 0, border: "1px solid #c0c0c0", borderRadius: 4, background: "#fff" }} />
        <input style={input} value={text} onChange={(e) => {
          setText(e.target.value);
          if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) onChange(e.target.value.toLowerCase());
        }} />
      </div>
    </Field>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>{children}</div>;
}

function ElementProps({ el, patch, align, onReplaceImage, onDuplicate, onDelete }: {
  el: DesignElement;
  patch: (p: Partial<DesignElement>, key?: string) => void;
  align: { centerH: () => void; centerV: () => void; fullWidth: () => void };
  onReplaceImage: () => void; onDuplicate: () => void; onDelete: () => void;
}) {
  const P = patch as (p: Record<string, unknown>, key?: string) => void;
  return (
    <div>
      <Field label="Name"><input style={input} value={el.name} onChange={(e) => P({ name: e.target.value }, "name")} /></Field>
      <Row>
        <NumberField label="X" value={el.x} onChange={(n) => P({ x: Math.round(n) }, "x")} />
        <NumberField label="Y" value={el.y} onChange={(n) => P({ y: Math.round(n) }, "y")} />
        <NumberField label="Width" value={el.w} min={1} onChange={(n) => P({ w: Math.round(n) }, "w")} />
        <NumberField label="Height" value={el.h} min={1} onChange={(n) => P({ h: Math.round(n) }, "h")} />
      </Row>
      <div style={{ display: "flex", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
        <button type="button" style={{ ...btn(), height: 26, fontSize: 12 }} onClick={align.centerH}>Center H</button>
        <button type="button" style={{ ...btn(), height: 26, fontSize: 12 }} onClick={align.centerV}>Center V</button>
        <button type="button" style={{ ...btn(), height: 26, fontSize: 12 }} onClick={align.fullWidth}>Full width</button>
      </div>

      {el.type === "frame" && (
        <>
          <ColorField label="Stroke colour" value={el.stroke} onChange={(c) => P({ stroke: c }, "stroke")} />
          <Row>
            <NumberField label="Stroke width" value={el.strokeWidth} min={0} onChange={(n) => P({ strokeWidth: n }, "sw")} />
            <NumberField label="Corner radius" value={el.radius} min={0} onChange={(n) => P({ radius: n }, "r")} />
          </Row>
        </>
      )}

      {el.type === "box" && (
        <>
          <Field label="Mode">
            <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={!!el.knockout} onChange={(e) => P({ knockout: e.target.checked })} /> Cut out (transparent hole)
            </label>
          </Field>
          {el.knockout && (
            <div style={{ fontSize: 11, color: "#666", marginTop: -6, marginBottom: 10 }}>
              Erases everything beneath it, leaving a see-through window in the PNG.
            </div>
          )}
          {!el.knockout && <ColorField label="Fill colour" value={el.fill} onChange={(c) => P({ fill: c }, "fill")} />}
          <Row>
            <NumberField label="Opacity %" value={Math.round(el.opacity * 100)} min={0} max={100} onChange={(n) => P({ opacity: n / 100 }, "op")} />
            <NumberField label="Corner radius" value={el.radius} min={0} onChange={(n) => P({ radius: n }, "r")} />
          </Row>
          {!el.knockout && <Field label="Stroke">
            <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={el.stroke !== null} onChange={(e) => P({ stroke: e.target.checked ? "#000000" : null })} /> Outline
            </label>
          </Field>}
          {!el.knockout && el.stroke !== null && (
            <>
              <ColorField label="Stroke colour" value={el.stroke} onChange={(c) => P({ stroke: c }, "stroke")} />
              <NumberField label="Stroke width" value={el.strokeWidth} min={0} onChange={(n) => P({ strokeWidth: n }, "sw")} />
            </>
          )}
        </>
      )}

      {el.type === "text" && (
        <>
          <Field label="Text">
            <textarea value={el.text} onChange={(e) => P({ text: e.target.value }, "text")} rows={4}
              style={{ ...input, height: "auto", padding: 8, resize: "vertical" }} />
          </Field>
          <Field label="Font">
            <select style={input} value={el.font} onChange={(e) => P({ font: e.target.value as FontKey })}>
              {(Object.keys(FONTS) as FontKey[]).map((k) => <option key={k} value={k}>{FONTS[k].label}</option>)}
            </select>
          </Field>
          {el.font === "sf-pro" && (
            <div style={{ fontSize: 11, color: "#8a6d00", marginTop: -6, marginBottom: 10 }}>
              System font — renders as SF Pro on a Mac, and as the operating system font elsewhere. Use Inter for guaranteed consistency.
            </div>
          )}
          <Row>
            <NumberField label="Size" value={el.size} min={1} onChange={(n) => P({ size: n }, "size")} />
            <NumberField label="Line height" value={el.lineHeight} step={0.05} min={0.5} max={5} onChange={(n) => P({ lineHeight: n }, "lh")} />
          </Row>
          <ColorField label="Colour" value={el.color} onChange={(c) => P({ color: c }, "color")} />
          <Field label="Style">
            <div style={{ display: "flex", gap: 4 }}>
              <button type="button" onClick={() => P({ bold: !el.bold })}
                style={{ ...btn(el.bold ? "primary" : "secondary"), height: 28, fontWeight: 700 }}>B</button>
              {(["left", "center", "right"] as const).map((a) => (
                <button type="button" key={a} onClick={() => P({ align: a })}
                  style={{ ...btn(el.align === a ? "primary" : "secondary"), height: 28, fontSize: 12 }}>{a[0].toUpperCase() + a.slice(1)}</button>
              ))}
            </div>
          </Field>
        </>
      )}

      {el.type === "image" && (
        <>
          <Field label="Fit">
            <select style={input} value={el.fit} onChange={(e) => P({ fit: e.target.value })}>
              <option value="contain">Contain (keep proportions)</option>
              <option value="stretch">Stretch to box</option>
            </select>
          </Field>
          <NumberField label="Opacity %" value={Math.round(el.opacity * 100)} min={0} max={100} onChange={(n) => P({ opacity: n / 100 }, "op")} />
          <button type="button" style={{ ...btn(), marginBottom: 12 }} onClick={onReplaceImage}>Replace image…</button>
        </>
      )}

      <div style={{ display: "flex", gap: 6, borderTop: "1px solid #e0e0e0", paddingTop: 12, marginTop: 4 }}>
        <button type="button" style={btn()} onClick={onDuplicate} title="⌘D">Duplicate</button>
        <button type="button" style={btn("danger")} onClick={onDelete} title="Delete">Delete</button>
      </div>
    </div>
  );
}

function DocumentProps({ doc, spec, meta, libImages, onBackground, onReplaces }: {
  doc: DesignDoc;
  spec: (typeof IMAGE_TYPES)[ImageType];
  meta: Meta;
  libImages: LibImage[];
  onBackground: (bg: string | null) => void;
  onReplaces: (id: string | null) => void;
}) {
  return (
    <div style={{ fontSize: 13 }}>
      <div style={{ marginBottom: 12, lineHeight: 1.6 }}>
        <div><b>{spec.label}</b></div>
        <div style={{ color: "#666" }}>{spec.width} × {spec.height} px · 150 DPI · PNG · max {spec.maxBytes / 1048576} MB</div>
      </div>
      <Field label="Background">
        <label style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
          <input type="checkbox" checked={doc.background === null} onChange={(e) => onBackground(e.target.checked ? null : "#ffffff")} />
          Transparent
        </label>
      </Field>
      {doc.background !== null && <ColorField label="Background colour" value={doc.background} onChange={onBackground} />}

      <Field label="Recreates library image">
        <select style={input} value={meta.replaces_image_id ?? ""} onChange={(e) => onReplaces(e.target.value || null)}>
          <option value="">— none —</option>
          {libImages.map((im) => <option key={im.id} value={im.id}>{im.display_name}</option>)}
        </select>
      </Field>
      <div style={{ fontSize: 11, color: "#666", marginTop: -4, marginBottom: 12 }}>
        Marks which old Illustrator image this design replaces, so it can be retired later.
      </div>
      {meta.replaces && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={meta.replaces.url} alt="" style={{ width: "100%", maxHeight: 160, objectFit: "contain", border: "1px solid #e0e0e0", background: "#f5f6f7", marginBottom: 12 }} />
      )}

      {meta.exported && (
        <Field label="Last saved to library">
          <a href={meta.exported.url} target="_blank" rel="noreferrer" style={{ color: BLUE, wordBreak: "break-all" }}>{meta.exported.display_name}</a>
        </Field>
      )}
      <div style={{ fontSize: 11, color: "#888", lineHeight: 1.6, marginTop: 8 }}>
        Click an element to edit it. Arrow keys nudge (Shift = 10 px) · ⌘D duplicate · Delete removes · ⌘Z undo · ⌘S save.
      </div>
    </div>
  );
}
