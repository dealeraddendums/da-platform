import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { validateFeedBody, type FeedBody } from "@/lib/feed-validation";

// Feed companies (FTP CSV export) — super_admin only. See lib/feed-export.ts.

export async function GET(): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;
  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dbErr } = await (admin as any)
    .from("feed_companies")
    .select("id, name, ftp_url, ftp_username, ftp_port, filename, protocol, include_vehicles, last_push_at, last_push_status, created_at")
    .order("name", { ascending: true });
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });

  // Dealer counts per feed for the list table.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: links } = await (admin as any)
    .from("feed_company_dealers")
    .select("feed_company_id");
  const counts = new Map<string, number>();
  for (const l of (links ?? []) as Array<{ feed_company_id: string }>) {
    counts.set(l.feed_company_id, (counts.get(l.feed_company_id) ?? 0) + 1);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = ((data ?? []) as any[]).map((f) => ({ ...f, dealer_count: counts.get(f.id) ?? 0 }));
  return NextResponse.json({ data: rows });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;
  let body: FeedBody;
  try { body = (await req.json()) as FeedBody; } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const invalid = validateFeedBody(body, false);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dbErr } = await (admin as any)
    .from("feed_companies")
    .insert({
      name: body.name!.trim(),
      ftp_url: body.ftp_url!.trim(),
      ftp_username: body.ftp_username!.trim(),
      ftp_password: body.ftp_password!,
      ftp_port: body.ftp_port ?? (body.protocol === "sftp" ? 22 : 21),
      filename: body.filename!.trim(),
      protocol: body.protocol ?? "ftp",
      include_vehicles: body.include_vehicles ?? "printed",
      column_mappings: [
        { recipientColumn: "DEALER_ID", daField: "DEALER_ID" },
        { recipientColumn: "VIN_NUMBER", daField: "VIN_NUMBER" },
        { recipientColumn: "STOCK_NUMBER", daField: "STOCK_NUMBER" },
      ],
    })
    .select("*")
    .single();
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data }, { status: 201 });
}
