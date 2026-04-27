import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { BG_KEYS, type BgKey } from "@/lib/buyers-guide-constants";
import {
  checkSystemPdfExists,
  getSystemPdfSignedUrl,
  seedSystemPdf,
  uploadSystemPdf,
} from "@/lib/buyers-guide-storage";

type Params = { params: { key: string } };

function validateKey(key: string): key is BgKey {
  return (BG_KEYS as string[]).includes(key);
}

export async function GET(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  if (!validateKey(params.key)) {
    return NextResponse.json({ error: "Invalid key" }, { status: 400 });
  }

  const exists = await checkSystemPdfExists(params.key);
  const url = exists ? await getSystemPdfSignedUrl(params.key) : null;
  return NextResponse.json({ exists, url });
}

export async function POST(
  req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  if (!validateKey(params.key)) {
    return NextResponse.json({ error: "Invalid key" }, { status: 400 });
  }

  const { searchParams } = new URL(req.url);
  if (searchParams.get("action") !== "seed") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  await seedSystemPdf(params.key);
  const url = await getSystemPdfSignedUrl(params.key);
  return NextResponse.json({ ok: true, url });
}

export async function PUT(
  req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  if (!validateKey(params.key)) {
    return NextResponse.json({ error: "Invalid key" }, { status: 400 });
  }

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (file.type !== "application/pdf") {
    return NextResponse.json({ error: "File must be a PDF" }, { status: 400 });
  }
  if (file.size > 20 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 20MB)" }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  await uploadSystemPdf(params.key, buf);
  const url = await getSystemPdfSignedUrl(params.key);
  return NextResponse.json({ ok: true, url });
}
