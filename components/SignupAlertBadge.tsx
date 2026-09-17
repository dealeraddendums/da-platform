"use client";

// The "trial signups need attention" badge in the admin topbar.
//
// Why it exists: the only way anyone noticed a signup waiting on us was to
// remember to open /admin/trial-signups. This puts the count on EVERY admin
// page so nobody has to remember.
//
// Design system only — orange #ffa500 on the navy #2a2b3c topbar is the
// established alert/active accent, Roboto is inherited, and the glyph is the
// same inline SVG weight used elsewhere in the chrome. No new colours.
//
// Renders NOTHING at zero. A badge that is always present stops being a signal,
// and a "0" would train people to ignore it.

import { useCallback, useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";

type Counts = {
  total: number;
  needsReview: number;
  stuck: number | null;
  stuckAvailable: boolean;
};

const POLL_MS = 60_000;

/** Fired by the signups page after an approve/provision so the count drops at once. */
export const SIGNUP_COUNT_REFRESH_EVENT = "da:signup-count-refresh";

export default function SignupAlertBadge() {
  const [counts, setCounts] = useState<Counts | null>(null);
  const router = useRouter();
  const pathname = usePathname();

  // `fresh` bypasses the server's per-worker count cache. Used by the
  // post-action refresh and on navigation, so a just-cleared item disappears
  // immediately instead of lingering for up to the cache TTL on whichever
  // worker answers. The background poll leaves the cache alone.
  const load = useCallback(async (fresh = false) => {
    try {
      const res = await fetch(`/api/admin/trial-signups/pending-count${fresh ? "?fresh=1" : ""}`, { cache: "no-store" });
      // 403 = a role that can't act on the queue. Stay silent rather than
      // rendering a count the viewer can do nothing about.
      if (!res.ok) { setCounts(null); return; }
      setCounts(await res.json() as Counts);
    } catch {
      // Network blip: keep the last known count rather than flicking to zero,
      // which would read as "all clear" when we simply don't know.
    }
  }, []);

  useEffect(() => {
    void load(true);
    const id = setInterval(() => void load(), POLL_MS);
    const onRefresh = () => void load(true);
    window.addEventListener(SIGNUP_COUNT_REFRESH_EVENT, onRefresh);
    return () => { clearInterval(id); window.removeEventListener(SIGNUP_COUNT_REFRESH_EVENT, onRefresh); };
  }, [load]);

  // Re-check on admin navigation — someone who just cleared the queue on
  // another page should see it reflected without waiting out the poll.
  useEffect(() => { void load(true); }, [pathname, load]);

  if (!counts || counts.total < 1) return null;

  const parts: string[] = [];
  if (counts.needsReview > 0) parts.push(`${counts.needsReview} awaiting approval`);
  if (counts.stuck && counts.stuck > 0) parts.push(`${counts.stuck} unconfirmed lead${counts.stuck === 1 ? "" : "s"}`);
  if (!counts.stuckAvailable) parts.push("unconfirmed leads unavailable");
  const tooltip = `${parts.join(" · ")} — click to review`;

  return (
    <button
      type="button"
      onClick={() => router.push("/admin/trial-signups")}
      title={tooltip}
      aria-label={`Trial signups need attention: ${tooltip}`}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        height: 28, padding: "0 10px",
        background: "#ffa500", color: "#2a2b3c",
        border: "none", borderRadius: 14,
        fontSize: 12, fontWeight: 700, lineHeight: 1,
        cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0,
      }}
    >
      {/* Inbox/tray glyph — "something is waiting for you". */}
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M22 12h-6l-2 3h-4l-2-3H2" />
        <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
      </svg>
      {counts.total}
      <span style={{ fontWeight: 600 }}>
        {counts.total === 1 ? "signup needs attention" : "signups need attention"}
      </span>
    </button>
  );
}
