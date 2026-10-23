// Display helpers shared by the /crm pages (server + client safe).

const TZ = "America/Los_Angeles";

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " PT";
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric", year: "numeric" });
}

/** "3h ago", "2d ago" — for list columns. */
export function fmtAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return fmtDate(iso);
}

export function contactName(c: { first_name?: string | null; last_name?: string | null; email?: string | null } | null | undefined): string {
  if (!c) return "—";
  const n = [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
  return n || c.email || "Unnamed contact";
}

export const ROLE_TAG_LABEL: Record<string, string> = {
  decision_maker: "Decision maker", fi: "F&I", gm: "GM", admin: "Admin", other: "Other", approver: "Approver",
};

/** Start of "today" in Pacific time, as an ISO instant. */
export function startOfTodayPT(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    .formatToParts(now).reduce<Record<string, string>>((a, p) => { a[p.type] = p.value; return a; }, {});
  const elapsed = ((Number(parts.hour) % 24) * 3600 + Number(parts.minute) * 60 + Number(parts.second)) * 1000;
  return new Date(Math.floor(now.getTime() / 1000) * 1000 - elapsed).toISOString();
}

export function formatDuration(sec: number | null | undefined): string {
  if (!sec) return "0s";
  const m = Math.floor(sec / 60), s = sec % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

export const STAGES = ["trial", "setup_training", "paying", "cancelled", "lost"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABEL: Record<Stage, string> = {
  trial: "Trial", setup_training: "Account setup & training", paying: "Paying", cancelled: "Cancelled", lost: "Lost",
};
export const KIND_LABEL: Record<string, string> = { dealer: "Dealer", group: "Group", vendor: "Vendor", feed_supplier: "Feed supplier" };
export const ROLE_TAGS = ["decision_maker", "fi", "gm", "admin", "other", "approver"] as const;

/** Whole days between an instant and now (for "days since last contact"). */
export function daysSince(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  return Math.max(0, Math.floor((now - Date.parse(iso)) / 86_400_000));
}
