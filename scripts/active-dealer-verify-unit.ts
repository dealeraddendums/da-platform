/* npm run test:active-dealer — lib/active-dealer.ts session-scoped dealer context.
 *
 * Covers the wrong-rooftop fix (2026-10-19): the active dealer is per
 * session/device and is RE-AUTHORIZED from the database on every request, so a
 * cookie is a request and never a grant.
 */
import {
  encodeActiveDealerCookie,
  decodeActiveDealerCookie,
  authorizeActiveDealer,
} from "../lib/active-dealer";

let fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n  got:  ${String(got)}\n  want: ${String(want)}`}`);
}

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const GROUP_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GROUP_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DEALER_IN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";   // in GROUP_1
const DEALER_OUT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";  // in GROUP_2
const TAG_OK = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const TAG_OTHER = "ffffffff-ffff-4fff-8fff-ffffffffffff";

// ── cookie encode/decode + identity binding ────────────────────────────────
eq("round-trips for the owning user",
  decodeActiveDealerCookie(encodeActiveDealerCookie(USER_A, DEALER_IN), USER_A), DEALER_IN);
eq("a DIFFERENT user in the same browser gets nothing (impersonation / re-login)",
  decodeActiveDealerCookie(encodeActiveDealerCookie(USER_A, DEALER_IN), USER_B), null);
eq("tampered dealer uuid rejected",
  decodeActiveDealerCookie(`${USER_A}.not-a-uuid`, USER_A), null);
eq("bare uuid with no owner rejected", decodeActiveDealerCookie(DEALER_IN, USER_A), null);
eq("empty cookie → null", decodeActiveDealerCookie("", USER_A), null);
eq("undefined cookie → null", decodeActiveDealerCookie(undefined, USER_A), null);
eq("leading separator rejected", decodeActiveDealerCookie(`.${DEALER_IN}`, USER_A), null);

// ── authorization gate ─────────────────────────────────────────────────────
// Minimal fake of the admin Supabase client: only the two shapes this module uses.
function fakeAdmin(opts: { dealerGroup?: string | null; dealerTags?: string[] } = {}) {
  const { dealerGroup = GROUP_1, dealerTags = [TAG_OK] } = opts;
  return {
    from(table: string) {
      if (table === "dealers") {
        return {
          select: () => ({
            eq: (_c: string, id: string) => ({
              maybeSingle: async () => ({
                data: id === DEALER_IN || id === DEALER_OUT
                  ? { id, dealer_id: `TEXT_${id.slice(0, 4)}`, group_id: id === DEALER_OUT ? GROUP_2 : dealerGroup }
                  : null,
              }),
            }),
          }),
        };
      }
      if (table === "dealer_tags") {
        return {
          select: () => ({
            eq: () => ({
              in: (_c: string, wanted: string[]) => ({
                limit: () => ({
                  maybeSingle: async () => ({
                    data: dealerTags.some((t) => wanted.includes(t)) ? { tag_id: TAG_OK } : null,
                  }),
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const gaArgs = { userId: USER_A, role: "group_admin", groupId: GROUP_1 };

async function run() {
  let r = await authorizeActiveDealer(fakeAdmin(), gaArgs, DEALER_IN);
  eq("group_admin + in-group dealer → authorized", r.uuid, DEALER_IN);

  r = await authorizeActiveDealer(fakeAdmin(), gaArgs, DEALER_OUT);
  eq("group_admin + OUT-of-group dealer → refused (group level)", r.uuid, null);

  r = await authorizeActiveDealer(fakeAdmin(), gaArgs, "99999999-9999-4999-8999-999999999999");
  eq("unknown dealer → refused", r.uuid, null);

  r = await authorizeActiveDealer(fakeAdmin(), gaArgs, null);
  eq("no dealer requested → group level", r.uuid, null);

  r = await authorizeActiveDealer(fakeAdmin(), { ...gaArgs, groupLevelReset: true }, DEALER_IN);
  eq("#116 group-level reset wins over a valid cookie", r.uuid, null);

  r = await authorizeActiveDealer(fakeAdmin(), { ...gaArgs, groupId: null }, DEALER_IN);
  eq("group_admin with no group → refused", r.uuid, null);

  for (const role of ["dealer_admin", "dealer_user", "dealer_restricted", "super_admin"]) {
    r = await authorizeActiveDealer(fakeAdmin(), { ...gaArgs, role }, DEALER_IN);
    eq(`${role} cannot hold an active dealer`, r.uuid, null);
  }

  // group_user: in-group AND tag-scoped
  const guArgs = { userId: USER_A, role: "group_user", groupId: GROUP_1 };
  r = await authorizeActiveDealer(fakeAdmin(), { ...guArgs, scopeTagIds: [TAG_OK] }, DEALER_IN);
  eq("group_user + in-group + matching tag → authorized", r.uuid, DEALER_IN);

  r = await authorizeActiveDealer(fakeAdmin(), { ...guArgs, scopeTagIds: [TAG_OTHER] }, DEALER_IN);
  eq("group_user + in-group but WRONG tag → refused", r.uuid, null);

  r = await authorizeActiveDealer(fakeAdmin(), { ...guArgs, scopeTagIds: [] }, DEALER_IN);
  eq("group_user with no tags → refused (empty scope = no dealers)", r.uuid, null);

  r = await authorizeActiveDealer(fakeAdmin(), { ...guArgs, scopeTagIds: [TAG_OK] }, DEALER_OUT);
  eq("group_user + out-of-group → refused even with a tag", r.uuid, null);

  // The dealer's text id is what every write path keys on — prove it comes from
  // the database row, not from anything the client supplied.
  r = await authorizeActiveDealer(fakeAdmin(), gaArgs, DEALER_IN);
  eq("text dealer_id comes from the dealers row", r.textId, `TEXT_${DEALER_IN.slice(0, 4)}`);

  // A dealer moved out of the group after selection stops resolving immediately.
  r = await authorizeActiveDealer(fakeAdmin({ dealerGroup: GROUP_2 }), gaArgs, DEALER_IN);
  eq("dealer moved out of the group after selection → refused on the NEXT request", r.uuid, null);

  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
}

void run();
