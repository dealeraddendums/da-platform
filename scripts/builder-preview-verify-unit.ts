/* npm run test:builder-preview — Template Builder "Preview products" (migration 194): the selection's
   parsing / filtering / banner, and the guardrail that NOTHING in the print pipeline reads it. */
import * as fs from "fs";
import * as path from "path";
import { DEFAULT_SELECTION, parsePreviewSelection, previewBanner, selectPreviewItems } from "../lib/builder-preview";

let fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`}`);
}

const A = "lib:11111111-1111-1111-1111-111111111111", B = "lib:22222222-2222-2222-2222-222222222222", G = "grp:33333333-3333-3333-3333-333333333333";
const items = [{ key: G, name: "Corp" }, { key: A, name: "Tint" }, { key: B, name: "Locks" }];

// ── Selection ───────────────────────────────────────────────────────────────
eq("junk → All", parsePreviewSelection("nope"), DEFAULT_SELECTION);
eq("unknown keys dropped, dupes removed", parsePreviewSelection({ mode: "picked", picked: { New: [A, A, "lib:bad", 5], Used: [B] } }).picked, { New: [A], Used: [B], CPO: [] });
eq("vehicle mode without a vehicle → All", parsePreviewSelection({ mode: "vehicle" }).mode, "all");
eq("vehicle mode kept with a vehicle", parsePreviewSelection({ mode: "vehicle", vehicle: { id: "44444444-4444-4444-4444-444444444444", stock: "A123" } }).vehicle, { id: "44444444-4444-4444-4444-444444444444", stock: "A123" });

// ── Filtering ───────────────────────────────────────────────────────────────
const sel = parsePreviewSelection({ mode: "picked", picked: { New: [B, G], Used: [A], CPO: [] } });
eq("picked: per condition, print order kept", selectPreviewItems(items, sel, "New").map((i) => i.name), ["Corp", "Locks"]);
eq("picked: Used has its own set", selectPreviewItems(items, sel, "Used").map((i) => i.name), ["Tint"]);
eq("picked: empty set → nothing", selectPreviewItems(items, sel, "CPO"), []);
eq("all: untouched", selectPreviewItems(items, DEFAULT_SELECTION, "New").length, 3);
eq("banner: picked", previewBanner(6, 14, sel), "Previewing 6 of 14 products — printing is not affected.");
eq("banner: all → none", previewBanner(14, 14, DEFAULT_SELECTION), null);

// ── Guardrail: the print pipeline never reads the preview selection ─────────
const ROOT = path.resolve(__dirname, "..");
const walk = (dir: string): string[] => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []));
const PRINT_PATH = [
  ...walk("app/api/pdf"), "lib/pdf-html.ts", "lib/print-options.ts", "lib/template-resolver.ts", "lib/options-engine.ts",
  "lib/pdf-service-client.ts", "lib/record-print.ts", "lib/vehicle-options-save.ts",
].filter((f) => fs.existsSync(path.join(ROOT, f)));
const readers = PRINT_PATH.filter((f) => /preview_products|previewSel|builder-preview/.test(fs.readFileSync(path.join(ROOT, f), "utf8")));
eq(`print path (${PRINT_PATH.length} files) never reads preview_products`, readers, []);
const resolver = fs.readFileSync(path.join(ROOT, "lib/template-resolver.ts"), "utf8");
eq("template resolver selects template_json only (no select *)", /from\("templates"\)[\s\S]{0,80}\.select\("\*"\)/.test(resolver) || /from\("group_templates"\)[\s\S]{0,80}\.select\("\*"\)/.test(resolver), false);
// The Builder writes the selection through its own endpoint, never via the template save body.
const save = ["app/api/templates/route.ts", "app/api/templates/[id]/route.ts"].map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");
eq("template save routes don't write preview_products", /preview_products/.test(save), false);

console.log(fail ? `\n${fail} failed` : "\nall passed");
process.exit(fail ? 1 : 0);
