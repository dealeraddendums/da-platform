import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuthEvent, clientIp } from "@/lib/auth-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── Unified front-door login (Phase 2) ──────────────────────────────────────
// One server-side entry for both platforms. The browser only ever posts to us;
// the 4.0 API key and all credentials stay server-to-server.
//
//   username is an email  -> try 5.0 (server-side GoTrue), then fall back to 4.0
//   username is not email  -> 4.0 SSO handoff only
//
// Hardening that closes the Phase-1 gaps (password path was client-side, had no
// per-account lockout, and leaked account existence via bcrypt timing):
//   * the 5.0 password check runs HERE (server-side), never in the browser
//   * per-email lockout (5 fails / 15 min) + per-IP throttle
//   * every response is floored to a constant time so existing-vs-unknown email
//     can't be distinguished by latency
//   * one generic error for every failure — never reveals which system matched
//     or whether an account exists

// Failure responses are floored ABOVE the worst-case failure path (5.0 GoTrue +
// 4.0 fallback, ~1.2-1.6s) so wrong-password-existing and unknown-email can't be
// told apart by latency. Successes return immediately (fast happy path; timing
// then only distinguishes success from failure, which needs the real password).
const FAIL_FLOOR_MS = 2600;
const LOCK_MAX_FAILS = 5;
const LOCK_WINDOW_MS = 15 * 60_000;

// Per-email failure counter (module-scoped = per worker; accepted ×workers, same
// as the OTP route). A strike is registered only on a real credential failure.
const failStore = new Map<string, { n: number; resetAt: number }>();
function isLocked(key: string): boolean {
  const e = failStore.get(key);
  return !!(e && Date.now() < e.resetAt && e.n >= LOCK_MAX_FAILS);
}
function registerFail(key: string): void {
  const now = Date.now();
  const e = failStore.get(key);
  if (!e || now > e.resetAt) failStore.set(key, { n: 1, resetAt: now + LOCK_WINDOW_MS });
  else e.n++;
}
function clearFails(key: string): void { failStore.delete(key); }

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const safeNext = (n: unknown): string =>
  (typeof n === "string" && n.startsWith("/") && !n.startsWith("//")) ? n : "/dashboard";

async function floor(started: number): Promise<void> {
  const el = Date.now() - started;
  if (el < FAIL_FLOOR_MS) await new Promise((r) => setTimeout(r, FAIL_FLOOR_MS - el));
}

// Generic, non-enumerable messages (never say which system or whether the account exists)
const ERR_CREDS = "Wrong username or password.";
const ERR_RATE = "Too many attempts. Please try again later.";
const ERR_GENERIC = "Login failed. Please try again.";

type FourZeroResult =
  | { kind: "ok"; login_url: string }
  | { kind: "rate" }
  | { kind: "fail" }        // invalid_credentials / no usable answer
  | { kind: "misconfig" };  // our key/allowlist wrong — log, never surface

async function call40(username: string, password: string): Promise<FourZeroResult> {
  const url = process.env.LEGACY_SSO_URL;
  const key = process.env.LEGACY_SSO_API_KEY;
  const redeemHosts = (process.env.LEGACY_SSO_REDEEM_HOSTS || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!url || !key) { console.error("[login] LEGACY_SSO_URL/API_KEY not configured"); return { kind: "misconfig" }; }

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "X-API-Key": key, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.error("[login] 4.0 SSO request failed:", (e as Error)?.message);
    return { kind: "misconfig" };
  }

  let j: Record<string, unknown> = {};
  try { j = await resp.json(); } catch { /* non-JSON */ }

  if (j?.ok === true && typeof j.login_url === "string") {
    // Redeem host is DIFFERENT from the token endpoint host. Never derive it —
    // validate the returned host against the allowlist (open-redirect guard).
    let host = "";
    try { host = new URL(j.login_url as string).host.toLowerCase(); } catch { /* bad url */ }
    const httpsOk = (j.login_url as string).startsWith("https://");
    if (!httpsOk || !redeemHosts.includes(host)) {
      console.error("[login] 4.0 login_url rejected (host not allowlisted or not https):", host);
      return { kind: "misconfig" };
    }
    return { kind: "ok", login_url: j.login_url as string };
  }

  const err = String((j as { error?: unknown })?.error ?? "");
  if (err === "too_many_attempts") return { kind: "rate" };
  if (err === "unauthorized") { console.error("[login] 4.0 returned 'unauthorized' — OUR API key/allowlist is misconfigured"); return { kind: "misconfig" }; }
  return { kind: "fail" }; // invalid_credentials, user_type_not_allowed, etc. -> generic
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const started = Date.now();
  const ip = clientIp(req) ?? "0.0.0.0";
  const done = async (status: number, body: Record<string, unknown>): Promise<NextResponse> => {
    await floor(started);
    return NextResponse.json(body, { status });
  };

  let username = "", password = "", next = "/dashboard";
  try {
    const b = await req.json();
    username = String(b?.username ?? "").trim();
    password = String(b?.password ?? "");
    next = safeNext(b?.next);
  } catch { /* malformed */ }

  if (!username || !password) return done(400, { ok: false, error: ERR_CREDS });

  // Per-IP throttle across all attempts (blunt DoS/abuse cap; per worker).
  if (!rateLimit(`login-ip:${ip}`, 20, 60_000)) {
    return done(429, { ok: false, error: ERR_RATE });
  }

  const email = username.toLowerCase();
  const emailMode = isEmail(username);

  // ── 5.0 first (email usernames only) ──────────────────────────────────────
  if (emailMode) {
    const lockKey = `login-fail:${email}`;
    if (isLocked(lockKey)) {
      recordAuthEvent({ event: "password_verify", result: "failure", email, detail: "per-email lockout", req });
      return done(429, { ok: false, error: ERR_RATE });
    }
    const supabase = createClient(); // server client — sets session cookies on success
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (!error && data?.session) {
      clearFails(lockKey);
      recordAuthEvent({ event: "password_verify", result: "success", email, userId: data.user?.id, req });
      // Cookies are already attached to the outgoing response by the ssr client.
      // Success returns immediately — no timing floor (see FAIL_FLOOR_MS note).
      return NextResponse.json({ ok: true, redirect: next });
    }
    // 5.0 failed — strike, then fall through to 4.0 (the email may be a 4.0 login).
    registerFail(lockKey);
    recordAuthEvent({ event: "password_verify", result: "failure", email, detail: "5.0 invalid", req });
  }

  // ── 4.0 SSO handoff ───────────────────────────────────────────────────────
  const r = await call40(username, password);
  if (r.kind === "ok") {
    recordAuthEvent({ event: "password_verify", result: "success", email: emailMode ? email : null, detail: "4.0 handoff", req });
    return NextResponse.json({ ok: true, redirect: r.login_url }); // success: no floor
  }
  if (r.kind === "rate") return done(429, { ok: false, error: ERR_RATE });
  if (r.kind === "misconfig") return done(400, { ok: false, error: ERR_GENERIC });
  return done(401, { ok: false, error: ERR_CREDS });
}
