/**
 * import-users.ts — Import active Aurora users → Supabase auth + profiles.
 * Sets temporary password "Welcome2DA!" and force_password_reset=true.
 * Skips users that already exist (matched by legacy_user_id in profiles).
 * Safe to re-run — resumes from last position via progress file.
 *
 * Run: npm run import:users
 *
 * After running, users must reset password on first login.
 */

import * as mysql from "mysql2/promise";
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.join(process.cwd(), ".env.local") });
dotenv.config({ path: path.join(process.cwd(), ".env.production") });

const TEMP_PASSWORD = "Welcome2DA!";
const DELAY_MS = 120; // between auth creates to avoid rate limits
const PROGRESS_FILE = path.join(process.cwd(), "import-users-progress.json");

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

interface Progress { lastId: number; imported: number; skipped: number; errors: number; startedAt: string }

function loadProgress(): Progress {
  if (fs.existsSync(PROGRESS_FILE)) {
    try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8")) as Progress; } catch { /* ignore */ }
  }
  return { lastId: 0, imported: 0, skipped: 0, errors: 0, startedAt: new Date().toISOString() };
}

function saveProgress(p: Progress) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

interface AuroraUser extends mysql.RowDataPacket {
  _ID: number;
  USERNAME: string | null;
  EMAIL: string | null;
  USER_TYPE: string | null;
  DEALER_ID: string | null;
  FULL_NAME: string | null;
  PHONE: string | null;
  ACTIVE: string | null;
  USER_IMAGE: string | null;
  HUBSPOT_CONTACT_ID: string | null;
  EMAIL_REPORT: number | null;
  REPORT_SEND_TO: string | null;
  LAST_LOGIN: Date | string | null;
  created_at: Date | string | null;
}

function mapRole(userType: string | null): string {
  if (!userType) return "dealer_user";
  const t = userType.toLowerCase().trim();
  if (t === "super_admin" || t === "superadmin") return "super_admin";
  if (t === "group_admin" || t === "groupadmin") return "group_admin";
  if (t === "group_user" || t === "groupuser") return "group_user";
  if (t === "admin" || t === "dealer_admin") return "dealer_admin";
  return "dealer_user";
}

function toTs(v: Date | string | null): string | null {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
  const s = String(v);
  if (!s || s.startsWith("0000")) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const start = Date.now();

  const pool = await mysql.createPool({
    host: process.env.AURORA_HOST,
    user: process.env.AURORA_USER,
    password: process.env.AURORA_PASSWORD,
    database: process.env.AURORA_DATABASE,
    port: parseInt(process.env.AURORA_PORT ?? "3306", 10),
    connectionLimit: 3,
    connectTimeout: 30000,
  });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });

  try {
    // Count active users
    const [countRows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS total FROM users WHERE ACTIVE = 'Yes' OR ACTIVE = '1'"
    );
    const total = (countRows[0] as { total: number }).total;
    console.log(`Active users in Aurora: ${total.toLocaleString()}`);

    // Load existing legacy_user_ids from Supabase to skip already-imported users
    console.log("Loading existing profiles...");
    const { data: existingProfiles } = await supabase
      .from("profiles")
      .select("legacy_user_id")
      .not("legacy_user_id", "is", null);
    const existingLegacyIds = new Set(
      (existingProfiles ?? []).map(p => p.legacy_user_id).filter(Boolean)
    );
    console.log(`Already imported: ${existingLegacyIds.size} users`);

    const progress = loadProgress();
    console.log(`Resuming from _ID > ${progress.lastId}`);

    const CHUNK = 100;

    while (true) {
      const [rows] = await pool.execute<AuroraUser[]>(
        `SELECT _ID, USERNAME, EMAIL, USER_TYPE, DEALER_ID, FULL_NAME,
                PHONE, ACTIVE, USER_IMAGE, HUBSPOT_CONTACT_ID,
                EMAIL_REPORT, REPORT_SEND_TO, LAST_LOGIN, created_at
         FROM users
         WHERE (ACTIVE = 'Yes' OR ACTIVE = '1') AND _ID > ?
         ORDER BY _ID ASC
         LIMIT ?`,
        [progress.lastId, CHUNK]
      );

      if (!rows.length) break;

      for (const r of rows) {
        progress.lastId = r._ID;

        // Skip if already imported
        if (existingLegacyIds.has(r._ID)) {
          progress.skipped++;
          continue;
        }

        // Build email — use EMAIL if valid, else fallback to username@dealeraddendums.com
        const rawEmail = r.EMAIL?.trim() ?? "";
        const email = rawEmail.includes("@") && rawEmail.length > 3
          ? rawEmail.toLowerCase()
          : `${(r.USERNAME ?? `user${r._ID}`).toLowerCase().replace(/\s+/g, ".")}@dealeraddendums.com`;

        const role = mapRole(r.USER_TYPE);
        const fullName = r.FULL_NAME?.trim() || r.USERNAME?.trim() || `User ${r._ID}`;

        // Create Supabase auth user
        const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
          email,
          password: TEMP_PASSWORD,
          email_confirm: true,
          app_metadata: {
            role,
            force_password_reset: true,
            legacy_user_id: r._ID,
          },
          user_metadata: {
            full_name: fullName,
          },
        });

        if (authErr) {
          // User already exists in auth — try to find and link profile
          if (authErr.message?.toLowerCase().includes("already") ||
              authErr.message?.toLowerCase().includes("exists")) {
            // Look up existing auth user by email
            const { data: listData } = await supabase.auth.admin.listUsers({ perPage: 1, page: 1 });
            // We can't search by email directly in listUsers easily; just update profile if it exists
            const { error: profileErr } = await supabase
              .from("profiles")
              .update({
                legacy_user_id: r._ID,
                role: role as never,
                dealer_id: r.DEALER_ID ?? null,
                phone: r.PHONE ?? null,
                user_image: r.USER_IMAGE ?? null,
                hubspot_contact_id: r.HUBSPOT_CONTACT_ID ?? null,
                email_report: r.EMAIL_REPORT ?? null,
                report_send_to: r.REPORT_SEND_TO ?? null,
                last_login: toTs(r.LAST_LOGIN),
                active: true,
              } as never)
              .eq("email", email);
            if (!profileErr) {
              progress.imported++;
              existingLegacyIds.add(r._ID);
            } else {
              progress.errors++;
              console.warn(`  Profile update failed for ${email}: ${profileErr.message}`);
            }
          } else {
            progress.errors++;
            console.warn(`  Auth create failed for _ID=${r._ID} (${email}): ${authErr.message}`);
          }
          saveProgress(progress);
          await sleep(DELAY_MS);
          continue;
        }

        const userId = authData.user?.id;
        if (!userId) { progress.errors++; continue; }

        // Upsert profile with full details
        const { error: profileErr } = await supabase
          .from("profiles")
          .upsert({
            id: userId,
            email,
            full_name: fullName,
            role: role as never,
            dealer_id: r.DEALER_ID ?? null,
            legacy_user_id: r._ID,
            phone: r.PHONE ?? null,
            user_image: r.USER_IMAGE ?? null,
            hubspot_contact_id: r.HUBSPOT_CONTACT_ID ?? null,
            force_password_reset: true,
            email_report: r.EMAIL_REPORT ?? null,
            report_send_to: r.REPORT_SEND_TO ?? null,
            last_login: toTs(r.LAST_LOGIN),
            active: true,
            created_at: toTs(r.created_at) ?? new Date().toISOString(),
          } as never, { onConflict: "id" });

        if (profileErr) {
          console.warn(`  Profile upsert failed for _ID=${r._ID}: ${profileErr.message}`);
          progress.errors++;
        } else {
          progress.imported++;
          existingLegacyIds.add(r._ID);
        }

        saveProgress(progress);
        await sleep(DELAY_MS);
      }

      const pct = ((progress.imported + progress.skipped) / total * 100).toFixed(1);
      console.log(
        `Processed ${(progress.imported + progress.skipped).toLocaleString()} / ${total.toLocaleString()} ` +
        `(${pct}%) — imported: ${progress.imported}, skipped: ${progress.skipped}, errors: ${progress.errors}`
      );
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n✓ Done in ${elapsed}s — imported: ${progress.imported}, skipped: ${progress.skipped}, errors: ${progress.errors}`);

    if (fs.existsSync(PROGRESS_FILE)) {
      fs.renameSync(PROGRESS_FILE, PROGRESS_FILE.replace(".json", "-completed.json"));
    }

  } finally {
    await pool.end();
  }
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
