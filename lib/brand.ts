import "server-only";
import { createAdminSupabaseClient } from "@/lib/db";
import type { GroupBranding } from "@/lib/db";

/**
 * Host-driven white-label branding (Phase 12a — docs/white-label-phase12.md).
 *
 * A request on an ACTIVE groups.custom_domain resolves that group's branding;
 * the canonical host (app.dealeraddendums.com) and any unknown host get the
 * default DA brand. Branding follows the HOST, never the user. Resolution is
 * cached per-host with a short TTL (operator-provisioned, changes are rare).
 */

export type Brand = {
  /** The branded group's UUID, or null for default DA. */
  groupId: string | null;
  displayName: string;
  logoUrl: string;
  primaryColor: string;
  accentColor: string;
  faviconUrl: string | null;
  isDefault: boolean;
};

export const DEFAULT_BRAND: Brand = {
  groupId: null,
  displayName: "DA Platform",
  logoUrl: "/images/da-logo.png",
  primaryColor: "#1976d2", // --blue
  accentColor: "#ffa500",  // --orange
  faviconUrl: null,
  isDefault: true,
};

/** Hosts that always render default DA branding (never a reseller brand). */
function isCanonicalHost(host: string): boolean {
  if (!host) return true;
  if (host === "app.dealeraddendums.com") return true;
  if (host === "localhost" || host === "127.0.0.1") return true;
  // The ALB / internal hostnames the app may be reached on directly.
  if (host.endsWith(".amazonaws.com")) return true;
  // Whatever NEXT_PUBLIC_APP_URL points at (defensive).
  try {
    const appHost = process.env.NEXT_PUBLIC_APP_URL ? new URL(process.env.NEXT_PUBLIC_APP_URL).host : "";
    if (appHost && host === appHost.toLowerCase()) return true;
  } catch { /* ignore */ }
  return false;
}

/** Normalize a raw Host header → lowercase hostname without port. */
export function normalizeHost(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.trim().toLowerCase().split(":")[0];
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
function safeColor(v: string | null | undefined, fallback: string): string {
  return v && HEX_RE.test(v) ? v : fallback;
}

function brandFromGroup(groupId: string, b: GroupBranding | null): Brand {
  const branding = b ?? {};
  return {
    groupId,
    displayName: (branding.display_name && branding.display_name.trim()) || DEFAULT_BRAND.displayName,
    logoUrl: (branding.logo_url && branding.logo_url.trim()) || DEFAULT_BRAND.logoUrl,
    primaryColor: safeColor(branding.primary_color, DEFAULT_BRAND.primaryColor),
    accentColor: safeColor(branding.accent_color, DEFAULT_BRAND.accentColor),
    faviconUrl: (branding.favicon_url && branding.favicon_url.trim()) || null,
    isDefault: false,
  };
}

// ── Per-host cache (short TTL; invalidated on config change) ──────────────────
type CacheEntry = { brand: Brand; exp: number };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000; // 60s — bounds staleness across PM2 workers without a shared store

export function invalidateBrandCache(host?: string): void {
  if (host) cache.delete(normalizeHost(host));
  else cache.clear();
}

/**
 * Resolve the brand for a request host. Cheap + cached. Unknown/canonical hosts
 * (and any DB hiccup) fall back to the default DA brand — branding never breaks
 * the app.
 */
export async function resolveBrandForHost(rawHost: string | null | undefined): Promise<Brand> {
  const host = normalizeHost(rawHost);
  if (!host || isCanonicalHost(host)) return DEFAULT_BRAND;

  const hit = cache.get(host);
  if (hit && hit.exp > Date.now()) return hit.brand;

  let brand = DEFAULT_BRAND;
  try {
    // custom_domain / branding aren't in the generated Supabase types yet (migration 110).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = createAdminSupabaseClient() as any;
    const { data } = await admin
      .from("groups")
      .select("id, branding, custom_domain_status")
      .eq("custom_domain", host)
      .eq("custom_domain_status", "active")
      .maybeSingle();
    if (data?.id) brand = brandFromGroup(data.id as string, (data.branding ?? null) as GroupBranding | null);
  } catch {
    brand = DEFAULT_BRAND;
  }

  cache.set(host, { brand, exp: Date.now() + TTL_MS });
  return brand;
}

/**
 * CSS that retints the design-system color tokens for a branded host. STRUCTURAL
 * tokens (navy chrome, layout, cards, spacing) are intentionally left intact —
 * we only retint the primary (buttons/links) + accent (active-nav) tokens, plus
 * the login page's palette. Returns "" for the default brand.
 */
export function brandCssVars(brand: Brand): string {
  if (brand.isDefault) return "";
  const p = brand.primaryColor;
  const a = brand.accentColor;
  // `:root:root` doubles the pseudo-class specificity so this override beats
  // globals.css's `:root` regardless of stylesheet injection order.
  return `:root:root{` +
    `--blue:${p};--blue-light:${p};--blue-primary:${p};` +
    `--orange:${a};--warning:${a};` +
    // Login page palette (app/(auth)/shell.tsx AUTH_CSS).
    `--da-blue:${p};--da-amber:${a};` +
    `}`;
}
