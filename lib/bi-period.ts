// Shared date-range resolution for the BI endpoints. Default window is the
// PREVIOUS calendar month (today Jun 8 → May 1–31). Custom from/to are
// validated YYYY-MM-DD and must be ordered.

import { NextResponse } from "next/server";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function previousCalendarMonth(now: Date = new Date()): { from: string; to: string } {
  // First day of the previous month and its last day, in UTC.
  const firstOfThis = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastOfPrev = new Date(firstOfThis.getTime() - 24 * 60 * 60 * 1000);
  const firstOfPrev = new Date(Date.UTC(lastOfPrev.getUTCFullYear(), lastOfPrev.getUTCMonth(), 1));
  return {
    from: firstOfPrev.toISOString().slice(0, 10),
    to: lastOfPrev.toISOString().slice(0, 10),
  };
}

export function resolvePeriod(
  fromParam: string | null,
  toParam: string | null,
): { from: string; to: string; errorResponse: NextResponse | null } {
  if (!fromParam && !toParam) {
    return { ...previousCalendarMonth(), errorResponse: null };
  }
  if (!fromParam || !toParam || !DATE_RE.test(fromParam) || !DATE_RE.test(toParam)) {
    return {
      from: "", to: "",
      errorResponse: NextResponse.json(
        { error: "from and to must both be provided as YYYY-MM-DD" },
        { status: 400 },
      ),
    };
  }
  if (fromParam > toParam) {
    return {
      from: "", to: "",
      errorResponse: NextResponse.json({ error: "from must be on or before to" }, { status: 400 }),
    };
  }
  return { from: fromParam, to: toParam, errorResponse: null };
}
