import crypto from "crypto";

const GHOST_SECRET =
  process.env.GHOST_SECRET ?? "da-ghost-dev-secret-change-in-prod";

export type GhostContext = {
  // Dealer ghost (set when ghosting a specific dealer)
  dealer_id?: string;       // UUID (dealers.id)
  dealer_text_id?: string;  // text (dealers.dealer_id)
  dealer_name?: string;
  // Group ghost (set when ghosting a group — mutually exclusive with dealer fields)
  group_id?: string;        // UUID (groups.id)
  group_name?: string;
  // Always present
  super_admin_id: string;
  issued_at: number;
  expires_at: number;       // issued_at + 7200000 (2 hours)
};

export function signGhostToken(ctx: GhostContext): string {
  const payload = Buffer.from(JSON.stringify(ctx)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", GHOST_SECRET)
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyGhostToken(token: string): GhostContext | null {
  try {
    const dotIdx = token.lastIndexOf(".");
    if (dotIdx < 0) return null;
    const payload = token.slice(0, dotIdx);
    const sig = token.slice(dotIdx + 1);
    const expected = crypto
      .createHmac("sha256", GHOST_SECRET)
      .update(payload)
      .digest("base64url");
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
      return null;
    const ctx = JSON.parse(
      Buffer.from(payload, "base64url").toString()
    ) as GhostContext;
    if (Date.now() > ctx.expires_at) return null;
    return ctx;
  } catch {
    return null;
  }
}
