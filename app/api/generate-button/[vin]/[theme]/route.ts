import { NextRequest, NextResponse } from "next/server";
import { checkPdfExists, buildButtonHtml } from "@/lib/addendum";

// Public endpoint — returns HTML embed. No JWT required.
// Called via script/iframe on dealer inventory pages.

type Params = { params: { vin: string; theme: string } };

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const vin = params.vin.toUpperCase();
  const theme = params.theme;
  const text = req.nextUrl.searchParams.get("text") || "Download Addendum";

  const pdfUrl = await checkPdfExists(vin);

  if (!pdfUrl) {
    return new NextResponse("", { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  return new NextResponse(buildButtonHtml(theme, pdfUrl, text), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
