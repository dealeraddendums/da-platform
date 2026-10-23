"use client";

// Company page → Summary (AI). Shows the cached summary at once, then asks the
// server to regenerate when it's due (new activity + an hour since the last
// run — lib/crm/company-summary.ts). Hover or tap a sentence to see the items
// it was built from; clicking an activity scrolls the timeline to it, a task
// or ticket opens it in the Tasks & Tickets card.

import { useCallback, useEffect, useRef, useState } from "react";
import type { StoredSummary, Ref } from "@/lib/crm/company-summary";
import { fmtAgo } from "@/lib/crm/format";
import { displaySubject } from "@/lib/crm/thread-display";

type State = { summary: StoredSummary | null; generated_at: string | null; has_activity: boolean; due: boolean; reason: string; error?: string };

export default function SummaryCard({ companyId }: { companyId: string }) {
  const [s, setS] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | "next" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Sources pop over the text: at the bottom, or at the top when the hovered sentence is in the lower half.
  const wrap = useRef<HTMLDivElement>(null);
  const [popTop, setPopTop] = useState(false);
  const show = (i: number | "next", el?: HTMLElement) => {
    const w = wrap.current?.getBoundingClientRect();
    const r = el?.getBoundingClientRect();
    setPopTop(!!(w && r && i !== "next" && r.top - w.top > w.height / 2));
    setOpen(i);
  };

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
    <section className="crm-rail-card crm-summary-card">
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
          <div className="crm-summary crm-summary-body">
            {/* The sentences scroll; Next step and the footer stay pinned below. */}
            <div className="crm-summary-scrollwrap" ref={wrap}>
              <div className="crm-summary-scroll" tabIndex={0} aria-label="Summary">
                <p>
                  {s.summary.sentences.map((x, i) => (
                    <span key={i}>
                      <span className="s" data-open={open === i} tabIndex={0} onMouseEnter={(e) => show(i, e.currentTarget)} onFocus={(e) => show(i, e.currentTarget)} onClick={(e) => (open === i ? setOpen(null) : show(i, e.currentTarget))}>{x.text}</span>{" "}
                    </span>
                  ))}
                </p>
              </div>
              {/* Sources float over the text so they never push Next step out of the card. */}
              {open !== null && (
                <div className="crm-sources crm-sources-pop" data-top={popTop} onMouseLeave={() => setOpen(null)}>
                  <strong style={{ fontWeight: 600 }}>Based on</strong>
                  {sentenceSources.length ? (
                    <ul>{sentenceSources.map((k) => refs[k] && <li key={k}><SourceLink r={refs[k]} /></li>)}</ul>
                  ) : <div>No specific items.</div>}
                </div>
              )}
            </div>
            <div className="crm-summary-pinned">
              {s.summary.next_step && (
                <p className="crm-summary-next">
                  <strong>Next step: </strong>
                  <span className="s" data-open={open === "next"} tabIndex={0} onMouseEnter={() => show("next")} onFocus={() => show("next")} onClick={() => setOpen(open === "next" ? null : "next")}>{s.summary.next_step.text}</span>
                </p>
              )}
              <p className="crm-ellipsis" style={{ marginTop: 8, fontSize: 11.5, color: "var(--crm-muted)" }}
                title="AI-written from this record only; hover a sentence for its sources.">
                Updated {fmtAgo(s.generated_at)}{busy ? " · updating…" : ""} · AI · hover a sentence for sources
              </p>
              {err && <p style={{ marginTop: 4, fontSize: 11.5, color: "var(--crm-danger)" }}>Refresh failed: {err}</p>}
            </div>
          </div>
        )}
    </section>
  );
}

function SourceLink({ r }: { r: Ref }) {
  const when = r.at ? new Date(r.at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
  const label = <>{displaySubject(r.label)}{when && <span style={{ color: "var(--crm-muted)" }}> · {when}</span>}</>;
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
