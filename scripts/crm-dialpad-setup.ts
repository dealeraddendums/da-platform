/**
 * crm-dialpad-setup.ts — one-time Dialpad wiring for DA-CRM. DRY RUN unless --apply.
 * Reads DIALPAD_API_KEY / DIALPAD_WEBHOOK_SECRET / DIALPAD_COMPANY_ID from
 * /var/www/da-platform/.env.local (see scripts/crm-env.ts); never prints them.
 *
 *   npm run crm:dialpad-setup -- --check        key works + belongs to DIALPAD_COMPANY_ID
 *   npm run crm:dialpad-setup -- --map          match Dialpad users → DA-CRM team by email
 *                                               (writes crm_staff_profiles.dialpad_user_id / _number)
 *   npm run crm:dialpad-setup -- --register     create the webhook (with our secret) + a
 *                                               company-wide call-event subscription, or add
 *                                               any missing call states to the existing one
 *   … add --apply to write. --url overrides the webhook URL.
 */
import { createClient } from "@supabase/supabase-js";
import { dialpadFetch } from "../lib/crm/dialpad";
import { crmEnv } from "../lib/crm/env";
import { normalizePhone } from "../lib/crm/phone";
import { loadScriptEnv } from "./crm-env";

loadScriptEnv();

/* eslint-disable @typescript-eslint/no-explicit-any */
const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const APPLY = has("--apply");
const WEBHOOK_URL = opt("--url") ?? "https://app.dealeraddendums.com/api/crm/dialpad/webhook";
// Every state DA-CRM handles (lib/crm/dialpad-ingest.ts eventCallState + follow-ups).
// Not admin_recording: Dialpad refuses it for our key ("Access denied to create
// subscription to state 'admin_recording'"), and the hangup event already
// carries the auto-recording in recording_details.
const CALL_STATES = [
  "calling", "ringing", "connected", "hold", "voicemail", "voicemail_uploaded", "missed", "hangup",
  "recording", "transcription", "call_transcription", "recap_summary", "recap_outcome", "recap_action_items",
];

async function check() {
  const company: any = await dialpadFetch("/api/v2/company");
  const want = crmEnv("DIALPAD_COMPANY_ID");
  const ok = !want || String(company?.id) === want;
  console.log(`Dialpad company: ${company?.name ?? "?"} (${company?.id ?? "?"}) — ${ok ? "matches DIALPAD_COMPANY_ID" : "DOES NOT match DIALPAD_COMPANY_ID"}`);
  if (!ok) process.exitCode = 1;
}

async function listUsers(): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const r: any = await dialpadFetch(`/api/v2/users${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
    out.push(...(r.items ?? []));
    if (!r.cursor || !(r.items ?? []).length) break;
    cursor = r.cursor;
  }
  return out;
}

async function map() {
  const admin: any = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const [users, { data: team }] = await Promise.all([
    listUsers(),
    admin.from("crm_staff_profiles").select("staff_id, full_name, dialpad_user_id"),
  ]);
  const { data: logins } = await admin.from("profiles").select("id, email").in("id", (team ?? []).map((t: any) => t.staff_id));
  const emailOf = Object.fromEntries((logins ?? []).map((l: any) => [l.id, String(l.email).toLowerCase()]));
  for (const t of team ?? []) {
    const email = emailOf[t.staff_id];
    const u = users.find((x) => (x.emails ?? []).map((e: string) => e.toLowerCase()).includes(email));
    if (!u) { console.log(`no Dialpad user for ${email} — map by hand on the Team page`); continue; }
    const number = normalizePhone((u.phone_numbers ?? [])[0]);
    const label = `${email} → Dialpad user ${u.id}${number ? ` (${number})` : ""}`;
    if (t.dialpad_user_id === String(u.id)) { console.log(`already mapped: ${label}`); continue; }
    console.log(`${APPLY ? "map" : "[dry-run] would map"} ${label}`);
    if (APPLY) {
      const { error } = await admin.from("crm_staff_profiles").update({ dialpad_user_id: String(u.id), dialpad_number: number }).eq("staff_id", t.staff_id);
      if (error) console.error(`  ${email}: ${error.message}`);
    }
  }
}

async function register() {
  const secret = crmEnv("DIALPAD_WEBHOOK_SECRET");
  if (!secret) throw new Error("DIALPAD_WEBHOOK_SECRET not set");
  const existing: any = await dialpadFetch("/api/v2/webhooks");
  const hook = (existing.items ?? []).find((w: any) => w.hook_url === WEBHOOK_URL);
  if (hook) console.log(`webhook already registered: ${WEBHOOK_URL} (id ${hook.id})`);
  else console.log(`${APPLY ? "creating" : "[dry-run] would create"} webhook ${WEBHOOK_URL} (HS256-signed)`);
  if (hook) {
    const subs: any = await dialpadFetch("/api/v2/subscriptions/call");
    const sub = (subs.items ?? []).find((s: any) => String(s.webhook?.id) === String(hook.id));
    if (sub) {
      const missing = CALL_STATES.filter((s) => !(sub.call_states ?? []).includes(s));
      console.log(`call subscription already exists: ${sub.id} (${(sub.call_states ?? []).length} states, ${sub.enabled ? "enabled" : "DISABLED"})${missing.length ? ` — missing: ${missing.join(", ")}` : ""}`);
      if (!missing.length && sub.enabled) return;
      if (!APPLY) { console.log(`[dry-run] would update subscription ${sub.id}: add ${missing.join(", ") || "nothing"}${sub.enabled ? "" : ", enable"}`); return; }
      const states = Array.from(new Set([...(sub.call_states ?? []), ...CALL_STATES]));
      await dialpadFetch(`/api/v2/subscriptions/call/${String(sub.id).replace(/\D/g, "")}`, {
        method: "PATCH",
        body: `{"call_states":${JSON.stringify(states)},"enabled":true}`,
      });
      console.log(`subscription ${sub.id} updated: ${states.length} states, enabled`);
      return;
    }
  }
  if (!APPLY) { console.log(`[dry-run] would subscribe call states: ${CALL_STATES.join(", ")}`); return; }
  const webhookId = hook?.id ?? (await dialpadFetch<any>("/api/v2/webhooks", { method: "POST", body: JSON.stringify({ hook_url: WEBHOOK_URL, secret }) })).id;
  // No target_type / target_id = every call in the company.
  const sub: any = await dialpadFetch("/api/v2/subscriptions/call", {
    method: "POST",
    body: `{"endpoint_id":${String(webhookId).replace(/\D/g, "")},"call_states":${JSON.stringify(CALL_STATES)},"enabled":true}`,
  });
  console.log(`subscription ${sub?.id ?? "?"} created for webhook ${webhookId}`);
}

async function main() {
  if (!crmEnv("DIALPAD_API_KEY")) throw new Error("DIALPAD_API_KEY not set");
  if (has("--check")) await check();
  if (has("--map")) await map();
  if (has("--register")) await register();
  if (!has("--check") && !has("--map") && !has("--register")) console.log("Pick --check, --map and/or --register (add --apply to write).");
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
