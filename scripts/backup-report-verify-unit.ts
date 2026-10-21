/* npm run test:backup-report — lib/backup-report.ts (backup-supabase summary + backup-check watchdog). */
import { backupSummaryLine, buildBackupReport, evaluateFreshness, formatBytes, formatDuration, missingBackupSubject } from "../lib/backup-report";

let fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`}`);
}

const t0 = new Date("2026-10-21T09:00:00Z"), t1 = new Date("2026-10-21T10:52:30Z");
const okRun = buildBackupReport("2026-10-21", t0, t1, [
  { project: "da-platform", table: "dealers", ok: true, rows: 2177, bytes: 420_000 },
  { project: "da-platform", table: "dealer_vehicles", ok: true, rows: 2_790_020, bytes: 1_300_000_000 },
  { project: "da-billing", table: "kv_store_0ecc29ad", ok: true, rows: 5131, bytes: 500_000 },
]);
eq("ok run: status / counts / bytes / duration", [okRun.status, okRun.tables_ok, okRun.tables_failed, okRun.total_bytes, okRun.duration_s], ["ok", 3, 0, 1_300_920_000, 6750]);
eq("ok run: summary line", backupSummaryLine(okRun), "[DA Backup] OK 2026-10-21 · 3/3 tables · 1.30 GB · 1h52m");

const partial = buildBackupReport("2026-10-21", t0, t1, [
  { project: "da-platform", table: "dealers", ok: true, rows: 1, bytes: 10 },
  { project: "da-billing", table: "invoices", ok: false, error: "HTTP 404" },
]);
eq("partial run: status + failed tables named", backupSummaryLine(partial), "[DA Backup] PARTIAL 2026-10-21 · 1/2 tables · 10 B · 1h52m · failed: da-billing/invoices");
eq("all failed → FAILED", buildBackupReport("d", t0, t1, [{ project: "p", table: "t", ok: false, error: "x" }]).status, "failed");
eq("no tables at all → FAILED (never OK)", buildBackupReport("d", t0, t1, []).status, "failed");
eq("bytes formatting", [formatBytes(999), formatBytes(42_000), formatBytes(1_400_000), formatBytes(1_330_000_000)], ["999 B", "42 KB", "1.4 MB", "1.33 GB"]);
eq("duration formatting", [formatDuration(45), formatDuration(125), formatDuration(6750)], ["45s", "2m05s", "1h52m"]);

const now = new Date("2026-10-22T14:00:00Z");
const obj = (key: string, iso: string) => ({ key, lastModified: new Date(iso) });
eq("fresh: object 12 h old", evaluateFreshness([obj("da-platform/2026-10-22/dealers.json.gz", "2026-10-22T02:00:00Z")], now).fresh, true);
eq("stale: newest 37 h old", evaluateFreshness([obj("da-platform/2026-10-21/dealers.json.gz", "2026-10-21T01:00:00Z")], now), { fresh: false, newest: "2026-10-21T01:00:00.000Z", objects: 1, ageHours: 37 });
eq("boundary: exactly 36 h counts as fresh", evaluateFreshness([obj("da-billing/2026-10-21/x.json.gz", "2026-10-21T02:00:00Z")], now).fresh, true);
eq("report files alone don't count as a backup", evaluateFreshness([obj("_reports/latest.json", "2026-10-22T13:00:00Z")], now).fresh, false);
eq("nothing at all → not fresh, newest null", evaluateFreshness([], now), { fresh: false, newest: null, objects: 0, ageHours: null });
eq("missing subject (stale)", missingBackupSubject(evaluateFreshness([obj("da-platform/2026-10-20/d.json.gz", "2026-10-20T10:00:00Z")], now)),
  "[DA Backup] MISSING · no backup object in the last 36 h · newest 2026-10-20 10:00 UTC (52 h old)");
eq("missing subject (none)", missingBackupSubject(evaluateFreshness([], now)), "[DA Backup] MISSING · no backup object in the last 36 h · none in the last 3 days");

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
