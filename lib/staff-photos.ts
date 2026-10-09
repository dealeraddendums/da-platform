// Staff headshots for the chat takeover header (migration 172, 2026-10-09).
// A HubSpot agent is matched to their DA account by EMAIL; only STAFF
// (super_admin) accounts resolve, so a dealer user's photo can never surface
// in the widget. Returns public URLs only — never emails or ids.
import { createAdminSupabaseClient } from "@/lib/db";

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; url: string | null }>();

export async function staffPhotosByEmail(emails: (string | null | undefined)[]): Promise<Map<string, string>> {
  const want = Array.from(new Set(emails.map((e) => (e ?? "").trim().toLowerCase()).filter(Boolean)));
  const out = new Map<string, string>();
  const missing = want.filter((e) => { const c = cache.get(e); if (c && Date.now() - c.at < TTL_MS) { if (c.url) out.set(e, c.url); return false; } return true; });
  if (missing.length) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (createAdminSupabaseClient() as any).from("profiles")
      .select("email, headshot_url").eq("role", "super_admin").in("email", missing).limit(50);
    const found = new Map<string, string | null>(((data ?? []) as { email: string; headshot_url: string | null }[])
      .map((r) => [r.email.trim().toLowerCase(), r.headshot_url]));
    for (const e of missing) {
      const url = found.get(e) ?? null;
      cache.set(e, { at: Date.now(), url });
      if (url) out.set(e, url);
    }
  }
  return out;
}
