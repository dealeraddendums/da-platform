// Server-only: fire-and-forget VIN decode usage logging (migration 151).
// Must NEVER affect decode latency or failure behavior — everything here is
// wrapped and fired via fireWrite (supabase-js builders are lazy thenables;
// `void builder` alone never executes — the 2026-07-15 audit-write lesson).

import { createAdminSupabaseClient, fireWrite } from "./db";
import type { JwtClaims } from "./auth";

export type DecodeLogSource =
  | "override"
  | "pattern"
  | "vpic"
  | "dealer_vehicles"
  | "wmi_partial"
  | "failed"
  | "vpic_direct";

export function logVinDecode(
  claims: Pick<JwtClaims, "sub" | "role" | "dealer_id"> | null,
  vin: string,
  source: DecodeLogSource,
  success: boolean,
  durationMs: number,
): void {
  try {
    const admin = createAdminSupabaseClient();
    fireWrite(
      // vin_decode_log isn't in the generated Supabase types yet (migration 151).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (admin as any).from("vin_decode_log").insert({
        dealer_id: claims?.dealer_id ?? null,
        user_id: claims?.sub ?? null,
        role: claims?.role ?? null,
        vin,
        source,
        success,
        duration_ms: Math.round(durationMs),
      }),
      "vin_decode_log",
    );
  } catch (err) {
    console.error("[vin-decode-log]", err instanceof Error ? err.message : err);
  }
}
