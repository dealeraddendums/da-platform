import { PageHeader } from "@/components/PageHeader";

/** Placeholder for DA-CRM nav items whose module ships in a later phase. */
export default function ComingSoon({ title, phase, blurb }: { title: string; phase: string; blurb: string }) {
  return (
    <div>
      <PageHeader title={title} />
      <div className="card" style={{ padding: 24 }}>
        <p style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Coming in {phase}</p>
        <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-secondary)" }}>{blurb}</p>
      </div>
    </div>
  );
}
