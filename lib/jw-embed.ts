"use client";

// Browser-side JW cloud player embedding.
//
// Article bodies store a video as a placeholder element in the sanitized HTML:
//     <div data-jw-media="AbCd1234"></div>
// rather than a <script> or a raw player embed. That keeps the body inside the
// existing strict sanitizer (lib/help-sanitize) with no new allowance for
// executable markup — the id is inert data, and the player is mounted here, in
// React, from a host we control.

const DATA_ATTR = "data-jw-media";
const MOUNTED_ATTR = "data-jw-mounted";

type JwPlayerInstance = { setup: (cfg: Record<string, unknown>) => void; remove?: () => void };
type JwWindow = Window & { jwplayer?: (el: HTMLElement | string) => JwPlayerInstance };

export const JW_MEDIA_SELECTOR = `[${DATA_ATTR}]`;

let libraryPromise: Promise<void> | null = null;

/** Load the account's cloud-hosted player library once per page. */
export function loadJwLibrary(playerId: string): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if ((window as JwWindow).jwplayer) return Promise.resolve();
  if (libraryPromise) return libraryPromise;

  libraryPromise = new Promise<void>((resolve, reject) => {
    const src = `https://cdn.jwplayer.com/libraries/${encodeURIComponent(playerId)}.js`;
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("player library failed to load")), { once: true });
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { libraryPromise = null; reject(new Error("player library failed to load")); };
    document.head.appendChild(s);
  });
  return libraryPromise;
}

/**
 * Turn every unmounted `[data-jw-media]` placeholder under `root` into a player.
 * Idempotent — a placeholder is marked once set up, so a re-render or a second
 * pass never stacks two players on one element.
 */
export async function mountJwPlayers(
  root: HTMLElement,
  cfg: { siteId: string; playerId: string },
): Promise<void> {
  const targets = Array.from(root.querySelectorAll<HTMLElement>(JW_MEDIA_SELECTOR))
    .filter((el) => el.getAttribute(MOUNTED_ATTR) !== "1");
  if (targets.length === 0) return;
  if (!cfg.siteId || !cfg.playerId) return;

  await loadJwLibrary(cfg.playerId);
  const jw = (window as JwWindow).jwplayer;
  if (!jw) return;

  for (const el of targets) {
    const mediaId = (el.getAttribute(DATA_ATTR) ?? "").trim();
    if (!/^[A-Za-z0-9]{8}$/.test(mediaId)) continue;
    el.setAttribute(MOUNTED_ATTR, "1");
    // JW replaces the element's contents with the player.
    if (!el.id) el.id = `jw-${mediaId}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      jw(el).setup({
        playlist: `https://cdn.jwplayer.com/v2/sites/${cfg.siteId}/media/${mediaId}/playback.json`,
        width: "100%",
        aspectratio: "16:9",
      });
    } catch {
      // A media item still transcoding (or a bad id) must not take the article
      // down with it — leave the placeholder showing its fallback text.
      el.removeAttribute(MOUNTED_ATTR);
    }
  }
}
