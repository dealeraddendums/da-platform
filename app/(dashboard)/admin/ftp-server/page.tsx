"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { PageHeader } from "@/components/PageHeader";

export const dynamic = "force-dynamic";

interface FtpUserRow {
  username: string;
  note: string;
}

const PASSWORD_RE = /^(?=.{10,})(?=.*?[^\w\s])(?=.*?[0-9])(?=.*?[A-Z]).*?[a-z].*$/;
const PROTECTED = new Set(["admin", "allantone"]);
const PAGE_SIZE = 25;

const inp: React.CSSProperties = { width: "100%", padding: "8px 10px", height: 36, border: "1px solid #e0e0e0", borderRadius: 6, background: "#fff", fontSize: 13, color: "#333" };
const lbl: React.CSSProperties = { display: "block", fontSize: 11, fontWeight: 600, color: "#78828c", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 };

export default function FtpServerPage() {
  const [rows, setRows] = useState<FtpUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [addOpen, setAddOpen] = useState(false);
  const [pwRow, setPwRow] = useState<FtpUserRow | null>(null);
  const [noteRow, setNoteRow] = useState<FtpUserRow | null>(null);
  const [deleteRow, setDeleteRow] = useState<FtpUserRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/ftp/users", { cache: "no-store" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        setError(j.error ?? `Failed to load (${res.status})`);
        setRows([]);
        return;
      }
      const j = await res.json() as { data: FtpUserRow[] };
      setRows(j.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.trim().toLowerCase();
    return rows.filter(r =>
      r.username.toLowerCase().includes(q) || (r.note ?? "").toLowerCase().includes(q),
    );
  }, [rows, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }

  return (
    <div>
      <PageHeader
        title="FTP Server"
        subtitle={loading ? "Loading…" : `${rows.length} FTP user${rows.length === 1 ? "" : "s"}`}
        action={
          <button
            onClick={() => setAddOpen(true)}
            style={{ padding: "8px 16px", background: "#4caf50", color: "#fff", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
          >
            + Add FTP User
          </button>
        }
      />

      {toast && (
        <div className="card p-3 mb-3" style={{ background: "#e8f5e9", border: "1px solid #c8e6c9", color: "#2e7d32" }}>
          {toast}
        </div>
      )}
      {error && (
        <div className="card p-3 mb-3" style={{ background: "#ffebee", border: "1px solid #ffcdd2", color: "#c62828" }}>
          {error}
        </div>
      )}

      <div className="card p-4 mb-4">
        <input
          type="text"
          className="input w-full"
          placeholder="Search by username or note…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        />
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <div className="p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>Loading FTP users…</div>
        ) : pageRows.length === 0 ? (
          <div className="p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
            {rows.length === 0 ? "No FTP users yet." : "No users match your search."}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "var(--bg-subtle)", borderBottom: "1px solid var(--border)" }}>
                {["User", "Note", "View", "Change Password", "Delete"].map(h => (
                  <th key={h} className="px-4 py-2 text-left font-semibold" style={{ color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r, i) => {
                const isProtected = PROTECTED.has(r.username.toLowerCase());
                return (
                  <tr key={r.username} style={{ borderBottom: i < pageRows.length - 1 ? "1px solid var(--border)" : "none" }}>
                    <td className="px-4 py-2.5" style={{ color: "var(--text-primary)", fontFamily: "monospace" }}>{r.username}</td>
                    <td className="px-4 py-2.5">
                      <button
                        onClick={() => setNoteRow(r)}
                        style={{ padding: "4px 10px", fontSize: 11, fontWeight: 600, background: "#e0f7fa", color: "#00838f", border: "1px solid #80deea", borderRadius: 4, cursor: "pointer", fontFamily: "inherit" }}
                      >
                        {r.note ? "Edit Note" : "Add Note"}
                      </button>
                      {r.note && (
                        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.note}>
                          {r.note}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <a
                        href={`https://hub.dealeraddendums.com/ftp.php?view=${encodeURIComponent(r.username)}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{ padding: "4px 12px", fontSize: 11, fontWeight: 600, background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, textDecoration: "none", cursor: "pointer" }}
                      >
                        View
                      </a>
                    </td>
                    <td className="px-4 py-2.5">
                      <button
                        onClick={() => setPwRow(r)}
                        style={{ padding: "4px 12px", fontSize: 11, fontWeight: 600, background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontFamily: "inherit" }}
                      >
                        Change
                      </button>
                    </td>
                    <td className="px-4 py-2.5">
                      {isProtected ? (
                        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Protected</span>
                      ) : (
                        <button
                          onClick={() => setDeleteRow(r)}
                          style={{ padding: "4px 12px", fontSize: 11, fontWeight: 600, background: "#ff5252", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontFamily: "inherit" }}
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {filtered.length > PAGE_SIZE && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", borderTop: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                style={{ padding: "4px 10px", fontSize: 12, background: "#fff", border: "1px solid #e0e0e0", borderRadius: 4, cursor: page === 1 ? "default" : "pointer", opacity: page === 1 ? 0.5 : 1, fontFamily: "inherit" }}
              >
                Prev
              </button>
              <span style={{ fontSize: 12, color: "var(--text-muted)", alignSelf: "center" }}>Page {page} of {totalPages}</span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                style={{ padding: "4px 10px", fontSize: 12, background: "#fff", border: "1px solid #e0e0e0", borderRadius: 4, cursor: page === totalPages ? "default" : "pointer", opacity: page === totalPages ? 0.5 : 1, fontFamily: "inherit" }}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {addOpen && (
        <AddUserModal
          existingUsernames={rows.map(r => r.username)}
          onClose={() => setAddOpen(false)}
          onAdded={(username) => {
            setAddOpen(false);
            flash(`✓ FTP user "${username}" added`);
            void load();
          }}
        />
      )}
      {pwRow && (
        <ChangePasswordModal
          row={pwRow}
          onClose={() => setPwRow(null)}
          onSaved={() => { setPwRow(null); flash(`✓ Password updated for "${pwRow.username}"`); }}
        />
      )}
      {noteRow && (
        <NoteModal
          row={noteRow}
          onClose={() => setNoteRow(null)}
          onSaved={(note) => {
            setRows(prev => prev.map(r => r.username === noteRow.username ? { ...r, note } : r));
            setNoteRow(null);
            flash(`✓ Note saved for "${noteRow.username}"`);
          }}
        />
      )}
      {deleteRow && (
        <DeleteModal
          row={deleteRow}
          onClose={() => setDeleteRow(null)}
          onDeleted={() => {
            setRows(prev => prev.filter(r => r.username !== deleteRow.username));
            setDeleteRow(null);
            flash(`✓ FTP user "${deleteRow.username}" deleted`);
          }}
        />
      )}
    </div>
  );
}

// ── Add User Modal ───────────────────────────────────────────────────────────

function AddUserModal({ existingUsernames, onClose, onAdded }: {
  existingUsernames: string[];
  onClose: () => void;
  onAdded: (username: string) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [folder, setFolder] = useState(""); // empty = create new folder named after username
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    if (!username.trim()) { setError("Username is required"); return; }
    if (!PASSWORD_RE.test(password)) {
      setError("Password must be 10+ chars with upper, lower, number, and one special char");
      return;
    }
    setSaving(true);
    const res = await fetch("/api/admin/ftp/add-user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: username.trim(),
        password,
        folderName: folder || undefined,
        note: note.trim() || undefined,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({})) as { error?: string };
      setError(j.error ?? `Failed (${res.status})`);
      return;
    }
    onAdded(username.trim());
  }

  return (
    <Modal title="Add FTP User" onClose={onClose}>
      {error && <div style={{ marginBottom: 12, padding: "8px 12px", background: "#ffebee", color: "#c62828", borderRadius: 4, fontSize: 12 }}>{error}</div>}
      <div style={{ marginBottom: 12 }}>
        <label style={lbl}>Username *</label>
        <input value={username} onChange={(e) => setUsername(e.target.value)} style={inp} placeholder="e.g. acmedms" autoFocus />
        <p style={{ fontSize: 11, color: "#78828c", marginTop: 4 }}>
          Letters, numbers, _ or - (up to 32 chars). Becomes the folder name at <code>C:\ftproot\{`{`}username{`}`}</code>.
        </p>
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={lbl}>Password *</label>
        <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} style={inp} placeholder="At least 10 chars, 1 upper, 1 lower, 1 number, 1 special" />
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={lbl}>Select Existing Folder (optional)</label>
        <select value={folder} onChange={(e) => setFolder(e.target.value)} style={inp}>
          <option value="">— Create new folder named after username —</option>
          {existingUsernames.map((u) => (
            <option key={u} value={u}>{u}</option>
          ))}
        </select>
        <p style={{ fontSize: 11, color: "#78828c", marginTop: 4 }}>
          Reuse a folder from a deleted user. The folder list mirrors current usernames since folder = username by convention.
        </p>
      </div>
      <div style={{ marginBottom: 16 }}>
        <label style={lbl}>Note (optional)</label>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} style={{ ...inp, height: 80, resize: "vertical" }} placeholder="Vendor, ticket #, gotchas…" />
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
        <button
          onClick={() => void save()}
          disabled={saving}
          style={{ padding: "8px 16px", background: "#4caf50", color: "#fff", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: saving ? "wait" : "pointer", fontFamily: "inherit" }}
        >
          {saving ? "Adding…" : "Add User"}
        </button>
      </div>
    </Modal>
  );
}

// ── Change Password Modal ────────────────────────────────────────────────────

function ChangePasswordModal({ row, onClose, onSaved }: { row: FtpUserRow; onClose: () => void; onSaved: () => void }) {
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    if (pw1 !== pw2) { setError("Passwords don't match"); return; }
    if (!PASSWORD_RE.test(pw1)) {
      setError("Password must be 10+ chars with upper, lower, number, and one special char");
      return;
    }
    setSaving(true);
    const res = await fetch("/api/admin/ftp/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: row.username, newPassword: pw1 }),
    });
    setSaving(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({})) as { error?: string };
      setError(j.error ?? `Failed (${res.status})`);
      return;
    }
    onSaved();
  }

  return (
    <Modal title={`Change Password — ${row.username}`} onClose={onClose}>
      {error && <div style={{ marginBottom: 12, padding: "8px 12px", background: "#ffebee", color: "#c62828", borderRadius: 4, fontSize: 12 }}>{error}</div>}
      <div style={{ marginBottom: 12 }}>
        <label style={lbl}>New Password</label>
        <input type="text" value={pw1} onChange={(e) => setPw1(e.target.value)} style={inp} autoFocus />
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={lbl}>Confirm Password</label>
        <input type="text" value={pw2} onChange={(e) => setPw2(e.target.value)} style={inp} />
      </div>
      <p style={{ fontSize: 11, color: "#78828c", marginBottom: 16 }}>
        At least 10 chars, 1 upper, 1 lower, 1 number, 1 special char.
      </p>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
        <button
          onClick={() => void save()}
          disabled={saving}
          style={{ padding: "8px 16px", background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: saving ? "wait" : "pointer", fontFamily: "inherit" }}
        >
          {saving ? "Saving…" : "Update Password"}
        </button>
      </div>
    </Modal>
  );
}

// ── Note Modal ───────────────────────────────────────────────────────────────

function NoteModal({ row, onClose, onSaved }: { row: FtpUserRow; onClose: () => void; onSaved: (note: string) => void }) {
  const [note, setNote] = useState(row.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    setSaving(true);
    const res = await fetch(`/api/admin/ftp/notes/${encodeURIComponent(row.username)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: note.trim() }),
    });
    setSaving(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({})) as { error?: string };
      setError(j.error ?? `Failed (${res.status})`);
      return;
    }
    onSaved(note.trim());
  }

  return (
    <Modal title={`Note — ${row.username}`} onClose={onClose}>
      {error && <div style={{ marginBottom: 12, padding: "8px 12px", background: "#ffebee", color: "#c62828", borderRadius: 4, fontSize: 12 }}>{error}</div>}
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        autoFocus
        style={{ ...inp, height: 120, resize: "vertical", marginBottom: 16 }}
        placeholder="Add a note about this FTP user…"
      />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
        <button
          onClick={() => void save()}
          disabled={saving}
          style={{ padding: "8px 16px", background: "#00838f", color: "#fff", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: saving ? "wait" : "pointer", fontFamily: "inherit" }}
        >
          {saving ? "Saving…" : "Save Note"}
        </button>
      </div>
    </Modal>
  );
}

// ── Delete Modal ─────────────────────────────────────────────────────────────

function DeleteModal({ row, onClose, onDeleted }: { row: FtpUserRow; onClose: () => void; onDeleted: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setDeleting(true);
    const res = await fetch(`/api/admin/ftp/users/${encodeURIComponent(row.username)}`, {
      method: "DELETE",
    });
    setDeleting(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({})) as { error?: string };
      setError(j.error ?? `Failed (${res.status})`);
      return;
    }
    onDeleted();
  }

  return (
    <Modal title={`Delete FTP User — ${row.username}`} onClose={onClose}>
      <p style={{ fontSize: 13, color: "#333", marginBottom: 16, lineHeight: 1.6 }}>
        Delete FTP user <strong>{row.username}</strong>?
        <br />
        <span style={{ color: "#78828c", fontSize: 12 }}>
          Their folder at <code>C:\ftproot\{row.username}</code> will NOT be deleted — only the account.
        </span>
      </p>
      {error && <div style={{ marginBottom: 12, padding: "8px 12px", background: "#ffebee", color: "#c62828", borderRadius: 4, fontSize: 12 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button className="btn btn-secondary" onClick={onClose} disabled={deleting}>Cancel</button>
        <button
          onClick={() => void confirm()}
          disabled={deleting}
          style={{ padding: "8px 16px", background: "#ff5252", color: "#fff", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: deleting ? "wait" : "pointer", fontFamily: "inherit" }}
        >
          {deleting ? "Deleting…" : "Delete User"}
        </button>
      </div>
    </Modal>
  );
}

// ── Generic modal wrapper ────────────────────────────────────────────────────

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
    >
      <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6, width: "min(560px, 96vw)", padding: 24 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0, color: "var(--text-primary)" }}>{title}</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, color: "var(--text-muted)", cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
