"use client";

import { useBrand } from "@/contexts/Brand";

/**
 * Login/signup page footer (© Dealer Addendums · Terms · Privacy · version).
 * Host-resolved (Phase 12a): shown only on the default DealerAddendums brand.
 * On a white-label reseller host it renders nothing — no DA copyright or legal
 * links belong on a reseller-branded sign-in page. Uses the same `lp-footer*`
 * classes defined in the auth shell stylesheet.
 */
export default function LoginFooter({ version, build }: { version: string; build: string }) {
  const brand = useBrand();
  if (!brand.isDefault) return null;
  return (
    <footer className="lp-footer">
      <div>
        © {new Date().getFullYear()} Dealer Addendums ·{" "}
        <a href="/terms">Terms</a> ·{" "}
        <a href="/privacy">Privacy</a>
      </div>
      <div className="lp-footer-version">v {version} · build {build}</div>
    </footer>
  );
}
