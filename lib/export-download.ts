// "Download CSV" proof for self-service exports (dealer + group). Generates
// exactly what a push would send from the export's SAVED config and returns it
// as a browser download. Never pushes, never records a push, never touches the
// schedule — it only calls the generator.

import JSZip from "jszip";
import { NextResponse } from "next/server";
import { generateFeedCsv, type FeedCompanyRow } from "@/lib/feed-export";

const slug = (s: string) => s.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "export";

/** YYYYMMDD in Pacific time (the business day the operator is in). */
function stamp(): string {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date());
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}`;
}

function file(body: string | ArrayBuffer, name: string, type: string): NextResponse {
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}

/**
 * `dealer`:
 *   - omitted / "combined" → ONE CSV, exactly the file a push sends (every
 *     covered dealer in one file) — the default, since that's what the
 *     provider receives;
 *   - a dealer_uuid → that dealer's rows only;
 *   - "zip" (or legacy "all") → a ZIP with one CSV per dealer plus the
 *     combined file. A single-dealer export always returns plain CSV.
 */
export async function exportDownload(feed: FeedCompanyRow, dealer: string | null): Promise<NextResponse> {
  const name = slug(feed.name);
  const day = stamp();
  try {
    const wantZip = dealer === "zip" || dealer === "all";
    if (dealer && dealer !== "combined" && !wantZip) {
      if (!/^[0-9a-f-]{36}$/i.test(dealer)) return NextResponse.json({ error: "Not found" }, { status: 404 });
      const r = await generateFeedCsv(feed.id, { onlyDealerUuids: [dealer] });
      const d = r.perDealer[0];
      if (!d) return NextResponse.json({ error: "That dealership isn't in this export." }, { status: 404 });
      return file(d.csv, `${name}-${slug(d.feedDealerId)}-${day}.csv`, "text/csv; charset=utf-8");
    }

    const r = await generateFeedCsv(feed.id);
    if (r.perDealer.length === 0) return NextResponse.json({ error: "This export doesn't cover any dealerships yet." }, { status: 404 });
    if (r.perDealer.length === 1) {
      // One dealer: its file IS the combined file a push sends.
      return file(r.csv, `${name}-${slug(r.perDealer[0].feedDealerId)}-${day}.csv`, "text/csv; charset=utf-8");
    }
    if (!wantZip) return file(r.csv, `${name}-ALL-DEALERS-${day}.csv`, "text/csv; charset=utf-8");
    const zip = new JSZip();
    const used = new Set<string>();
    for (const d of r.perDealer) {
      let fn = `${name}-${slug(d.feedDealerId)}-${day}.csv`;
      for (let n = 2; used.has(fn); n++) fn = `${name}-${slug(d.feedDealerId)}-${n}-${day}.csv`;
      used.add(fn);
      zip.file(fn, d.csv);
    }
    zip.file(`${name}-ALL-DEALERS-as-pushed-${day}.csv`, r.csv);
    const bytes = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
    return file(bytes, `${name}-${day}.zip`, "application/zip");
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Couldn't generate the file" }, { status: 500 });
  }
}
