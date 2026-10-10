// Last-line credential guard for Steven's output (both modes). Nothing secret
// is in Steven's context — the KB is secret-free and keys live in the vault —
// but if the model ever emits something shaped like a credential (pasted by a
// user, hallucinated, or from a future article), it is replaced before it
// reaches the browser or the transcript.

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, // PEM / SSH private keys
  /\bAKIA[0-9A-Z]{12,}/g,                       // AWS access key id
  /\beyJ[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]*){0,2}/g, // JWTs (Supabase anon/service keys, bearer tokens)
  /\bsk-(ant-)?[A-Za-z0-9_-]{12,}/g,            // Anthropic / OpenAI-style keys
  /\bsk_(live|test)_[A-Za-z0-9]{8,}/g,          // Stripe secret keys
  /\b(pk|rk)_live_[A-Za-z0-9]{8,}/g,
  /\bpat-na1-[A-Za-z0-9-]{8,}/g,                // HubSpot private-app tokens
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,             // Slack tokens
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,              // GitHub tokens
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@]+@[^\s]+/gi, // connection strings with an embedded password
];

export const REDACTED = "[redacted — credentials live in the vault]";

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, REDACTED);
  return out;
}
