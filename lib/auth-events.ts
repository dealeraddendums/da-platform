// Application-level auth-event log (migration 155).
//
// GoTrue's own audit trail is unavailable on this project — `audit_log_disable_
// postgres` is true and hosted Supabase won't let us clear it — so
// `auth.audit_log_entries` has never had a row. That is why the 2026-09-03
// forensics couldn't answer "did this account ever sign in?" from the auth
// layer: sessions cascade-delete with the user, and nothing else recorded an
// attempt.
//
// Every write is fire-and-forget through fireWrite(): an auth event must never
// be able to fail a login. (fireWrite exists because bare supabase-js builders
// are lazy — 14 audit writes across this codebase were silent no-ops until it
// was introduced.)

import { createAdminSupabaseClient, fireWrite } from "@/lib/db";
import type { NextRequest } from "next/server";

export type AuthEventName =
  | "otp_code_requested"
  | "otp_verify"
  | "passkey_verify"
  | "password_verify"
  | "invite_accept"
  | "impersonate"
  | "ghost_enter"
  | "signout";

/** Client IP as seen by the app. nginx now sets $remote_addr from the ALB's
 *  X-Forwarded-For, and passes the chain through, so the first hop here is the
 *  real browser address. */
export function clientIp(req: NextRequest | Request): string | null {
  const h = (req as Request).headers;
  const xff = h.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return h.get("x-real-ip") ?? null;
}

export function clientUserAgent(req: NextRequest | Request): string | null {
  return (req as Request).headers.get("user-agent");
}

export function recordAuthEvent(args: {
  event: AuthEventName;
  result: "success" | "failure";
  email?: string | null;
  userId?: string | null;
  detail?: string | null;
  req?: NextRequest | Request;
  ip?: string | null;
  userAgent?: string | null;
  /** 'client' for browser-reported events (see the column comment in 155). */
  source?: "server" | "client";
}): void {
  try {
    const admin = createAdminSupabaseClient();
    fireWrite(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (admin as any).from("auth_events").insert({
        event: args.event,
        result: args.result,
        email: args.email?.trim().toLowerCase() ?? null,
        user_id: args.userId ?? null,
        detail: args.detail ?? null,
        ip: args.ip ?? (args.req ? clientIp(args.req) : null),
        user_agent: (args.userAgent ?? (args.req ? clientUserAgent(args.req) : null))?.slice(0, 400) ?? null,
        source: args.source ?? "server",
      }),
      "auth_events",
    );
  } catch (err) {
    // Never let logging break auth.
    console.error("[auth-events] record failed:", err instanceof Error ? err.message : err);
  }
}
