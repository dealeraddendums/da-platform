// Entry-point memory for the group_admin "Switch to Dealer" → "Back to Group" flow.
//
// When a group_admin switches into a member dealer we remember the path they came
// from (My Group vs. the Dealers list), so exiting the dealer drops them back
// exactly where they started instead of a fixed page. A cookie (not localStorage)
// is used so it survives the full-page `window.location` navigation into /dashboard.

const RETURN_COOKIE = "da_dealer_return_to";
const TTL_SECONDS = 1800; // 30 min — covers a work session without lingering indefinitely

/** Remember the current path before switching into a dealer. Call before navigating to /dashboard. */
export function rememberDealerReturnPath(): void {
  if (typeof document === "undefined") return;
  const path = window.location.pathname;
  document.cookie = `${RETURN_COOKIE}=${encodeURIComponent(path)}; path=/; max-age=${TTL_SECONDS}; SameSite=Lax`;
}

/**
 * Read and clear the stored return path. Returns null if none is stored.
 * Only internal absolute paths are returned — a tampered cookie can't drive an
 * open redirect off-site.
 */
export function takeDealerReturnPath(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|;\s*)da_dealer_return_to=([^;]*)/);
  // Clear regardless of whether we end up using it.
  document.cookie = `${RETURN_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
  if (!match) return null;
  const val = decodeURIComponent(match[1]);
  return val.startsWith("/") && !val.startsWith("//") ? val : null;
}
