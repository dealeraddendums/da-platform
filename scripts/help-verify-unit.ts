/**
 * Help/Support — committed, deterministic unit tests (no DB, no network, no env).
 * Run: `npm run test:help`  (or `npx tsx scripts/help-verify-unit.ts`)
 *
 * Covers the security-critical, browser-free behavior from
 * docs/help-support-widget.md:
 *   #4/#5  sanitizeHelpHtml — strict iframe/video allowlist
 *   #6     ownsConversation + listConversations scoping + review gate
 *   #3     buildDealerContext is own-data-only (claims-driven, never a request id)
 *
 * DB access is exercised through an injected fake Supabase client so the asserts
 * are deterministic and inspect the exact filters the production code applies.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import type { JwtClaims } from "@/lib/auth";
import { sanitizeHelpHtml } from "@/lib/help-sanitize";
import { ownsConversation, listConversations, canReviewConversations } from "@/lib/help-conversations";
import { buildDealerContext } from "@/lib/help-context";

// ── tiny test runner ─────────────────────────────────────────────────────────
const results: { name: string; ok: boolean; err?: string }[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e instanceof Error ? e.message : String(e) }); }
}

// ── claims + fake Supabase client ────────────────────────────────────────────
function claims(p: Partial<JwtClaims>): JwtClaims {
  return {
    sub: "u-test", email: "u@test", role: "dealer_user",
    dealer_id: null, group_id: null, impersonating_dealer_id: null,
    active_dealer_id: null, is_ghost: false, ghost_dealer_uuid: null, ...p,
  } as JwtClaims;
}

type Recorded = { table: string; eqs: [string, unknown][]; selects: unknown[]; opts: unknown; terminal?: string };
/** A chainable + thenable fake query builder; `responder` returns the result. */
function fakeAdmin(responder: (q: Recorded) => unknown) {
  const calls: Recorded[] = [];
  const make = (table: string) => {
    const q: Record<string, unknown> = { table, eqs: [] as [string, unknown][], selects: [], opts: null };
    const self = q as unknown as Recorded & Record<string, (...a: unknown[]) => unknown>;
    q.select = (cols: unknown, opts?: unknown) => { (q.selects as unknown[]).push(cols); if (opts) q.opts = opts; return q; };
    q.eq = (c: string, v: unknown) => { (q.eqs as [string, unknown][]).push([c, v]); return q; };
    q.in = (c: string, v: unknown) => { (q.eqs as [string, unknown][]).push([c, v]); return q; };
    q.or = () => q;
    q.order = () => q;
    q.limit = () => q;
    q.maybeSingle = () => { self.terminal = "maybeSingle"; calls.push(self); return Promise.resolve(responder(self)); };
    q.single = () => { self.terminal = "single"; calls.push(self); return Promise.resolve(responder(self)); };
    q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => { self.terminal = "await"; calls.push(self); return Promise.resolve(responder(self)).then(res, rej); };
    return q;
  };
  return { client: { from: (t: string) => make(t) }, calls };
}

function dealerResponder(name: string, prints: number) {
  return (q: Recorded) => {
    if (q.table === "dealers") return { data: { name, account_type: "Trial", created_at: new Date(Date.now() - 3 * 86_400_000).toISOString(), downgraded_at: null, subscription_billed_to: null, group_controls_templates: false } };
    if (q.table === "print_history") return { count: prints };
    return { data: null };
  };
}

(async () => {
// ── #4/#5  sanitizeHelpHtml ──────────────────────────────────────────────────
await test("sanitize: keeps a YouTube /embed/ https iframe", () => {
  const out = sanitizeHelpHtml('<iframe src="https://www.youtube.com/embed/abc123"></iframe>');
  assert.match(out, /<iframe/i);
  assert.match(out, /youtube\.com\/embed\/abc123/);
});
await test("sanitize: keeps a Vimeo /video/ https iframe", () => {
  const out = sanitizeHelpHtml('<iframe src="https://player.vimeo.com/video/12345"></iframe>');
  assert.match(out, /<iframe/i);
  assert.match(out, /player\.vimeo\.com\/video\/12345/);
});
await test("sanitize: strips an http:// (non-https) iframe", () => {
  const out = sanitizeHelpHtml('<iframe src="http://www.youtube.com/embed/abc"></iframe>');
  assert.doesNotMatch(out, /<iframe/i);
});
await test("sanitize: strips a javascript: iframe", () => {
  const out = sanitizeHelpHtml('<iframe src="javascript:alert(1)"></iframe>');
  assert.doesNotMatch(out, /<iframe/i);
  assert.doesNotMatch(out, /javascript:/i);
});
await test("sanitize: strips a foreign-host iframe", () => {
  const out = sanitizeHelpHtml('<iframe src="https://evil.com/embed/x"></iframe>');
  assert.doesNotMatch(out, /<iframe/i);
  assert.doesNotMatch(out, /evil\.com/);
});
await test("sanitize: strips <script>", () => {
  const out = sanitizeHelpHtml('<p>hello</p><script>alert(1)</script>');
  assert.match(out, /hello/);
  assert.doesNotMatch(out, /<script/i);
});
await test("sanitize: keeps a <video> from the help/ S3 bucket", () => {
  const out = sanitizeHelpHtml('<video src="https://new-infobox-images.s3.us-east-1.amazonaws.com/help/clip.mp4"></video>');
  assert.match(out, /<video/i);
  assert.match(out, /help\/clip\.mp4/);
});
await test("sanitize: strips a <video> from a foreign host", () => {
  const out = sanitizeHelpHtml('<video src="https://evil.com/x.mp4"></video>');
  assert.doesNotMatch(out, /<video/i);
  assert.doesNotMatch(out, /evil\.com/);
});
await test("sanitize: keeps a bucket <source>, strips a foreign <source>", () => {
  const ok = sanitizeHelpHtml('<video><source src="https://new-infobox-images.s3.us-west-2.amazonaws.com/help/c.webm"></video>');
  assert.match(ok, /<source/i);
  const bad = sanitizeHelpHtml('<video><source src="https://evil.com/x.mp4"></video>');
  assert.doesNotMatch(bad, /evil\.com/);
});

// ── #6  ownsConversation + scoping + review gate ─────────────────────────────
await test("ownsConversation: super_admin → true without touching the DB", async () => {
  const throwing = { from() { throw new Error("DB must not be queried for super_admin"); } };
  assert.equal(await ownsConversation("c1", claims({ role: "super_admin" }), throwing), true);
});
await test("ownsConversation: owner → true", async () => {
  const { client } = fakeAdmin(() => ({ data: { user_id: "u1" } }));
  assert.equal(await ownsConversation("c1", claims({ role: "dealer_user", sub: "u1" }), client), true);
});
await test("ownsConversation: other user → false", async () => {
  const { client } = fakeAdmin(() => ({ data: { user_id: "u1" } }));
  assert.equal(await ownsConversation("c1", claims({ role: "dealer_user", sub: "u2" }), client), false);
});
await test("listConversations: a dealer is hard-scoped to user_id", async () => {
  const { client, calls } = fakeAdmin(() => ({ data: [] }));
  await listConversations(claims({ role: "dealer_admin", sub: "u1" }), { status: "open", flagged: true }, client);
  const eqs = calls[0].eqs;
  assert.ok(eqs.some(([c, v]) => c === "user_id" && v === "u1"), "must filter user_id = sub");
  assert.ok(!eqs.some(([c]) => c === "status" || c === "flagged"), "dealer must NOT use review-queue filters");
});
await test("listConversations: super_admin gets the review queue (no user_id scope)", async () => {
  const { client, calls } = fakeAdmin(() => ({ data: [] }));
  await listConversations(claims({ role: "super_admin", sub: "a1" }), { status: "escalated", flagged: true }, client);
  const eqs = calls[0].eqs;
  assert.ok(!eqs.some(([c]) => c === "user_id"), "super_admin must NOT be scoped to user_id");
  assert.ok(eqs.some(([c, v]) => c === "status" && v === "escalated"));
  assert.ok(eqs.some(([c, v]) => c === "flagged" && v === true));
});
await test("canReviewConversations: super_admin only", () => {
  assert.equal(canReviewConversations(claims({ role: "super_admin" })), true);
  for (const role of ["dealer_admin", "dealer_user", "group_admin", "group_user", "dealer_restricted"] as const) {
    assert.equal(canReviewConversations(claims({ role })), false, `${role} must not review`);
  }
});

// ── #3  buildDealerContext is own-data-only (claims-driven) ──────────────────
await test("buildDealerContext: returns ONLY the claims-resolved dealer's data (A)", async () => {
  const { client, calls } = fakeAdmin(dealerResponder("Alpha Motors", 3));
  const out = await buildDealerContext(claims({ role: "dealer_admin", dealer_id: "dealerA", sub: "uA" }), client as any);
  assert.match(out, /Alpha Motors/);
  assert.match(out, /Trial/);
  assert.match(out, /Prints used 3/);
  // every dealer_id filter targeted the claims dealer — never any other id
  const dealerEqs = calls.flatMap((c) => c.eqs).filter(([col]) => col === "dealer_id");
  assert.ok(dealerEqs.length > 0);
  assert.ok(dealerEqs.every(([, v]) => v === "dealerA"), "must only ever query dealerA");
});
await test("buildDealerContext: dealer is driven by claims, not a request id (B)", async () => {
  const { client, calls } = fakeAdmin(dealerResponder("Beta Auto", 7));
  const out = await buildDealerContext(claims({ role: "dealer_admin", dealer_id: "dealerB", sub: "uB" }), client as any);
  assert.match(out, /Beta Auto/);
  assert.doesNotMatch(out, /Alpha Motors/);
  assert.ok(calls.flatMap((c) => c.eqs).filter(([col]) => col === "dealer_id").every(([, v]) => v === "dealerB"));
  // structural: the signature exposes no request-supplied dealer-id parameter
  assert.equal(buildDealerContext.length, 1, "buildDealerContext must require only claims (admin is an injected default)");
});

// ── report ───────────────────────────────────────────────────────────────────
console.log("\n===== HELP/SUPPORT UNIT VERIFICATION =====");
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n        ↳ ${r.err}`}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ""}.`);
process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e instanceof Error ? e.stack : e); process.exit(1); });
