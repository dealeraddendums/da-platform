// DA-CRM secrets loader. On prod the CRM secrets (DIALPAD_API_KEY,
// DIALPAD_WEBHOOK_SECRET, MS_CLIENT_ID / MS_CLIENT_SECRET / MS_TENANT_ID, …)
// live in /var/www/da-platform/.env.local — OUTSIDE the release dir PM2 runs
// from (`current/`, which only symlinks shared/.env.production), so Next never
// auto-loads it. Every CRM read goes through crmEnv(), which loads that file
// once by explicit path. Existing process.env values always win (override:
// false), and values are never logged.
//
// Search order: $CRM_ENV_FILE, /var/www/da-platform/.env.local, then the
// repo's own .env.local (local dev / scripts).
// Parsed in-house (dotenv is only a devDependency — not guaranteed at runtime).
import * as fs from "fs";
import * as path from "path";

export const CRM_ENV_FILES = [
  process.env.CRM_ENV_FILE,
  "/var/www/da-platform/.env.local",
  path.join(process.cwd(), ".env.local"),
].filter((f): f is string => !!f);

let loaded = false;

export function loadCrmEnv(): void {
  if (loaded) return;
  loaded = true;
  for (const file of CRM_ENV_FILES) {
    try {
      if (!fs.existsSync(file)) continue;
      for (const [k, v] of Object.entries(parseEnvFile(fs.readFileSync(file, "utf8")))) {
        if (process.env[k] === undefined) process.env[k] = v;
      }
    } catch (e) {
      console.error(`[crm-env] could not read ${file}:`, e instanceof Error ? e.message : "error");
    }
  }
}

export function crmEnv(name: string): string | undefined {
  loadCrmEnv();
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

/** KEY=VALUE lines; `export ` prefix, # comments, single/double quotes (\\n in double). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/.exec(line);
    if (!m) continue;
    let v = (m[2] ?? "").trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1).replace(/\\n/g, "\n");
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}
