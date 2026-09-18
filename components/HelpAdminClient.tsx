"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { Node, mergeAttributes } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import HelpConversationsClient from "@/components/HelpConversationsClient";
import HelpCategoriesClient, { type HelpCategory } from "@/components/HelpCategoriesClient";
import { sanitizeHelpHtml } from "@/lib/help-sanitize";

// ── Media blocks ────────────────────────────────────────────────────────────
// A YouTube/Vimeo embed (responsive 16:9 wrapper), an uploaded clip, and an
// inline image. These produce <iframe>/<video>/<img> HTML that the /help
// renderer re-sanitizes against a strict allowlist (lib/help-sanitize) — only
// YT/Vimeo embeds + our S3 clips survive there, so a stray paste can never
// inject an arbitrary iframe.
const VideoEmbed = Node.create({
  name: "videoEmbed",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() { return { src: { default: null } }; },
  parseHTML() { return [{ tag: "iframe[src]" }]; },
  // Sized via width/height attributes (not inline style — the /help sanitizer
  // strips style). 16:9 at a readable width.
  renderHTML({ HTMLAttributes }) {
    return ["iframe", mergeAttributes(HTMLAttributes, {
      width: "560",
      height: "315",
      frameborder: "0",
      allowfullscreen: "true",
      allow: "accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture",
    })];
  },
});

const VideoFile = Node.create({
  name: "videoFile",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() { return { src: { default: null } }; },
  parseHTML() { return [{ tag: "video[src]" }]; },
  renderHTML({ HTMLAttributes }) {
    return ["video", mergeAttributes(HTMLAttributes, { controls: "true", width: "560" })];
  },
});

// Inline image — a screenshot placed WITHIN the text, as opposed to the
// image_urls attachments that render in a strip below the article. Defined here
// rather than pulled from @tiptap/extension-image: no new dependency, and it
// matches the two nodes above. Width is an attribute, not inline style (the
// /help sanitizer strips style).
const InlineImage = Node.create({
  name: "inlineImage",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() { return { src: { default: null }, alt: { default: "" } }; },
  parseHTML() { return [{ tag: "img[src]" }]; },
  renderHTML({ HTMLAttributes }) { return ["img", mergeAttributes(HTMLAttributes)]; },
});

/** Convert a YouTube/Vimeo share URL into its embed URL, or null if unrecognized. */
function toEmbedUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") { const id = u.pathname.slice(1); return id ? `https://www.youtube.com/embed/${id}` : null; }
    if (host === "youtube.com" || host === "m.youtube.com") {
      if (u.pathname === "/watch") { const id = u.searchParams.get("v"); return id ? `https://www.youtube.com/embed/${id}` : null; }
      if (u.pathname.startsWith("/embed/")) return `https://www.youtube.com${u.pathname}`;
    }
    if (host === "vimeo.com") { const id = u.pathname.split("/").filter(Boolean)[0]; return /^\d+$/.test(id) ? `https://player.vimeo.com/video/${id}` : null; }
    if (host === "player.vimeo.com" && u.pathname.startsWith("/video/")) return `https://player.vimeo.com${u.pathname}`;
    return null;
  } catch { return null; }
}

type Article = {
  id: string;
  slug: string;
  category: string;
  category_id: string | null;
  title: string;
  body: string;
  image_urls: string[];
  pdf_url: string | null;
  product_fruits_tour_id: string | null;
  audience: string;
  sort_order: number;
  published: boolean;
  updated_at: string;
};

type Draft = {
  id: string;
  slug: string;
  category_id: string;
  title: string;
  body: string;
  image_urls: string[];
  pdf_url: string;
  product_fruits_tour_id: string;
  audience: string;
  sort_order: number;
  published: boolean;
};

const EMPTY: Draft = {
  id: "", slug: "", category_id: "", title: "", body: "", image_urls: [],
  pdf_url: "", product_fruits_tour_id: "", audience: "dealer", sort_order: 0, published: false,
};

function toDraft(a: Article): Draft {
  return {
    id: a.id, slug: a.slug, category_id: a.category_id ?? "", title: a.title, body: a.body,
    image_urls: a.image_urls ?? [], pdf_url: a.pdf_url ?? "",
    product_fruits_tour_id: a.product_fruits_tour_id ?? "",
    audience: a.audience, sort_order: a.sort_order, published: a.published,
  };
}

type Tab = "articles" | "categories" | "conversations";

export default function HelpAdminClient() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [cats, setCats] = useState<HelpCategory[]>([]);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const [tab, setTab] = useState<Tab>("articles");
  const [initialConvId, setInitialConvId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inlineImgRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<HTMLInputElement>(null);

  // Deep links from escalation emails: /help/manage?tab=conversations&id=…
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("tab") === "conversations") setTab("conversations");
    setInitialConvId(sp.get("id"));
  }, []);

  const editor = useEditor({
    extensions: [StarterKit, Underline, VideoEmbed, VideoFile, InlineImage],
    content: "",
    immediatelyRender: false,
    editorProps: { attributes: { class: "help-article-body", style: "min-height:240px;padding:12px;outline:none;font-size:14px;line-height:1.6" } },
  });

  const load = useCallback(async () => {
    const [aRes, cRes] = await Promise.all([
      fetch("/api/help/articles?all=1"),
      fetch("/api/help/categories?all=1"),
    ]);
    if (aRes.ok) setArticles((await aRes.json()).data ?? []);
    if (cRes.ok) setCats((await cRes.json()).data ?? []);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const catById = useMemo(() => new Map(cats.map((c) => [c.id, c])), [cats]);
  const articleCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of articles) if (a.category_id) m[a.category_id] = (m[a.category_id] ?? 0) + 1;
    return m;
  }, [articles]);

  // Group the CMS list the same way dealers see it, so "what will they find
  // where" needs no translation.
  const grouped = useMemo(() => {
    const byCat = new Map<string, Article[]>();
    const orphans: Article[] = [];
    for (const a of articles) {
      if (!a.category_id || !catById.has(a.category_id)) { orphans.push(a); continue; }
      const l = byCat.get(a.category_id);
      if (l) l.push(a); else byCat.set(a.category_id, [a]);
    }
    const out = cats.map((c) => ({ key: c.id, name: c.name, published: c.published, items: (byCat.get(c.id) ?? []).sort(bySort) }));
    if (orphans.length) out.push({ key: "__none", name: "Uncategorized", published: true, items: orphans.sort(bySort) });
    return out;
  }, [articles, cats, catById]);

  function startEdit(d: Draft) {
    setEditing(d);
    setPreview(false);
    editor?.commands.setContent(d.body || "");
  }

  function startNew() {
    // Default into the first category so the required field is never silently blank.
    startEdit({ ...EMPTY, category_id: cats[0]?.id ?? "" });
  }

  // From a flagged/escalated conversation: open a new draft article prefilled
  // with the dealer's question + the assistant's last answer to correct.
  function correctIntoKb(draft: { title: string; body: string }) {
    setTab("articles");
    startEdit({ ...EMPTY, category_id: cats[0]?.id ?? "", title: draft.title, body: draft.body });
  }

  async function uploadImage(file: File, inline: boolean) {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/help/articles/upload-image", { method: "POST", body: fd });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setToast(j.error ?? "Upload failed"); return; }
    if (inline) editor?.chain().focus().insertContent({ type: "inlineImage", attrs: { src: j.url, alt: "" } }).run();
    else setEditing((e) => (e ? { ...e, image_urls: [...e.image_urls, j.url] } : e));
  }

  function embedVideo() {
    const raw = prompt("Paste a YouTube or Vimeo link:");
    if (!raw) return;
    const url = toEmbedUrl(raw);
    if (!url) { setToast("Only YouTube or Vimeo links are supported"); return; }
    editor?.chain().focus().insertContent({ type: "videoEmbed", attrs: { src: url } }).run();
  }

  async function uploadVideo(file: File) {
    setToast("Uploading video…");
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/help/articles/upload-video", { method: "POST", body: fd });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setToast(j.error ?? "Upload failed"); return; }
    setToast(null);
    editor?.chain().focus().insertContent({ type: "videoFile", attrs: { src: j.url } }).run();
  }

  async function uploadPdf(file: File) {
    setToast("Uploading PDF…");
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/help/articles/upload-pdf", { method: "POST", body: fd });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setToast(j.error ?? "Upload failed"); return; }
    setToast(null);
    setEditing((e) => (e ? { ...e, pdf_url: j.url } : e));
  }

  async function save() {
    if (!editing) return;
    if (!editing.category_id) { setToast("Pick a category"); return; }
    setSaving(true); setToast(null);
    // getHTML() returns real HTML; it is stored VERBATIM and re-sanitized on
    // render. Never entity-encode on the way in.
    const payload = { ...editing, body: editor?.getHTML() ?? editing.body };
    const isNew = !editing.id;
    const res = await fetch(isNew ? "/api/help/articles" : `/api/help/articles/${editing.id}`, {
      method: isNew ? "POST" : "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const j = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) { setToast(j.error ?? "Save failed"); return; }
    setToast("✓ Saved");
    setEditing(null);
    await load();
  }

  async function remove(id: string) {
    if (!confirm("Delete this article?")) return;
    const res = await fetch(`/api/help/articles/${id}`, { method: "DELETE" });
    if (res.ok) { setEditing(null); await load(); setToast("✓ Deleted"); }
  }

  const btn = (active: boolean) => ({
    padding: "5px 9px", border: "1px solid #e0e0e0", borderRadius: 4, cursor: "pointer", fontSize: 13,
    background: active ? "#1976d2" : "#fff", color: active ? "#fff" : "#333", fontFamily: "inherit",
  });

  const TABS: Array<[Tab, string]> = [["articles", "Articles"], ["categories", "Categories"], ["conversations", "Conversations"]];

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
        {TABS.map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)}
            style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid #e0e0e0", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600, background: tab === t ? "#1976d2" : "#fff", color: tab === t ? "#fff" : "#55595c" }}>
            {label}
          </button>
        ))}
      </div>

      {tab === "conversations" ? (
        <HelpConversationsClient initialId={initialConvId} onCorrectIntoKb={correctIntoKb} />
      ) : tab === "categories" ? (
        <HelpCategoriesClient categories={cats} articleCounts={articleCounts} onChanged={load} />
      ) : (
      <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: "#2a2b3c", margin: 0 }}>Help Center — Articles</h1>
        {!editing && (
          <button onClick={startNew} disabled={cats.length === 0}
            style={{ ...btn(cats.length > 0), padding: "8px 14px", fontWeight: 600, opacity: cats.length ? 1 : 0.5, cursor: cats.length ? "pointer" : "default" }}>
            + New article
          </button>
        )}
      </div>
      {cats.length === 0 && !editing && (
        <div style={{ marginBottom: 12, padding: "10px 12px", borderRadius: 6, fontSize: 13, background: "#fff8e1", border: "1px solid #ffe082", color: "#7a5c00" }}>
          Add a category first — every article lives in one. See the <strong>Categories</strong> tab.
        </div>
      )}
      {toast && <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 6, fontSize: 13, background: toast.startsWith("✓") ? "#e8f5e9" : "#ffebee", color: toast.startsWith("✓") ? "#2e7d32" : "#c62828" }}>{toast}</div>}

      {!editing ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {grouped.map((g) => (
            <div key={g.key}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "#78828c", textTransform: "uppercase", letterSpacing: ".05em" }}>{g.name}</span>
                {!g.published && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: "#eceff1", color: "#607d8b" }}>SECTION HIDDEN</span>}
                <span style={{ fontSize: 12, color: "#b0b6bb" }}>{g.items.length}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {g.items.map((a) => (
                  <button key={a.id} onClick={() => startEdit(toDraft(a))} style={{ textAlign: "left", padding: "10px 12px", border: "1px solid #e0e0e0", borderRadius: 6, background: "#fff", cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 14, color: "#2a2b3c", fontWeight: 500, flex: 1 }}>{a.title}</span>
                    {a.product_fruits_tour_id && <Tag>Tour</Tag>}
                    {a.pdf_url && <Tag>PDF</Tag>}
                    <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10, background: a.published ? "#e8f5e9" : "#fff3e0", color: a.published ? "#2e7d32" : "#e65100" }}>{a.published ? "Published" : "Draft"}</span>
                  </button>
                ))}
                {g.items.length === 0 && <div style={{ fontSize: 13, color: "#b0b6bb", padding: "4px 2px" }}>No articles yet.</div>}
              </div>
            </div>
          ))}
          {articles.length === 0 && cats.length > 0 && <div style={{ color: "#78828c", fontSize: 13 }}>No articles yet.</div>}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <button onClick={() => setEditing(null)} style={{ alignSelf: "flex-start", background: "none", border: "none", color: "#1976d2", cursor: "pointer", fontSize: 13, padding: 0 }}>← Back to list</button>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Title"><input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} style={inp} /></Field>
            <Field label="Category">
              <select value={editing.category_id} onChange={(e) => setEditing({ ...editing, category_id: e.target.value })} style={inp}>
                <option value="">— pick a category —</option>
                {cats.map((c) => <option key={c.id} value={c.id}>{c.name}{c.published ? "" : " (hidden)"}</option>)}
              </select>
            </Field>
            <Field label="Slug (optional — auto from title)"><input value={editing.slug} onChange={(e) => setEditing({ ...editing, slug: e.target.value })} style={inp} /></Field>
            <Field label="Audience">
              <select value={editing.audience} onChange={(e) => setEditing({ ...editing, audience: e.target.value })} style={inp}>
                <option value="dealer">dealer</option><option value="group">group</option><option value="all">all</option>
              </select>
            </Field>
            <Field label="Sort order (within the category)"><input type="number" value={editing.sort_order} onChange={(e) => setEditing({ ...editing, sort_order: Number(e.target.value) })} style={inp} /></Field>
            <Field label="Published">
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, paddingTop: 6 }}>
                <input type="checkbox" checked={editing.published} onChange={(e) => setEditing({ ...editing, published: e.target.checked })} /> Visible to dealers
              </label>
            </Field>
          </div>

          {/* Rich text toolbar + editor */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <div style={{ fontSize: 12, color: "#55595c" }}>Body</div>
              <button onClick={() => setPreview((p) => !p)} style={{ ...btn(preview), fontSize: 12 }}>
                {preview ? "← Back to editing" : "Preview as dealer"}
              </button>
            </div>
            <div style={{ border: "1px solid #e0e0e0", borderRadius: 6, overflow: "hidden" }}>
              {preview ? (
                // Renders through the exact sanitizer the dealer page uses, so
                // anything the allowlist drops is visible here first.
                <div className="help-article-body" style={{ padding: 14, fontSize: 14, lineHeight: 1.65, color: "#33363d", minHeight: 240, background: "#fff" }}
                  dangerouslySetInnerHTML={{ __html: sanitizeHelpHtml(editor?.getHTML() ?? editing.body) }} />
              ) : (
                <>
                  <div style={{ display: "flex", gap: 4, padding: 8, borderBottom: "1px solid #eee", flexWrap: "wrap" }}>
                    <button onClick={() => editor?.chain().focus().toggleBold().run()} style={btn(editor?.isActive("bold") ?? false)}><b>B</b></button>
                    <button onClick={() => editor?.chain().focus().toggleItalic().run()} style={btn(editor?.isActive("italic") ?? false)}><i>I</i></button>
                    <button onClick={() => editor?.chain().focus().toggleUnderline().run()} style={btn(editor?.isActive("underline") ?? false)}><u>U</u></button>
                    <button onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} style={btn(editor?.isActive("heading", { level: 2 }) ?? false)}>H2</button>
                    <button onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()} style={btn(editor?.isActive("heading", { level: 3 }) ?? false)}>H3</button>
                    <button onClick={() => editor?.chain().focus().toggleBulletList().run()} style={btn(editor?.isActive("bulletList") ?? false)}>• List</button>
                    <button onClick={() => editor?.chain().focus().toggleOrderedList().run()} style={btn(editor?.isActive("orderedList") ?? false)}>1. List</button>
                    <span style={{ width: 1, background: "#e0e0e0", margin: "0 2px" }} />
                    <button onClick={() => inlineImgRef.current?.click()} style={btn(false)} title="Place an image in the text">🖼 Image</button>
                    <input ref={inlineImgRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadImage(f, true); e.target.value = ""; }} />
                    <button onClick={embedVideo} style={btn(false)} title="Embed YouTube/Vimeo">▶ Embed</button>
                    <button onClick={() => videoRef.current?.click()} style={btn(false)} title="Upload an MP4/WebM clip">⬆ Video</button>
                    <input ref={videoRef} type="file" accept="video/mp4,video/webm" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadVideo(f); e.target.value = ""; }} />
                  </div>
                  <EditorContent editor={editor} />
                </>
              )}
            </div>
          </div>

          {/* Image attachments (shown as a strip under the article) */}
          <div>
            <div style={{ fontSize: 12, color: "#55595c", marginBottom: 4 }}>Photos (shown below the article)</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              {editing.image_urls.map((u) => (
                <div key={u} style={{ position: "relative" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={u} alt="" style={{ height: 64, borderRadius: 4, border: "1px solid #eee" }} />
                  <button onClick={() => setEditing({ ...editing, image_urls: editing.image_urls.filter((x) => x !== u) })}
                    style={{ position: "absolute", top: -8, right: -8, width: 20, height: 20, borderRadius: 10, border: "none", background: "#c62828", color: "#fff", cursor: "pointer", fontSize: 12 }}>×</button>
                </div>
              ))}
              <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadImage(f, false); e.target.value = ""; }} />
              <button onClick={() => fileRef.current?.click()} style={{ ...btn(false), padding: "8px 12px" }}>+ Upload photo</button>
            </div>
          </div>

          {/* PDF attachment */}
          <div>
            <div style={{ fontSize: 12, color: "#55595c", marginBottom: 4 }}>PDF (optional — dealers can read or download it)</div>
            {editing.pdf_url ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", border: "1px solid #e0e0e0", borderRadius: 6, background: "#fff", maxWidth: 560 }}>
                <span style={{ fontSize: 13, color: "#2a2b3c", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {decodeURIComponent(editing.pdf_url.split("/").pop() ?? "").replace(/^\d{10,}_/, "")}
                </span>
                <a href={editing.pdf_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: "#1976d2", textDecoration: "none", fontWeight: 600 }}>Open</a>
                <button onClick={() => setEditing({ ...editing, pdf_url: "" })} style={{ padding: "5px 10px", border: "1px solid #ffcdd2", borderRadius: 4, background: "#fff", color: "#c62828", cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>Remove</button>
              </div>
            ) : (
              <>
                <input ref={pdfRef} type="file" accept="application/pdf" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadPdf(f); e.target.value = ""; }} />
                <button onClick={() => pdfRef.current?.click()} style={{ ...btn(false), padding: "8px 12px" }}>+ Attach PDF</button>
              </>
            )}
          </div>

          {/* ProductFruits tour */}
          <div>
            <Field label="Product Fruits tour ID (optional)">
              <input value={editing.product_fruits_tour_id}
                onChange={(e) => setEditing({ ...editing, product_fruits_tour_id: e.target.value })}
                placeholder="e.g. 12345" style={{ ...inp, maxWidth: 260 }} />
            </Field>
            <div style={{ fontSize: 12, color: "#78828c", marginTop: 4 }}>
              Adds a <strong>Start tour</strong> button to the article that launches this tour in the app.
              Find the ID in Product Fruits → Tours (leave blank for no tour).
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
            <button onClick={() => void save()} disabled={saving} style={{ ...btn(true), padding: "9px 18px", fontWeight: 600, opacity: saving ? 0.6 : 1 }}>{saving ? "Saving…" : "Save"}</button>
            {editing.id && <button onClick={() => void remove(editing.id)} style={{ padding: "9px 16px", border: "1px solid #ffcdd2", borderRadius: 4, background: "#fff", color: "#c62828", cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>Delete</button>}
          </div>
        </div>
      )}
      </>
      )}
    </div>
  );
}

function bySort(a: Article, b: Article): number {
  return a.sort_order - b.sort_order || a.title.localeCompare(b.title);
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", padding: "2px 7px", borderRadius: 10, background: "#f1f3f5", color: "#78828c" }}>{children}</span>;
}

const inp: React.CSSProperties = { width: "100%", padding: "8px 10px", border: "1px solid #e0e0e0", borderRadius: 6, fontSize: 14, fontFamily: "inherit", boxSizing: "border-box" };
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div style={{ fontSize: 12, color: "#55595c", marginBottom: 4 }}>{label}</div>{children}</div>;
}
