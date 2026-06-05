import crypto from "crypto";

// Scanner-proof invite setup code. The invite email carries this 8-digit code
// (not just a clickable link); the invitation is consumed only when the human
// submits the code (POST /api/invite/accept verifies it server-side). Mail
// scanners (Barracuda, Safe Links, etc.) pre-fetch and even submit forms behind
// links, but cannot read and re-type a one-time code — so a pre-touch can never
// consume the invite. Mirrors the scanner-proof OTP onboarding flow.

/** 8-digit numeric code, leading zeros preserved. */
export function generateSetupCode(): string {
  return String(crypto.randomInt(0, 100_000_000)).padStart(8, "0");
}

/** SHA-256 hex of the code — only the hash is stored on the invitation row. */
export function hashSetupCode(code: string): string {
  return crypto.createHash("sha256").update(code.trim()).digest("hex");
}

/** Constant-time compare of a submitted code against a stored hash. */
export function verifySetupCode(submitted: string, storedHash: string | null): boolean {
  if (!storedHash) return false;
  const a = Buffer.from(hashSetupCode(submitted), "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
