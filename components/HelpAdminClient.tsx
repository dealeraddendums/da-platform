"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { Node, mergeAttributes } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import HelpConversationsClient from "@/components/HelpConversationsClient";
import HelpCategoriesClient, { type HelpCategory } from "@/components/HelpCategoriesClient";
import { useCollapsedSections, chevronStyle } from "@/lib/use-collapsed-sections";
import HelpArticleBody, { type JwConfig } from "@/components/HelpArticleBody";

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

// A JW-hosted video. Stored as an inert placeholder — `<div data-jw-media="id">`
// — NOT a player embed or a <script>, so the article body needs no new
// allowance in the strict sanitizer (lib/help-sanitize). The player is mounted
// onto the placeholder at render time by lib/jw-embed.
const JwVideo = Node.create({
  name: "jwVideo",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() { return { mediaId: { default: null, parseHTML: (el) => el.getAttribute("data-jw-media"), renderHTML: (a) => ({ "data-jw-media": a.mediaId }) } }; },
  parseHTML() { return [{ tag: "div[data-jw-media]" }]; },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { class: "jw-video" })];
  },
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

export default function HelpAdminClient({ jw }: { jw: JwConfig }) {
  const [articles, setArticles] = useState<Article[]>([]);
  const [cats, setCats] = useState<HelpCategory[]>([]);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const [tab, setTab] = useState<Tab>("articles");
  const [initialConvId, setInitialConvId] = useState<string | null>(null);
  const { isCollapsed, toggle } = useCollapsedSections("da.helpAdmin.collapsedCategories");
  const [rewriting, setRewriting] = useState(false);
  /** Body HTML from before the last AI rewrite — lets the author back out of one. */
  const [preRewrite, setPreRewrite] = useState<string | null>(null);
  /** JW upload: null when idle, otherwise the live phase for the progress row. */
  const [upload, setUpload] = useState<{ phase: "starting" | "uploading" | "processing"; pct: number; via?: "direct" | "proxy" } | null>(null);
  /** mediaId → transcode status, so a just-uploaded video can flip Processing → Ready. */
  const [mediaStatus, setMediaStatus] = useState<Record<string, "processing" | "ready" | "failed">>({});
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
    extensions: [StarterKit, Underline, VideoEmbed, VideoFile, InlineImage, JwVideo],
    content: "",
    immediatelyRender: false,
    // White editing surface with dark text, like the Title/Slug inputs — the
    // body sits on the blue app background and was inheriting it.
    editorProps: { attributes: { class: "help-article-body", style: "min-height:240px;padding:12px;outline:none;font-size:14px;line-height:1.6;background:#fff;color:#333" } },
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
    setPreRewrite(null);
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

  /**
   * Upload a video to JW straight from the editor.
   *
   * The server signs the media-create call (the JW secret never reaches the
   * browser) and hands back JW's own pre-authorized S3 URL; the bytes then go
   * BROWSER → JW directly, so a 500 MB screencast never passes through our app
   * server. Whether that S3 bucket accepts a cross-origin PUT from our origin
   * is JW's configuration and isn't documented, so an opaque failure retries
   * once through our streaming proxy rather than dead-ending the author.
   */
  async function uploadVideoToJw(file: File) {
    if (!jw.configured) { setToast("Video upload isn't configured yet — JW credentials are missing."); return; }
    if (file.size > 2 * 1024 * 1024 * 1024) { setToast("Video must be under 2 GB."); return; }

    setToast(null);
    setUpload({ phase: "starting", pct: 0 });
    try {
      const initRes = await fetch("/api/help/jw/upload-init", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, mimeType: file.type, size: file.size, title: editing?.title || file.name }),
      });
      const init = await initRes.json().catch(() => ({}));
      if (!initRes.ok || !init.mediaId || !init.uploadLink) {
        setUpload(null); setToast(init.error ?? "Couldn't start the upload."); return;
      }

      setUpload({ phase: "uploading", pct: 0, via: "direct" });
      const onProgress = (pct: number) => setUpload((u) => (u ? { ...u, pct } : u));
      let ok = await putWithProgress(init.uploadLink, file, onProgress);
      if (!ok) {
        // Direct PUT gave an opaque failure — almost always CORS on JW's bucket.
        setUpload({ phase: "uploading", pct: 0, via: "proxy" });
        ok = await putWithProgress(`/api/help/jw/upload-proxy?to=${encodeURIComponent(init.uploadLink)}`, file, onProgress, "POST");
      }
      if (!ok) { setUpload(null); setToast("The upload to JW failed. Nothing was added to the article."); return; }

      // The id goes into the article NOW, so a finished upload can't be lost.
      editor?.chain().focus().insertContent({ type: "jwVideo", attrs: { mediaId: init.mediaId } }).run();
      setMediaStatus((m) => ({ ...m, [init.mediaId]: "processing" }));
      setUpload({ phase: "processing", pct: 100 });
      setToast("✓ Uploaded. JW is processing it — Save the article; it plays once processing finishes.");
      void pollMediaStatus(init.mediaId);
      window.setTimeout(() => setUpload((u) => (u?.phase === "processing" ? null : u)), 6000);
    } catch {
      setUpload(null);
      setToast("The upload failed. Nothing was added to the article.");
    }
  }

  /** Watch a freshly uploaded item until JW finishes transcoding (~a few minutes). */
  async function pollMediaStatus(mediaId: string) {
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 10000));
      try {
        const r = await fetch(`/api/help/jw/status/${mediaId}`);
        if (!r.ok) continue;
        const { status } = await r.json();
        if (status === "ready") { setMediaStatus((m) => ({ ...m, [mediaId]: "ready" })); return; }
        if (status === "failed") { setMediaStatus((m) => ({ ...m, [mediaId]: "failed" })); return; }
      } catch { /* keep waiting — a blip isn't a failure */ }
    }
  }

  /** Paste an id for a video already in the JW account. */
  function insertExistingMedia() {
    const raw = prompt("Paste a JW media ID (8 characters):");
    if (!raw) return;
    const id = raw.trim();
    if (!/^[A-Za-z0-9]{8}$/.test(id)) { setToast("That doesn't look like a JW media ID (8 letters/numbers)."); return; }
    editor?.chain().focus().insertContent({ type: "jwVideo", attrs: { mediaId: id } }).run();
    setMediaStatus((m) => ({ ...m, [id]: "ready" }));
    setToast("✓ Video added.");
  }

  /**
   * Clean up the body with Claude. The result lands IN the editor for review —
   * nothing is persisted until Save — and the previous HTML is held so a rewrite
   * the author doesn't like is one click away from undone.
   */
  async function rewriteBody() {
    if (!editing || rewriting) return;
    const current = editor?.getHTML() ?? editing.body;
    setRewriting(true); setToast(null);
    try {
      const res = await fetch("/api/ai-content/help-article", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html: current, title: editing.title }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.html) { setToast(j.error ?? "Rewrite failed — your text is unchanged."); return; }
      setPreRewrite(current);
      // setContent parses against the editor schema, so anything it doesn't
      // support is dropped here rather than reaching a dealer.
      editor?.commands.setContent(j.html);
      setToast("✓ Rewritten — read it over, then Save (or Undo rewrite).");
    } catch {
      setToast("Rewrite failed — your text is unchanged.");
    } finally {
      setRewriting(false);
    }
  }

  function undoRewrite() {
    if (preRewrite === null) return;
    editor?.commands.setContent(preRewrite);
    setPreRewrite(null);
    setToast("Rewrite undone.");
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
        <h1 style={{ fontSize: 20, fontWeight: 700, color: "#fff", margin: 0 }}>Help Center — Articles</h1>
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
          {grouped.map((g) => {
            const expanded = !isCollapsed(g.key);
            return (
              <div key={g.key}>
                {/* This list renders straight onto the blue app background
                    (--bg-app #3a6897), so the section title is white — the muted
                    grey used inside white cards is unreadable here. */}
                <button onClick={() => toggle(g.key)} aria-expanded={expanded}
                  style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", background: "none", border: "none", padding: "4px 2px", marginBottom: 8, cursor: "pointer", fontFamily: "inherit" }}>
                  <span aria-hidden style={{ ...chevronStyle(expanded), fontSize: 11, color: "#fff" }}>▶</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#fff", textTransform: "uppercase", letterSpacing: ".05em" }}>{g.name}</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.75)" }}>{g.items.length}</span>
                  {!g.published && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: "rgba(255,255,255,0.18)", color: "#fff" }}>SECTION HIDDEN</span>}
                </button>
                {expanded && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {g.items.map((a) => (
                      <button key={a.id} onClick={() => startEdit(toDraft(a))} style={{ textAlign: "left", padding: "10px 12px", border: "1px solid #e0e0e0", borderRadius: 6, background: "#fff", cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: 14, color: "#2a2b3c", fontWeight: 500, flex: 1 }}>{a.title}</span>
                        {a.product_fruits_tour_id && <Tag>Tour</Tag>}
                        {a.pdf_url && <Tag>PDF</Tag>}
                        <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10, background: a.published ? "#e8f5e9" : "#fff3e0", color: a.published ? "#2e7d32" : "#e65100" }}>{a.published ? "Published" : "Draft"}</span>
                      </button>
                    ))}
                    {g.items.length === 0 && <div style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", padding: "4px 2px" }}>No articles yet.</div>}
                  </div>
                )}
              </div>
            );
          })}
          {articles.length === 0 && cats.length > 0 && <div style={{ color: "#78828c", fontSize: 13 }}>No articles yet.</div>}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <button onClick={() => setEditing(null)} style={{ alignSelf: "flex-start", background: "none", border: "none", color: "#fff", fontWeight: 600, cursor: "pointer", fontSize: 13, padding: 0, textDecoration: "underline" }}>← Back to list</button>
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
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, paddingTop: 6, color: "#fff" }}>
                <input type="checkbox" checked={editing.published} onChange={(e) => setEditing({ ...editing, published: e.target.checked })} /> Visible to dealers
              </label>
            </Field>
          </div>

          {/* Rich text toolbar + editor */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <div style={fieldLabel}>Body</div>
              <button onClick={() => setPreview((p) => !p)} style={{ ...btn(preview), fontSize: 12 }}>
                {preview ? "← Back to editing" : "Preview as dealer"}
              </button>
            </div>
            <div style={{ border: "1px solid #e0e0e0", borderRadius: 6, overflow: "hidden", background: "#fff" }}>
              {preview ? (
                // Renders through the exact sanitizer the dealer page uses, so
                // anything the allowlist drops is visible here first.
                <HelpArticleBody html={editor?.getHTML() ?? editing.body} jw={jw}
                  style={{ padding: 14, fontSize: 14, lineHeight: 1.65, color: "#33363d", minHeight: 240, background: "#fff" }} />
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
                    <button onClick={() => videoRef.current?.click()} disabled={!!upload || !jw.configured}
                      style={{ ...btn(false), opacity: upload || !jw.configured ? 0.55 : 1, cursor: upload ? "wait" : jw.configured ? "pointer" : "not-allowed" }}
                      title={jw.configured ? "Upload a video — it is hosted and streamed by JW Player" : "JW Player credentials aren't configured yet"}>
                      ⬆ Upload video
                    </button>
                    <button onClick={insertExistingMedia} disabled={!jw.configured}
                      style={{ ...btn(false), opacity: jw.configured ? 1 : 0.55 }} title="Paste the ID of a video already in JW Player">
                      JW ID
                    </button>
                    <input ref={videoRef} type="file" accept="video/mp4,video/webm,video/quicktime" style={{ display: "none" }}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadVideoToJw(f); e.target.value = ""; }} />
                    <span style={{ width: 1, background: "#e0e0e0", margin: "0 2px" }} />
                    <button onClick={() => void rewriteBody()} disabled={rewriting} style={{ ...btn(false), opacity: rewriting ? 0.6 : 1, cursor: rewriting ? "wait" : "pointer" }} title="Clean up this text with AI">
                      {rewriting ? "✨ Rewriting…" : "✨ Rewrite"}
                    </button>
                    {preRewrite !== null && (
                      <button onClick={undoRewrite} style={{ ...btn(false), color: "#c62828", borderColor: "#ffcdd2" }} title="Put the previous text back">
                        ↩ Undo rewrite
                      </button>
                    )}
                  </div>
                  {upload && (
                    <div style={{ padding: "10px 12px", borderBottom: "1px solid #eee", background: "#f7fbff" }}>
                      <div style={{ fontSize: 12, color: "#33363d", marginBottom: 6 }}>
                        {upload.phase === "starting" && "Preparing the upload…"}
                        {upload.phase === "uploading" && `Uploading to JW Player… ${upload.pct}%${upload.via === "proxy" ? " (via the server)" : ""}`}
                        {upload.phase === "processing" && "Uploaded — JW is processing it. Playable in a few minutes."}
                      </div>
                      <div style={{ height: 6, borderRadius: 3, background: "#e3eaf2", overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${upload.phase === "starting" ? 3 : upload.pct}%`, background: "#1976d2", transition: "width 150ms" }} />
                      </div>
                    </div>
                  )}
                  {Object.entries(mediaStatus).filter(([, st]) => st !== "ready").length > 0 && !upload && (
                    <div style={{ padding: "8px 12px", borderBottom: "1px solid #eee", background: "#fff8e1", fontSize: 12, color: "#7a5c00" }}>
                      {Object.entries(mediaStatus).filter(([, st]) => st !== "ready").map(([id, st]) => (
                        <div key={id}>
                          {st === "failed"
                            ? `Video ${id} failed to process in JW Player.`
                            : `Video ${id} is still processing — it will play once JW finishes.`}
                        </div>
                      ))}
                    </div>
                  )}
                  <EditorContent editor={editor} />
                </>
              )}
            </div>
          </div>

          {/* Image attachments (shown as a strip under the article) */}
          <div>
            <div style={fieldLabel}>Photos (shown below the article)</div>
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
            <div style={fieldLabel}>PDF (optional — dealers can read or download it)</div>
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
            <div style={{ ...helpText, marginTop: 4 }}>
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

/**
 * PUT/POST a file with a progress callback. XHR rather than fetch because fetch
 * still has no upload-progress event, and a 500 MB upload with no feedback
 * looks like a hang.
 *
 * Returns false instead of throwing on failure: a cross-origin PUT that the
 * target rejects surfaces as status 0 with no detail, which is exactly the case
 * the proxy retry exists for, and it is not an exceptional condition here.
 */
function putWithProgress(
  url: string,
  file: File,
  onProgress: (pct: number) => void,
  method: "PUT" | "POST" = "PUT",
): Promise<boolean> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
    xhr.onerror = () => resolve(false);
    xhr.onabort = () => resolve(false);
    xhr.send(file);
  });
}

function bySort(a: Article, b: Article): number {
  return a.sort_order - b.sort_order || a.title.localeCompare(b.title);
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", padding: "2px 7px", borderRadius: 10, background: "#f1f3f5", color: "#78828c" }}>{children}</span>;
}

const inp: React.CSSProperties = { width: "100%", padding: "8px 10px", border: "1px solid #e0e0e0", borderRadius: 6, fontSize: 14, fontFamily: "inherit", boxSizing: "border-box" };
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div style={fieldLabel}>{label}</div>{children}</div>;
}

// The editor form renders straight onto the blue app background (--bg-app
// #3a6897), so labels and helper text are white — the muted greys used inside
// white cards are unreadable here. Same treatment as the category titles.
const fieldLabel: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: "#fff", marginBottom: 4 };
const helpText: React.CSSProperties = { fontSize: 12, color: "rgba(255,255,255,0.8)" };
