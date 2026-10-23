"use client";

// Company page → Summary (AI). Shows the cached summary at once, then asks the
// server to regenerate when it's due (new activity + an hour since the last
// run — lib/crm/company-summary.ts). Hover or tap a sentence to see the items
// it was built from; clicking an activity scrolls the timeline to it, a task
// or ticket opens it in the Tasks & Tickets card.

import { useCallback, useEffect, useState } from "react";
import type { StoredSummary, Ref } from "@/lib/crm/company-summary";
import { fmtAgo } from "@/lib/crm/format";

type State = { summary: StoredSummary | null; generated_at: string | null; has_activity: boolean; due: boolean; reason: string; error?: string };

export default function SummaryCard({ companyId }: { companyId: string }) {
  const [s, setS] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | "next" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const generate = useCallback(async (manual: boolean) => {
    setBusy(true);
    const r = await fetch(`/api/crm/companies/${companyId}/summary`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ manual }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setErr(j.error ?? "Couldn't refresh the summary"); return; }
    setErr(j.error ?? null);
    setS(j);
  }, [companyId]);

  useEffect(() => {
    let live = true;
    (async () => {
      const r = await fetch(`/api/crm/companies/${companyId}/summary`);
      const j = await r.json().catch(() => null);
      if (!live || !j || !r.ok) return;
      setS(j);
      if (j.due) void generate(false);
    })();
    return () => { live = false; };
  }, [companyId, generate]);

  const refs = s?.summary?.refs ?? {};
  const sentenceSources = open === null || !s?.summary ? [] : open === "next" ? s.summary.next_step?.sources ?? [] : s.summary.sentences[open]?.sources ?? [];

  return (
    <section className="crm-rail-card">
      <div className="crm-rail-title">
        <span>Summary</span>
        {s?.has_activity && (
          <button type="button" className="crm-textlink" style={{ fontSize: 12, textTransform: "none", letterSpacing: 0, fontWeight: 500 }} disabled={busy} onClick={() => void generate(true)}>
            {busy ? "Updating…" : "Refresh"}
          </button>
        )}
      </div>
      {!s ? <p style={{ margin: 0, fontSize: 13, color: "var(--crm-muted)" }}>Loading…</p>
        : !s.has_activity ? <p style={{ margin: 0, fontSize: 13, color: "var(--crm-muted)" }}>No activity yet — a summary appears once there are calls, emails, tasks or tickets.</p>
        : !s.summary ? <p style={{ margin: 0, fontSize: 13, color: "var(--crm-muted)" }}>{busy ? "Writing the summary…" : err ? `Couldn't write a summary: ${err}` : "No summary yet."}</p>
        : (
          <div className="crm-summary">
            <p>
              {s.summary.sentences.map((x, i) => (
                <span key={i}>
                  <span className="s" data-open={open === i} tabIndex={0} onMouseEnter={() => setOpen(i)} onFocus={() => setOpen(i)} onClick={() => setOpen(open === i ? null : i)}>{x.text}</span>{" "}
                </span>
              ))}
            </p>
            {s.summary.next_step && (
              <p style={{ marginTop: 10 }}>
                <strong>Next step: </strong>
                <span className="s" data-open={open === "next"} tabIndex={0} onMouseEnter={() => setOpen("next")} onFocus={() => setOpen("next")} onClick={() => setOpen(open === "next" ? null : "next")}>{s.summary.next_step.text}</span>
              </p>
            )}
            {open !== null && (
              <div className="crm-sources" onMouseLeave={() => setOpen(null)}>
                <strong style={{ fontWeight: 600 }}>Based on</strong>
                {sentenceSources.length ? (
                  <ul>{sentenceSources.map((k) => refs[k] && <li key={k}><SourceLink r={refs[k]} /></li>)}</ul>
                ) : <div>No specific items.</div>}
              </div>
            )}
            <p style={{ marginTop: 10, fontSize: 11.5, color: "var(--crm-muted)" }}>
              Updated {fmtAgo(s.generated_at)}{busy ? " · updating…" : ""} · AI-written from this record only; hover a sentence for its sources.
            </p>
            {err && <p style={{ marginTop: 4, fontSize: 11.5, color: "var(--crm-danger)" }}>Refresh failed: {err}</p>}
          </div>
        )}
    </section>
  );
}

function SourceLink({ r }: { r: Ref }) {
  const when = r.at ? new Date(r.at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
  const label = <>{r.label}{when && <span style={{ color: "var(--crm-muted)" }}> · {when}</span>}</>;
  if (r.kind === "activity" && r.id !== "older") {
    return <button type="button" className="crm-textlink" style={{ textAlign: "left" }} onClick={() => {
      const el = document.getElementById(`act-${r.id}`);
      if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.animate([{ background: "var(--crm-accent-soft)" }, { background: "transparent" }], { duration: 1600 }); }
      else window.dispatchEvent(new CustomEvent("crm:activity-show-all", { detail: { id: r.id } }));
    }}>{label}</button>;
  }
  if (r.kind === "task" || r.kind === "ticket") {
    return <button type="button" className="crm-textlink" style={{ textAlign: "left" }} onClick={() => window.dispatchEvent(new CustomEvent("crm:work-open", { detail: { kind: r.kind, id: r.id } }))}>{label}</button>;
  }
  return <span>{label}</span>;
}
