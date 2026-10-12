// Unit checks for lib/svg-sanitize.ts — the SVG intake guard (LogoForge Phase 3).
// Mirrors da-logoforge/tests/test_library.py's sanitizer tests, plus parser
// strictness cases. Run: npm run test:svg-sanitize [path/to/real.svg ...]
import { readFileSync } from "fs";
import { sanitizeSvg, SvgSanitizeError, reportIsClean } from "../lib/svg-sanitize";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
  if (!ok) failed++;
}
function rejects(name: string, src: string): void {
  try { sanitizeSvg(src); check(name, false, "accepted"); }
  catch (e) { check(name, e instanceof SvgSanitizeError, String(e)); }
}

const SQUARE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="30" y="30" width="40" height="40" fill="#c00"/></svg>';

// 1. scripts, handlers, external refs
{
  const dirty = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" onload="alert(1)">'
    + "<script>alert(1)</script>"
    + '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>'
    + '<image href="https://evil.example/x.png" width="10" height="10"/>'
    + '<a href="javascript:alert(1)"><path d="M0 0h1v1z"/></a>'
    + '<use xlink:href="https://evil.example/s.svg#a"/>'
    + '<use xlink:href="#ok"/>'
    + '<path id="ok" d="M0 0h5v5z" onclick="x()" style="fill:url(https://evil.example/f)"/>'
    + '<rect width="1" height="1" fill="url(#grad)"/>'
    + '<animate attributeName="href" to="javascript:alert(1)"/>'
    + '<set attributeName="onmouseover" to="alert(1)"/>'
    + "</svg>";
  const { svg, report } = sanitizeSvg(dirty);
  for (const bad of ["script", "alert", "foreignObject", "<image", "evil.example", "onclick", "onload", "<animate", "<set", "<a ", "javascript"]) {
    check(`hostile: '${bad}' removed`, !svg.includes(bad), svg);
  }
  check("internal href kept (xlink normalised)", svg.includes('href="#ok"'), svg);
  check("internal paint ref kept", svg.includes("url(#grad)"), svg);
  check("report lists removals", !reportIsClean(report) && report.removedElements.includes("script"));
}

// 2. reject entities / DTD / non-svg / malformed
rejects("ENTITY rejected", '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "boom">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>');
rejects("non-svg root rejected", "<html><body/></html>");
rejects("truncated rejected", "<svg");
rejects("unquoted attribute rejected", '<svg xmlns="http://www.w3.org/2000/svg" width=10></svg>');
rejects("unknown entity rejected", '<svg xmlns="http://www.w3.org/2000/svg"><style>&nbsp;</style></svg>');
rejects("mismatched tags rejected", '<svg xmlns="http://www.w3.org/2000/svg"><g></rect></svg>');
rejects("two roots rejected", '<svg xmlns="http://www.w3.org/2000/svg"/><svg xmlns="http://www.w3.org/2000/svg"/>');
rejects("HTML-namespace root rejected", '<svg xmlns="http://www.w3.org/1999/xhtml"/>');
rejects("markup declaration rejected", '<svg xmlns="http://www.w3.org/2000/svg"><!ELEMENT x ANY></svg>');

// 3. Illustrator cruft
{
  const ai = '<?xml version="1.0" encoding="utf-8"?>\n<!-- Generator: Adobe Illustrator 28.0 -->\n'
    + '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n'
    + '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" '
    + 'x="0px" y="0px" viewBox="0 0 10 10" xml:space="preserve" inkscape:version="1">'
    + "<style>@import url(https://evil.example/x.css); .st0{fill:#E4002B;}</style>"
    + '<metadata>x</metadata><inkscape:thing/><path class="st0" d="M0 0h10v10z"/></svg>';
  const { svg } = sanitizeSvg(ai);
  check("illustrator: doctype/@import/evil/inkscape gone", !/DOCTYPE|@import|evil|inkscape|metadata/.test(svg), svg);
  check("illustrator: class rule kept", svg.replace(/\s/g, "").includes(".st0{fill:#E4002B;}"), svg);
}

// 4. style can't break out; CDATA handled
{
  const { svg } = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><style><![CDATA[ .a{fill:red} </style><script>alert(1)</script> ]]></style></svg>');
  check("style CDATA: no '<' survives inside style", !/<\/style><script/.test(svg) && !svg.includes("<script"), svg);
}

// 5. prefixed svg elements resolve; idempotent; entity in attribute
{
  const { svg } = sanitizeSvg('<s:svg xmlns:s="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><s:path d="M0 0h1v1z" fill="#000"/></s:svg>');
  check("prefixed svg namespace accepted", svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') && svg.includes("<path"), svg);
  const once = sanitizeSvg(SQUARE).svg;
  const twice = sanitizeSvg(once);
  check("idempotent", once === twice.svg && reportIsClean(twice.report), `${once}\n${twice.svg}`);
  const amp = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><g id="a&amp;b"/></svg>').svg;
  check("entities round-trip escaped", amp.includes('id="a&amp;b"'), amp);
}

// 6. real LogoForge outputs (optional paths on the command line)
for (const p of process.argv.slice(2)) {
  const src = readFileSync(p, "utf8");
  const { svg, report } = sanitizeSvg(src);
  const again = sanitizeSvg(svg);
  check(`real file ${p}: accepted, idempotent`, svg === again.svg && reportIsClean(again.report),
    JSON.stringify(report));
  console.log(`      ${src.length} → ${svg.length} bytes; removed ${JSON.stringify(report)}`);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
