/**
 * Supabase backup self-reporting (POST /api/cron/backup-supabase, POST /api/cron/backup-check).
 *
 * Every nightly run ends with one summary — tables, total size, duration, status —
 * written three places:
 *   - the PM2 log (`[backup-supabase] SUMMARY …`)
 *   - S3: s3://da-platform-backups/_reports/<date>.json (+ _reports/latest.json)
 *   - an email to allan@ whose subject IS the summary line ("[DA Backup] OK …"),
 *     which the Morning Brief reads.
 * backup-check (daily, after the run) independently checks the bucket and emails
 *   - "[DA Backup] MISSING …"    no backup object newer than 36 h (the run never started), or
 *   - "[DA Backup] INCOMPLETE …" objects exist but no run REPORT finished in 36 h — the run was
 *     killed mid-way (a deploy's pm2 reload or a memory restart kills this fire-and-forget job).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { sendMandrillEmail } from "./mandrill";

export const BACKUP_PROJECTS = ["da-platform", "da-billing"] as const;
export const BACKUP_MAX_AGE_HOURS = 36;
const REPORT_TO = [{ email: "allan@dealeraddendums.com", name: "Allan Tone", type: "to" as const }];

export type BackupTableResult = { project: string; table: string; ok: boolean; rows?: number; bytes?: number; error?: string };

export type BackupReport = {
  date: string;
  started_at: string;
  finished_at: string;
  duration_s: number;
  status: "ok" | "partial" | "failed";
  tables_ok: number;
  tables_failed: number;
  total_bytes: number;
  tables: BackupTableResult[];
};

export function buildBackupReport(date: string, startedAt: Date, finishedAt: Date, tables: BackupTableResult[]): BackupReport {
  const ok = tables.filter((t) => t.ok).length;
  const failed = tables.length - ok;
  return {
    date,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_s: Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
    status: failed === 0 && ok > 0 ? "ok" : ok === 0 ? "failed" : "partial",
    tables_ok: ok,
    tables_failed: failed,
    total_bytes: tables.reduce((n, t) => n + (t.ok ? t.bytes ?? 0 : 0), 0),
    tables,
  };
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

export function formatDuration(s: number): string {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, "0")}m` : m ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/** The one-line summary — also the email subject the Morning Brief looks for. */
export function backupSummaryLine(r: BackupReport): string {
  const total = r.tables_ok + r.tables_failed;
  return `[DA Backup] ${r.status.toUpperCase()} ${r.date} · ${r.tables_ok}/${total} tables · ${formatBytes(r.total_bytes)} · ${formatDuration(r.duration_s)}`
    + (r.tables_failed ? ` · failed: ${r.tables.filter((t) => !t.ok).map((t) => `${t.project}/${t.table}`).join(", ")}` : "");
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function reportHtml(r: BackupReport): string {
  const rows = r.tables.map((t) =>
    `<tr><td>${esc(t.project)}/${esc(t.table)}</td><td style="text-align:right">${t.ok ? (t.rows ?? 0).toLocaleString("en-US") : "—"}</td>`
    + `<td style="text-align:right">${t.ok ? formatBytes(t.bytes ?? 0) : "—"}</td><td>${t.ok ? "ok" : `<strong>failed</strong>: ${esc(t.error ?? "")}`}</td></tr>`).join("");
  return `<div style="font-family:Roboto,Arial,sans-serif;font-size:14px;color:#2a2b3c">`
    + `<p>${esc(backupSummaryLine(r))}</p>`
    + `<p>Started ${esc(r.started_at)}, finished ${esc(r.finished_at)}. Objects are in s3://da-platform-backups/&lt;project&gt;/${esc(r.date)}/.</p>`
    + `<table cellpadding="4" style="border-collapse:collapse;font-size:13px"><tr><th align="left">Table</th><th>Rows</th><th>Size (gz)</th><th align="left">Status</th></tr>${rows}</table></div>`;
}

/** Log + S3 + email. Each channel is best-effort; one failing doesn't stop the others. */
export async function publishBackupReport(s3: S3Client, bucket: string, r: BackupReport): Promise<void> {
  const line = backupSummaryLine(r);
  console.log(`[backup-supabase] SUMMARY ${line}`);
  const body = JSON.stringify({ ...r, summary: line }, null, 1);
  for (const key of [`_reports/${r.date}.json`, "_reports/latest.json"]) {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/json" }))
      .catch((e) => console.error(`[backup-supabase] report ${key} not written:`, e instanceof Error ? e.message : e));
  }
  await sendMandrillEmail({ subject: line, from_email: "noreply@dealeraddendums.com", from_name: "DealerAddendums", to: REPORT_TO, html: reportHtml(r) })
    .catch((e) => console.error("[backup-supabase] report email not sent:", e instanceof Error ? e.message : e));
}

// ── Freshness check ──────────────────────────────────────────────────────────

export type BackupFreshness = { fresh: boolean; newest: string | null; objects: number; ageHours: number | null };
export type LatestReport = { date: string; status: string; finished_at: string; summary?: string } | null;
export type BackupHealth = BackupFreshness & { state: "ok" | "missing" | "incomplete"; report: LatestReport; reportAgeHours: number | null };

/** Pure: combine object freshness with the latest run report. */
export function evaluateBackupHealth(f: BackupFreshness, report: LatestReport, now: Date, maxAgeHours = BACKUP_MAX_AGE_HOURS): BackupHealth {
  const reportAgeHours = report?.finished_at ? (now.getTime() - new Date(report.finished_at).getTime()) / 3_600_000 : null;
  const state = !f.fresh ? "missing" : reportAgeHours === null || reportAgeHours > maxAgeHours ? "incomplete" : "ok";
  return { ...f, state, report, reportAgeHours };
}

/** Pure: is any backup object newer than `maxAgeHours`? (`_reports/` files don't count.) */
export function evaluateFreshness(objects: { key: string; lastModified: Date }[], now: Date, maxAgeHours = BACKUP_MAX_AGE_HOURS): BackupFreshness {
  const data = objects.filter((o) => !o.key.startsWith("_reports/"));
  const newest = data.reduce<Date | null>((m, o) => (!m || o.lastModified > m ? o.lastModified : m), null);
  const ageHours = newest ? (now.getTime() - newest.getTime()) / 3_600_000 : null;
  return { fresh: ageHours !== null && ageHours <= maxAgeHours, newest: newest?.toISOString() ?? null, objects: data.length, ageHours };
}

/** Lists only the date folders that could hold a fresh object (today and the two days before, UTC). */
export async function checkBackupFreshness(s3: S3Client, bucket: string, now = new Date()): Promise<BackupFreshness> {
  const dates = [0, 1, 2].map((d) => new Date(now.getTime() - d * 86_400_000).toISOString().slice(0, 10));
  const found: { key: string; lastModified: Date }[] = [];
  for (const project of BACKUP_PROJECTS) {
    for (const date of dates) {
      let token: string | undefined;
      do {
        const r: any = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${project}/${date}/`, ContinuationToken: token }));
        for (const o of r.Contents ?? []) if (o.Key && o.LastModified) found.push({ key: o.Key, lastModified: new Date(o.LastModified) });
        token = r.NextContinuationToken;
      } while (token);
    }
  }
  return evaluateFreshness(found, now);
}

export async function readLatestReport(s3: S3Client, bucket: string): Promise<LatestReport> {
  try {
    const r: any = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: "_reports/latest.json" }));
    const j = JSON.parse(await r.Body.transformToString());
    return { date: j.date, status: j.status, finished_at: j.finished_at, summary: j.summary };
  } catch (e: any) {
    if (e?.name === "NoSuchKey") return null;
    throw e;
  }
}

export function missingBackupSubject(f: BackupFreshness): string {
  return `[DA Backup] MISSING · no backup object in the last ${BACKUP_MAX_AGE_HOURS} h`
    + (f.newest ? ` · newest ${f.newest.slice(0, 16).replace("T", " ")} UTC (${Math.round(f.ageHours ?? 0)} h old)` : " · none in the last 3 days");
}

export function incompleteBackupSubject(h: BackupHealth): string {
  return `[DA Backup] INCOMPLETE · no finished run in the last ${BACKUP_MAX_AGE_HOURS} h (objects written, run never reported)`
    + (h.report ? ` · last report ${h.report.date} ${h.report.status.toUpperCase()}` : " · no report yet");
}

export async function sendBackupHealthAlert(h: BackupHealth): Promise<void> {
  if (h.state === "ok") return;
  const subject = h.state === "missing" ? missingBackupSubject(h) : incompleteBackupSubject(h);
  await sendMandrillEmail({
    subject,
    from_email: "noreply@dealeraddendums.com",
    from_name: "DealerAddendums",
    to: REPORT_TO,
    html: `<div style="font-family:Roboto,Arial,sans-serif;font-size:14px;color:#2a2b3c"><p>${esc(subject)}</p>`
      + (h.state === "missing"
        ? `<p>The nightly Supabase backup (EasyCron → POST /api/cron/backup-supabase, 02:00 PT) didn't leave a fresh object in s3://da-platform-backups.</p>`
        : `<p>The nightly run started (fresh objects exist) but never wrote its summary, so it was cut short. The usual cause is a deploy's <code>pm2 reload</code> or a memory restart of the worker it runs in; the tables after the cut-off are not in today's backup.</p>`)
      + `<p>Check the EasyCron job log and <code>/var/log/da-platform/out-*.log</code> for <code>[backup-supabase]</code>.</p></div>`,
  });
}
