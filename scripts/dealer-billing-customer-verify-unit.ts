/**
 * Unit checks for ensureDealerCustomer — the link-don't-duplicate resolver.
 *   npm run test:dealer-billing-customer
 *
 * No network, no database: every da-billing call and the pointer write are
 * injected, so what is pinned down here is the BRANCH PRECEDENCE, which is the
 * whole fix. The bug being guarded against (AutoNation Audi Fremont,
 * 2026-09-18) was a NULL `billing_customer_id` read as "no billing exists",
 * minting a duplicate customer beside a real, actively-billing one. So the
 * cases that matter most are the ones asserting `created === false`.
 */

import { ensureDealerCustomer, type DealerCustomerSnap, type EnsureDealerCustomerDeps } from "../lib/dealer-billing-customer";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; failures.push(`${label}${detail ? ` — ${detail}` : ""}`); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

const FREMONT: DealerCustomerSnap = {
  id: "7e2b328f-b7e9-4cf0-9d56-528e826cebd5",
  name: "AutoNation Audi Fremont",
  internal_id: "1781903035",
  billing_customer_id: null,
  primary_contact: "Joseph Malek",
  primary_contact_email: "malekj@autonation.com",
};

interface Spy { pointerWrites: { dealerId: string; customerId: string }[]; created: number; stamped: { id: string; internalId?: string }[]; }

function deps(over: Partial<EnsureDealerCustomerDeps> & { spy: Spy }): Partial<EnsureDealerCustomerDeps> {
  const { spy, ...rest } = over;
  return {
    customerExists: async () => false,
    searchCustomers: async () => [],
    createCustomer: async (input) => { spy.created++; return { id: "NEW-CUSTOMER", company: input.company }; },
    updateCustomer: async (id, fields) => { spy.stamped.push({ id, internalId: fields.internalId }); return { id }; },
    setPointer: async (dealerId, customerId) => { spy.pointerWrites.push({ dealerId, customerId }); },
    ...rest,
  };
}
const spy = (): Spy => ({ pointerWrites: [], created: 0, stamped: [] });

(async () => {
  console.log("\nensureDealerCustomer — link-don't-duplicate precedence\n");

  // 1. THE REGRESSION. Fremont's exact shape: NULL pointer, real customer
  //    already there under the same company name, carrying no internalId.
  {
    const s = spy();
    const r = await ensureDealerCustomer(null as never, FREMONT, deps({
      spy: s,
      searchCustomers: async () => [{ id: "b566b490", company: "AutoNation Audi Fremont", name: "Joseph Malek" }],
    }));
    check("NULL pointer + existing customer by name → links, does NOT mint", r.customerId === "b566b490" && r.created === false, `got ${r.customerId} via ${r.via} created=${r.created}`);
    check("  …and mints nothing", s.created === 0, `created ${s.created}`);
    check("  …and writes the pointer to the existing customer", s.pointerWrites.length === 1 && s.pointerWrites[0].customerId === "b566b490");
    check("  …and stamps internal_id so next time resolves by id", s.stamped.length === 1 && s.stamped[0].id === "b566b490" && s.stamped[0].internalId === "1781903035");
  }

  // 2. internal_id wins over a name-only candidate.
  {
    const s = spy();
    const r = await ensureDealerCustomer(null as never, FREMONT, deps({
      spy: s,
      searchCustomers: async () => [
        { id: "NAME-TWIN", company: "AutoNation Audi Fremont" },
        { id: "ID-HIT", company: "AN Audi Fremont (legacy)", internalId: "1781903035" },
      ],
    }));
    check("internal_id match beats an exact-name match", r.customerId === "ID-HIT" && r.via === "internal_id", `got ${r.customerId} via ${r.via}`);
    check("  …no re-stamp when the id is already there", s.stamped.length === 0);
  }

  // 3. Genuinely new dealer → still creates, exactly once, carrying internal_id.
  {
    const s = spy();
    const r = await ensureDealerCustomer(null as never, { ...FREMONT, name: "Brand New Motors" }, deps({ spy: s }));
    check("no customer anywhere → creates one", r.customerId === "NEW-CUSTOMER" && r.via === "created" && r.created === true, `via ${r.via}`);
    check("  …exactly once", s.created === 1);
    check("  …and the pointer is set", s.pointerWrites.length === 1 && s.pointerWrites[0].customerId === "NEW-CUSTOMER");
  }

  // 4. Already linked → untouched. No re-mint, no pointer overwrite.
  {
    const s = spy();
    const r = await ensureDealerCustomer(null as never, { ...FREMONT, billing_customer_id: "ALREADY-LINKED" }, deps({
      spy: s,
      customerExists: async () => true,
      searchCustomers: async () => { throw new Error("must not search when already linked"); },
    }));
    check("existing valid pointer → returned as-is", r.customerId === "ALREADY-LINKED" && r.via === "existing_pointer");
    check("  …no pointer write, no mint", s.pointerWrites.length === 0 && s.created === 0);
  }

  // 5. A da-billing hiccup must never become a mint — that is how the
  //    duplicate was born.
  {
    const s = spy();
    const r = await ensureDealerCustomer(null as never, FREMONT, deps({
      spy: s,
      searchCustomers: async () => { throw new Error("da-billing 503"); },
    }));
    check("lookup failure → fails closed, does NOT mint", r.customerId === null && r.via === "failed" && s.created === 0, `via ${r.via}, created ${s.created}`);
  }

  // 6. A non-NULL pointer is only re-resolved when da-billing CONFIRMS it is
  //    gone — never on a transient error.
  {
    const s = spy();
    const r = await ensureDealerCustomer(null as never, { ...FREMONT, billing_customer_id: "MAYBE-GONE" }, deps({
      spy: s,
      customerExists: async () => { throw new Error("da-billing 503"); },
      searchCustomers: async () => { throw new Error("must not re-resolve on a transient error"); },
    }));
    check("pointer check errors → keeps the existing pointer", r.customerId === "MAYBE-GONE" && s.pointerWrites.length === 0);
  }
  {
    const s = spy();
    const r = await ensureDealerCustomer(null as never, { ...FREMONT, billing_customer_id: "REALLY-GONE" }, deps({
      spy: s,
      customerExists: async () => false,
      searchCustomers: async () => [{ id: "THE-REAL-ONE", company: "AutoNation Audi Fremont", internalId: "1781903035" }],
    }));
    check("confirmed-stale pointer → re-resolves to the real customer", r.customerId === "THE-REAL-ONE" && r.via === "internal_id");
  }

  // 7. Ambiguity must not be guessed at.
  {
    const s = spy();
    const r = await ensureDealerCustomer(null as never, FREMONT, deps({
      spy: s,
      searchCustomers: async () => [
        { id: "TWIN-A", company: "AutoNation Audi Fremont" },
        { id: "TWIN-B", company: "AutoNation Audi Fremont" },
      ],
    }));
    check("two exact-name matches → refuses to guess, creates instead", r.via === "created" && s.created === 1, `via ${r.via}`);
  }

  // 8. A substring hit is not a match (searchCustomers is a substring search).
  {
    const s = spy();
    const r = await ensureDealerCustomer(null as never, FREMONT, deps({
      spy: s,
      searchCustomers: async () => [{ id: "NEARLY", company: "AutoNation Audi Fremont Collision Center" }],
    }));
    check("substring-only candidate is NOT linked", r.customerId !== "NEARLY" && r.via === "created", `via ${r.via}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("\nFailures:"); failures.forEach(f => console.log("  - " + f)); process.exit(1); }
})();
