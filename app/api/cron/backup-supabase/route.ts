import { NextRequest, NextResponse } from "next/server";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const dynamic = "force-dynamic";

const LOCK = "/tmp/da-backup-supabase.lock";
const LOG = "/var/log/da-platform/backup-supabase.log";

/**
 * POST /api/cron/backup-supabase (X-Cron-Secret) — EasyCron 10944634, 02:00 PT.
 * Starts scripts/backup-supabase.ts (lib/backup-supabase.ts) as its own process
 * and returns at once. The run takes 3 h+; inside a PM2 worker it died on every
 * deploy's `pm2 reload` and every memory restart (2026-10-21), so it is started
 * through `sh -c '… &'`: the shell exits immediately and the run is re-parented
 * away from the worker, out of reach of PM2's tree-kill. `flock -n` keeps it to
 * one run at a time (409 while one is going). Output → backup-supabase.log.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Resolve `current` → the real release dir, so a later deploy's symlink flip doesn't move files under the run.
  const root = fs.realpathSync(process.cwd());
  const tsx = path.join(root, "node_modules/tsx/dist/cli.mjs");
  const script = path.join(root, "scripts/backup-supabase.ts");
  if (!fs.existsSync(tsx) || !fs.existsSync(script)) {
    return NextResponse.json({ error: "backup script not found", root }, { status: 500 });
  }

  if (spawnSync("flock", ["-n", LOCK, "true"]).status !== 0) {
    return NextResponse.json({ ok: false, error: "a backup run is already in progress" }, { status: 409 });
  }

  const cmd = `setsid flock -n ${LOCK} ${process.execPath} ${tsx} ${script} >> ${LOG} 2>&1 < /dev/null &`;
  const child = spawn("/bin/sh", ["-c", cmd], { cwd: root, detached: true, stdio: "ignore" });
  child.unref();

  const date = new Date().toISOString().slice(0, 10);
  console.log(`[backup-supabase] started detached run for ${date} from ${root} (log ${LOG})`);
  return NextResponse.json({ ok: true, started: true, date, log: LOG });
}
