"use client";

import { useBrand } from "@/contexts/Brand";

/**
 * Login-page logo. Default host keeps the DA wordmark (login-logo.svg); a
 * branded reseller host shows the reseller's logo + name. Host-resolved.
 */
export default function BrandLoginLogo() {
  const brand = useBrand();

  if (brand.isDefault) {
    return (
      <a href="/" className="lp-logo" aria-label="Dealer Addendums home">
        <img src="/images/login-logo.svg" alt="Dealer Addendums" />
      </a>
    );
  }

  return (
    <span className="lp-logo" style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <img src={brand.logoUrl} alt={brand.displayName} style={{ height: 36, width: "auto", display: "block" }} />
      <span style={{ color: "#fff", fontWeight: 600, fontSize: 16 }}>{brand.displayName}</span>
    </span>
  );
}
