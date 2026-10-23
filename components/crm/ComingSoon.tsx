import { PageHeader } from "@/components/PageHeader";

/** Placeholder for DA-CRM nav items whose module ships in a later phase. */
export default function ComingSoon({ title, phase, blurb }: { title: string; phase: string; blurb: string }) {
  return (
    <div>
      <PageHeader title={title} />
      <div className="crm-card crm-empty" style={{ padding: "48px 24px" }}>
        <strong>Coming in {phase}</strong>
        <span style={{ display: "block", maxWidth: 560, margin: "0 auto", lineHeight: 1.5 }}>{blurb}</span>
      </div>
    </div>
  );
}
