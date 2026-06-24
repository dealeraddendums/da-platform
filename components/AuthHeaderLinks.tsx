"use client";

import { useBrand } from "@/contexts/Brand";

/**
 * Auth-page header links (Help · Status). Both point to DealerAddendums-branded
 * destinations (support@dealeraddendums.com, status.dealeraddendums.com), so
 * they render only on the default DA brand. On a white-label reseller host they
 * render nothing — same host-resolved pattern as the login footer + logo.
 */
export default function AuthHeaderLinks() {
  const brand = useBrand();
  if (!brand.isDefault) return null;
  return (
    <>
      <a href="mailto:support@dealeraddendums.com">Help</a>
      <a href="https://status.dealeraddendums.com" target="_blank" rel="noopener noreferrer">Status</a>
    </>
  );
}
