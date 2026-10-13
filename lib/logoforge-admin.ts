import "server-only";

// Server-side client for DA-LogoForge's ADMIN API (/api/admin/* + brand-generate),
// used only by the super_admin dashboard at /admin/logoforge via
// /api/admin/logoforge/*.
//
// Same rule as lib/logoforge-client.ts: LOGOFORGE_URL (a private VPC address) and
// LOGOFORGE_API_KEY never reach a response body, a log line, or a client bundle.
// The service-side key needs admin=1 (`python -m app.keys admin <id> on` on the
// box) for the /api/admin/* paths; brand-generate works with any key.
//
// Error handling: the service's 4xx `detail` strings are user-facing by design
// (sanitizer verdicts, "slot 'make' longer than 40 characters", "font X has no
// glyph for 'Ü'") and carry no address or key, so they are passed through; a 5xx
// or a network failure becomes a generic message.

export class LogoForgeAdminError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function logoForgeAdminConfigured(): boolean {
  return !!process.env.LOGOFORGE_URL && !!process.env.LOGOFORGE_API_KEY;
}

type CallOpts = {
  method?: "GET" | "POST" | "PUT";
  json?: unknown;
  form?: FormData;
  actor?: string | null;
  timeoutMs?: number;
};

async function call(path: string, opts: CallOpts = {}): Promise<Response> {
  if (!logoForgeAdminConfigured()) throw new LogoForgeAdminError("LogoForge isn't configured on this server.", 503);
  const headers: Record<string, string> = { "X-API-Key": process.env.LOGOFORGE_API_KEY! };
  if (opts.actor) headers["X-Actor"] = opts.actor.slice(0, 120);
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    body = opts.form;
  }
  let res: Response;
  try {
    res = await fetch(`${process.env.LOGOFORGE_URL!.replace(/\/+$/, "")}${path}`, {
      method: opts.method ?? (body ? "POST" : "GET"),
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      cache: "no-store",
    });
  } catch (e) {
    console.error(`[logoforge-admin] ${path.split("?")[0]} request failed:`, e instanceof Error ? e.name : "error");
    throw new LogoForgeAdminError("LogoForge didn't respond — try again in a minute.", 502);
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({})) as { detail?: unknown };
    const detail = typeof j.detail === "string" ? j.detail : "";
    console.error(`[logoforge-admin] ${path.split("?")[0]} ${res.status} ${detail.slice(0, 200)}`);
    if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403 && detail) {
      throw new LogoForgeAdminError(detail, res.status);
    }
    if (res.status === 401 || res.status === 403) {
      throw new LogoForgeAdminError("This server's LogoForge key isn't allowed to use the admin API.", 502);
    }
    throw new LogoForgeAdminError("LogoForge couldn't complete that request.", 502);
  }
  return res;
}

export async function lfJson<T = unknown>(path: string, opts: CallOpts = {}): Promise<T> {
  return (await call(path, opts)).json() as Promise<T>;
}

export async function lfBytes(path: string, opts: CallOpts = {}): Promise<{ bytes: ArrayBuffer; type: string }> {
  const res = await call(path, opts);
  return { bytes: await res.arrayBuffer(), type: res.headers.get("content-type") ?? "application/octet-stream" };
}
