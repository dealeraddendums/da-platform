/* npm run test:rw-asking — Dealer Asking Price base with the Retail/Wholesale widget */
import { buildPdfHtml } from "../lib/pdf-html";
import { retailWholesaleSecondPrice, resolveWholesaleAskingBase } from "../components/builder/widgetRenderer";
import type { Widget } from "../components/builder/types";

let fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`}`);
}

const W = (id: string, type: string, d: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, w: 300, h: 40, d }) as unknown as Widget;
const askbar = W("a", "askbar", { label: "Dealer Asking Price", value: "$0", barColor: "clear" });
const subtotal = W("s", "subtotal", { label: "Subtotal", value: "$0" });
const vehicle = { MSRP: "42749", YEAR: "2026", MAKE: "Toyota", MODEL: "Tacoma", VIN_NUMBER: "X" } as never;
const options = [
  { option_name: "Bedliner", option_price: "9060", active: true, required: true },
  { option_name: "Mats", option_price: "500", active: true, required: true },
];
// The price text the askbar / subtotal widgets render.
const valueOf = (html: string, label: string) => {
  const i = html.indexOf(label); const m = html.slice(i).match(/\$[\d,]+(?:\.\d\d)?/); return m ? m[0] : null;
};
async function render(widgets: Widget[], retailWholesalePrice?: number | null) {
  return buildPdfHtml({ widgets, paperSize: "standard", fontScale: 1, bgUrl: "", vehicle, options, retailWholesalePrice });
}

(async () => {
  const rwAsk = W("r", "retail_wholesale", { mode: "ask", label1: "Retail Price", label2: "Simple Price" });
  let h = await render([rwAsk, subtotal, askbar], 30000);
  eq("Tacoma: ask 30000 → asking $39,560", valueOf(h, "Dealer Asking Price"), "$39,560");
  eq("Tacoma: subtotal unchanged $9,560", valueOf(h, "Subtotal"), "$9,560");
  eq("Tacoma: struck MSRP still shown", h.includes("line-through") && h.includes("$42,749"), true);
  eq("Tacoma: Simple Price $30,000 shown", valueOf(h, "Simple Price"), "$30,000");

  h = await render([rwAsk, subtotal, askbar], null);
  eq("ask SKIPPED → MSRP base $52,309", valueOf(h, "Dealer Asking Price"), "$52,309");
  eq("ask SKIPPED → plain retail line, no strikethrough", h.includes("line-through"), false);

  h = await render([W("r", "retail_wholesale", { mode: "percent", percentOff: 10 }), askbar]);
  eq("MSRP−10% → 38474 + 9560 = $48,034", valueOf(h, "Dealer Asking Price"), "$48,034");
  h = await render([W("r", "retail_wholesale", { mode: "dollars", dollarsOff: 2749 }), askbar]);
  eq("MSRP−$2,749 → 40000 + 9560 = $49,560", valueOf(h, "Dealer Asking Price"), "$49,560");
  h = await render([askbar]);
  eq("no widget → MSRP base $52,309", valueOf(h, "Dealer Asking Price"), "$52,309");

  const noMsrp = await buildPdfHtml({ widgets: [rwAsk, askbar], paperSize: "standard", fontScale: 1, bgUrl: "", vehicle: { ...(vehicle as object), MSRP: null } as never, options, retailWholesalePrice: 30000 });
  eq("no MSRP → widget renders nothing, asking = products only $9,560", valueOf(noMsrp, "Dealer Asking Price"), "$9,560");

  eq("second price rounds to nearest dollar", retailWholesaleSecondPrice({ mode: "percent", percentOff: 7 }, 42749), 39757);
  eq("second price never negative", retailWholesaleSecondPrice({ mode: "dollars", dollarsOff: 99999 }, 42749), 0);
  eq("first resolving widget wins (ask without price skipped)", resolveWholesaleAskingBase([{ type: "retail_wholesale", d: { mode: "ask" } }, { type: "retail_wholesale", d: { mode: "dollars", dollarsOff: 749 } }], 42749, null), 42000);

  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
