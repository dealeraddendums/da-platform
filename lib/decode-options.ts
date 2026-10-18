// Multi-value VIN decode fields — shared by the Add Vehicle modal and the
// admin Decoder "Test Decode" tab so both offer exactly the same candidates.
// vPIC returns several possibilities for some fields as one string — trim
// "SEL, SEL Plus", body style "Sport Utility Vehicle [SUV]/Multipurpose Vehicle
// [MPV]", drivetrain "4WD/4-Wheel Drive/4x4". Split them into options so the
// user picks ONE and the vehicle stores a clean single value. Separators inside
// [] / () don't split, nor do "w/", "w/o" or digit/digit ("1/2 Ton").

export function splitDecodedOptions(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const parts: string[] = [];
  let cur = "";
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "[" || ch === "(") depth++;
    else if ((ch === "]" || ch === ")") && depth > 0) depth--;
    const isSep = depth === 0 && (ch === "," || (ch === "/"
      && !/(^|[^a-z])w$/i.test(cur)                          // "w/", "w/o"
      && !(/\d$/.test(cur) && /\d/.test(raw[i + 1] ?? ""))));  // "1/2"
    if (isSep) { parts.push(cur); cur = ""; } else cur += ch;
  }
  parts.push(cur);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const v = p.trim();
    if (v && !seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); out.push(v); }
  }
  return out;
}
