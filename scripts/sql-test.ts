// Run a SQL test file against the database through the Supabase Management API. The file's DO block ends
// with RAISE EXCEPTION '<MARKER> all passed …' / '<MARKER> n of m failed: …', which also aborts the
// transaction, so fixtures never persist. Token: SUPABASE_ACCESS_TOKEN, else (macOS) the Supabase CLI's
// keychain entry. Never printed.
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

const ROOT = path.resolve(__dirname, "..");

function token(): string {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN;
  if (process.platform === "darwin") {
    const raw = execSync('security find-generic-password -s "Supabase CLI" -a supabase -w', { encoding: "utf8" }).trim();
    return raw.startsWith("go-keyring-base64:") ? Buffer.from(raw.slice(18), "base64").toString("utf8") : raw;
  }
  throw new Error("Set SUPABASE_ACCESS_TOKEN");
}

/** Returns true when the file reported "all passed"; prints the result line. `prepend` = repo-relative SQL files run first (e.g. an unapplied migration). */
export async function runSqlTest(file: string, marker: string, prepend: string[] = []): Promise<boolean> {
  const project = process.env.SUPABASE_PROJECT_REF ?? "byouefbebqgffhtfdggu";
  const sql = [...prepend, file].map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");
  const res = await fetch(`https://api.supabase.com/v1/projects/${project}/database/query`, {
    method: "POST", headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: `begin;\n${sql}` }),
  });
  const body = await res.text();
  const m = body.match(new RegExp(`${marker} ([^"\\\\]*)`));
  if (!m) { console.error(`Unexpected response (${res.status}): ${body.slice(0, 500)}`); return false; }
  console.log(m[1]);
  return m[1].startsWith("all passed");
}
