"use client";

// DA-CRM email editor (templates, signatures; Phase 2 compose). TipTap with
// only what renders reliably in Outlook: bold / italic / underline, bullet +
// numbered lists, links, inline images (uploaded to S3 — never base64) and
// {{variable}} insertion. The server re-sanitizes and inlines Outlook styles
// at send time (lib/crm/email-html.ts), so this only has to stay simple.

import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Node } from "@tiptap/core";
import { useEffect, useRef, useState } from "react";
import { TEMPLATE_VARIABLES } from "@/lib/crm/template-vars";

// Same minimal inline image node as components/RichTextEditor (no new dependency).
const InlineImage = Node.create({
  name: "image",
  inline: true,
  group: "inline",
  draggable: true,
  addAttributes() {
    return { src: { default: null }, alt: { default: null }, width: { default: null }, height: { default: null }, style: { default: null } };
  },
  parseHTML() { return [{ tag: "img[src]" }]; },
  renderHTML({ HTMLAttributes }) { return ["img", HTMLAttributes]; },
});

const tb = (active: boolean): React.CSSProperties => ({
  height: 26, minWidth: 26, padding: "0 7px", fontSize: 12, fontWeight: 600, fontFamily: "inherit",
  border: "1px solid transparent", borderRadius: 6, cursor: "pointer",
  background: active ? "var(--bg-subtle)" : "transparent", color: "var(--text-primary)",
  display: "inline-flex", alignItems: "center", justifyContent: "center",
});

export default function EmailEditor({
  value, onChange, minHeight = 220, variables = true, disabled = false,
}: {
  value: string;
  onChange: (html: string) => void;
  minHeight?: number;
  /** Show the {{variable}} picker (off for signatures). */
  variables?: boolean;
  disabled?: boolean;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        code: false, codeBlock: false, strike: false,
        link: {
          openOnClick: false, autolink: true, defaultProtocol: "https", HTMLAttributes: { target: "_blank", rel: "noopener" },
          // {{company.website}}-style targets are filled at send time.
          isAllowedUri: (url, { defaultValidate }) => /^\{\{[^{}]+\}\}$/.test(url) || defaultValidate(url),
        },
      }),
      InlineImage,
    ],
    content: value || "",
    editable: !disabled,
    immediatelyRender: false,
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      onChange(html === "<p></p>" ? "" : html);
    },
  });

  useEffect(() => {
    if (!editor) return;
    const cur = editor.getHTML();
    if ((value || "") !== (cur === "<p></p>" ? "" : cur)) editor.commands.setContent(value || "", { emitUpdate: false });
  }, [value, editor]);

  useEffect(() => { editor?.setEditable(!disabled); }, [disabled, editor]);

  if (!editor) return <div style={{ minHeight, border: "1px solid var(--border-strong)", borderRadius: 8, background: "#fff" }} />;

  return (
    <div style={{ border: "1px solid var(--border-strong)", borderRadius: 8, background: "#fff", overflow: "hidden" }}>
      {!disabled && <Toolbar editor={editor} variables={variables} />}
      <EditorContent editor={editor} className="crm-email-editor" style={{ minHeight, padding: "10px 12px", fontFamily: "Arial, Helvetica, sans-serif", fontSize: 14 }} />
      <style>{`
        .crm-email-editor .ProseMirror { outline: none; min-height: ${minHeight - 20}px; }
        .crm-email-editor .ProseMirror p { margin: 0 0 12px; }
        .crm-email-editor .ProseMirror ul, .crm-email-editor .ProseMirror ol { margin: 0 0 12px; padding-left: 24px; }
        .crm-email-editor .ProseMirror ul { list-style: disc; }
        .crm-email-editor .ProseMirror ol { list-style: decimal; }
        .crm-email-editor .ProseMirror a { color: #1976d2; text-decoration: underline; }
        .crm-email-editor .ProseMirror img { max-width: 100%; }
        .crm-email-editor .ProseMirror h2 { font-size: 18px; font-weight: 700; margin: 0 0 12px; }
        .crm-email-editor .ProseMirror h3 { font-size: 16px; font-weight: 700; margin: 0 0 12px; }
      `}</style>
    </div>
  );
}

function Toolbar({ editor, variables }: { editor: Editor; variables: boolean }) {
  const file = useRef<HTMLInputElement>(null);
  const [varOpen, setVarOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function setLink() {
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link address (https://…, mailto:… or {{company.website}})", prev ?? "https://");
    if (url === null) return;
    if (!url.trim() || url.trim() === "https://") { editor.chain().focus().extendMarkRange("link").unsetLink().run(); return; }
    if (!/^(https?:\/\/|mailto:|tel:|\{\{)/i.test(url.trim())) { setErr("Links must start with https://, mailto: or tel:"); return; }
    setErr(null);
    editor.chain().focus().extendMarkRange("link").setLink({ href: url.trim() }).run();
  }

  async function upload(f: File) {
    setBusy(true);
    setErr(null);
    const fd = new FormData();
    fd.append("file", f);
    const res = await fetch("/api/crm/email-images", { method: "POST", body: fd });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(j.error ?? "Upload failed"); return; }
    // Explicit width: Outlook ignores CSS max-width.
    const width = await new Promise<number>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(Math.min(img.naturalWidth || 600, 600));
      img.onerror = () => resolve(600);
      img.src = URL.createObjectURL(f);
    });
    editor.chain().focus().insertContent({ type: "image", attrs: { src: j.url, alt: f.name.replace(/\.[a-z]+$/i, ""), width: String(width) } }).run();
  }

  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center", padding: 6, borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)", borderRadius: "6px 6px 0 0", position: "relative" }}>
      <button type="button" style={{ ...tb(editor.isActive("bold")), fontWeight: 800 }} title="Bold" onClick={() => editor.chain().focus().toggleBold().run()}>B</button>
      <button type="button" style={{ ...tb(editor.isActive("italic")), fontStyle: "italic" }} title="Italic" onClick={() => editor.chain().focus().toggleItalic().run()}>I</button>
      <button type="button" style={{ ...tb(editor.isActive("underline")), textDecoration: "underline" }} title="Underline" onClick={() => editor.chain().focus().toggleUnderline().run()}>U</button>
      <span style={{ width: 1, height: 18, background: "var(--border)", margin: "0 2px" }} />
      <button type="button" style={tb(editor.isActive("bulletList"))} title="Bulleted list" onClick={() => editor.chain().focus().toggleBulletList().run()}>•</button>
      <button type="button" style={tb(editor.isActive("orderedList"))} title="Numbered list" onClick={() => editor.chain().focus().toggleOrderedList().run()}>1.</button>
      <button type="button" style={tb(editor.isActive("heading", { level: 3 }))} title="Heading" onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>H</button>
      <span style={{ width: 1, height: 18, background: "var(--border)", margin: "0 2px" }} />
      <button type="button" style={tb(editor.isActive("link"))} title="Link" onClick={setLink}>Link</button>
      <button type="button" style={tb(false)} title="Insert image" disabled={busy} onClick={() => file.current?.click()}>{busy ? "…" : "Image"}</button>
      <input ref={file} type="file" accept="image/png,image/jpeg,image/gif" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
      <button type="button" style={tb(false)} title="Clear formatting" onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}>Clear</button>
      {variables && (
        <>
          <span style={{ width: 1, height: 18, background: "var(--border)", margin: "0 2px" }} />
          <button type="button" style={tb(varOpen)} onClick={() => setVarOpen((o) => !o)}>{"{{ }}"} Variable</button>
          {varOpen && (
            <div className="card" style={{ position: "absolute", top: 36, left: 6, zIndex: 20, width: 320, maxHeight: 320, overflowY: "auto", padding: 8 }}>
              {TEMPLATE_VARIABLES.map((g) => (
                <div key={g.group} style={{ marginBottom: 6 }}>
                  <p className="label" style={{ margin: "4px 0" }}>{g.label}</p>
                  {g.vars.map((v) => (
                    <button key={v.key} type="button" onClick={() => { editor.chain().focus().insertContent(`{{${v.key}}}`).run(); setVarOpen(false); }}
                      style={{ display: "flex", justifyContent: "space-between", width: "100%", gap: 8, padding: "4px 6px", border: "none", background: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12, textAlign: "left" }}>
                      <span>{v.label}</span><code style={{ color: "var(--text-muted)" }}>{`{{${v.key}}}`}</code>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {err && <span style={{ fontSize: 12, color: "var(--error)", marginLeft: 6 }}>{err}</span>}
    </div>
  );
}
