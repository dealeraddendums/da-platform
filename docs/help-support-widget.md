# Feature — Global Help/Support widget (AI + experience + live human chat + HubSpot memory)

> For Claude Code. Owner: Allan. Created 2026-06-06. **Consolidates + supersedes** the
> Help-engine enhancements (videos, corrections, 👎, escalation) and builds on the shipped
> /help assistant. Decisions (Allan): **full-transcript** HubSpot logging · **in-app
> live-chat takeover** for the human handoff · a **support-agent client that runs on the
> support team's computers and iPhones**.

## Vision
A persistent **Help/Support bubble on every authenticated screen**. It answers from
**experience** (the help KB, continuously improved by corrections) + **AI** (the grounded,
context-aware Claude assistant already built), hands off to a **real person via in-app live
chat** when asked, and writes **every conversation to HubSpot** for future reference.

## Recommended phasing (these are two very different sizes of build)
Allan chose the ambitious options; phase it so value ships fast and the heavy part is built right:
- **Phase A — the widget + AI + memory (reuses what's built):** global bubble · the existing
  grounded assistant everywhere · corrections/feedback loop · video guides · **async** human
  handoff (notify support + review queue) · **HubSpot transcript logging**. Most of the value,
  soon.
- **Phase B — real-time live chat + the support-agent client:** Supabase Realtime, the AI→human
  takeover, and a **support console for desktop + iPhone** with alerting. This is essentially a
  lightweight Intercom + an agent app — a sizable, focused build on top of Phase A's plumbing.

## 1. Global widget (dealer/user side, all UI)
Floating "Help / Support" bubble (bottom-right) in the `(dashboard)` layout — every
authenticated page, all dealer-context roles (+ group_admin-as-dealer). Opens a panel: AI
chat, quick links to top guides, and **"Talk to a real person."** Reuses the shipped assistant
(`/api/help/chat`, `lib/help-knowledge`, `help-context` — own-data-only). Complements the
`/help` tab (full guide browsing stays there).

## 2. Experience + AI grounding
- **AI** = the grounded, context-aware assistant (KB + the dealer's own context).
- **Experience** = the `help_articles` KB, continuously improved by the **corrections loop**:
  super_admin reviews logged conversations and turns good resolutions/corrections into
  articles, so answers get better over time.

## 3. Videos + corrections + feedback (folded from the enhancements scope)
- **Video** in guides: embed YouTube/Vimeo + upload short clips to S3 — **strict iframe
  allowlist** in the sanitizer (YouTube/Vimeo only; never arbitrary iframes).
- **Conversation logging** (migration `help_conversations` + messages + `status` + `feedback`)
  — own-data-only (dealer's help Q&A + own-account context; no card/PII/cross-dealer).
- **Dealer 👍/👎** per answer; 👎 flags for review.
- **Review surface** (super_admin/support): correct bad answers **into** the KB; mark resolved.

## 4. Real person — in-app live-chat takeover (Phase B)
- Trigger: "Talk to a real person," or the AI escalates when it can't help.
- Transport: **Supabase Realtime** (already in the stack) — dealer ↔ support messages stream
  live on the conversation channel.
- State machine: AI → requested-human → waiting → claimed (live with {agent}) → resolved; the
  widget reflects the state ("connecting you to support…", "Marlena is helping you").
- **Presence + graceful fallback (critical):** show support online/offline; when **no agent is
  available** (off-hours), do NOT strand the dealer — take a message, notify support (Mandrill),
  promise follow-up, log as open. Live chat must degrade to async when unstaffed.

## 5. Support-agent client — desktop + iPhone (Phase B)
The support team (Marlena/Claire/super_admin) needs to receive and answer chats from their
**computers and iPhones**:
- **Build it as one responsive web console** (an inbox: waiting/open conversations, claim, full
  AI transcript + dealer context, respond in real time via Supabase Realtime, resolve) that
  works on desktop browsers **and** iPhone Safari.
- **Make it an installable PWA** so support can add it to the iPhone home screen and receive
  **web push** for new/waiting chats (iOS 16.4+ supports push for installed PWAs) — one
  codebase covers computers + phones, no app store.
- **Alert backstop:** also fire an **SMS (Twilio — already in the DA stack) and/or email** on a
  new waiting chat, so a request is never missed when the PWA isn't foregrounded.
- *(Heavier alternative if you want a true native app later: a native iOS support app — two
  codebases + app-store. Recommend the responsive-PWA path for v1.)*
- **Availability + routing:** each agent has an **On / Off (available) toggle**. While **On**,
  they receive a **notification of every new support chat** — web push (if the PWA is
  installed), the SMS/email backstop, and an in-console alert/unread badge — and are counted as
  present. While **Off**, no notifications and not counted. The widget's "support online"
  indicator and the **unstaffed → async fallback** both derive from whether **any** agent is
  currently On. (Optional later: round-robin/claim so one chat doesn't alert everyone forever
  once an agent picks it up.)

## 6. HubSpot memory — full transcript (Allan's choice)
- **Every conversation → HubSpot** for future reference: a **note/engagement** on the **user's
  Contact** (`HUBSPOT_CONTACT_ID` on profiles) associated to the **dealership's Company**
  (`HUBSPOT_COMPANY_ID` on dealers), via the existing `lib/hubspot.ts` +
  `HUBSPOT_PRIVATE_APP_TOKEN`.
- **Write on conversation CLOSE** — one note = the full transcript (questions, AI answers, any
  human turns, resolution) — **async/fire-and-forget** (like the Phase-14 sync), never blocking
  the chat. Not per-message.
- **Volume caveat:** full transcripts across ~1,600 dealers is heavy — batch/async, respect
  HubSpot rate limits, and log failures to the existing `hubspot_sync_errors` table. Additive
  write type; does not touch the fields Phase-14 owns.

## Safety
- Assistant context stays **own-data-only** via the `dealer-authz` helper (never cross-dealer);
  the AI is read-only (humans take actions).
- Conversation logs + HubSpot notes hold the dealer's own help Q&A + own-account basics — no
  card/PII/cross-dealer.
- The live chat, support console, and review surface are **support/super_admin-gated**.

## Verify
- Widget on every page; AI answers grounded + context-aware; "Talk to a real person" connects
  live to a support agent (or, when unstaffed, takes a message + notifies).
- Support agent answers from **desktop and iPhone** (responsive PWA), gets a push/SMS on a new
  chat, and replies in real time.
- On close, a full-transcript note lands on the user's HubSpot Contact + dealership Company;
  failures → `hubspot_sync_errors`.
- 👎 + corrections improve the KB; video guides render (safe embeds only).
- No card/PII/cross-dealer in any log or HubSpot note.
- Stop for review before deploy (AI + live chat + CRM writes) — review the prompt, own-data
  scoping, the unstaffed fallback, and the HubSpot write volume.
