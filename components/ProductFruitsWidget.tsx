"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";

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
  // Steven (components/StevenChat.tsx) is the ONE chat bubble now; ProductFruits
  // stays for tours/checklists/onboarding only. Hide PF's AI-assistant ("Elvin")
  // launcher: it lives in an OPEN shadow root on a [data-pfai-container] host
  // under <html> that page CSS can't reach (the same mechanism 20b55dc used to
  // move it), so the rule is injected into the shadow root and re-applied if PF
  // re-creates the host. The real off switch is PF's dashboard — this keeps a
  // second bubble from ever showing if that setting is turned back on.
  useEffect(() => {
    const inject = () => {
      const sr = document.querySelector("[data-pfai-container]")?.shadowRoot;
      if (!sr || sr.querySelector("#da-pfai-hide")) return;
      const style = document.createElement("style");
      style.id = "da-pfai-hide";
      style.textContent = ".actor-launcher { display: none !important; }";
      sr.appendChild(style);
    };
    inject();
    const mo = new MutationObserver(inject);
    mo.observe(document.documentElement, { childList: true });
    return () => mo.disconnect();
  }, []);

  if (!user?.username) return null;
  return <ProductFruits workspaceCode={WORKSPACE_CODE} language="en" user={user} />;
}
