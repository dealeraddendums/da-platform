// Template Builder — which products the canvas previews (templates.preview_products, migration 194).
// PREVIEW ONLY: the print pipeline never reads the selection; it only narrows what the Builder injects into
// the product widgets' render argument. Pure — tested in scripts/builder-preview-verify-unit.ts.

export type PreviewCondition = "New" | "Used" | "CPO";
export const PREVIEW_CONDITIONS: PreviewCondition[] = ["New", "Used", "CPO"];
export type PreviewMode = "all" | "picked" | "vehicle";

export type PreviewSelection = {
  mode: PreviewMode;
  /** Hand-picked product keys per condition ("lib:<id>" | "grp:<id>"). */
  picked: Record<PreviewCondition, string[]>;
  /** "As vehicle": the dealer_vehicles row the preview renders. */
  vehicle: { id: string; stock: string } | null;
};

export const DEFAULT_SELECTION: PreviewSelection = { mode: "all", picked: { New: [], Used: [], CPO: [] }, vehicle: null };

const KEY = /^(lib|grp):[0-9a-f-]{36}$/i;
const UUID = /^[0-9a-f-]{36}$/i;

/** Whatever is stored (or sent) → a valid selection; junk is dropped, never thrown. */
export function parsePreviewSelection(raw: unknown): PreviewSelection {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const mode: PreviewMode = r.mode === "picked" || r.mode === "vehicle" ? r.mode : "all";
  const picked = { New: [], Used: [], CPO: [] } as Record<PreviewCondition, string[]>;
  for (const c of PREVIEW_CONDITIONS) {
    const list = Array.isArray(r.picked?.[c]) ? r.picked[c] : [];
    picked[c] = Array.from(new Set(list.filter((k: unknown) => typeof k === "string" && KEY.test(k)))).slice(0, 500) as string[];
  }
  const v = r.vehicle;
  const vehicle = v && typeof v.id === "string" && UUID.test(v.id) ? { id: v.id, stock: String(v.stock ?? "").slice(0, 60) } : null;
  return { mode: mode === "vehicle" && !vehicle ? "all" : mode, picked, vehicle };
}

/** The canvas items for one section under the selection. `all` / `vehicle` leave the list as given
 *  (vehicle mode swaps the list itself); `picked` keeps the chosen keys in their print order. */
export function selectPreviewItems<T extends { key?: string }>(items: T[], sel: PreviewSelection, condition: PreviewCondition): T[] {
  if (sel.mode !== "picked") return items;
  const want = new Set(sel.picked[condition] ?? []);
  return items.filter((it) => !!it.key && want.has(it.key));
}

/** Banner text when the preview is narrowed (null = showing everything). */
export function previewBanner(shown: number, total: number, sel: PreviewSelection): string | null {
  if (sel.mode === "all") return null;
  if (sel.mode === "vehicle") return `Previewing what stock #${sel.vehicle?.stock ?? "?"} prints (${shown} product${shown === 1 ? "" : "s"}) — printing is not affected.`;
  return `Previewing ${shown} of ${total} products — printing is not affected.`;
}
