"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// collapsible: a one-line "Add a note…" until clicked (timeline header). onSaved: the caller reloads its own list.
export default function AddNoteForm({ companyId, contactId, collapsible = false, onSaved }: { companyId?: string; contactId?: string; collapsible?: boolean; onSaved?: () => void }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(!collapsible);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!text.trim()) return;
    setSaving(true);
    setErr(null);
    const res = await fetch("/api/crm/activities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company_id: companyId, contact_id: contactId, body: text }),
    });
    const j = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) { setErr(j.error ?? "Couldn't save the note"); return; }
    setText("");
    if (collapsible) setOpen(false);
    if (onSaved) onSaved(); else router.refresh();
  }

  if (!open) {
    return (
      <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border)" }}>
        <button type="button" className="input" onClick={() => setOpen(true)}
          style={{ textAlign: "left", color: "var(--text-muted)", cursor: "text", height: 36, padding: "0 12px", width: "100%", background: "var(--bg-surface)" }}>
          Add a note…
        </button>
      </div>
    );
  }

  return (
    <div style={{ padding: 16, borderTop: "1px solid var(--border)" }}>
      <textarea
        className="input"
        style={{ height: 72, padding: "8px 12px", resize: "vertical" }}
        placeholder="Add a note…"
        autoFocus={collapsible}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
        <button type="button" className="btn btn-primary" onClick={save} disabled={saving || !text.trim()}>
          {saving ? "Saving…" : "Add note"}
        </button>
        {collapsible && <button type="button" className="btn btn-ghost" onClick={() => { setOpen(false); setText(""); }}>Cancel</button>}
        {err && <span style={{ fontSize: 12, color: "var(--error)" }}>{err}</span>}
      </div>
    </div>
  );
}
