# In-App Interactive Tours (V5.0)

> Owner: Allan. Created 2026-06-15. **Decision (Allan): interactive guided tours only** — coachmark
> step-by-step overlays on the real app, for both the **new-user overview** (auto on first login) and
> **existing-user task how-tos** (order labels, change card, print multiple addendums, etc.). Extends the
> existing Help Center (`help_articles` CMS, Help widget, AI assistant) — tours are a sibling content type,
> not a new silo.

## ✅ APPROACH DECIDED: BUY — Product Fruits (no-code SaaS), Business plan
Build-vs-buy resolved to **buy**. **Product Fruits** wins because it delivers the thing the in-house build
can't: **true no-code authoring** — Allan/Marlena build tours by clicking through the live app (no dev
needed to anchor elements), with hotspots + modals + tooltips + checklists + analytics + AI flow-generation
out of the box, live in days. **Plan: Business** — the AI-rich tier (Allan, 2026-06-22): contextual + voice
onboarding, the Elvin AI copilot (on-demand guides, discoveries), the creator agent, auto-translations,
SAML SSO, unlimited tours/hints/flows.

### ⚠️ Pricing — corrected 2026-06-22 (the earlier "free tier ≤5,000 MAU / $99 above" was WRONG)
Product Fruits revamped its site/pricing in 2026 — there is **no free-forever tier**, and the trial is now
**demo-led** (no self-serve "Start free trial" on the plan cards; their FAQ: *"we figure out the right trial
length together during the call"*). Pricing is **per monthly-active-user (MAU)** — Starter ~$96 / Pro ~$149 /
Business ~$149 **at 1,500 MAU**, scaling up from there.
**🔴 MAU cost caveat:** DA serves **1,600+ dealer accounts with multiple users each**, so the real MAU is
likely **several thousand** → Business will cost **materially more** than the 1,500-MAU sticker. **Confirm
the Business price at DA's actual MAU on the demo before committing** — this is the real budget question, not
the headline number. (Survey for reference: Appcues ~$300/mo·1k MAU, Userpilot ~$299·2k, Chameleon $279+ w/
free plan, Pendo enterprise; cheaper alts that DO have real free/low tiers if Business gets too costly:
Usetiful free/$39, or the build-it-yourself Driver.js/Joyride MIT-free fallback parked below.)

### Sign-up
- **Self-serve account:** "Try for Free" → https://my.productfruits.com/account/signup
- **Business plan / trial setup:** Book a Demo → https://productfruits.com/demo · Talk to Sales →
  https://productfruits.com/contact
- Pricing → https://productfruits.com/pricing

**Integration (small, da-platform):** embed the PF SDK in `app/(dashboard)/layout.tsx`, **identify** the
logged-in user (stable id, email, signUpAt, role, account_type, dealer/group) for segmentation, and
**allowlist PF domains in the `middleware.ts` CSP** (the CSP would otherwise block the script — same gotcha
that bit Turnstile). The two audiences/triggers below (new-user overview = auto; task how-tos = on-demand)
are then **configured inside Product Fruits** (segments + triggers), not built. Tradeoff accepted: a
third-party script on the app + tour content lives in PF's cloud (onboarding content, not business data).

> **⚠️ Everything below (Driver.js engine, data model, anchors, authoring UI) is PARKED as the in-house
> fallback** — revisit only if the third-party script or data-residency becomes a dealbreaker.

## Two audiences, two triggers
- **New user → overview tour.** Auto-runs once on first login (welcome + the 5-6 things that matter:
  inventory, Builder, Print, Order Supplies, Billing, Help). Tracked per user so it never re-nags;
  replayable from the Help Center any time.
- **Existing user → task tours.** On-demand, launched from (a) the Help Center "Tours" list and (b)
  contextual **"Show me how"** buttons on the relevant page (e.g. a "Show me how" on Order Supplies starts
  the order-labels tour). Each is a named tour keyed by slug.

## Library — Driver.js
Use **Driver.js** (~5kb, framework-agnostic, overlay highlight + popover, fully programmatic). Cleaner in
Next.js than react-joyride (no React-version friction) and easy to drive across route changes. Wrap it in
one runner component; never let a tour throw into the app.

## Targeting — stable `data-tour` anchors, NOT CSS selectors
Each step targets a **`data-tour="<anchor>"`** attribute added to the real element — never a brittle CSS
/ class selector. Devs add anchors once to key elements; tours reference them by name. If an anchored
element is absent for this user/role/page, the step **gracefully skips** (never breaks the tour). Keep a
central **anchor registry** (`lib/tour-anchors.ts`) listing every known anchor + a human label, so the
authoring UI can offer a dropdown instead of raw strings.

> **Honest limitation of "interactive tours only" (flagged to Allan):** a tour pointed at a NEW element
> needs a dev to add its `data-tour` anchor first. To make authoring broadly self-serve, **Phase 1 anchors
> the whole primary nav + the key action buttons across the core pages** so a wide library of tours is
> authorable with no further dev work.

## Data model (Supabase — next sequential migration; check latest, ~097+)
- `tours` — `id`, `key` (slug, e.g. `new-user-overview`, `order-labels`), `title`, `description`,
  `audience` (`all` | `dealer` | `group_admin` | …), `trigger` (`auto_first_login` | `manual`),
  `start_route`, `enabled`, `sort_order`, timestamps.
- `tour_steps` — `tour_id`, `step_order`, `anchor` (data-tour value), `route` (page this step lives on —
  enables multi-page tours), `title`, `body`, `placement` (`top|bottom|left|right|auto`). (Or a JSON
  `steps[]` column on `tours` — author's call; a child table is cleaner for ordering/editing.)
- `tour_completions` — `user_id` (auth user / profile), `tour_key`, `completed_at`, `dismissed_at`. Drives
  the once-only auto-run + replay + engagement analytics. RLS: a user reads/writes only their own rows.

## Runner (client component, mounted in the dashboard layout)
- On mount: if an `auto_first_login` tour for this user's audience has no `tour_completions` row → start it.
- Exposes `startTour(key)` (React context) for replay links + "Show me how" buttons. Also accept
  `?tour=<key>` on a route to deep-link a tour.
- Drives Driver.js from the tour's steps, resolving each `anchor` → element; **skip missing anchors**.
- **Cross-page tours:** when the next step's `route` ≠ current route, persist `{tourKey, stepIndex}` to
  `sessionStorage`, `router.push(route)`, and resume on the next page's mount. (P1 can keep the overview
  single-page-ish; full cross-page lands in P2 for task tours like order-labels.)
- On finish/dismiss → write `tour_completions`. On-brand popovers: navy `#2a2b3c` header, orange `#ffa500`
  accent, blue `#1976d2` primary button, Roboto.

## Surfacing
- **Auto** first-login overview (once).
- **Help Center** gains a **"Tours"** section listing enabled tours for the user's audience, each with a
  **Start** button (replayable).
- **Contextual "Show me how"** buttons on key pages → `startTour(<key>)`.

## Authoring (Phase 2) — extend the Help admin
Add a **"Tours"** tab to the Help admin (mirror `HelpAdminClient`): CRUD tours + steps — pick the `anchor`
from the registry dropdown, write `title`/`body`, set order, `placement`, `route`, `audience`, `trigger`,
`enabled`. This is the non-dev "way to create tutorials" Allan asked for — over already-anchored elements.

## Phasing
- **P1 — engine + first tour.** Driver.js runner in the dashboard layout; `tours`/`tour_steps`/
  `tour_completions` migration; anchor the full primary nav + key action buttons across core pages;
  author the **new-user overview** tour (dev-seeded) with auto-first-login + replay-from-Help. Proves the
  system + ships the genuine gap.
- **P2 — authoring + task tours.** Tours admin tab; cross-page resume; contextual "Show me how" buttons;
  seed the first task tours (order labels, change credit card, print multiple addendums).
- **P3 — polish.** Completion analytics per tour (where users drop), audience targeting refinements, more
  anchors as features ship.

## Guardrails
- Tours never block or break the app (missing anchor → skip; runner errors swallowed).
- Per-user completion tracking; never re-nag a finished/dismissed auto tour.
- Anchors are the contract — when a feature's UI changes, update its anchor, not every tour.
