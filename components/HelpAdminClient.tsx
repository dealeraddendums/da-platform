"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { Node, mergeAttributes } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import HelpConversationsClient from "@/components/HelpConversationsClient";

// ── Video blocks ────────────────────────────────────────────────────────────
// A YouTube/Vimeo embed (responsive 16:9 wrapper) and an uploaded clip. These
// produce <iframe>/<video> HTML that the /help renderer re-sanitizes against a
// strict allowlist (lib/help-sanitize) — only YT/Vimeo embeds + our S3 clips
// survive there, so a stray paste can never inject an arbitrary iframe.
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
  title: string;
  body: string;
  image_urls: string[];
  audience: string;
  sort_order: number;
  published: boolean;
  updated_at: string;
};

const EMPTY = { id: "", slug: "", category: "", title: "", body: "", image_urls: [] as string[], audience: "dealer", sort_order: 0, published: false };

export default function HelpAdminClient() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [editing, setEditing] = useState<typeof EMPTY | Article | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"articles" | "conversations">("articles");
  const [initialConvId, setInitialConvId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);

  // Deep links from escalation emails: /help/manage?tab=conversations&id=…
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("tab") === "conversations") setTab("conversations");
    setInitialConvId(sp.get("id"));
  }, []);

  const editor = useEditor({
    extensions: [StarterKit, Underline, VideoEmbed, VideoFile],
    content: "",
    immediatelyRender: false,
    editorProps: { attributes: { style: "min-height:240px;padding:12px;outline:none;font-size:14px;line-height:1.6" } },
  });

  const load = useCallback(async () => {
    const res = await fetch("/api/help/articles?all=1");
    if (res.ok) setArticles((await res.json()).data ?? []);
  }, []);
  useEffect(() => { void load(); }, [load]);

  function startEdit(a: typeof EMPTY | Article) {
    setEditing({ ...a });
    editor?.commands.setContent(a.body || "");
  }

  // From a flagged/escalated conversation: open a new draft article prefilled
  // with the dealer's question + the assistant's last answer to correct.
  function correctIntoKb(draft: { title: string; body: string }) {
    setTab("articles");
    startEdit({ ...EMPTY, title: draft.title, body: draft.body });
  }

  async function uploadImage(file: File) {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/help/articles/upload-image", { method: "POST", body: fd });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setToast(j.error ?? "Upload failed"); return; }
    setEditing((e) => (e ? { ...e, image_urls: [...e.image_urls, j.url] } : e));
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

  async function save() {
    if (!editing) return;
    setSaving(true); setToast(null);
    const payload = { ...editing, body: editor?.getHTML() ?? editing.body };
    const isNew = !("id" in editing) || !editing.id;
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

  return (
    <div style={{ maxWidth: 820 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
        {(["articles", "conversations"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid #e0e0e0", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600, background: tab === t ? "#1976d2" : "#fff", color: tab === t ? "#fff" : "#55595c" }}>
            {t === "articles" ? "Articles" : "Conversations"}
          </button>
        ))}
      </div>

      {tab === "conversations" ? (
        <HelpConversationsClient initialId={initialConvId} onCorrectIntoKb={correctIntoKb} />
      ) : (
      <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: "#2a2b3c", margin: 0 }}>Help Center — Articles</h1>
        {!editing && <button onClick={() => startEdit(EMPTY)} style={{ ...btn(true), padding: "8px 14px", fontWeight: 600 }}>+ New article</button>}
      </div>
      {toast && <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 6, fontSize: 13, background: toast.startsWith("✓") ? "#e8f5e9" : "#ffebee", color: toast.startsWith("✓") ? "#2e7d32" : "#c62828" }}>{toast}</div>}

      {!editing ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {articles.map((a) => (
            <button key={a.id} onClick={() => startEdit(a)} style={{ textAlign: "left", padding: "10px 12px", border: "1px solid #e0e0e0", borderRadius: 6, background: "#fff", cursor: "pointer", fontFamily: "inherit", display: "flex", justifyContent: "space-between", gap: 10 }}>
              <span style={{ fontSize: 14, color: "#2a2b3c" }}><strong>{a.title}</strong> <span style={{ color: "#9aa0a6" }}>· {a.category}</span></span>
              <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10, background: a.published ? "#e8f5e9" : "#fff3e0", color: a.published ? "#2e7d32" : "#e65100" }}>{a.published ? "Published" : "Draft"}</span>
            </button>
          ))}
          {articles.length === 0 && <div style={{ color: "#78828c", fontSize: 13 }}>No articles yet.</div>}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <button onClick={() => setEditing(null)} style={{ alignSelf: "flex-start", background: "none", border: "none", color: "#1976d2", cursor: "pointer", fontSize: 13, padding: 0 }}>← Back to list</button>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Title"><input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} style={inp} /></Field>
            <Field label="Category"><input value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value })} placeholder="Builder, Printing, …" style={inp} /></Field>
            <Field label="Slug (optional — auto from title)"><input value={editing.slug} onChange={(e) => setEditing({ ...editing, slug: e.target.value })} style={inp} /></Field>
            <Field label="Audience">
              <select value={editing.audience} onChange={(e) => setEditing({ ...editing, audience: e.target.value })} style={inp}>
                <option value="dealer">dealer</option><option value="group">group</option><option value="all">all</option>
              </select>
            </Field>
            <Field label="Sort order"><input type="number" value={editing.sort_order} onChange={(e) => setEditing({ ...editing, sort_order: Number(e.target.value) })} style={inp} /></Field>
            <Field label="Published">
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, paddingTop: 6 }}>
                <input type="checkbox" checked={editing.published} onChange={(e) => setEditing({ ...editing, published: e.target.checked })} /> Visible to dealers
              </label>
            </Field>
          </div>

          {/* Rich text toolbar + editor */}
          <div>
            <div style={{ fontSize: 12, color: "#55595c", marginBottom: 4 }}>Body</div>
            <div style={{ border: "1px solid #e0e0e0", borderRadius: 6, overflow: "hidden" }}>
              <div style={{ display: "flex", gap: 4, padding: 8, borderBottom: "1px solid #eee", flexWrap: "wrap" }}>
                <button onClick={() => editor?.chain().focus().toggleBold().run()} style={btn(editor?.isActive("bold") ?? false)}><b>B</b></button>
                <button onClick={() => editor?.chain().focus().toggleItalic().run()} style={btn(editor?.isActive("italic") ?? false)}><i>I</i></button>
                <button onClick={() => editor?.chain().focus().toggleUnderline().run()} style={btn(editor?.isActive("underline") ?? false)}><u>U</u></button>
                <button onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} style={btn(editor?.isActive("heading", { level: 2 }) ?? false)}>H2</button>
                <button onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()} style={btn(editor?.isActive("heading", { level: 3 }) ?? false)}>H3</button>
                <button onClick={() => editor?.chain().focus().toggleBulletList().run()} style={btn(editor?.isActive("bulletList") ?? false)}>• List</button>
                <button onClick={() => editor?.chain().focus().toggleOrderedList().run()} style={btn(editor?.isActive("orderedList") ?? false)}>1. List</button>
                <span style={{ width: 1, background: "#e0e0e0", margin: "0 2px" }} />
                <button onClick={embedVideo} style={btn(false)} title="Embed YouTube/Vimeo">▶ Embed</button>
                <button onClick={() => videoRef.current?.click()} style={btn(false)} title="Upload an MP4/WebM clip">⬆ Video</button>
                <input ref={videoRef} type="file" accept="video/mp4,video/webm" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadVideo(f); e.target.value = ""; }} />
              </div>
              <EditorContent editor={editor} />
            </div>
          </div>

          {/* Image attachments */}
          <div>
            <div style={{ fontSize: 12, color: "#55595c", marginBottom: 4 }}>Images (shown below the article)</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              {editing.image_urls.map((u) => (
                <div key={u} style={{ position: "relative" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={u} alt="" style={{ height: 64, borderRadius: 4, border: "1px solid #eee" }} />
                  <button onClick={() => setEditing({ ...editing, image_urls: editing.image_urls.filter((x) => x !== u) })}
                    style={{ position: "absolute", top: -8, right: -8, width: 20, height: 20, borderRadius: 10, border: "none", background: "#c62828", color: "#fff", cursor: "pointer", fontSize: 12 }}>×</button>
                </div>
              ))}
              <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadImage(f); e.target.value = ""; }} />
              <button onClick={() => fileRef.current?.click()} style={{ ...btn(false), padding: "8px 12px" }}>+ Upload image</button>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
            <button onClick={() => void save()} disabled={saving} style={{ ...btn(true), padding: "9px 18px", fontWeight: 600, opacity: saving ? 0.6 : 1 }}>{saving ? "Saving…" : "Save"}</button>
            {"id" in editing && editing.id && <button onClick={() => void remove(editing.id)} style={{ padding: "9px 16px", border: "1px solid #ffcdd2", borderRadius: 4, background: "#fff", color: "#c62828", cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>Delete</button>}
          </div>
        </div>
      )}
      </>
      )}
    </div>
  );
}

const inp: React.CSSProperties = { width: "100%", padding: "8px 10px", border: "1px solid #e0e0e0", borderRadius: 6, fontSize: 14, fontFamily: "inherit", boxSizing: "border-box" };
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div style={{ fontSize: 12, color: "#55595c", marginBottom: 4 }}>{label}</div>{children}</div>;
}
