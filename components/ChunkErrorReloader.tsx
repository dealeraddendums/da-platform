"use client";

// Defensive auto-reload for Next.js chunk-load failures.
//
// After a production deploy, the new HTML references freshly-hashed
// webpack chunks while the previous HTML (still in users' tabs) points
// at the old hashes. Once the old chunks are gone from the server,
// dynamic imports throw `ChunkLoadError: Loading chunk N failed` and
// the page can render half-broken or blank.
//
// This listener catches the error globally (window.onerror +
// window.onunhandledrejection) and triggers a single page reload so
// the user picks up the new HTML + new chunks. Guarded by a
// sessionStorage flag with a 10-minute window so a genuine bug that
// throws the same error class never causes a reload loop.
//
// Mount once in the root layout.

import { useEffect } from "react";

const RELOAD_FLAG = "__chunkReloadAt";
const RELOAD_GUARD_MS = 10 * 60 * 1000;
const CHUNK_ERROR_RE = /Loading chunk \w+ failed|ChunkLoadError|Failed to find Server Action/;

export default function ChunkErrorReloader() {
  useEffect(() => {
    function maybeReload(err: unknown) {
      const msg = err instanceof Error ? err.message : String(err ?? "");
      if (!CHUNK_ERROR_RE.test(msg)) return;
      const last = Number(sessionStorage.getItem(RELOAD_FLAG) ?? 0);
      if (Number.isFinite(last) && Date.now() - last < RELOAD_GUARD_MS) {
        // Already reloaded recently — don't spin.
        console.warn("[ChunkErrorReloader] suppressed reload (already reloaded recently):", msg);
        return;
      }
      sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
      console.warn("[ChunkErrorReloader] stale-chunk detected, reloading:", msg);
      window.location.reload();
    }

    function onError(e: ErrorEvent) { maybeReload(e.error ?? e.message); }
    function onRejection(e: PromiseRejectionEvent) { maybeReload(e.reason); }

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
