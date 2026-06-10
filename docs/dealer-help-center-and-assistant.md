# Feature — Dealer Help tab: dedicated help CMS + context-aware Claude assistant

> For Claude Code. Owner: Allan. Created 2026-06-06.
> Decisions (Allan): assistant **grounded** in DA help content + curated app knowledge ·
> assistant is **context-aware** of the signed-in dealer's own state · static guides live in
> a **new dedicated dealer-help store** (separate from `qa_help_center`). Surface in the
> existing Help tab (`/help` nav + page already exist; `lib/ai-content.ts` is the Claude
> client to reuse).

## What already exists (build on / replace)
- `/help` page + "Help" nav (dealer-facing) — currently renders `qa_help_center` items
  flagged `faq_visible` (how-to guides by area, steps + tips). Allan wants dealer help on its
  **own** content store, so the dealer Help tab moves to the new model below; QA keeps its
  table for QA.
- `lib/ai-content.ts` — the Anthropic/Claude client (used for vehicle descriptions); reuse it
  for the assistant.

## Part 1 — Dedicated dealer-help CMS (static guides, text + graphics)
- **Migration 091 `help_articles`:** `id, slug, category, title, body (markdown/rich text),
  image_urls (or embedded), audience, sort_order, published bool, updated_by, updated_at`.
  Separate from `qa_help_center`.
- **Authoring UI** (super_admin + support staff — Marlena/Claire): create/edit articles with
  rich-text/markdown **and image upload** (reuse the scoped-image/upload infra → S3), plus a
  publish toggle and ordering. This is the "team edits it" CMS.
- **`/help` rendering:** category browse + search + article view **with graphics**, sourced
  from `help_articles` (published, dealer audience). Replaces the QA-backed list on the dealer
  Help tab.
- Cover the core dealer functions first: Builder/templates, Printing (addendum/infosheet/
  buyer's guide), Inventory (add/edit/VIN), Order Supplies/labels, Billing/plan, Account/Users,
  Settings.

## Part 2 — Context-aware Claude help assistant
- **UI:** an "Ask for help" chat panel in the Help tab (streaming, like the marketing chat).
  Dealer-facing (+ group_admin-as-dealer, super_admin).
- **API:** `POST /api/help/chat` (authenticated). Reuse `lib/ai-content.ts`; stream responses.
- **Grounding (accuracy):**
  - Retrieve the most relevant `help_articles` for the question (search/RAG) and include them
    in the prompt.
  - A curated, **dealer-safe** app-knowledge system prompt (how DA works, navigation, the key
    flows). **Do NOT feed the internal `docs/` spec files or CLAUDE.md** — they hold infra/IPs/
    security detail that must never reach a dealer-facing answer. Maintain a separate
    dealer-facing knowledge doc for grounding.
- **Context-aware (the dealer's OWN data only):** resolve the **effective dealer** via the
  `lib/dealer-authz.ts` helper / `getJwtClaims` and include **safe, relevant** context in the
  prompt — `account_type`/plan, trial status + prints used/remaining (from
  `lib/print-eligibility.ts`), key settings, role/group. So "why can't I print?" gets a real
  answer ("You're on Trial and have used 30 of 30 prints — upgrade from My Profile → Billing").
  - **Safety (non-negotiable):** own-dealer context only — **never** another dealer's;
    group_admin-as-dealer → the **active** dealer; no card/payment data, no PII beyond the
    dealer's own account basics. The assistant is **read-only** in v1 — it explains and points
    to where/how, it does **not** take actions (no cancel/print/charge execution).
- **Guardrails:** system prompt scopes to DA help; declines off-topic; **never invents
  features** (ground or say "I'm not sure — contact support"); rate-limit per dealer; cap
  history length. **Model:** Haiku by default (cost + latency at ~1,600 dealers; grounding
  carries accuracy) — escalate to a stronger model only if quality needs it.
- **Escalation:** when it can't resolve, offer **support@dealeraddendums.com** (or a ticket).

## Surfacing
- The existing **Help tab**: browse the graphic guides (Part 1) + the **Ask-Claude** assistant
  (Part 2), for dealers / group_admin-as-dealer / super_admin.

## Verify
- A dealer opens Help → browses image-rich guides → asks "why can't I print?" → the assistant
  reads **their own** trial/print status and explains + links to Billing.
- Assistant answers DA how-to accurately (grounded), declines off-topic, and **never** surfaces
  another dealer's data; group_admin-as-dealer sees the **active** dealer's context.
- Support staff author/edit an article with an image and publish it → it appears in the Help
  tab.
- Rate-limit + auth hold; the assistant takes no actions (read-only).
- **Stop for review before deploy** — new AI surface for ~1,600 dealers: review the system
  prompt, the guardrails, and the dealer-context scoping (own-data-only) specifically.
