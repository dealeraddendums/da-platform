// Genuine Code 128 encoder → inline SVG (2026-08-12).
//
// The old VIN "barcode" widget drew decorative divs from character-code
// arithmetic — not Code 39, not Code 128, not scannable at all — with a
// Code-39-style *VIN* caption. This is a real Code 128 subset-B encoder:
// standard 11-module symbols, weighted mod-103 checksum, 13-module stop,
// 10-module quiet zones. Pure function (no DOM, no deps) so the shared
// widget renderer can emit identical output on the Builder canvas and the
// PDF box, self-contained in the printed document.
//
// Correctness gate: verified by rasterizing the SVG at print scale and
// decoding with ZXing (see the 2026-08-12 session) — decoded value must be
// byte-identical to the input.

// Standard Code 128 bar/space module widths for values 0–105 ("212222" =
// bar 2, space 1, bar 2, space 2, bar 2, space 2 — 11 modules each).
const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213",
  "122312", "132212", "221213", "221312", "231212", "112232", "122132",
  "122231", "113222", "123122", "123221", "223211", "221132", "221231",
  "213212", "223112", "312131", "311222", "321122", "321221", "312212",
  "322112", "322211", "212123", "212321", "232121", "111323", "131123",
  "131321", "112313", "132113", "132311", "211313", "231113", "231311",
  "112133", "112331", "132131", "113123", "113321", "133121", "313121",
  "211331", "231131", "213113", "213311", "213131", "311123", "311321",
  "331121", "312113", "312311", "332111", "314111", "221411", "431111",
  "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114",
  "413111", "241112", "134111", "111242", "121142", "121241", "114212",
  "124112", "124211", "411212", "421112", "421211", "212141", "214121",
  "412121", "111143", "111341", "131141", "114113", "114311", "411113",
  "411311", "113141", "114131", "311141", "411131", "211412", "211214",
  "211232",
];
const STOP_PATTERN = "2331112"; // 13 modules, 7 elements
const START_B = 104;
const QUIET_MODULES = 10;

/** Code 128 subset-B module sequence for `text` (ASCII 32–126 only).
 *  Returns alternating bar/space widths starting with a bar, WITHOUT quiet
 *  zones. Throws on characters outside subset B (VINs are A–Z, 0–9 — safe). */
export function code128BWidths(text: string): number[] {
  const values: number[] = [START_B];
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code > 126) throw new Error(`Code 128B cannot encode char ${JSON.stringify(ch)}`);
    values.push(code - 32);
  }
  let checksum = START_B;
  for (let i = 1; i < values.length; i++) checksum += values[i] * i;
  values.push(checksum % 103);

  const widths: number[] = [];
  for (const v of values) for (const w of PATTERNS[v]) widths.push(Number(w));
  for (const w of STOP_PATTERN) widths.push(Number(w));
  return widths;
}

/**
 * Inline SVG for a Code 128 barcode of `text`. Fills its box (width/height
 * 100%); preserveAspectRatio="none" stretches modules uniformly, which keeps
 * the bar:space RATIOS exact — that's what scanners read. White background
 * includes 10-module quiet zones on both sides.
 */
export function code128Svg(text: string): string {
  const widths = code128BWidths(text);
  const totalModules = widths.reduce((a, b) => a + b, 0) + QUIET_MODULES * 2;
  let x = QUIET_MODULES;
  let rects = "";
  for (let i = 0; i < widths.length; i++) {
    if (i % 2 === 0) rects += `<rect x="${x}" y="0" width="${widths[i]}" height="100"/>`;
    x += widths[i];
  }
  return `<svg viewBox="0 0 ${totalModules} 100" preserveAspectRatio="none" style="width:100%;height:100%;display:block" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="${totalModules}" height="100" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}
