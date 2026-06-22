"use client";

import { createContext, useContext } from "react";

/** Client-visible subset of the resolved brand (logo/name + colors for chips). */
export type ClientBrand = {
  displayName: string;
  logoUrl: string;
  primaryColor: string;
  accentColor: string;
  isDefault: boolean;
};

export const DEFAULT_CLIENT_BRAND: ClientBrand = {
  displayName: "DA Platform",
  logoUrl: "/images/da-logo.png",
  primaryColor: "#1976d2",
  accentColor: "#ffa500",
  isDefault: true,
};

const BrandContext = createContext<ClientBrand>(DEFAULT_CLIENT_BRAND);

/** Read the host-resolved brand. Defaults to DA when no provider is mounted. */
export function useBrand(): ClientBrand {
  return useContext(BrandContext);
}

export function BrandProvider({ brand, children }: { brand: ClientBrand; children: React.ReactNode }) {
  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}
