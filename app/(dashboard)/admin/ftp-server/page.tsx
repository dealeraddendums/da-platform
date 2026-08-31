"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { PageHeader } from "@/components/PageHeader";
import Pager from "@/components/Pager";

export const dynamic = "force-dynamic";

interface FtpUserRow {
  username: string;
  note: string;
}

// FTP account passwords (Allan, 2026-07-28): min 6 chars, >=1 letter,
// >=1 number, >=1 uppercase. No special-char requirement. FTP accounts
// ONLY — platform user passwords keep their own rules.
const PASSWORD_RE = /^(?=.*[A-Za-z])(?=.*\d)(?=.*[A-Z]).{6,}$/;
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
  const [viewRow, setViewRow] = useState<FtpUserRow | null>(null);

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
                      <button
                        onClick={() => setViewRow(r)}
                        style={{ padding: "4px 12px", fontSize: 11, fontWeight: 600, background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontFamily: "inherit" }}
                      >
                        View
                      </button>
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

      </div>

      {/* Pagination (shared centered Pager — keeps Next clear of corner overlays) */}
      {filtered.length > PAGE_SIZE && (
        <Pager page={page} totalPages={totalPages} onPage={setPage} light
          summary={<>Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length}</>} />
      )}

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
      {viewRow && (
        <FileBrowserModal
          row={viewRow}
          onClose={() => setViewRow(null)}
          onFlash={flash}
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
      setError("At least 6 characters, with a letter, a number, and an uppercase letter.");
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
        <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} style={inp} placeholder="At least 6 chars, with a letter, a number, and an uppercase" />
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
      setError("At least 6 characters, with a letter, a number, and an uppercase letter.");
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
        At least 6 characters, with a letter, a number, and an uppercase letter.
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

function Modal({ title, children, onClose, width }: { title: string; children: React.ReactNode; onClose: () => void; width?: number }) {
  const cssWidth = `min(${width ?? 560}px, 96vw)`;
  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
    >
      <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6, width: cssWidth, padding: 24 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0, color: "var(--text-primary)" }}>{title}</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, color: "var(--text-muted)", cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── File Browser Modal ───────────────────────────────────────────────────────

interface FtpFile {
  name: string;
  size: number;
  date: string;
  isDir: boolean;
}

function fmtSize(bytes: number): string {
  if (bytes === 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// FTP LIST dates arrive as "Jun 25 07:02" (recent files: month day time, in the
// server's UTC) or "Jun 25 2025" (older files: month day year). Parse as UTC and
// render in Pacific (America/Los_Angeles) so the times match the operator's wall
// clock instead of showing UTC.
const FTP_MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};
function fmtFtpDate(raw: string): string {
  if (!raw) return "—";
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 3) return raw;
  const [mon, dayStr, last] = parts;
  const m = FTP_MONTHS[mon];
  const day = Number(dayStr);
  if (m === undefined || !Number.isFinite(day)) return raw;

  let year: number, hour = 0, minute = 0;
  if (last.includes(":")) {
    const [h, mi] = last.split(":").map(Number);
    hour = h; minute = mi;
    // FTP omits the year for recent files — infer the most recent occurrence
    // (this month/day in the future means it was last year).
    const now = new Date();
    year = now.getUTCFullYear();
    if (Date.UTC(year, m, day, hour, minute) > now.getTime() + 86_400_000) year -= 1;
  } else {
    year = Number(last);
    if (!Number.isFinite(year)) return raw;
  }
  const d = new Date(Date.UTC(year, m, day, hour, minute));
  if (isNaN(d.getTime())) return raw;
  return d.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

// Self-contained spinner (SMIL-animated SVG — no CSS keyframes needed) for the
// "Preparing download…" button state.
function BtnSpinner() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" style={{ display: "block" }} aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="#fff" strokeWidth="3" strokeOpacity="0.3" />
      <path d="M12 3 a9 9 0 0 1 9 9" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round">
        <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.7s" repeatCount="indefinite" />
      </path>
    </svg>
  );
}

function joinPath(base: string, seg: string): string {
  const cleanBase = base === "/" ? "" : base.replace(/\/+$/, "");
  return `${cleanBase}/${seg}`;
}

function parentPath(p: string): string {
  if (p === "/" || p === "") return "/";
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx) || "/";
}

function FileBrowserModal({ row, onClose, onFlash }: {
  row: FtpUserRow;
  onClose: () => void;
  onFlash: (msg: string) => void;
}) {
  const [path, setPath] = useState("/");
  const [files, setFiles] = useState<FtpFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  const load = useCallback(async (p: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/ftp/files/${encodeURIComponent(row.username)}?path=${encodeURIComponent(p)}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        setError(j.error ?? `Failed (${res.status})`);
        setFiles([]);
        return;
      }
      const j = await res.json() as { files: FtpFile[] };
      // Folders first, then files; alphabetical.
      const sorted = [...(j.files ?? [])].sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setFiles(sorted);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }, [row.username]);

  useEffect(() => { void load(path); }, [path, load]);

  function openFolder(name: string) {
    setPath(joinPath(path, name));
  }

  async function download(name: string) {
    if (downloading) return;
    setError(null);
    setDownloading(name);

    // Download-cookie handshake: the route echoes our token back as a
    // (non-HttpOnly) cookie the moment it starts streaming the response — i.e.
    // when the browser's native download + progress bar take over. We poll for
    // that cookie so we can drop the "Preparing…" state exactly then, WITHOUT
    // buffering the (multi-GB) file in JS memory. A 30s watchdog surfaces an
    // error if the stream never starts.
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const cookieName = `ftpdl_${token}`;
    const url = `/api/admin/ftp/download/${encodeURIComponent(row.username)}`
      + `?path=${encodeURIComponent(path)}&file=${encodeURIComponent(name)}`
      + `&dl_token=${encodeURIComponent(token)}`;

    // Trigger native streaming download via hidden anchor.
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();

    const startedAt = Date.now();
    const poll = setInterval(() => {
      const seen = document.cookie.split("; ").some(c => c.startsWith(`${cookieName}=`));
      if (seen) {
        document.cookie = `${cookieName}=; Path=/; Max-Age=0`;  // consume it
        clearInterval(poll);
        setDownloading(null);
      } else if (Date.now() - startedAt > 30_000) {
        clearInterval(poll);
        setDownloading(null);
        setError(`Download failed — try again ("${name}")`);
      }
    }, 500);
  }

  async function remove(name: string) {
    if (!confirm(`Delete "${name}" from ${row.username}'s FTP folder?`)) return;
    setBusy(name);
    try {
      const res = await fetch(
        `/api/admin/ftp/files/${encodeURIComponent(row.username)}?path=${encodeURIComponent(path)}&file=${encodeURIComponent(name)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        setError(j.error ?? `Delete failed (${res.status})`);
        return;
      }
      onFlash(`✓ Deleted "${name}"`);
      await load(path);
    } finally {
      setBusy(null);
    }
  }

  async function upload(file: File) {
    setBusy(`upload:${file.name}`);
    try {
      const form = new FormData();
      form.append("path", path);
      form.append("file", file, file.name);
      const res = await fetch(
        `/api/admin/ftp/files/${encodeURIComponent(row.username)}`,
        { method: "POST", body: form },
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        setError(j.error ?? `Upload failed (${res.status})`);
        return;
      }
      onFlash(`✓ Uploaded "${file.name}"`);
      await load(path);
    } finally {
      setBusy(null);
    }
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";  // allow re-uploading the same name
    if (f) void upload(f);
  }

  const inSubfolder = path !== "/";

  return (
    <Modal title={`Files — ${row.username}`} onClose={onClose} width={900}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 12 }}>
        <div style={{ fontSize: 12, color: "#78828c", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          C:\ftproot\{row.username}{path === "/" ? "" : path.replace(/\//g, "\\")}
        </div>
        <label
          style={{ padding: "6px 14px", fontSize: 12, fontWeight: 600, background: "#4caf50", color: "#fff", border: "none", borderRadius: 4, cursor: busy?.startsWith("upload:") ? "wait" : "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}
        >
          {busy?.startsWith("upload:") ? "Uploading…" : "Upload File"}
          <input
            type="file"
            onChange={onPickFile}
            disabled={busy !== null}
            style={{ display: "none" }}
          />
        </label>
      </div>

      {error && (
        <div style={{ marginBottom: 12, padding: "8px 12px", background: "#ffebee", color: "#c62828", borderRadius: 4, fontSize: 12 }}>
          {error}
        </div>
      )}

      <div style={{ border: "1px solid #e0e0e0", borderRadius: 4, maxHeight: "60vh", overflow: "auto" }}>
        {loading ? (
          <div style={{ padding: 24, textAlign: "center", fontSize: 13, color: "#78828c" }}>Loading…</div>
        ) : (
          <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f7f8fa", borderBottom: "1px solid #e0e0e0", position: "sticky", top: 0 }}>
                <th style={{ padding: "8px 12px", textAlign: "left", fontSize: 11, fontWeight: 600, color: "#78828c", textTransform: "uppercase" }}>Name</th>
                <th style={{ padding: "8px 12px", textAlign: "right", fontSize: 11, fontWeight: 600, color: "#78828c", textTransform: "uppercase", width: 110 }}>Size</th>
                <th style={{ padding: "8px 12px", textAlign: "left", fontSize: 11, fontWeight: 600, color: "#78828c", textTransform: "uppercase", width: 150 }}>Date</th>
                <th style={{ padding: "8px 12px", textAlign: "right", fontSize: 11, fontWeight: 600, color: "#78828c", textTransform: "uppercase", width: 180 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {inSubfolder && (
                <tr style={{ borderBottom: "1px solid #f0f0f0", cursor: "pointer" }} onClick={() => setPath(parentPath(path))}>
                  <td style={{ padding: "8px 12px", fontFamily: "monospace", color: "#1976d2" }}>📁 ..</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", color: "#78828c", fontSize: 12 }}>—</td>
                  <td style={{ padding: "8px 12px", color: "#78828c", fontSize: 12 }}>—</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", color: "#78828c", fontSize: 12 }}>Up one level</td>
                </tr>
              )}
              {!loading && files.length === 0 && !inSubfolder && (
                <tr>
                  <td colSpan={4} style={{ padding: 24, textAlign: "center", fontSize: 13, color: "#78828c" }}>
                    No files in this folder.
                  </td>
                </tr>
              )}
              {files.map((f) => (
                <tr key={f.name} style={{ borderBottom: "1px solid #f0f0f0" }}>
                  <td style={{ padding: "8px 12px", fontFamily: "monospace", color: "#333" }}>
                    {f.isDir ? (
                      <button
                        onClick={() => openFolder(f.name)}
                        style={{ background: "none", border: "none", padding: 0, font: "inherit", color: "#1976d2", cursor: "pointer", textAlign: "left" }}
                      >
                        📁 {f.name}
                      </button>
                    ) : (
                      <span>📄 {f.name}</span>
                    )}
                  </td>
                  <td style={{ padding: "8px 12px", textAlign: "right", color: "#666", fontSize: 12 }}>
                    {f.isDir ? "—" : fmtSize(f.size)}
                  </td>
                  <td style={{ padding: "8px 12px", color: "#666", fontSize: 12 }}>{fmtFtpDate(f.date)}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", whiteSpace: "nowrap" }}>
                    {f.isDir ? (
                      <button
                        onClick={() => openFolder(f.name)}
                        style={{ padding: "3px 10px", fontSize: 11, fontWeight: 600, background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontFamily: "inherit" }}
                      >
                        Open
                      </button>
                    ) : (
                      <>
                        <button
                          onClick={() => void download(f.name)}
                          disabled={downloading !== null}
                          title={downloading === f.name ? "Preparing download…" : undefined}
                          style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", fontSize: 11, fontWeight: 600, background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, cursor: downloading ? "wait" : "pointer", fontFamily: "inherit", marginRight: 6, opacity: downloading && downloading !== f.name ? 0.55 : 1 }}
                        >
                          {downloading === f.name ? (<><BtnSpinner /> Preparing…</>) : "Download"}
                        </button>
                        <button
                          onClick={() => void remove(f.name)}
                          disabled={busy === f.name}
                          style={{ padding: "3px 10px", fontSize: 11, fontWeight: 600, background: "#ff5252", color: "#fff", border: "none", borderRadius: 4, cursor: busy === f.name ? "wait" : "pointer", fontFamily: "inherit", opacity: busy === f.name ? 0.6 : 1 }}
                        >
                          {busy === f.name ? "…" : "Delete"}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
        <div style={{ fontSize: 11, color: "#78828c" }}>
          {!loading && files.length > 0 && `${files.length} item${files.length === 1 ? "" : "s"}`}
        </div>
        <button className="btn btn-secondary" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
