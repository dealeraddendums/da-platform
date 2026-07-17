// Computed-style → widget-button CSS conversion for the "Match from URL"
// feature (2026-07-17). Kept out of the route file so it can be unit-tested
// (App Router route files may only export handlers).

export interface ExtractedMatch {
  tag: string;
  className: string;
  text: string;
  fullWidth: boolean;
  rectWidth: number;
  parentWidth: number;
  styles: Record<string, string>;
  hoverStyles: Record<string, string> | null;
  outerHTML: string;
}

const px = (v: string | undefined) => {
  const n = parseFloat(v ?? "");
  return Number.isFinite(n) ? n : 0;
};
const present = (v: string | undefined) => !!v && v !== "none" && v !== "normal" && v.trim() !== "";

/** Convert a computed-style object into widget-button CSS. Computed values are
 *  browser-normalized (rgb()/px/keywords) so they drop into CSS verbatim. */
export function stylesToButtonCss(match: ExtractedMatch, targetClass: string): string {
  const s = match.styles;
  const lines: string[] = [];
  const put = (prop: string, val: string | undefined) => {
    if (val && val.trim()) lines.push(`  ${prop}: ${val.trim()};`);
  };

  const bg = s["background-color"];
  put("background-color", bg === "rgba(0, 0, 0, 0)" ? "transparent" : bg);
  put("color", s["color"]);
  put("font-family", s["font-family"]);
  put("font-size", s["font-size"]);
  put("font-weight", s["font-weight"]);
  if (present(s["letter-spacing"])) put("letter-spacing", s["letter-spacing"]);
  if (present(s["text-transform"])) put("text-transform", s["text-transform"]);
  put("line-height", s["line-height"]);
  put("padding", `${s["padding-top"]} ${s["padding-right"]} ${s["padding-bottom"]} ${s["padding-left"]}`);

  if (px(s["border-top-width"]) > 0 && present(s["border-top-style"])) {
    put("border", `${s["border-top-width"]} ${s["border-top-style"]} ${s["border-top-color"]}`);
  } else {
    lines.push("  border: none;");
  }
  put("border-radius", s["border-radius"]);
  if (present(s["box-shadow"])) put("box-shadow", s["box-shadow"]);

  // Width behavior: mirror full-width block buttons exactly; otherwise the
  // widget button stays shrink-to-fit.
  if (match.fullWidth) {
    lines.push("  display: block;");
    lines.push("  width: 100%;");
    lines.push("  box-sizing: border-box;");
    put("text-align", s["text-align"] || "center");
  } else {
    lines.push("  display: inline-block;");
    put("text-align", s["text-align"] || "center");
  }
  const mt = px(s["margin-top"]);
  const mb = px(s["margin-bottom"]);
  if (mt > 0 || mb > 0) put("margin", `${s["margin-top"]} 0 ${s["margin-bottom"]}`);

  lines.push("  text-decoration: none;");
  lines.push("  cursor: pointer;");

  let css = `${targetClass} {\n${lines.join("\n")}\n}`;

  if (match.hoverStyles && Object.keys(match.hoverStyles).length) {
    const h: string[] = [];
    const hs = match.hoverStyles;
    if (hs["background-color"]) h.push(`  background-color: ${hs["background-color"]};`);
    if (hs["color"]) h.push(`  color: ${hs["color"]};`);
    if (hs["border-top-color"]) h.push(`  border-color: ${hs["border-top-color"]};`);
    if (hs["box-shadow"] && hs["box-shadow"] !== "none") h.push(`  box-shadow: ${hs["box-shadow"]};`);
    if (hs["text-decoration-line"] && hs["text-decoration-line"] !== "none") h.push(`  text-decoration: ${hs["text-decoration-line"]};`);
    if (h.length) css += `\n${targetClass}:hover {\n${h.join("\n")}\n}`;
  }
  return css;
}
