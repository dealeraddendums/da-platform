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
  // Move the PF AI-assistant launcher (the red floating circle) to the
  // bottom-LEFT: its default bottom-right spot covered list pagination and the
  // last table row's action buttons (2026-08-26). It renders inside an open
  // shadow root on a [data-pfai-container] host div under <html>, so page CSS
  // can't reach it — inject the override into the shadow root instead. At
  // bottom-left it sits over the sidebar's version label (non-interactive;
  // the nav above it scrolls). The fullscreen assistant panel is inset-0 and
  // unaffected.
  useEffect(() => {
    const inject = () => {
      const host = document.querySelector("[data-pfai-container]");
      const sr = host?.shadowRoot;
      if (!sr || sr.querySelector("#da-pfai-position")) return;
      const style = document.createElement("style");
      style.id = "da-pfai-position";
      style.textContent = ".actor-launcher { right: auto !important; left: 20px !important; }";
      sr.appendChild(style);
    };
    inject();
    // The container mounts (and can be re-created) whenever PF boots — watch
    // <html>'s direct children; the host div is appended there.
    const mo = new MutationObserver(inject);
    mo.observe(document.documentElement, { childList: true });
    return () => mo.disconnect();
  }, []);

  if (!user?.username) return null;
  return <ProductFruits workspaceCode={WORKSPACE_CODE} language="en" user={user} />;
}
