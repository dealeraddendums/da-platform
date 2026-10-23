/* npm run test:crm-feed-approver — Start feed order approver = a CRM contact (lib/crm/feeds/approver.ts,
   migration 198): picker order, picked contact linked + blanks filled, group contacts allowed for a group
   dealer, typed approver saved as a contact of the dealer and deduped on email. In-memory Supabase fake. */
import { fakeDb } from "./crm-fake-supabase";
import { approverCandidates, rankApprovers, resolveApproverContact } from "../lib/crm/feeds/approver";
import { withApproverFields } from "../lib/crm/feeds/orders";

let fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`}`);
}
const NOW = new Date("2026-10-23T18:00:00Z");
const seed = () => fakeDb({
  crm_company_directory: [
    { id: "co-d", kind: "dealer", name: "Harbor Hills GMC", parent_group_id: "grp-1" },
    { id: "co-g", kind: "group", name: "Harbor Hills Auto Group", group_id: "grp-1" },
    { id: "co-x", kind: "dealer", name: "Elsewhere Ford", parent_group_id: null },
  ],
  crm_companies: [{ id: "co-d", kind: "dealer" }, { id: "co-g", kind: "group", group_id: "grp-1" }, { id: "co-x", kind: "dealer" }],
  crm_contacts: [
    { id: "k-gm", company_id: "co-d", first_name: "Gina", last_name: "Moss", email: "gina@hh.example", phone: null, phone_raw: null, title: null, role_tag: "gm", user_id: null, approver_at: null, deleted_at: null, updated_at: "2026-10-01" },
    { id: "k-user", company_id: "co-d", first_name: "Paul", last_name: "User", email: "paul@hh.example", phone: "+12055550100", phone_raw: null, title: "Internet Manager", role_tag: null, user_id: "u1", approver_at: null, deleted_at: null, updated_at: "2026-10-01" },
    { id: "k-owner", company_id: "co-g", first_name: "Matt", last_name: "Owner", email: "matt@hhholdings.example", phone: null, phone_raw: null, title: "Owner", role_tag: null, user_id: null, approver_at: "2026-09-01T00:00:00Z", deleted_at: null, updated_at: "2026-10-01" },
    { id: "k-other", company_id: "co-x", first_name: "Olly", last_name: "Other", email: "olly@other.example", phone: null, phone_raw: null, title: null, role_tag: null, user_id: null, approver_at: null, deleted_at: null, updated_at: "2026-10-01" },
  ],
  profiles: [], crm_webhook_subscriptions: [],
});

async function main() {
  eq("rank: past approvers, then platform users, own company before the group, then name",
    rankApprovers([
      { name: "Zed", approver: false, platform_user: false, company_label: null },
      { name: "Amy", approver: false, platform_user: true, company_label: null },
      { name: "Bob", approver: true, platform_user: false, company_label: "Group" },
      { name: "Cat", approver: false, platform_user: false, company_label: "Group" },
      { name: "Dan", approver: true, platform_user: true, company_label: null },
    ]).map((x) => x.name), ["Dan", "Bob", "Amy", "Zed", "Cat"]);

  let db = seed();
  const cands = await approverCandidates(db, "co-d");
  eq("picker: dealer's contacts + its group's (labelled), past approver first; other dealers' contacts absent",
    cands.map((c) => [c.name, c.company_label, c.approver, c.platform_user]),
    [["Matt Owner", "Harbor Hills Auto Group", true, false], ["Paul User", null, false, true], ["Gina Moss", null, false, false]]);

  const picked = await resolveApproverContact(db, "co-d", { contactId: "k-gm", title: "General Manager", phone: "205-555-0199" }, NOW);
  const gm = db.rows("crm_contacts").find((c: any) => c.id === "k-gm");
  eq("picked contact: linked, approver_at stamped, blank title / phone filled (role tag kept)", [picked?.id, picked?.created, gm.approver_at, gm.title, gm.phone, gm.role_tag], ["k-gm", false, NOW.toISOString(), "General Manager", "+12055550199", "gm"]);
  const keep = await resolveApproverContact(db, "co-d", { contactId: "k-user", title: "Typed title" }, NOW);
  eq("picked contact: an existing title is never overwritten", [keep?.id, db.rows("crm_contacts").find((c: any) => c.id === "k-user").title], ["k-user", "Internet Manager"]);
  eq("group contact allowed for a group dealer", (await resolveApproverContact(db, "co-d", { contactId: "k-owner" }, NOW))?.id, "k-owner");
  let err = ""; try { await resolveApproverContact(db, "co-d", { contactId: "k-other" }, NOW); } catch (e) { err = (e as Error).message; }
  eq("another dealer's contact refused", err, "not_allowed");

  db = seed();
  const before = db.rows("crm_contacts").length;
  const dup = await resolveApproverContact(db, "co-d", { name: "Gina M.", email: "GINA@hh.example", title: "GM" }, NOW);
  eq("typed approver whose email is already a contact here → that contact linked, blank title filled, no new row",
    [dup?.id, dup?.created, db.rows("crm_contacts").length, db.rows("crm_contacts").find((c: any) => c.id === "k-gm").title], ["k-gm", false, before, "GM"]);

  const made = await resolveApproverContact(db, "co-d", { name: "Rosa Delgado", email: "Rosa@HH.example", phone: "(205) 555-0142", title: "Internet Manager" }, NOW);
  const row = db.rows("crm_contacts").find((c: any) => c.id === made?.id);
  eq("new typed approver → contact of the dealer, source feed_order, role_tag approver, E.164 phone",
    [made?.created, row.company_id, row.first_name, row.last_name, row.email, row.phone, row.title, row.source, row.role_tag, row.approver_at],
    [true, "co-d", "Rosa", "Delgado", "rosa@hh.example", "+12055550142", "Internet Manager", "feed_order", "approver", NOW.toISOString()]);
  const again = await resolveApproverContact(db, "co-d", { name: "Rosa Delgado", email: "rosa@hh.example" }, NOW);
  eq("the same approver typed again → linked, not duplicated", [again?.id, again?.created, db.rows("crm_contacts").filter((c: any) => c.email === "rosa@hh.example").length], [made?.id, false, 1]);
  const odd = await resolveApproverContact(db, "co-d", { name: "Sam", phone: "ext 4" }, NOW);
  eq("no email: saved by name, an unparseable phone kept as typed", [odd?.created, db.rows("crm_contacts").find((c: any) => c.id === odd?.id).phone_raw], [true, "ext 4"]);
  eq("…and the same name without email links it next time", (await resolveApproverContact(db, "co-d", { name: "Sam" }, NOW))?.id, odd?.id);
  eq("nothing typed → no contact", await resolveApproverContact(db, "co-d", { name: " ", email: "" }, NOW), null);

  eq("order fields: blanks take the contact's values, typed values win",
    withApproverFields({ dealerCompanyId: "co-d", source: "call", approverName: "", approverEmail: null, approverTitle: "Owner" }, { first_name: "Matt", last_name: "Owner", email: "matt@x.example", phone: "+12055550100", title: "President" }),
    { dealerCompanyId: "co-d", source: "call", approverName: "Matt Owner", approverEmail: "matt@x.example", approverTitle: "Owner", approverPhone: "+12055550100" });

  console.log(fail ? `\n${fail} failed` : "\nall passed");
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
