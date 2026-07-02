// One-off: replay the reliable HubSpot dealer-create sync for a single dealer.
// Runs the DEPLOYED app source via tsx (resolves the @/ alias from tsconfig),
// so it exercises the real syncDealerCreateReliable path — not a reimplementation.
//
//   cd /var/www/da-platform/current
//   npx tsx scripts/replay-hubspot-dealer.ts <dealerUuid> [sourceForm]
//
// dotenv is loaded BEFORE the dynamic import so env-reading module init sees it.
import { config } from "dotenv";
config({ path: "/var/www/da-platform/shared/.env.production" });

const dealerId = process.argv[2];
const sourceForm = process.argv[3] ?? "DA Mktg OS";
if (!dealerId) {
  console.error("usage: tsx scripts/replay-hubspot-dealer.ts <dealerUuid> [sourceForm]");
  process.exit(1);
}

// async IIFE (project transforms .ts as CJS → no top-level await). dotenv above
// runs before the dynamic import so env-reading module init sees it.
(async () => {
  const { syncDealerCreateReliable } = await import("@/lib/sync-hubspot");
  try {
    const id = await syncDealerCreateReliable(dealerId, sourceForm);
    console.log("hubspot_company_id:", id);
    process.exit(id ? 0 : 1); // null = sync failed (see [hubspot-sync] error above for the body)
  } catch (e) {
    console.error("REPLAY ERROR:", e);
    process.exit(1);
  }
})();
