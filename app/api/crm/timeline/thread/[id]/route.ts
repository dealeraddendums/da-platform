import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { staffNames } from "@/lib/crm/queries";
import { emailNewText, emailSender } from "@/lib/crm/timeline-rows";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/crm/timeline/thread/[id] — a thread's messages as compact timeline rows, newest first:
 * { id, activity_id, direction, who, at, new_text, full_text }. full_text backs "Show quoted history".
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { error } = await requireCrmStaff();
  if (error) return error;
  if (!UUID.test(params.id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const admin = createAdminSupabaseClient() as any;
  const [{ data: emails, error: qErr }, staff] = await Promise.all([
    admin.from("crm_emails").select("id, activity_id, direction, from_name, from_email, sent_by_staff_id, body_text, received_at").eq("thread_id", params.id).order("received_at", { ascending: false }).limit(200),
    staffNames(admin),
  ]);
  if (qErr) return NextResponse.json({ error: qErr.message }, { status: 500 });
  return NextResponse.json({
    messages: (emails ?? []).map((e: any) => {
      const full = (e.body_text ?? "").replace(/\r\n/g, "\n").trim();
      return {
        id: e.id, activity_id: e.activity_id, direction: e.direction, at: e.received_at,
        who: emailSender({ direction: e.direction, actor_staff_id: e.sent_by_staff_id, metadata: { from_name: e.from_name, from_email: e.from_email } }, staff),
        new_text: emailNewText(full), full_text: full.slice(0, 20000),
      };
    }),
  });
}
