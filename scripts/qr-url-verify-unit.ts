/* npm run test:qr-url — lib/qr-url.ts resolveQrUrlTemplate */
import { resolveQrUrlTemplate } from "../lib/qr-url";

let fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n  got:  ${String(got)}\n  want: ${String(want)}`}`);
}

const jeep = { vin: "1C4RJKBG5S8123456", stock_number: "J1234", year: 2025, make: "Jeep", model: "Grand Cherokee", trim: "Limited 4x4" };

eq("all six tokens, make/model/trim encoded",
  resolveQrUrlTemplate("https://dealer.com/[YEAR]-[MAKE]-[MODEL]/[TRIM]/[VIN]?s=[STOCK]", jeep),
  "https://dealer.com/2025-Jeep-Grand%20Cherokee/Limited%204x4/1C4RJKBG5S8123456?s=J1234");
eq("legacy [VIN]/[STOCK] unchanged",
  resolveQrUrlTemplate("https://dealer.com/inventory/[VIN]?stock=[STOCK]", jeep),
  "https://dealer.com/inventory/1C4RJKBG5S8123456?stock=J1234");
eq("missing trim → empty, no literal token",
  resolveQrUrlTemplate("https://d.com/[MAKE]/[MODEL]/[TRIM]", { ...jeep, trim: null }),
  "https://d.com/Jeep/Grand%20Cherokee/");
eq("special chars encoded (value only)",
  resolveQrUrlTemplate("https://d.com/s?m=[MODEL]&t=[TRIM]", { model: "F-150 Lightning", trim: "XLT & Co/#1" }),
  "https://d.com/s?m=F-150%20Lightning&t=XLT%20%26%20Co%2F%231");
eq("repeated + lowercase tokens", resolveQrUrlTemplate("/[vin]/[VIN]", jeep), "/1C4RJKBG5S8123456/1C4RJKBG5S8123456");
eq("string year", resolveQrUrlTemplate("/[YEAR]", { year: "2024" }), "/2024");
eq("unknown token left alone", resolveQrUrlTemplate("/[COLOR]/[VIN]", jeep), "/[COLOR]/1C4RJKBG5S8123456");
eq("blank template → null (VDP/url fallback)", resolveQrUrlTemplate("", jeep), null);
eq("null template → null", resolveQrUrlTemplate(null, jeep), null);
eq("empty vehicle → no tokens left", resolveQrUrlTemplate("https://d.com/[YEAR]/[MAKE]/[VIN]", {}), "https://d.com///");

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
