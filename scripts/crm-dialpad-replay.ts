/**
 * crm-dialpad-replay.ts — replay sample Dialpad call events at the DA-CRM
 * webhook, signed exactly as Dialpad signs them (HS256 JWT with
 * DIALPAD_WEBHOOK_SECRET). Use against a local `npm run dev` or prod.
 *
 *   npm run crm:dialpad-replay                       # all fixtures → localhost:3000
 *   npm run crm:dialpad-replay -- --url https://app.dealeraddendums.com/api/crm/dialpad/webhook
 *   npm run crm:dialpad-replay -- --only 0[1-6]      # one call (regex on file name)
 *   npm run crm:dialpad-replay -- --twice            # send each twice (idempotency check)
 *   npm run crm:dialpad-replay -- --bad-signature    # expect 401s
 *   npm run crm:dialpad-replay -- --file path.json   # a captured real payload
 *
 * Fixtures: scripts/fixtures/crm-dialpad/*.json — an answered + recorded +
 * transcribed + AI-recapped inbound call from a known dealer number, a missed
 * call from an unknown number with a voicemail (lands in Unmatched), and an
 * unanswered outbound call. They use call ids 900000000000001-3; delete those
 * crm_calls / crm_activities rows after testing on prod.
 */
import * as fs from "fs";
import * as path from "path";
import { signDialpadJwt } from "../lib/crm/dialpad";
import { loadScriptEnv } from "./crm-env";

loadScriptEnv();

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

async function main() {
  const url = opt("--url") ?? "http://localhost:3000/api/crm/dialpad/webhook";
  const secret = process.env.DIALPAD_WEBHOOK_SECRET;
  if (!secret) throw new Error("DIALPAD_WEBHOOK_SECRET not set (looked in /var/www/da-platform/.env.local and the repo .env.local)");

  const dir = path.join(__dirname, "fixtures/crm-dialpad");
  const only = opt("--only") ? new RegExp(opt("--only")!) : null;
  const files = opt("--file") ? [opt("--file")!]
    : fs.readdirSync(dir).filter((f) => f.endsWith(".json") && (!only || only.test(f))).sort().map((f) => path.join(dir, f));

  let bad = 0;
  for (const file of files) {
    const payload = JSON.parse(fs.readFileSync(file, "utf8"));
    const token = signDialpadJwt(payload, flag("--bad-signature") ? `${secret}-wrong` : secret);
    for (let i = 0; i < (flag("--twice") ? 2 : 1); i++) {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/jwt" }, body: token });
      const text = await res.text();
      const expected = flag("--bad-signature") ? res.status === 401 : res.ok;
      if (!expected) bad++;
      console.log(`${expected ? "ok  " : "FAIL"} ${res.status} ${path.basename(file)}${i ? " (repeat)" : ""} ${text.slice(0, 160)}`);
    }
  }
  console.log(bad ? `\n${bad} unexpected responses` : `\n${files.length} payloads replayed`);
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
