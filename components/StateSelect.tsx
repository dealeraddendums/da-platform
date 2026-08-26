"use client";

// Shared US-state dropdown — options render as "TX — Texas" but the stored
// value is always the two-letter code. Legacy stored values ("Texas", "tx")
// are normalized to their code on mount; a value that matches nothing stays
// visible as a disabled "(current: …)" option so it is never silently lost —
// the form's save guard (normalizeStateCode returning null) blocks saving
// until a real state is picked.

import { useEffect } from "react";
import { US_STATES, normalizeStateCode } from "@/lib/constants/us-states";

export default function StateSelect({
  value,
  onChange,
  className,
  style,
  disabled,
}: {
  value: string;
  onChange: (code: string) => void;
  className?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
}) {
  const norm = normalizeStateCode(value);
  const unmatched = value.trim() !== "" && norm === null;

  // Legacy value that maps to a code ("tx" / "Texas") → adopt the code so the
  // preselected option and the saved value are the canonical two-letter form.
  useEffect(() => {
    if (norm && norm !== value) onChange(norm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <select
      className={className}
      style={style}
      value={unmatched ? value : norm ?? ""}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
    >
      {unmatched && <option value={value} disabled>(current: {value})</option>}
      <option value="">Select state</option>
      {US_STATES.map((s) => (
        <option key={s.code} value={s.code}>{s.code} — {s.name}</option>
      ))}
    </select>
  );
}
