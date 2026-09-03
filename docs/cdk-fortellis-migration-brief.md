# CDK → Fortellis Migration Brief

**Status:** Action required  
**Deadline:** October 23, 2026 (Sunset Date)  
**Effective today:** June 27, 2026 — ~119 days remaining  
**Owner:** Allan Tone  

---

## What's Happening

CDK is permanently shutting down its "Partner Integration Program" (PIP) — the legacy mechanism by which CDK DMS dealerships push vehicle inventory to third-party apps like DA. After the Sunset Date, CDK will cut off all PIP access and DA will stop receiving inventory from CDK dealers.

The replacement is **Fortellis** — CDK's modern API platform. Fortellis is owned and operated by CDK Global; it's not a separate vendor, it's just the new way CDK exposes its data.

---

## What DA Uses CDK PIP For

CDK PIP delivers **vehicle inventory** (new & used lot data) for CDK-DMS dealerships to DA's **ETL2 server** (`etl2.dealeraddendums.com`, `34.227.197.196`). ETL2 receives the pushed feed and stores it in Aurora MySQL, where it flows into the standard DA inventory system.

CDK dealers in DA are identifiable by:
- `DEALER_ID` prefix `3PA`, OR  
- `CREATED_BY = 'automatic9'`

DA Pulse already treats these dealers as a separate tier (90-day inventory window vs. 18-month for standard dealers) because CDK never sends sold/inactive signals — this nuance must be preserved after migration.

---

## The Replacement: Fortellis Inventory Vehicle API

The specific API replacing the PIP vehicle inventory feed is the **CDK Inventory Vehicle API** on Fortellis (Wave 4, released Jan 2024). It supports:

- **GET (bulk/delta)** — pull current inventory for a dealer
- **Async (event-driven)** — receive inventory change events as they happen

This is a shift from **CDK pushing data to DA** → **DA pulling data from CDK per dealer via Fortellis**.

---

## Migration Process (8 Mandatory Steps)

This is CDK's formal process. There's no shortcut — they control certification and won't cut over until all steps are complete.

### Step 1 — Create Fortellis Account & Organization
- Go to [developer.fortellis.io](https://developer.fortellis.io)
- Create an account under DealerAddendums LLC
- Connect to or create the DealerAddendums organization

### Step 2 — Register the App
- Register a new app in the Fortellis Developer Console
- Add the **Inventory Vehicle** API to the app
- This generates OAuth 2.0 credentials (client_id/secret) for development

### Step 3 — Build & Test
- CDK provides a sandbox environment after registration (sent via "Fortellis Welcome" email)
- Before certification, you must submit an **App Workflow Template** describing how the API is used
- ETL2 must be rewritten to authenticate via Fortellis OAuth and pull inventory via GET/Async instead of receiving PIP pushes

### Step 4 — CDK Certification
- CDK's team reviews the app and tests integration quality
- Requires completion of the app workflow template first
- CDK issues a Certification Test report; you sign and return it
- **This step is the critical path** — CDK's timeline is unknown; it can take weeks

### Step 5 — Publish Marketplace App Listing
- Create a public App Listing on Fortellis Marketplace
- This is how dealers consent to DA accessing their CDK data going forward
- **Cost: $129/month** (new recurring fee)

### Step 6 — Pilot Test (~40 days)
- Run new Fortellis integration with a small subset of CDK dealers
- CDK establishes a standard 40-day pilot window starting from Certification Date
- Continue using PIP during pilot

### Step 7 — CDK Migrates All Dealer Subscriptions
- Once certified, CDK migrates all existing dealer PIP subscriptions to Fortellis
- CDK commits to doing this within 10 days of certification completion
- DA gets to test connections to every CDK dealer before full cutover

### Step 8 — Sign Cutover Document & Go Live
- Sign CDK's "ISV Migration Cutover Signoff" confirming pilot complete + all connections tested
- CDK disables PIP access on the Sunset Date

---

## Timeline

| Milestone | Target Date | Notes |
|-----------|------------|-------|
| Start Fortellis registration | **ASAP — this week** | Free, no dependency |
| Dev complete + cert submission | Mid-August 2026 | ~7 weeks of dev time |
| Certification complete | ~September 12, 2026 | CDK's review timeline unknown |
| 40-day pilot begins | ~September 12 | Runs concurrent with PIP |
| CDK migrates dealer subs | ~September 22 | Within 10 days of cert |
| All dealer connections tested | ~October 10 | Before cutover signoff |
| **Sunset Date / PIP disabled** | **October 23, 2026** | Hard deadline |

> **Risk:** If certification takes longer than expected, the entire timeline compresses. CDK cannot extend the Sunset Date once set. Starting registration and dev this week is critical.

---

## Technical Scope (ETL2 Rewrite)

ETL2 currently sits passively and receives pushed inventory data from CDK. After migration, ETL2 becomes an active puller.

**Changes required to ETL2:**

1. **Fortellis OAuth authentication** — each CDK dealer connection has its own OAuth token (client credentials flow using the Fortellis credentials from the app). Need to manage token refresh per dealer.

2. **Inventory Vehicle API calls** — replace the PIP receiver with scheduled API calls:
   - Either GET bulk (full inventory pull per dealer on a schedule), or
   - Subscribe to Async events (real-time delta updates)
   - Recommend starting with GET bulk to mirror current behavior, then evaluate Async

3. **Response mapping** — Fortellis returns standardized JSON (not CDK's proprietary PIP format). The mapping from Fortellis inventory fields to Aurora/Supabase fields needs to be built.

4. **Dealer subscription management** — when a new CDK dealer onboards to DA, they now activate via Fortellis Marketplace (not CDK E-Store). ETL2 needs to detect new subscriptions.

5. **DA Pulse compatibility** — the 90-day active-window logic for CDK dealers must remain. The `feed_type = 'cdk'` classification in `report_dealer_coverage` should stay intact regardless of ETL2's pull mechanism.

---

## Cost Changes

| Fee | Before | After |
|-----|--------|-------|
| CDK Partner Program per-dealer install fee | $100/dealer | **$0** (eliminated on Fortellis) |
| CDK Partner Program per-dealer monthly integration fee | Varies (per contract) | Replaced by Fortellis API usage fees |
| Fortellis Marketplace listing | $0 | **$129/month** (new) |
| Fortellis API call fees | $0 | Usage-based (get pricing from CDK account team) |

The per-dealer install fee going to $0 is a benefit. Monthly API fees need to be clarified with CDK — ask your Customer Success Manager during Step 1.

---

## Immediate Action Items

1. **Contact CDK account manager today** — confirm your specific Certification Date (your 120-day notice started a clock; the exact cert date may be in the letter). Ask about API pricing.

2. **Create Fortellis account** at [developer.fortellis.io](https://developer.fortellis.io) — register DealerAddendums LLC as organization.

3. **Register app + select Inventory Vehicle API** — this triggers CDK to send the Fortellis Welcome email with sandbox access.

4. **Send to CC** (Claude Code on Mac) to begin ETL2 rewrite once sandbox credentials arrive.

---

## Key Resources

- [Fortellis API Directory](https://apidocs.fortellis.io/) — Inventory Vehicle API specs
- [Fortellis Developer Resources](https://docs.fortellis.io/) — tutorials, authorization guide
- [CDK ISV Migration Page](https://www2.fortellis.io/isv-migration) — migration guide and updates
- [CDK Migration Guide PDF](https://community.fortellis.io/sites/default/files/CDK_Modern.APIs_Migration.Guide_04.14.2023.pdf) — formal migration steps
- [Fortellis Marketplace](https://marketplace.fortellis.io/) — where App Listing gets published

---

## Open Questions for CDK Account Team

- What is DA's exact Certification Date (as stated in the Sunset Notification)?
- What are Fortellis API pricing plans for Inventory Vehicle (cost per dealer per month)?
- How many DA dealers are currently enrolled via CDK PIP? (CDK can provide this list)
- Does DA currently use any other CDK PIPs beyond vehicle inventory? (check with ETL2 code audit)
- Is there a Fortellis "History Setup" API needed if dealers lose historical data during transition?
