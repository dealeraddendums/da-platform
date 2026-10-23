"use client";

// Email threads for a company or contact (company / contact pages). Rows open
// the thread in a slide-over (reply from there); "New email" composes from
// support@ / feeds@ without leaving the record.

import { useCallback, useEffect, useState } from "react";
import SlideOver from "./SlideOver";
import ThreadView, { STATUS_LABEL } from "./ThreadView";
import { ComposeNew } from "./CompanyContextRail";
import { fmtAgo } from "@/lib/crm/format";

type Row = { id: string; subject: string | null; status: string; unread: boolean; last_message_at: string | null; last_from_name: string | null; last_from_email: string | null; last_snippet: string | null; message_count: number; mailbox: string | null };
const TH: React.CSSProperties = { fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", fontWeight: 600 };

export default function EmailThreadsPanel({ companyId, contactId, meId, to }: { companyId?: string | null; contactId?: string | null; meId: string; to?: { email: string; name?: string }[] }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [compose, setCompose] = useState(false);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ view: "all" });
    if (contactId) qs.set("contact_id", contactId); else if (companyId) qs.set("company_id", companyId);
    const j = await fetch(`/api/crm/inbox/threads?${qs}`).then((r) => r.json()).catch(() => ({}));
    setRows(j.threads ?? []);
  }, [companyId, contactId]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div>
      <div style={{ padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{rows ? `${rows.length} thread${rows.length === 1 ? "" : "s"}` : "Loading…"}</span>
        <button type="button" className="btn btn-primary" style={{ height: 30 }} onClick={() => setCompose(true)}>New email</button>
      </div>
      {rows && !rows.length && <p className="text-sm" style={{ color: "var(--text-muted)", padding: "0 16px 16px", margin: 0 }}>No email yet.</p>}
      {rows && rows.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)", textAlign: "left" }}>
              <th className="px-3 py-2" style={TH}>Subject</th><th className="px-3 py-2" style={TH}>Last from</th>
              <th className="px-3 py-2" style={TH}>Mailbox</th><th className="px-3 py-2" style={TH}>Status</th><th className="px-3 py-2" style={TH}>Last message</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} onClick={() => setOpen(t.id)} style={{ borderBottom: "1px solid var(--border)", cursor: "pointer" }}>
                <td className="px-3 py-2">
                  <span style={{ color: "var(--blue)", fontWeight: t.unread ? 700 : 400 }}>{t.subject || "(no subject)"}</span>
                  {t.message_count > 1 && <span style={{ color: "var(--text-muted)" }}> ({t.message_count})</span>}
                  {t.last_snippet && <div style={{ fontSize: 12, color: "var(--text-muted)", maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.last_snippet}</div>}
                </td>
                <td className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>{t.last_from_name ?? t.last_from_email ?? "—"}</td>
                <td className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>{t.mailbox ?? "—"}</td>
                <td className="px-3 py-2">{STATUS_LABEL[t.status] ?? t.status}</td>
                <td className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>{fmtAgo(t.last_message_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <SlideOver open={!!open} title="Email thread" onClose={() => { setOpen(null); void load(); }} width={820}>
        {open && <ThreadView threadId={open} meId={meId} onChanged={load} />}
      </SlideOver>
      <SlideOver open={compose} title="New email" onClose={() => setCompose(false)} width={760}>
        {compose && <ComposeNew companyId={companyId ?? null} contactId={contactId ?? null} to={to ?? []} onDone={() => { setCompose(false); void load(); }} onCancel={() => setCompose(false)} />}
      </SlideOver>
    </div>
  );
}
