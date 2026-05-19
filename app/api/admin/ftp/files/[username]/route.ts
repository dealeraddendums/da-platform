import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import {
  listFiles, deleteFile, uploadFile,
  cerberusConfigured, CerberusError,
} from "@/lib/cerberus";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: { username: string } };

function unauthorized() {
  return NextResponse.json({ error: "Cerberus proxy not configured" }, { status: 500 });
}
function fail(err: unknown): NextResponse {
  if (err instanceof CerberusError) {
    return NextResponse.json({ error: err.faultString ?? err.message }, { status: 502 });
  }
  return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
}

/** GET /api/admin/ftp/files/[username]?path=/ — list FTP files. */
export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;
  if (!cerberusConfigured()) return unauthorized();

  const username = decodeURIComponent(params.username).trim();
  const path = req.nextUrl.searchParams.get("path") ?? "/";
  try {
    const files = await listFiles(username, path);
    return NextResponse.json({ files, path });
  } catch (err) {
    return fail(err);
  }
}

/** DELETE /api/admin/ftp/files/[username]?file=...&path=/ */
export async function DELETE(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;
  if (!cerberusConfigured()) return unauthorized();

  const username = decodeURIComponent(params.username).trim();
  const path = req.nextUrl.searchParams.get("path") ?? "/";
  const filename = req.nextUrl.searchParams.get("file");
  if (!filename) return NextResponse.json({ error: "file required" }, { status: 400 });

  try {
    const ok = await deleteFile(username, path, filename);
    if (!ok) return NextResponse.json({ error: "Delete failed" }, { status: 502 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}

/** POST /api/admin/ftp/files/[username] — multipart upload. */
export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;
  if (!cerberusConfigured()) return unauthorized();

  const username = decodeURIComponent(params.username).trim();
  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ error: "Invalid multipart body" }, { status: 400 }); }

  const path = (form.get("path") as string | null) ?? "/";
  const fileEntry = form.get("file");
  if (!(fileEntry instanceof Blob)) {
    return NextResponse.json({ error: "file required" }, { status: 400 });
  }
  const filename = (fileEntry as File).name || "upload.bin";

  try {
    const ok = await uploadFile(username, path, fileEntry, filename);
    if (!ok) return NextResponse.json({ error: "Upload failed" }, { status: 502 });
    return NextResponse.json({ ok: true, filename });
  } catch (err) {
    return fail(err);
  }
}
