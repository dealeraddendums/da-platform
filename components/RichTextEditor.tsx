"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { Mark } from "@tiptap/core";
import { useEffect, useState } from "react";

const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20];
const COLORS: { hex: string; label: string }[] = [
  { hex: "#000000", label: "Black" },
  { hex: "#ffffff", label: "White" },
  { hex: "#c62828", label: "Red" },
  { hex: "#ef6c00", label: "Orange" },
  { hex: "#1976d2", label: "Blue" },
  { hex: "#2e7d32", label: "Green" },
  { hex: "#78828c", label: "Gray" },
];

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

function toEditorContent(value: string): string {
  if (!value) return "";
  if (looksLikeHtml(value)) return value;
  const escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<p>${escaped.replace(/\n/g, "<br/>")}</p>`;
}

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
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  disabled?: boolean;
  minHeight?: number;
}) {
  const [toolbarOpen, setToolbarOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      TextStyle,
      Color.configure({ types: ["textStyle"] }),
      FontSize,
    ],
    content: toEditorContent(value),
    editable: !disabled,
    immediatelyRender: false,
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      // Tiptap returns "<p></p>" for an empty doc — normalize to "" so saves stay clean.
      onChange(html === "<p></p>" ? "" : html);
    },
  });

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

  return (
    <div style={{ position: "relative" }}>
      {/* Format toggle (top-right) */}
      <button
        type="button"
        onClick={() => setToolbarOpen(o => !o)}
        title={toolbarOpen ? "Hide formatting" : "Show formatting"}
        style={{
          position: "absolute", top: -28, right: 0, zIndex: 1,
          height: 22, padding: "0 8px", fontSize: 12, fontWeight: 700,
          border: "1px solid #e0e0e0", borderRadius: 6,
          background: toolbarOpen ? "#1976d2" : "#fff",
          color: toolbarOpen ? "#fff" : "#78828c",
          cursor: "pointer", lineHeight: 1,
        }}
      >
        A
      </button>

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
                display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4,
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
                }} style={{ gridColumn: "span 7", height: 22, fontSize: 11, border: "1px solid #e0e0e0", borderRadius: 4, background: "#fff", cursor: "pointer" }}>
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
