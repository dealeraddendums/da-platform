import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { downloadFileResponse, cerberusConfigured } from "@/lib/cerberus";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: { username: string } };

/** GET /api/admin/ftp/download/[username]?file=...&path=/ — streams file body. */
export async function GET(req: NextRequest, { params }: Params): Promise<Response> {
  const { error } = await requireSuperAdmin();
  if (error) return error;
  if (!cerberusConfigured()) {
    return NextResponse.json({ error: "Cerberus proxy not configured" }, { status: 500 });
  }

  const username = decodeURIComponent(params.username).trim();
  const path = req.nextUrl.searchParams.get("path") ?? "/";
  const filename = req.nextUrl.searchParams.get("file");
  if (!filename) {
    return NextResponse.json({ error: "file required" }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await downloadFileResponse(username, path, filename);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    return NextResponse.json({ error: text || `proxy HTTP ${upstream.status}` }, { status: upstream.status });
  }

  const headers = new Headers();
  headers.set("Content-Type", upstream.headers.get("content-type") ?? "application/octet-stream");
  headers.set(
    "Content-Disposition",
    upstream.headers.get("content-disposition")
      ?? `attachment; filename="${filename.replace(/"/g, "")}"`,
  );
  const len = upstream.headers.get("content-length");
  if (len) headers.set("Content-Length", len);

  // Download-cookie handshake: echo the client's token back as a short-lived,
  // readable (non-HttpOnly) cookie. It rides on the response head, so the
  // browser sets it the instant streaming begins — letting the UI drop its
  // "Preparing…" state the moment the native download takes over. We stream
  // upstream.body directly (no buffering), so the browser shows its own
  // progress bar against Content-Length.
  const dlToken = req.nextUrl.searchParams.get("dl_token");
  if (dlToken && /^[A-Za-z0-9._-]{1,128}$/.test(dlToken)) {
    headers.append("Set-Cookie", `ftpdl_${dlToken}=1; Path=/; Max-Age=30; SameSite=Lax`);
  }

  return new Response(upstream.body, { status: 200, headers });
}
