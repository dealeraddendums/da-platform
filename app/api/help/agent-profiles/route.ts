import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { staffPhotosByEmail } from "@/lib/staff-photos";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

function secretOk(given: string | null): boolean {
  const want = process.env.MARKETING_WEBHOOK_SECRET;
  if (!want || !given) return false;
  const a = Buffer.from(want), b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * POST { emails: string[] } (X-Webhook-Secret) → { photos: { [email]: url } }.
 * The homepage chat (da-marketing-os) asks which agents have a staff headshot,
 * for the takeover header. Staff accounts only (lib/staff-photos.ts).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!secretOk(req.headers.get("x-webhook-secret"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => ({})) as { emails?: unknown };
  const emails = Array.isArray(b.emails) ? (b.emails as unknown[]).filter((e): e is string => typeof e === "string").slice(0, 20) : [];
  const photos = await staffPhotosByEmail(emails);
  return NextResponse.json({ photos: Object.fromEntries(photos) });
}
