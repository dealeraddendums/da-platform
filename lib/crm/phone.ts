// DA-CRM phone normalization → E.164. Mirrors public.crm_normalize_phone()
// (migration 179) exactly — inbound-call matching compares the two, so keep
// them in step; scripts/crm-verify-unit.ts pins the shared behaviour.
//
// NANP-first (every DA dealer is US/CA): 10 digits → +1…, 11 starting with 1 →
// +…. An explicit leading "+" (or 011 international prefix) keeps its country
// code. Extensions are dropped. Anything that isn't a dialable number → null.

export function normalizePhone(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let s = String(raw).trim().toLowerCase();
  s = s.replace(/\s*(x|ext\.?|extension)\s*\d+\s*$/, "");
  let d = s.replace(/\D/g, "");
  const intl = (digits: string): string | null => {
    if (digits.startsWith("1") && digits.length !== 11) return null;
    return digits.length >= 8 && digits.length <= 15 && !digits.startsWith("0") ? `+${digits}` : null;
  };
  if (s.startsWith("+")) return intl(d);
  if (d.startsWith("011") && d.length >= 11 && d.length <= 18) return intl(d.slice(3));
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length === 10 && /^[2-9]\d{2}[2-9]/.test(d)) return `+1${d}`;
  return null;
}

/** "+18014159435" → "(801) 415-9435"; other countries keep E.164. */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return "";
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}
