import { NextRequest, NextResponse } from "next/server";
import { getServerProfile } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const ctx = await getServerProfile();
  if (!ctx?.profile) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx.profile.role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();

  type EnvRow = {
    id: string;
    entity_type: "dealer" | "group" | "user";
    entity_id: string;
    role: string | null;
    email: string | null;
    display_name: string | null;
    created_at: string;
  };

  const resp = await (admin as any)
    .from("qa_test_environment")
    .select("id, entity_type, entity_id, role, email, display_name, created_at")
    .order("entity_type", { ascending: true })
    .order("created_at", { ascending: true });

  if (resp.error) {
    console.error("[qa/environment] query failed:", resp.error);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }

  const entities: EnvRow[] = resp.data ?? [];
  const counts = {
    dealer: entities.filter(e => e.entity_type === "dealer").length,
    group:  entities.filter(e => e.entity_type === "group").length,
    user:   entities.filter(e => e.entity_type === "user").length,
  };
  const isProvisioned = counts.group >= 1 && counts.dealer >= 2 && counts.user >= 4;

  return NextResponse.json({
    provisioned: isProvisioned,
    counts,
    entities,
    expected: { group: 1, dealer: 2, user: 4 },
  });
}

export async function DELETE(_req: NextRequest): Promise<NextResponse> {
  const ctx = await getServerProfile();
  if (!ctx?.profile) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (ctx.profile.role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();

  type EnvRow = { id: string; entity_type: "dealer" | "group" | "user"; entity_id: string };
  const envResp = await (admin as any)
    .from("qa_test_environment")
    .select("id, entity_type, entity_id");
  const env: EnvRow[] = envResp.data ?? [];

  const removed = { dealer: 0, group: 0, user: 0 };

  // Order matters: users first (they reference dealers/groups via profiles.dealer_id),
  // then dealers (they reference groups.group_id), then groups.
  const users   = env.filter(e => e.entity_type === "user");
  const dealers = env.filter(e => e.entity_type === "dealer");
  const groups  = env.filter(e => e.entity_type === "group");

  for (const u of users) {
    // Profile delete first then auth user. Profile is guarded by
    // test_account = true so a misconfigured env row can't sweep
    // a real account.
    const profDel = await (admin as any)
      .from("profiles")
      .delete()
      .eq("id", u.entity_id)
      .eq("test_account", true);
    if (!profDel.error) {
      try {
        await admin.auth.admin.deleteUser(u.entity_id);
      } catch (err) {
        console.error("[qa/environment DELETE] auth user delete failed:", err);
      }
      removed.user += 1;
    }
  }

  for (const d of dealers) {
    const del = await (admin as any)
      .from("dealers")
      .delete()
      .eq("id", d.entity_id)
      .eq("test_account", true);
    if (!del.error) removed.dealer += 1;
  }

  for (const g of groups) {
    const del = await (admin as any)
      .from("groups")
      .delete()
      .eq("id", g.entity_id)
      .eq("test_account", true);
    if (!del.error) removed.group += 1;
  }

  // Sweep the registry last.
  await (admin as any).from("qa_test_environment").delete().neq("id", "00000000-0000-0000-0000-000000000000");

  return NextResponse.json({ success: true, removed });
}
