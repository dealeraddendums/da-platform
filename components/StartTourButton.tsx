"use client";

import { useEffect, useState } from "react";

/**
 * Launches a ProductFruits guided tour from inside a Help article.
 *
 * The PF SDK is mounted once for the whole dashboard (ProductFruitsWidget in the
 * (dashboard) layout), so this component only talks to the already-loaded API:
 *   window.productFruits.api.tours.tryStartTour(id)
 * Readiness is signalled by `window.productFruitsIsReady` / the one-shot
 * `productfruits_ready` window event, per the SDK.
 *
 * tryStartTour re-evaluates the tour's own rules and segmentation, so a tour
 * restricted to another page or audience simply does nothing. That silent no-op
 * is the failure Allan will actually hit while wiring tour IDs up, so after
 * starting we check getTours() and say so rather than leaving a dead button.
 */

type PFTour = { id: number | string; isRunning?: boolean };
type PFToursApi = {
  tryStartTour?: (id: number | string) => void;
  getTours?: () => PFTour[];
};
type PFWindow = Window & {
  productFruitsIsReady?: boolean;
  productFruits?: { api?: { tours?: PFToursApi } };
};

function pfTours(): PFToursApi | null {
  if (typeof window === "undefined") return null;
  return (window as PFWindow).productFruits?.api?.tours ?? null;
}

export default function StartTourButton({ tourId }: { tourId?: string | null }) {
  const [ready, setReady] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (pfTours()) { setReady(true); return; }
    // Both signals, because neither alone is reliable: `productfruits_ready`
    // fires once and may already be gone by the time an article is opened, and
    // `productFruitsIsReady` has been observed still false on a page where the
    // tours API was live. Poll for the API itself and take whichever lands first.
    const onReady = () => { if (pfTours()) setReady(true); };
    window.addEventListener("productfruits_ready", onReady);
    const poll = window.setInterval(() => {
      if (pfTours()) { setReady(true); window.clearInterval(poll); }
    }, 500);
    // The SDK is loaded by the dashboard layout; if it hasn't appeared in 30s it
    // isn't coming (blocked script, offline), and the button stays disabled.
    const stop = window.setTimeout(() => window.clearInterval(poll), 30000);
    return () => {
      window.removeEventListener("productfruits_ready", onReady);
      window.clearInterval(poll);
      window.clearTimeout(stop);
    };
  }, []);

  if (!tourId) return null;

  function start() {
    setNote(null);
    const tours = pfTours();
    if (!tours?.tryStartTour) {
      setNote("Tours aren't available right now — refresh the page and try again.");
      return;
    }
    // PF's own tour ids are numeric; the column is text so an aliased id still
    // round-trips. Hand the SDK a number when it is one.
    const id = /^\d+$/.test(tourId!) ? Number(tourId) : tourId!;
    try {
      tours.tryStartTour(id);
    } catch {
      setNote("Couldn't start the tour — please contact support@dealeraddendums.com.");
      return;
    }
    // Confirm it actually took. A tour whose rules exclude this page/user starts
    // nothing and throws nothing.
    window.setTimeout(() => {
      try {
        const list = tours.getTours?.() ?? [];
        const running = Array.isArray(list) && list.some((t) => String(t.id) === String(tourId) && t.isRunning);
        if (!running) setNote("This tour runs on another page — open that page, then start it from there.");
      } catch { /* getTours is best-effort feedback only */ }
    }, 1200);
  }

  return (
    <div style={{ marginTop: 20 }}>
      <button
        onClick={start}
        disabled={!ready}
        title={ready ? "Walk through this in the app" : "Loading the guided tour…"}
        style={{
          display: "inline-flex", alignItems: "center", gap: 8,
          padding: "10px 18px", borderRadius: 6, border: "none",
          background: ready ? "#1976d2" : "#9e9e9e", color: "#fff",
          fontSize: 14, fontWeight: 600, fontFamily: "inherit",
          cursor: ready ? "pointer" : "default",
        }}
      >
        <span aria-hidden>▶</span> {ready ? "Start tour" : "Loading tour…"}
      </button>
      <div style={{ fontSize: 12, color: "#78828c", marginTop: 6 }}>
        Walks you through this in the app, step by step.
      </div>
      {note && (
        <div style={{ marginTop: 8, padding: "8px 12px", borderRadius: 6, background: "#fff8e1", border: "1px solid #ffe082", fontSize: 13, color: "#7a5c00", maxWidth: 520 }}>
          {note}
        </div>
      )}
    </div>
  );
}
