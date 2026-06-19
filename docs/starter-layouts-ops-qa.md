# SuperAdmin Starter Layouts — Ops / QA note

> Companion to `docs/superadmin-starter-layouts.md` (the spec). Captures what shipped, where it
> lives, and how to verify. Feature complete + live as of 2026-06-19.

## What shipped (both phases live)
- **Phase 1** (`01b376b`) — platform starter store + API + SuperAdmin Builder authoring UI.
- **Phase 2** (`66ce1e8`) — dealer/group Builder **"+ New"** picker that clones starters.
- Nav fix (`5d78e5b`) — single **Documents** group (lower position): Documents · SuperAdmin Builder ·
  Buyer's Guide PDFs · Image Library.

## Where it lives
| Piece | Location |
| --- | --- |
| Table | `starter_templates` (migration `107_starter_templates.sql`) — platform scope, no dealer/group |
| API | `app/api/starter-templates/route.ts` (GET list, POST) · `.../[id]/route.ts` (GET, PATCH, DELETE) |
| Nav | `components/Sidebar.tsx` → "SuperAdmin Builder" (`/starter-layouts`, super_admin only) |
| Authoring page | `app/(dashboard)/starter-layouts/page.tsx` + `components/StarterLayoutsClient.tsx` (Add/Edit/Delete) |
| Authoring Builder | `app/(dashboard)/starter-layouts/builder/page.tsx` → `BuilderPage starterMode` |
| Builder | `components/builder/BuilderPage.tsx` — `starterMode` save/load/list; `loadStarterAsNew`; "+ New" picker |

## Auth / data rules
- **Reads** (`GET`, `GET/[id]`) — any authenticated user (dealers need to list starters in +New).
- **Writes** (`POST`/`PATCH`/`DELETE`) — **super_admin only** (`requireSuperAdmin`). RLS blocks all writes;
  the API uses the service-role admin client. Dealers can never mutate a starter (API 403s + RLS).
- **DDL is applied via the Supabase SQL editor** (per the migration pattern) — not from the box. The
  migration file is in the repo for reference; the table was created by Allan in the dashboard.
- Dealers cloning a starter write to their **own** `templates` (`POST /api/templates`) — `loadStarterAsNew`
  clears `loadedTemplateId`/`loadedTemplateLocked`, so Save creates a new dealer template; the starter is
  untouched.

## Gotchas
- **Buyer's-guide starters are filtered out of the dealer "+ New" picker.** The dealer Builder only
  authors addendum/infosheet, and the dealer `templates` POST rejects `buyers_guide`. Buyer's guides
  remain a separate (PDF) flow. The SuperAdmin Builder can still *create* buyer's-guide starters; they
  just won't appear in the dealer picker.
- **Zero starters → "+ New" goes straight to Blank** (no empty picker); a fetch error also falls through
  to Blank — never blocks the dealer.
- super_admin **starter-mode** "+ New" makes a new blank **starter** (not the dealer picker).
- A starter clone pre-fills the Save modal's `name` (from the starter) + `doc_type`. If a dealer already
  has a template with that exact name, Save updates theirs (existing name-match behavior) — rename in the
  Save modal to force a new row.

## QA click-through (live verification — do once)
1. **super_admin → SuperAdmin Builder** (`/starter-layouts`): + New → design → Save (name + doc type +
   paper) → row appears; Edit reopens it; Delete (confirm) removes it. Create 1 addendum + 1 infosheet
   starter so the dealer picker has content.
2. **Role gating:** a normal dealer can `GET` the list (200) but `POST/PATCH/DELETE` 403.
3. **Dealer/group Builder (ghost or impersonate) → + New:** picker shows Blank + the starters.
   - **Blank** resets exactly as before.
   - **Pick a starter** → layout clones (bg/widgets/paper/font); **Save template** → a *new* dealer
     template is created; re-open the starter in SuperAdmin Builder → unchanged. Save doc-type matches
     the starter.
4. **Edge:** with no starters, + New goes straight to Blank.

## Deploy refs
- `01b376b` Phase 1 · `5d78e5b` nav merge · `66ce1e8` Phase 2. All on da-platform V5.0
  (`bash deploy.sh`, health-gated). Migration 107 applied in the Supabase SQL editor 2026-06-19.
