import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

type Params = { params: { id: string } };

/**
 * GET /api/groups/[id]/delete-preview
 *
 * Counts the rows the Delete Group confirmation modal needs to show
 * before the super_admin types-to-confirm. super_admin only. Counts
 * only — no mutations.
 */
export async function GET(
  _req: NextRequest,
  { params }: Params,
): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const admin = createAdminSupabaseClient();

  const { data: group, error: loadErr } = await admin
    .from("groups")
    .select("id, name, is_test")
    .eq("id", params.id)
    .maybeSingle<{ id: string; name: string; is_test: boolean }>();
  if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 });
  if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 });

  const [dealersC, templatesC, optionsC, usersC] = await Promise.all([
    admin.from("dealers").select("id", { count: "exact", head: true }).eq("group_id", group.id),
    admin.from("group_templates").select("id", { count: "exact", head: true }).eq("group_id", group.id),
    admin.from("group_options").select("id", { count: "exact", head: true }).eq("group_id", group.id),
    admin.from("profiles").select("id", { count: "exact", head: true }).eq("group_id", group.id),
  ]);

  return NextResponse.json({
    group: { id: group.id, name: group.name, is_test: group.is_test },
    counts: {
      member_dealers: dealersC.count ?? 0,
      group_templates: templatesC.count ?? 0,
      group_options: optionsC.count ?? 0,
      users: usersC.count ?? 0,
    },
  });
}
