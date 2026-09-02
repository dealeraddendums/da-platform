"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

// Month selector for the Payments Received by Period card. The card itself is
// server-rendered (both halves read secrets — da-billing's API key and the
// FreshBooks snapshot in admin_settings), so the picker only moves the
// ?period= search param and lets the server re-render.

export function PeriodPicker({
  value,
  months,
}: {
  value: string;
  months: { value: string; label: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <label className="inline-flex items-center gap-2 text-sm" style={{ color: "var(--text-muted)" }}>
      Month
      <select
        className="input"
        value={value}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value;
          startTransition(() => router.push(`/billing?period=${next}`, { scroll: false }));
        }}
        style={{ width: "auto", opacity: pending ? 0.6 : 1 }}
      >
        {months.map((m) => (
          <option key={m.value} value={m.value}>{m.label}</option>
        ))}
      </select>
    </label>
  );
}
