// DA-CRM company page header: back link, name, stage pill (dot + light),
// brands as plain text; Edit on the right. The kind
// pill is only for vendors and feed suppliers — on a dealer or group page the
// list you came from already said what it is.
import type { ReactNode } from "react";
import Link from "next/link";
import { KIND_LABEL, STAGE_LABEL, type Stage } from "@/lib/crm/format";
import { BILLING_STATE_LABEL, type BillingState } from "@/lib/crm/billing-labels";

/** What a dealer's stage pill says: paying dealers show their DA-Billing state. */
export function stageDisplay(stage: Stage, billing: BillingState | null): { label: string; dot: string } {
  if (stage === "paying") {
    if (billing === "past_due") return { label: BILLING_STATE_LABEL.past_due, dot: "var(--crm-warn)" };
    if (billing === "suspended") return { label: BILLING_STATE_LABEL.suspended, dot: "var(--crm-danger)" };
    if (billing === "current") return { label: BILLING_STATE_LABEL.current, dot: "var(--crm-success)" };
    if (billing === "archived") return { label: BILLING_STATE_LABEL.archived, dot: "var(--crm-muted)" };
    if (billing === "none") return { label: BILLING_STATE_LABEL.none, dot: "var(--crm-border-strong)" };
    return { label: "Billing unknown", dot: "var(--crm-border-strong)" };
  }
  const dot: Record<Stage, string> = {
    trial: "var(--crm-warn)", setup_training: "var(--crm-accent)", paying: "var(--crm-success)", cancelled: "var(--crm-muted)", lost: "var(--crm-danger)",
  };
  return { label: stage === "setup_training" ? "Setup & training" : STAGE_LABEL[stage], dot: dot[stage] };
}

export function KindPill({ kind }: { kind: string }) {
  return <span className="crm-pill-kind">{KIND_LABEL[kind] ?? kind}</span>;
}

export function StagePill({ stage, billing = null, label, title, dot }: { stage: Stage; billing?: BillingState | null; label?: string; title?: string; dot?: string }) {
  const d = stageDisplay(stage, billing);
  return (
    <span className="crm-pill-stage" title={title} style={{ ["--crm-stage-dot" as string]: dot ?? d.dot }}>
      {label ?? d.label}
    </span>
  );
}

export default function CompanyHeader({ name, kind, stage, billing, billingNote, brands, backHref, backLabel, actions, meta }: {
  name: string; kind: string; stage: Stage | null; billing: BillingState | null; billingNote?: string | null; brands: string[];
  backHref: string; backLabel: string; actions: ReactNode; meta?: string | null;
}) {
  const partner = kind === "vendor" || kind === "feed_supplier";
  return (
    <header style={{ marginBottom: 24 }}>
      <Link href={backHref} style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 28, padding: "0 6px", marginLeft: -6, marginBottom: 14, borderRadius: 6, fontSize: 14, color: "var(--crm-ink-2)", textDecoration: "none" }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></svg>
        {backLabel}
      </Link>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
        <div style={{ minWidth: 0 }}>
          <h1 className="crm-h1">{name}</h1>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
            {partner && <KindPill kind={kind} />}
            {stage && <StagePill stage={stage} billing={billing} title={billingNote ?? undefined} />}
            {brands.length > 0 && <span className="crm-brands">{brands.join(" · ")}</span>}
            {meta && <span style={{ fontSize: 13, color: "var(--crm-muted)" }}>{meta}</span>}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>{actions}</div>
      </div>
    </header>
  );
}
