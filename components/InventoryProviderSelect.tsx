"use client";

// The canonical Inventory Provider dropdown — single markup for every place a
// provider is chosen (dealer profile, group Member Dealers plan-change, …).
// Options come from lib/inventory-providers.ts only: adding a vendor there
// (e.g. Team Velocity) is the one way a new value enters the system — no
// free-text entry anywhere.

import { DMS_PROVIDERS, OTHER_PROVIDERS } from "@/lib/inventory-providers";

export default function InventoryProviderSelect({
  value,
  onChange,
  className = "input",
  style,
  autoFocus,
  /** Label for the empty option; pass e.g. "— select provider —" in flows
   *  where a provider is required (caller validates non-empty on submit). */
  noneLabel = "— None —",
}: {
  value: string;
  onChange: (provider: string) => void;
  className?: string;
  style?: React.CSSProperties;
  autoFocus?: boolean;
  noneLabel?: string;
}) {
  return (
    <select
      className={className}
      style={style}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      autoFocus={autoFocus}
    >
      <option value="">{noneLabel}</option>
      <optgroup label="DMS Providers">
        {DMS_PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
      </optgroup>
      <optgroup label="All Other Providers">
        {OTHER_PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
      </optgroup>
    </select>
  );
}
