// DA-CRM company page header: back link, name, kind pill (filled dark), stage
// pill (dot + light), brands as plain text; Edit and delete on the right.
import Link from "next/link";
import { KIND_LABEL, STAGE_LABEL, type Stage } from "@/lib/crm/format";

const STAGE_DOT: Record<Stage, string> = {
  trial: "var(--crm-warn)",
  setup_training: "var(--crm-accent)",
  paying: "var(--crm-success)",
  cancelled: "var(--crm-muted)",
  lost: "var(--crm-danger)",
};

export function KindPill({ kind }: { kind: string }) {
  return <span className="crm-pill-kind">{KIND_LABEL[kind] ?? kind}</span>;
}

export function StagePill({ stage }: { stage: Stage }) {
  return (
    <span className="crm-pill-stage" style={{ ["--crm-stage-dot" as string]: STAGE_DOT[stage] }}>
      {stage === "trial" ? "In trial" : STAGE_LABEL[stage]}
    </span>
  );
}

export default function CompanyHeader({ name, kind, stage, brands, backHref, backLabel, editHref, deletable, meta }: {
  name: string; kind: string; stage: Stage | null; brands: string[];
  backHref: string; backLabel: string; editHref: string; deletable: boolean; meta?: string | null;
}) {
  return (
    <header style={{ marginBottom: 28 }}>
      <Link href={backHref} className="btn-ghost" style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 28, padding: "0 6px", marginLeft: -6, marginBottom: 18, borderRadius: 6, fontSize: 14, color: "var(--crm-ink-2)", textDecoration: "none" }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></svg>
        {backLabel}
      </Link>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
        <div style={{ minWidth: 0 }}>
          <h1 className="crm-h1">{name}</h1>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
            <KindPill kind={kind} />
            {stage && <StagePill stage={stage} />}
            {brands.length > 0 && <span className="crm-brands">{brands.join(" · ")}</span>}
            {meta && <span style={{ fontSize: 13, color: "var(--crm-muted)" }}>{meta}</span>}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <Link href={editHref} className="btn btn-secondary" style={{ textDecoration: "none" }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
            Edit
          </Link>
          {deletable && (
            <button type="button" className="btn btn-ghost" aria-label="Delete company" title="Delete company" style={{ width: 36, padding: 0 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
