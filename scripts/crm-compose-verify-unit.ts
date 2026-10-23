/* npm run test:crm-compose — compose window recipients (lib/crm/recipients.ts, components/crm/RecipientField.tsx)
   and thread ↔ contact link filters (lib/crm/thread-links.ts). Pure — no database. */
import { classifyRecipient, rankSuggestions, splitName, type RecipientContact } from "../lib/crm/recipients";
import { parseRecipientText } from "../components/crm/RecipientField";
import { threadOwnerFilter } from "../lib/crm/thread-links";

let fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`}`);
}

const HERE = "11111111-1111-4111-8111-111111111111", CLEO = "22222222-2222-4222-8222-222222222222";
const jane = (company_id: string, extra: Partial<RecipientContact> = {}): RecipientContact => ({
  id: `c-${company_id.slice(0, 4)}`, name: "Jane Doe", email: "jane@cleobayhonda.com", title: "GM", company_id,
  company_name: company_id === HERE ? "Sunrise Auto Group" : "Cleo Bay Honda", weak: false, ...extra });
const opts = (domainCompanies: { id: string; name: string; kind: string }[] = []) => ({ companyId: HERE, internalDomains: ["dealeraddendums.com"], domainCompanies });

// ── Paste / typing ─────────────────────────────────────────────────────────
eq("paste: comma + semicolon list, names, dedupe, lowercase",
  parseRecipientText('Jane Doe <Jane@CleoBayHonda.com>; bob@x.com, "Ann Lee" <ann@y.com>\nbob@x.com').list,
  [{ email: "jane@cleobayhonda.com", name: "Jane Doe" }, { email: "bob@x.com", name: null }, { email: "ann@y.com", name: "Ann Lee" }]);
eq("paste: junk reported, not chipped", parseRecipientText("bob@x.com, not-an-address").bad, ["not-an-address"]);
eq("mailto: prefix stripped", parseRecipientText("mailto:a@b.co").list[0].email, "a@b.co");

// ── Classification ─────────────────────────────────────────────────────────
eq("contact at this company → here", classifyRecipient("jane@cleobayhonda.com", [jane(CLEO), jane(HERE)], opts()).status, "here");
const el = classifyRecipient("jane@cleobayhonda.com", [jane(CLEO)], opts([{ id: CLEO, name: "Cleo Bay Honda", kind: "dealer" }]));
eq("contact at another company → elsewhere, names the company", [el.status, el.contact?.company_name], ["elsewhere", "Cleo Bay Honda"]);
eq("dealer domain → also-add defaults on", el.dealerDomain, true);
eq("free-mail → also-add defaults off",
  classifyRecipient("jane@gmail.com", [jane(CLEO, { email: "jane@gmail.com" })], opts([{ id: CLEO, name: "Cleo Bay Honda", kind: "dealer" }])).dealerDomain, false);
eq("vendor domain → also-add defaults off",
  classifyRecipient("ann@vendor.com", [jane(CLEO)], opts([{ id: "v", name: "Vendor", kind: "vendor" }])).dealerDomain, false);
eq("strong contact preferred over a 'verify' copy",
  classifyRecipient("jane@cleobayhonda.com", [jane(CLEO, { weak: true, id: "weak" }), jane(CLEO, { id: "strong" })], opts()).contact?.id, "strong");
const none = classifyRecipient("new@cleobayhonda.com", [], opts([{ id: CLEO, name: "Cleo Bay Honda", kind: "dealer" }, { id: HERE, name: "Sunrise", kind: "group" }]));
eq("no match → none + domain hint (never this company)", [none.status, none.domainCompanies.map((c) => c.name)], ["none", ["Cleo Bay Honda"]]);
eq("our own address → internal", classifyRecipient("marlena@dealeraddendums.com", [], opts()).status, "internal");
eq("no compose company: a contact anywhere is 'elsewhere'", classifyRecipient("jane@cleobayhonda.com", [jane(HERE)], { ...opts(), companyId: null }).status, "elsewhere");

// ── Suggestions ────────────────────────────────────────────────────────────
const s = rankSuggestions([
  { ...jane(CLEO), id: "a", name: "Janet Other", email: "janet@other.com" },
  { ...jane(HERE), id: "b", name: "Bob Jansen", email: "bob@sunrise.com" },
  { ...jane(CLEO), id: "c", name: "Jane Doe" },
], "jan", HERE);
eq("this company's contacts first, then name-start matches", s.map((x) => x.id), ["b", "c", "a"]);

// ── Names for new contacts ─────────────────────────────────────────────────
eq("display name split", splitName("Jane Doe Smith", "x@y.com"), { first: "Jane", last: "Doe Smith" });
eq("'Last, First'", splitName("Doe, Jane", "x@y.com"), { first: "Jane", last: "Doe" });
eq("from the address", splitName(null, "jane.doe2@x.com"), { first: "Jane", last: "Doe" });
eq("single-word address", splitName(null, "sales@x.com"), { first: "Sales", last: null });

// ── Thread ownership filter (Email tabs / counts) ──────────────────────────
eq("no links → primary only", threadOwnerFilter("company_id", HERE, []), `company_id.eq.${HERE}`);
eq("links → primary or linked", threadOwnerFilter("contact_id", HERE, ["t1", "t2"]), `contact_id.eq.${HERE},id.in.(t1,t2)`);

console.log(fail ? `\n${fail} failed` : "\nall passed");
process.exit(fail ? 1 : 0);
