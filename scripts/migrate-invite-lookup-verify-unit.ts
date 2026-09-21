/**
 * Checks for the /migrate manual-code fallback.
 *   npm run test:migrate-invite
 *
 * The email templates render offline. The resolver hits Supabase, so its
 * logic is exercised through a stubbed admin client — what matters is the
 * decision table, above all that the CODE (never the email alone) decides
 * WHICH rooftop is migrated when one mailbox holds several live invites.
 * shirley@tuttleclick.com really does hold 6.
 */

import { hashSetupCode } from "../lib/invite-code";
import { buildMigrationInviteEmail, buildMigrationFollowUpEmail, buildInviteEmail } from "../lib/invite-email";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; failures.push(`${label}${detail ? ` — ${detail}` : ""}`); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

const future = new Date(Date.now() + 7 * 864e5).toISOString();
const past = new Date(Date.now() - 864e5).toISOString();

function inv(over: Record<string, unknown> = {}) {
  return {
    id: "inv-1", email: "rich_meier@jenkinscars.com", first_name: "Rich", last_name: "Meier",
    dealer_id: "dealer-crystal-river", expires_at: future, accepted_at: null,
    setup_code_hash: hashSetupCode("02099258"), setup_code_expires_at: future,
    purpose: "migration", token: "tok-good", ...over,
  };
}

/** Minimal stand-in for the supabase admin client the resolver uses. */
function stubAdmin(rows: Record<string, unknown>[]) {
  return {
    from() {
      const q: Record<string, unknown> = {};
      let tokenFilter: string | null = null;
      const api: Record<string, unknown> = {
        select: () => api,
        eq: (col: string, val: string) => { if (col === "token") tokenFilter = val; return api; },
        ilike: () => api,
        limit: () => Promise.resolve({ data: rows }),
        maybeSingle: () => Promise.resolve({ data: rows.find(r => r.token === tokenFilter) ?? null }),
      };
      void q;
      return api;
    },
  };
}

async function resolve(rows: Record<string, unknown>[], input: { token?: string; email?: string; code: string }) {
  const { resolveMigrationInvite } = await import("../lib/invite-lookup");
  return resolveMigrationInvite({ ...input, admin: stubAdmin(rows) });
}

/** /signup side — same resolver, purpose:'user'. */
async function resolveUser(rows: Record<string, unknown>[], input: { token?: string; email?: string; code: string }) {
  const { resolveUserInvite } = await import("../lib/invite-lookup");
  return resolveUserInvite({ ...input, admin: stubAdmin(rows) });
}

/** A staff/user invitation (what /signup consumes). */
function userInv(over: Record<string, unknown> = {}) {
  return {
    id: "u-1", email: "karen_kessinger@jenkinscars.com", first_name: "Karen", last_name: "Kessinger",
    dealer_id: "dealer-jenkins-ford", expires_at: future, accepted_at: null,
    setup_code_hash: hashSetupCode("11223344"), setup_code_expires_at: future,
    purpose: "user", token: "utok-good", ...over,
  };
}

(async () => {
  console.log("\n/migrate invite resolution — token AND manual email+code\n");

  // The tokenized link keeps working exactly as before.
  {
    const r = await resolve([inv()], { token: "tok-good", code: "02099258" });
    check("token + correct code → resolves", r.ok === true);
    const bad = await resolve([inv()], { token: "tok-good", code: "00000000" });
    check("token + wrong code → 401, no resolve", bad.ok === false && bad.status === 401);
  }

  // THE FIX: the email tells dealers to go to /migrate and use the code.
  {
    const r = await resolve([inv()], { email: "rich_meier@jenkinscars.com", code: "02099258" });
    check("manual email + code → resolves (no token needed)", r.ok === true && (r as { invite: { id: string } }).invite.id === "inv-1");
    const mixedCase = await resolve([inv()], { email: "  Rich_Meier@JenkinsCars.com  ", code: "02099258" });
    check("  …email is case/space tolerant", mixedCase.ok === true);
    const spaced = await resolve([inv()], { email: "rich_meier@jenkinscars.com", code: " 02099258 " });
    check("  …code is trimmed (copy/paste from email)", spaced.ok === true);
  }

  // The disambiguation that matters: one mailbox, several rooftops.
  {
    const rows = [
      inv({ id: "inv-a", dealer_id: "rooftop-A", token: "tok-a", setup_code_hash: hashSetupCode("11111111") }),
      inv({ id: "inv-b", dealer_id: "rooftop-B", token: "tok-b", setup_code_hash: hashSetupCode("22222222") }),
      inv({ id: "inv-c", dealer_id: "rooftop-C", token: "tok-c", setup_code_hash: hashSetupCode("33333333") }),
    ];
    const r = await resolve(rows, { email: "rich_meier@jenkinscars.com", code: "22222222" });
    check("6-rooftop mailbox: the CODE picks the rooftop, not the email",
      r.ok === true && (r as { invite: { dealer_id: string } }).invite.dealer_id === "rooftop-B",
      r.ok ? (r as { invite: { dealer_id: string } }).invite.dealer_id : "did not resolve");
    const none = await resolve(rows, { email: "rich_meier@jenkinscars.com", code: "99999999" });
    check("  …a code matching none of them is rejected", none.ok === false);
  }

  // Terminal states stay terminal, and stay honest.
  {
    const done = await resolve([inv({ accepted_at: new Date().toISOString() })], { email: "rich_meier@jenkinscars.com", code: "02099258" });
    check("already-migrated mailbox → 410 'already completed'", done.ok === false && done.status === 410 && /already been completed/i.test(done.error));
    const exp = await resolve([inv({ setup_code_expires_at: past })], { email: "rich_meier@jenkinscars.com", code: "02099258" });
    check("expired code → 410 'expired', not 'incorrect'", exp.ok === false && exp.status === 410 && /expired/i.test(exp.error));
    const tokDone = await resolve([inv({ accepted_at: new Date().toISOString() })], { token: "tok-good", code: "02099258" });
    check("token path keeps its terminal states too", tokDone.ok === false && tokDone.status === 410);
  }

  // Public endpoint: must not confirm who was invited.
  {
    const unknown = await resolve([], { email: "stranger@example.com", code: "02099258" });
    const wrongCode = await resolve([inv()], { email: "rich_meier@jenkinscars.com", code: "87654321" });
    check("unknown email and wrong code give the SAME answer (non-enumerable)",
      unknown.ok === false && wrongCode.ok === false && unknown.error === wrongCode.error && unknown.status === wrongCode.status);
  }

  // A /signup user invite must not be drivable through /migrate.
  {
    const r = await resolve([inv({ purpose: "user" })], { email: "rich_meier@jenkinscars.com", code: "02099258" });
    check("non-migration invite is not accepted by /migrate", r.ok === false);
  }

  // Missing input.
  {
    const noCode = await resolve([inv()], { email: "rich_meier@jenkinscars.com", code: "" });
    check("no code → 400", noCode.ok === false && noCode.status === 400);
    const noneAtAll = await resolve([inv()], { code: "02099258" });
    check("code but neither token nor email → 400", noneAtAll.ok === false && noneAtAll.status === 400);
  }

  // The email must actually tell them the manual path, in plain text.
  {
    const html = buildMigrationInviteEmail({ firstName: "Rich", orgName: "Jenkins Kia Crystal River", migrateUrl: "https://app.dealeraddendums.com/migrate?invite=tok", setupCode: "02099258" });
    check("invite email shows the spaced code", html.includes("0 2 0 9 9 2 5 8"));
    check("invite email names the manual URL", html.includes("app.dealeraddendums.com/migrate"));
    check("invite email has the 'button not working' fallback", /Button not working\?/.test(html));
    const fallbackIdx = html.indexOf("Button not working?");
    const anchorIdx = html.lastIndexOf("<a href=\"https://app.dealeraddendums.com/migrate?invite=tok\"");
    check("  …and it sits AFTER the button, where a stuck dealer looks", fallbackIdx > anchorIdx);
    // The fallback must survive a link rewriter: it cannot be an anchor.
    const seg = html.slice(fallbackIdx, fallbackIdx + 320);
    check("  …and is plain text, not an <a> a rewriter would mangle", !/<a\s/i.test(seg));

    const fu = buildMigrationFollowUpEmail({ firstName: "Rich", orgName: "Jenkins Kia Crystal River", migrateUrl: "https://app.dealeraddendums.com/migrate?invite=tok", setupCode: "02099258", followUpNumber: 1, invitedAt: new Date() });
    check("follow-up (drip) email carries the same fallback", /Button not working\?/.test(fu) && fu.includes("app.dealeraddendums.com/migrate"));
  }

  // ── /signup staff invites: the same trap, closed the same way ────────────
  console.log("\n/signup invite resolution — user invites (Karen-class)\n");
  {
    const r = await resolveUser([userInv()], { token: "utok-good", code: "11223344" });
    check("user: token + correct code → resolves", r.ok === true);

    const m = await resolveUser([userInv()], { email: "karen_kessinger@jenkinscars.com", code: "11223344" });
    check("user: manual email + code → resolves (the Karen case)", m.ok === true && (m as { invite: { id: string } }).invite.id === "u-1");

    const mixed = await resolveUser([userInv()], { email: " Karen_Kessinger@JenkinsCars.com ", code: "11223344" });
    check("user:   …email is case/space tolerant", mixed.ok === true);

    const wrong = await resolveUser([userInv()], { email: "karen_kessinger@jenkinscars.com", code: "00000000" });
    const unknown = await resolveUser([userInv()], { email: "nobody@example.com", code: "11223344" });
    check("user: wrong code → 401", wrong.ok === false && wrong.status === 401);
    check("user: unknown email and wrong code give the SAME answer (non-enumerable)",
      wrong.ok === false && unknown.ok === false && wrong.status === unknown.status &&
      (wrong as { error: string }).error === (unknown as { error: string }).error);

    const used = await resolveUser([userInv({ accepted_at: new Date().toISOString() })], { email: "karen_kessinger@jenkinscars.com", code: "11223344" });
    check("user: already-used invite → 410, not a retry prompt", used.ok === false && used.status === 410);

    const expired = await resolveUser([userInv({ setup_code_expires_at: past })], { email: "karen_kessinger@jenkinscars.com", code: "11223344" });
    check("user: expired code → 410", expired.ok === false && expired.status === 410);

    // One mailbox, two rooftops — the CODE picks, never the email.
    const two = [userInv({ id: "u-a", dealer_id: "d-a", token: "ta", setup_code_hash: hashSetupCode("11112222") }),
                 userInv({ id: "u-b", dealer_id: "d-b", token: "tb", setup_code_hash: hashSetupCode("33334444") })];
    const picked = await resolveUser(two, { email: "karen_kessinger@jenkinscars.com", code: "33334444" });
    check("user: two live invites for one mailbox → the CODE picks the right one",
      picked.ok === true && (picked as { invite: { id: string } }).invite.id === "u-b");
  }

  // ── The two flows must not be able to consume each other's invitations ────
  {
    const crossA = await resolveUser([inv()], { email: "rich_meier@jenkinscars.com", code: "02099258" });
    check("a MIGRATION invite cannot be consumed via /signup", crossA.ok === false);
    const crossB = await resolveUser([inv()], { token: "tok-good", code: "02099258" });
    check("  …not by token either (404)", crossB.ok === false && crossB.status === 404);
    const crossC = await resolve([userInv()], { email: "karen_kessinger@jenkinscars.com", code: "11223344" });
    check("a USER invite cannot be consumed via /migrate", crossC.ok === false);
    const crossD = await resolve([userInv()], { token: "utok-good", code: "11223344" });
    check("  …not by token either (404)", crossD.ok === false && crossD.status === 404);
  }

  // ── Email copy: the staff invite must name the typable fallback ───────────
  {
    const html = buildInviteEmail({
      firstName: "Karen", orgName: "Jenkins Ford Lincoln", roleLabel: "Dealer Admin",
      inviteUrl: "https://app.dealeraddendums.com/signup?invite=tok", setupCode: "11223344",
    });
    check("staff invite email has the 'button not working' fallback", /Button not working\?/.test(html));
    check("  …and names the /signup manual URL", /app\.dealeraddendums\.com\/signup<\/strong>/.test(html));
    check("  …and is plain text, not an <a> a rewriter would mangle",
      !/<a[^>]*>[^<]*app\.dealeraddendums\.com\/signup/.test(html));
    check("  …and sits AFTER the button, where a stuck invitee looks",
      html.indexOf("Button not working?") > html.indexOf("Set Up Your Account"));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("\nFailures:"); failures.forEach(f => console.log("  - " + f)); process.exit(1); }
})();
