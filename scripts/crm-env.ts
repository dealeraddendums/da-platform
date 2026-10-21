// Env for DA-CRM scripts — every file by explicit absolute path, so a script
// behaves the same from any cwd (repo checkout, a release dir under
// /var/www/da-platform/releases/…, or `current/`). First file to define a key
// wins; values are never printed (quiet: true).
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { CRM_ENV_FILES } from "../lib/crm/env";

const REPO = path.resolve(__dirname, "..");

export const SCRIPT_ENV_FILES = Array.from(new Set([
  ...CRM_ENV_FILES,                                  // $CRM_ENV_FILE, /var/www/da-platform/.env.local
  path.join(REPO, ".env.local"),
  "/var/www/da-platform/shared/.env.production",     // Supabase / AWS on the prod box
  path.join(REPO, ".env.production"),
]));

export function loadScriptEnv(): void {
  for (const file of SCRIPT_ENV_FILES) {
    if (fs.existsSync(file)) dotenv.config({ path: file, override: false, quiet: true });
  }
}
