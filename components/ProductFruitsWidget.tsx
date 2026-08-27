"use client";

import dynamic from "next/dynamic";

// ProductFruits in-app tours / onboarding (docs/in-app-tours.md). Per ProductFruits'
// Next.js App Router guide, load via dynamic import with ssr:false so the widget
// only initializes client-side (it touches window/localStorage). lifeCycle defaults
// to "neverUnmount", which avoids the documented flicker on remount.
const ProductFruits = dynamic(
  () => import("react-product-fruits").then((m) => m.ProductFruits),
  { ssr: false },
);

// Public workspace code (client-side, not a secret). Overridable via env so we can
// point staging/other workspaces without a code change; defaults to the live one.
const WORKSPACE_CODE = process.env.NEXT_PUBLIC_PRODUCTFRUITS_WORKSPACE_CODE || "rCq5a0gbCepRt91B";

export type ProductFruitsUser = {
  /** REQUIRED — stable unique identifier (we use the Supabase auth user id). */
  username: string;
  email?: string;
  firstname?: string;
  lastname?: string;
  signUpAt?: string;
  role?: string;
  /** Custom attributes for tour targeting — value types per ProductFruits' UserCustomProps. */
  props?: Record<string, string | number | boolean | string[] | number[]>;
};

/**
 * Mounts the ProductFruits widget for the signed-in user. Rendered from the
 * authenticated dashboard layout, so it only loads for logged-in users (PF
 * requires a unique user identifier). Renders nothing if we don't have one.
 */
export default function ProductFruitsWidget({ user }: { user: ProductFruitsUser }) {
  // The PF AI-assistant launcher sits at its native bottom-RIGHT default.
  // (2026-08-26 it was briefly moved bottom-left via a shadow-root style
  // injection because it covered list pagination — the shared Pager is
  // centered now, so the corner is free and Allan asked for the default
  // back; bottom-left overlapped the sidebar version label.)
  if (!user?.username) return null;
  return <ProductFruits workspaceCode={WORKSPACE_CODE} language="en" user={user} />;
}
