// GET /api/admin/bi/export?format=pdf|xlsx&from=&to= — download the BI report
// as a PDF (via da-pdf-service) or Excel workbook (via exceljs). super_admin only.

import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { buildBiReport } from "@/lib/bi";
import { resolvePeriod } from "@/lib/bi-period";
import { generateBiPdf, generateBiExcel, biFileStem, PDF_MIME, XLSX_MIME } from "@/lib/bi-export";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const format = (req.nextUrl.searchParams.get("format") ?? "pdf").toLowerCase();
  if (format !== "pdf" && format !== "xlsx") {
    return NextResponse.json({ error: "format must be pdf or xlsx" }, { status: 400 });
  }

  const { from, to, errorResponse } = resolvePeriod(
    req.nextUrl.searchParams.get("from"),
    req.nextUrl.searchParams.get("to"),
  );
  if (errorResponse) return errorResponse;

  try {
    const report = await buildBiReport(from, to);
    const stem = biFileStem(report);

    if (format === "pdf") {
      const buf = await generateBiPdf(report);
      return new NextResponse(buf as unknown as BodyInit, {
        status: 200,
        headers: {
          "Content-Type": PDF_MIME,
          "Content-Disposition": `attachment; filename="${stem}.pdf"`,
          "Cache-Control": "no-store",
        },
      });
    }

    const buf = await generateBiExcel(report);
    return new NextResponse(buf as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": XLSX_MIME,
        "Content-Disposition": `attachment; filename="${stem}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Export failed" },
      { status: 500 },
    );
  }
}
