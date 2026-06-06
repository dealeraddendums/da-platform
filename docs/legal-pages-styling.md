# Feature — brand the /terms and /privacy pages (logo, login background, white sheet, PDF, LLC)

> For Claude Code. Owner: Allan. Created 2026-06-05.
> The /terms and /privacy pages are live but plain. Make them on-brand and add a PDF.

## Ask (applies to BOTH /terms and /privacy)
1. **Correct logo** in the topbar — use the real login logo, not the placeholder "DA
   DealerAddendums" text.
2. **Background like the login page** — the animated navy gradient backdrop.
3. The document sits on a **white "sheet" on top of** that background (centered, readable,
   subtle shadow — like a page floating on the desk).
4. A **"Download PDF"** link/button.
5. Represented as **DealerAddendums LLC** (the live page still shows "Inc." because the
   LLC re-sync/redeploy is pending — this rebuild must render the current LLC markdown).

## How
- **Reuse the auth shell's chrome** (`app/(auth)/shell.tsx`): the `MotionGradient` backdrop
  + `.lp-page`/`.lp-blob-*`/grain CSS, the navy topbar with `<img src="/images/login-logo.svg">`,
  and a "← Back to sign in" link. Factor a shared **`LegalShell`** (or a `wide`/document
  variant of `AuthShell`) so both legal pages and the login page share one definition.
- Render the markdown inside a **wide white card** — max-width ~800px, generous padding
  (~48px), rounded corners, soft shadow like `.lp-card` but document-width — with dark text
  (Roboto/Inter) and proper heading/list/paragraph styling. The card is centered and the
  page scrolls; the gradient shows behind/around it.
- Keep the **"Last updated"** line and the **"← Back to sign in"** link.

## Download PDF
- A **"Download PDF"** button at the top of the sheet (by the title).
- **Recommended:** a server route (e.g. `app/api/legal/[doc]/pdf` or `/terms/pdf`) that
  renders the document HTML through the existing **da-pdf-service** (`lib/pdf-service-client.ts`)
  and returns `application/pdf` with `Content-Disposition: attachment; filename=
  "DealerAddendums-Terms-of-Use.pdf"` (and `…-Privacy-Policy.pdf`). This always matches the
  live content and reuses existing infra. The PDF should carry the logo + title so it's a
  clean branded document.
- **Acceptable fallback** if the service route is more than you want here: a print-optimized
  stylesheet (`@media print` hides the backdrop, topbar, and button; shows only the white
  sheet) + a button that calls `window.print()` (the user saves as PDF). One-click via the
  service is the nicer UX.

## LLC (must verify)
- Canonical markdown (`da-platform/docs/legal/*.md`) already reads **"DealerAddendums LLC"**;
  the live page shows "Inc." only because the LLC redeploy hasn't shipped. This rebuild must
  render the current markdown — confirm **"DealerAddendums LLC"** appears and **no "Inc."**
  remains, on both the app and the marketing site.

## Scope
- Both **/terms** and **/privacy** on **DA Platform**, and mirror the same branding on the
  **marketing site's** /terms and /privacy for consistency.
- Pages stay **public** (no auth gate) — unchanged.

## Verify
- /terms and /privacy show the real logo, the login-style gradient, the white document
  sheet, and a working **Download PDF** (opens/downloads a branded PDF of the current
  content).
- Body reads **DealerAddendums LLC** — no "Inc." anywhere.
- Responsive on mobile; print output is clean (just the document).
- Stop for review before deploy.
