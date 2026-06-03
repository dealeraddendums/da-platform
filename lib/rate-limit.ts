// Minimal in-memory rate limiter (per-process). Defensive throttle for the
// key-authenticated self-serve endpoint — the real gate is SELF_SERVE_API_KEY
// + Turnstile on the marketing side; this just caps abuse if the key leaks.
// Single-instance only (matches the rest of the app); swap for Redis if scaled.

interface Entry { count: number; resetAt: number }
const store = new Map<string, Entry>();

export function rateLimit(key: string, max = 30, windowMs = 60_000): boolean {
  const now = Date.now();
  const entry = store.get(key);
  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}
