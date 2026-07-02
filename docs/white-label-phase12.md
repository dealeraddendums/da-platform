# Phase 12 — Enterprise White Label (`<reseller>.addendums.ai` subdomains)

> Owner: Allan. Created 2026-06-19. Groups/resellers get a **branded subdomain under the
> DA-owned `addendums.ai`** (e.g. `autonation.addendums.ai`); their group, users, and dealers who log
> in via that URL see a UI branded to it (logo + name + colors). The same users on
> `app.dealeraddendums.com` see default DA — no branding. STOP for review per phase.

## Decisions (Allan, 2026-06-19)
- **Domain model:** **`<reseller>.addendums.ai` subdomains** (DA controls `addendums.ai`, registered
  2026-06-19). **Revised** from the earlier "reseller's own domain" plan — DA-controlled subdomains are
  far simpler (one wildcard cert, shared auth) and still clean/white-label-feeling. True reseller-owned
  vanity domains (`addendums.autonation.com`) become an **optional later premium** (12c).
- **Branding scope:** **logo + name + colors** (a theme over the structural design system).
- **Host-driven:** branding follows the URL, not the user. Via the `<reseller>.addendums.ai` URL →
  branded; via `app.dealeraddendums.com` → default DA, even for the same dealer/user.

## Auth (now simple, because it's all under one registrable domain)
WebAuthn passkeys + Supabase cookies are bound to the **registrable domain**. All white-label hosts
share `addendums.ai`, so:
- Set the WebAuthn **rpID = `addendums.ai`** and cookies to **`.addendums.ai`** for white-label hosts →
  **passkeys + sessions share across every `*.addendums.ai` subdomain** → seamless login, **no
  cross-domain rework.**
- The canonical app stays `app.dealeraddendums.com` (a *different* registrable domain), so make the
  relying-party **host-aware** instead of one static value: derive `rpID` / `expectedOrigin` from the
  **request host's registrable domain**, allowlisted to `dealeraddendums.com` **and** `addendums.ai`.
  → existing `dealeraddendums.com` passkeys keep working unchanged; `*.addendums.ai` hosts share among
  themselves. (Today `RP_ID`/`RP_ORIGIN` are single env values in the four `app/api/auth/passkey/*`
  routes — make them host-derived with an allowlist.)
- Password + OTP-code login works on every host regardless (no passkey dependency).
- **Confirm prod `RP_ID`** before building (governs the canonical behavior + the host-aware change).
- **Optional future / strategic:** moving the **canonical** app to `app.addendums.ai` would unify
  everything under one rpID (cleanest long-term) but is a rebrand + a passkey re-registration migration
  off `dealeraddendums.com` — **separate decision, not required** for white-label.

## Infra (12b — mostly ONE-TIME, with Alex)
- **One wildcard TLS cert `*.addendums.ai`** (ACM) on the ALB HTTPS listener + **wildcard DNS
  `*.addendums.ai` → the ALB**. The app accepts `*.addendums.ai` hosts (add to CSP / allowed-origins in
  `middleware.ts`).
- After that one-time setup, **adding a reseller = just set the group's `custom_domain =
  <reseller>.addendums.ai`** (the wildcard cert + DNS already cover it) — **no per-reseller cert or DNS.**
  That's the big win over reseller-owned domains.

## Data model (shipped in 12a)
- `groups.custom_domain text UNIQUE` (case-insensitive) — holds a `<reseller>.addendums.ai` host.
- `groups.branding jsonb` — `{ display_name, logo_url, primary_color, accent_color, favicon_url }`.
- `groups.custom_domain_status` — `pending | active`. (Migration 110.)

## Host → brand resolution + branding (shipped in 12a)
- `lib/brand.ts resolveBrandForHost(host)`: active `custom_domain` match → that group's brand;
  canonical/unknown → default DA. 60s cache, fail-open. Partial branding merges over DA defaults;
  colors validated `#rrggbb`.
- Branded login + app shell (logo + name + primary/accent + login palette via CSS-var override). Navy
  topbar/sidebar **chrome stays structural** (white text → don't tint with an arbitrary brand color;
  contrast). Default DA on canonical. super_admin config UI on the group (domain + branding + status +
  DNS target).

## super_admin config UI (12a)
- Set `custom_domain` (a `<reseller>.addendums.ai` host) + branding (logo upload, display name,
  primary/accent pickers); show status + the DNS/wildcard note. super_admin-only.

## Phasing
- **12a — SHIPPED** (built; deploying): data model + host→brand resolution + branded login/shell +
  super_admin config UI. Testable now by pointing a `*.addendums.ai` (or any host that routes to the
  ALB) at a group.
- **12b — infra + host-aware auth (with Alex):** wildcard cert `*.addendums.ai` + wildcard DNS → ALB +
  app accepts the hosts (CSP) + **host-aware WebAuthn rpID/expectedOrigin** (+ cookie domain) so
  `*.addendums.ai` shares passkeys/sessions while `dealeraddendums.com` is unaffected. Password/OTP +
  passkey both work on reseller subdomains.
- **12c — optional premium (later):** true reseller-owned vanity domains (their own registrable
  domain) — per-domain cert + the cross-registrable-domain auth this subdomain model avoids.

## Open decisions
1. **Confirm prod `RP_ID`** + adopt the **host-aware rpID/expectedOrigin** approach (12b).
2. **Wildcard cert** `*.addendums.ai` on the ALB — **Alex** (one-time; replaces the per-reseller cert
   runbook the old plan needed).
3. (Strategic, optional) eventually move the canonical to `app.addendums.ai` to unify rpID — not
   required for white-label.

## Verify
- 12a: point a host at a group → that host shows reseller logo/name/colors on login + shell;
  `app.dealeraddendums.com` stays default DA; same dealer differs by host; 2nd group can't reuse a
  domain (409).
- 12b: `<reseller>.addendums.ai` resolves over HTTPS (wildcard cert); login works incl. a passkey that
  works across `*.addendums.ai`; `dealeraddendums.com` passkeys still work; out-of-brand hosts unaffected.
- STOP for review per phase.
