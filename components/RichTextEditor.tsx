"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { Mark, Extension, Node, type Editor } from "@tiptap/core";
import { useEffect, useRef, useState } from "react";
import { normalizeProductHtmlSource } from "@/lib/product-name";
import { cleanProductDescription, type DescriptionFlag } from "@/lib/product-description-clean";

const LINE_HEIGHT_TYPES = ["paragraph", "heading", "listItem"] as const;
const LINE_HEIGHT_MIN = 0.8;
const LINE_HEIGHT_MAX = 3.0;
const LINE_HEIGHT_DEFAULT = 1.2;

const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20];
const COLORS: { hex: string; label: string }[] = [
  { hex: "#000000", label: "Black" },
  { hex: "#ffffff", label: "White" },
  { hex: "#c62828", label: "Red" },
  { hex: "#ef6c00", label: "Orange" },
  { hex: "#1976d2", label: "Blue" },
  { hex: "#1a237e", label: "Dark Blue" },
  { hex: "#2e7d32", label: "Green" },
  { hex: "#78828c", label: "Gray" },
];

const LineHeight = Extension.create({
  name: "lineHeight",
  addGlobalAttributes() {
    return [{
      types: [...LINE_HEIGHT_TYPES],
      attributes: {
        lineHeight: {
          default: null,
          parseHTML: (el: HTMLElement) => el.style.lineHeight || null,
          renderHTML: (attrs: Record<string, unknown>) => {
            const lh = attrs.lineHeight as string | null | undefined;
            if (!lh) return {};
            return { style: `line-height: ${lh}` };
          },
        },
      },
    }];
  },
  addCommands() {
    return {
      setLineHeight: (lh: string | null) => ({ commands }: { commands: { updateAttributes: (t: string, a: Record<string, unknown>) => boolean } }) => {
        return LINE_HEIGHT_TYPES.every(t => commands.updateAttributes(t, { lineHeight: lh }));
      },
    } as unknown as Record<string, () => () => boolean>;
  },
});

const FontSize = Mark.create({
  name: "fontSize",
  addOptions() { return { types: ["textStyle"] }; },
  addGlobalAttributes() {
    return [{
      types: ["textStyle"],
      attributes: {
        fontSize: {
          default: null,
          parseHTML: (el: HTMLElement) => el.style.fontSize?.replace(/['"]+/g, "") || null,
          renderHTML: (attrs: Record<string, unknown>) => {
            const size = attrs.fontSize as string | null | undefined;
            if (!size) return {};
            return { style: `font-size: ${size}` };
          },
        },
      },
    }];
  },
  addCommands() {
    return {
      setFontSize: (size: string | null) => ({ chain }: { chain: () => { setMark: (n: string, a: Record<string, unknown>) => { run: () => boolean; removeEmptyTextStyle?: () => { run: () => boolean } } } }) => {
        const c = chain().setMark("textStyle", { fontSize: size });
        return c.run();
      },
    } as unknown as Record<string, () => () => boolean>;
  },
});

function looksLikeHtml(s: string): boolean {
  return /<[a-z][^>]*>/i.test(s);
}

// Paste goes through the same converter as the 2026-10-23 description cleanup
// (lib/product-description-clean.ts), so pasted Word / web / 4.0 HTML lands in
// the editor's own format instead of carrying styles, <div>s or entity-escaped
// tag source the printer can't use. Flags that mean something the person can
// see was dropped trigger the "Formatting removed" note.
const VISIBLE_LOSS: DescriptionFlag[] = [
  "style-trimmed", "dropped-blocks", "table", "heading", "link", "image-dropped",
  "script-or-style", "unknown-tag", "escaped-markup", "double-encoded", "nbsp",
];
// Clipboard wrappers every browser / Office adds — not the person's formatting.
function stripClipboardWrapper(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<!--(?:StartFragment|EndFragment)-->/gi, "")
    .replace(/<\/?(?:html|body|meta|xml)\b[^>]*>/gi, "");
}
function cleanPaste(html: string): { html: string; lossy: boolean } {
  const r = cleanProductDescription(stripClipboardWrapper(html));
  return { html: r.html, lossy: r.flags.some((f) => VISIBLE_LOSS.includes(f)) };
}
// Plain-text paste that is really HTML source ("<li>Paint</li>", "&lt;b&gt;…").
const HTML_SOURCE = /<\/?(?:p|br|b|strong|i|em|u|span|div|ul|ol|li|font|h[1-6])\b[^>]*>|&lt;\/?(?:p|br|b|strong|i|em|u|span|div|ul|ol|li)\b/i;

function toEditorContent(value: string): string {
  if (!value) return "";
  // Load the NORMALIZED value: a stored description whose markup is entity-
  // escaped (legacy-ETL rows, or HTML source an operator pasted in) has no
  // real tag, so the plain-text branch below escaped it again and the editor
  // showed tag source — which is how a mixed real/escaped value got made in
  // the first place. Normalizing here means the operator sees the formatting,
  // and a re-save stores real markup (the row self-heals on next edit).
  const src = normalizeProductHtmlSource(value);
  if (looksLikeHtml(src)) return src;
  const escaped = src.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<p>${escaped.replace(/\n/g, "<br/>")}</p>`;
}

// Inline <img> support. StarterKit has no image node, so a product image
// inserted by the "Add image to description" picker was dropped the moment
// Tiptap parsed the document — it never appeared, and the next keystroke
// re-serialized the doc without it, silently discarding the insert. Declared
// here as a minimal inline node rather than pulling in @tiptap/extension-image
// (no new dependency): src/alt/width/style round-trip verbatim, which is
// exactly the tag the picker writes, and the render allowlist in
// lib/product-name.tsx remains the gatekeeper for what actually prints.
const InlineImage = Node.create({
  name: "image",
  inline: true,
  group: "inline",
  draggable: true,
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      title: { default: null },
      width: { default: null },
      height: { default: null },
      style: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: "img[src]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["img", HTMLAttributes];
  },
});

const tbBtn = (active: boolean): React.CSSProperties => ({
  height: 26, minWidth: 26, padding: "0 6px", fontSize: 12, fontWeight: 600,
  border: "1px solid #e0e0e0", borderRadius: 6,
  background: active ? "#1976d2" : "#fff", color: active ? "#fff" : "#333",
  cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center",
});

export default function RichTextEditor({
  value,
  onChange,
  placeholder,
  disabled,
  minHeight = 64,
  toolbarOpen = false,
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  disabled?: boolean;
  minHeight?: number;
  toolbarOpen?: boolean;
}) {
  const [colorOpen, setColorOpen] = useState(false);
  const [pasteNote, setPasteNote] = useState(false);
  const pasteNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flagPasteLoss = () => {
    setPasteNote(true);
    if (pasteNoteTimer.current) clearTimeout(pasteNoteTimer.current);
    pasteNoteTimer.current = setTimeout(() => setPasteNote(false), 3000);
  };
  useEffect(() => () => { if (pasteNoteTimer.current) clearTimeout(pasteNoteTimer.current); }, []);
  // handlePaste is configured before useEditor returns the instance.
  const editorRef = useRef<Editor | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      TextStyle,
      Color.configure({ types: ["textStyle"] }),
      FontSize,
      LineHeight,
      InlineImage,
    ],
    content: toEditorContent(value),
    editable: !disabled,
    immediatelyRender: false,
    editorProps: {
      transformPastedHTML: (html) => {
        // Copy/paste inside a TipTap editor is already editor HTML, and its
        // data-pm-slice marker is what keeps a partial-line paste inline.
        if (/data-pm-slice/.test(html)) return html;
        const r = cleanPaste(html);
        if (r.lossy) flagPasteLoss();
        return r.html;
      },
      handlePaste: (_view, event) => {
        const dt = event.clipboardData;
        if (!dt || dt.types.includes("text/html")) return false;   // HTML goes through transformPastedHTML
        const text = dt.getData("text/plain");
        if (!text || !HTML_SOURCE.test(text)) return false;          // ordinary text: default paste
        const r = cleanPaste(text);
        if (r.lossy) flagPasteLoss();
        editorRef.current?.chain().focus().insertContent(r.html).run();
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      // Tiptap returns "<p></p>" for an empty doc — normalize to "" so saves stay clean.
      onChange(html === "<p></p>" ? "" : html);
    },
  });

  editorRef.current = editor;

  // Keep external value updates (e.g. AI Generate) in sync without remounting.
  useEffect(() => {
    if (!editor) return;
    const current = editor.getHTML();
    const next = toEditorContent(value);
    const normalizedCurrent = current === "<p></p>" ? "" : current;
    if (next !== normalizedCurrent && next !== current) {
      editor.commands.setContent(next, { emitUpdate: false });
    }
  }, [value, editor]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [disabled, editor]);

  if (!editor) {
    return <div style={{ height: minHeight, border: "1px solid #e0e0e0", borderRadius: 6, background: "#fff" }} />;
  }

  const currentSize = editor.getAttributes("textStyle").fontSize as string | undefined;

  function readCurrentLineHeight(): number {
    for (const t of LINE_HEIGHT_TYPES) {
      const v = editor!.getAttributes(t).lineHeight as string | undefined;
      if (v) {
        const n = parseFloat(v);
        if (!Number.isNaN(n)) return n;
      }
    }
    return LINE_HEIGHT_DEFAULT;
  }
  const currentLh = readCurrentLineHeight();
  const adjustLh = (delta: number) => {
    const next = Math.round(Math.max(LINE_HEIGHT_MIN, Math.min(LINE_HEIGHT_MAX, currentLh + delta)) * 10) / 10;
    if (next === currentLh) return;
    const cmd = editor!.chain().focus() as unknown as { setLineHeight: (s: string | null) => { run: () => boolean } };
    cmd.setLineHeight(String(next)).run();
  };

  return (
    <div>
      {toolbarOpen && (
        <div
          style={{
            display: "flex", alignItems: "center", gap: 4,
            padding: "5px 6px", marginBottom: 4,
            border: "1px solid #e0e0e0", borderRadius: 6, background: "#fafafa",
            flexWrap: "wrap",
          }}
        >
          <button type="button" onClick={() => editor.chain().focus().toggleBold().run()}
            style={{ ...tbBtn(editor.isActive("bold")), fontWeight: 800 }} title="Bold">B</button>
          <button type="button" onClick={() => editor.chain().focus().toggleItalic().run()}
            style={{ ...tbBtn(editor.isActive("italic")), fontStyle: "italic" }} title="Italic">I</button>
          <button type="button" onClick={() => editor.chain().focus().toggleUnderline().run()}
            style={{ ...tbBtn(editor.isActive("underline")), textDecoration: "underline" }} title="Underline">U</button>

          <span style={{ width: 1, height: 18, background: "#e0e0e0", margin: "0 2px" }} />

          <button type="button" onClick={() => editor.chain().focus().toggleBulletList().run()}
            style={tbBtn(editor.isActive("bulletList"))} title="Bullet list">•</button>
          <button type="button" onClick={() => editor.chain().focus().sinkListItem("listItem").run()}
            disabled={!editor.can().sinkListItem("listItem")}
            style={tbBtn(false)} title="Indent (sub-bullet)">⇥</button>
          <button type="button" onClick={() => editor.chain().focus().liftListItem("listItem").run()}
            disabled={!editor.can().liftListItem("listItem")}
            style={tbBtn(false)} title="Outdent">⇤</button>

          <span style={{ width: 1, height: 18, background: "#e0e0e0", margin: "0 2px" }} />

          <select
            value={currentSize ?? ""}
            onChange={e => {
              const v = e.target.value;
              const cmd = editor.chain().focus() as unknown as { setFontSize: (s: string | null) => { run: () => boolean } };
              cmd.setFontSize(v ? `${v}px` : null).run();
            }}
            style={{ height: 26, fontSize: 12, border: "1px solid #e0e0e0", borderRadius: 6, background: "#fff", padding: "0 4px", cursor: "pointer" }}
            title="Font size"
          >
            <option value="">Size</option>
            {FONT_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>

          <span style={{ width: 1, height: 18, background: "#e0e0e0", margin: "0 2px" }} />

          {/* Line spacing stepper */}
          <div style={{ display: "inline-flex", alignItems: "center", gap: 2 }} title="Line spacing">
            <button type="button" onClick={() => adjustLh(-0.1)} style={tbBtn(false)} aria-label="Decrease line spacing">−</button>
            <span style={{ minWidth: 28, textAlign: "center", fontSize: 11, fontFamily: "monospace", color: "#1976d2" }}>{currentLh.toFixed(1)}</span>
            <button type="button" onClick={() => adjustLh(0.1)} style={tbBtn(false)} aria-label="Increase line spacing">+</button>
          </div>

          <span style={{ width: 1, height: 18, background: "#e0e0e0", margin: "0 2px" }} />

          <div style={{ position: "relative" }}>
            <button type="button" onClick={() => setColorOpen(o => !o)}
              style={tbBtn(colorOpen)} title="Text color">
              <span style={{
                display: "inline-block", width: 12, height: 12, borderRadius: 2,
                background: editor.getAttributes("textStyle").color || "#000",
                border: "1px solid #ccc",
              }} />
            </button>
            {colorOpen && (
              <div style={{
                position: "absolute", top: 30, left: 0, zIndex: 10,
                display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 4,
                padding: 6, background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6,
              }}>
                {COLORS.map(c => (
                  <button key={c.hex} type="button" title={c.label}
                    onClick={() => {
                      editor.chain().focus().setColor(c.hex).run();
                      setColorOpen(false);
                    }}
                    style={{
                      width: 18, height: 18, borderRadius: 3, cursor: "pointer",
                      background: c.hex, border: "1px solid #c0c0c0", padding: 0,
                    }} />
                ))}
                <button type="button" title="Clear color" onClick={() => {
                  editor.chain().focus().unsetColor().run();
                  setColorOpen(false);
                }} style={{ gridColumn: "span 8", height: 22, fontSize: 11, border: "1px solid #e0e0e0", borderRadius: 4, background: "#fff", cursor: "pointer" }}>
                  Clear
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <div
        className="rte-area"
        style={{
          border: "1px solid #e0e0e0", borderRadius: 6, background: "#fff",
          minHeight, padding: "8px 10px", fontSize: 13, lineHeight: 1.5,
          opacity: disabled ? 0.5 : 1,
        }}
        data-placeholder={placeholder ?? ""}
      >
        <EditorContent editor={editor} />
      </div>
      {pasteNote && (
        <div role="status" style={{ marginTop: 4, fontSize: 11, color: "#78828c" }}>
          Formatting removed — pasted text was converted to plain description formatting.
        </div>
      )}

      <style jsx global>{`
        .rte-area .ProseMirror { outline: none; min-height: ${minHeight - 18}px; }
        .rte-area .ProseMirror p { margin: 0; }
        .rte-area .ProseMirror ul { margin: 0; padding-left: 1.2em; list-style-type: disc; }
        .rte-area .ProseMirror ul ul { list-style-type: circle; padding-left: 1.2em; }
        .rte-area .ProseMirror li { margin: 0; padding: 0; }
      `}</style>
    </div>
  );
}
