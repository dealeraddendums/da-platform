// JW Player integration for Help Center article video.
//
// SECRET DISCIPLINE: JW_API_SECRET is a Management API v2 secret — full control
// of the JW account. It is read ONLY here, ONLY on the server, and is never
// returned to a caller, logged, or echoed in an error. `getJwPublicConfig()` is
// the only thing a browser ever sees, and it carries just the site id and
// player id, both of which are already public by construction (they appear in
// the Delivery URLs the player fetches).
//
// Config is read at REQUEST time, not baked at build time (no NEXT_PUBLIC_*
// vars): the credentials can be added to shared/.env.production and picked up
// with a pm2 reload, with no rebuild and no chance of an empty string being
// compiled into the client bundle.

const MANAGEMENT_BASE = "https://api.jwplayer.com";
export const JW_DELIVERY_BASE = "https://cdn.jwplayer.com";

export type JwPublicConfig = {
  siteId: string;
  playerId: string;
  /** False when the env isn't filled in yet — the UI degrades instead of erroring. */
  configured: boolean;
};

/** Safe for the browser: site id + player id only. Never the secret. */
export function getJwPublicConfig(): JwPublicConfig {
  const siteId = (process.env.JW_SITE_ID ?? "").trim();
  const playerId = (process.env.JW_PLAYER_ID ?? "").trim();
  const secret = (process.env.JW_API_SECRET ?? "").trim();
  return { siteId, playerId, configured: Boolean(siteId && playerId && secret) };
}

function serverConfig(): { siteId: string; secret: string } | null {
  const siteId = (process.env.JW_SITE_ID ?? "").trim();
  const secret = (process.env.JW_API_SECRET ?? "").trim();
  if (!siteId || !secret) return null;
  return { siteId, secret };
}

/** JW media ids are 8 alphanumeric characters. Validate everywhere one crosses a boundary. */
export function isJwMediaId(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9]{8}$/.test(v.trim());
}

export type JwCreateResult = {
  mediaId: string;
  /** Pre-authorized S3 URL the bytes are PUT to. Short-lived; not a secret of ours. */
  uploadLink: string;
};

export class JwError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function jwFetch(path: string, init: RequestInit & { secret: string }): Promise<Response> {
  const { secret, ...rest } = init;
  return fetch(`${MANAGEMENT_BASE}${path}`, {
    ...rest,
    headers: {
      ...(rest.headers ?? {}),
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });
}

/**
 * Create a hosted media item with a direct upload and hand back the id plus the
 * pre-authorized upload URL.
 *
 * Direct (single PUT) rather than multipart: JW's direct method takes files up
 * to 5 GB, and the editor caps uploads far below that, so the multipart/
 * resumable path would be code that can never run on a help screencast. If the
 * cap is ever raised past 5 GB this is the place to add it.
 */
export async function createDirectUpload(opts: { title: string; mimeType: string }): Promise<JwCreateResult> {
  const cfg = serverConfig();
  if (!cfg) throw new JwError("Video upload isn't configured yet.", 503);

  const res = await jwFetch(`/v2/sites/${cfg.siteId}/media`, {
    method: "POST",
    secret: cfg.secret,
    body: JSON.stringify({
      hosting_type: "hosted",
      upload: { method: "direct", mime_type: opts.mimeType },
      metadata: { title: opts.title.slice(0, 5000) },
    }),
  });

  if (!res.ok) {
    // Deliberately does NOT include the response body: a JW auth failure can
    // echo request detail, and this message reaches the browser.
    throw new JwError(`JW rejected the upload request (HTTP ${res.status}).`, 502);
  }

  const body = (await res.json()) as { id?: string; upload_link?: string };
  if (!body.id || !body.upload_link) throw new JwError("JW didn't return an upload target.", 502);
  return { mediaId: body.id, uploadLink: body.upload_link };
}

export type JwMediaStatus = "created" | "processing" | "ready" | "failed" | "unknown";

/** Poll a media item's transcode status. */
export async function getMediaStatus(mediaId: string): Promise<JwMediaStatus> {
  const cfg = serverConfig();
  if (!cfg) throw new JwError("Video upload isn't configured yet.", 503);
  if (!isJwMediaId(mediaId)) throw new JwError("Not a JW media id.", 400);

  const res = await jwFetch(`/v2/sites/${cfg.siteId}/media/${mediaId}`, { method: "GET", secret: cfg.secret });
  if (res.status === 404) return "unknown";
  if (!res.ok) throw new JwError(`JW status check failed (HTTP ${res.status}).`, 502);

  const body = (await res.json()) as { status?: string };
  const known: readonly string[] = ["created", "processing", "ready", "failed"];
  const s = body.status ?? "";
  return known.includes(s) ? (s as JwMediaStatus) : "unknown";
}

/** The Delivery URL the player loads a media item from. Public. */
export function playbackUrl(siteId: string, mediaId: string): string {
  return `${JW_DELIVERY_BASE}/v2/sites/${siteId}/media/${mediaId}/playback.json`;
}
