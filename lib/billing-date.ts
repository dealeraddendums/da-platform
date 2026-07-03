// Timezone-safe formatting for da-billing date fields (nextInvoiceDate, invoice
// date/dueDate). da-billing stores these in two shapes:
//   - a bare calendar date "YYYY-MM-DD" (the subscription upgrade path + manual edits)
//   - a full ISO timestamp anchored to 11 PM America/New_York (da-billing's default
//     nextInvoiceDate + the post-generation monthly roll)
//
// A bare date parses to UTC midnight; formatting it in the viewer's local zone
// (ET is UTC-4/5) shifts it to the previous calendar day — the "Jul 3 shows as
// Jul 2" bug. So render a bare date as its literal calendar day (UTC), and render
// a full timestamp in America/New_York so the 11 PM ET anchor lands on the
// intended day rather than rolling into the next UTC day.
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function formatBillingDate(v: string | null | undefined): string {
  if (!v) return "—";
  const bare = BARE_DATE.test(v);
  const date = new Date(bare ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: bare ? "UTC" : "America/New_York",
  });
}
