// Server-page guard for /crm: signed in, ACTIVE super_admin, and the 'crm'
// staff permission (lib/crm/access.ts). Anyone else is redirected — DA-CRM is
// never dealer-facing.
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";
import { crmPermissions, type CrmPerms } from "./access";

export async function requireCrmPage(next = "/crm", opts: { admin?: boolean } = {}): Promise<{ userId: string; fullName: string | null; perms: CrmPerms }> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(next)}`);

  const admin = createAdminSupabaseClient();
  const profile = await resolveSessionProfile<{ id: string; role: string; full_name: string | null; active: boolean | null }>(
    admin, session, "id, role, full_name, active");
  if (!profile || profile.role !== "super_admin" || profile.active === false) redirect("/dashboard");
  const perms = await crmPermissions(profile.id, admin);
  if (!perms.crm) redirect("/dashboard");
  if (opts.admin && !perms.crmAdmin) redirect("/crm");
  return { userId: profile.id, fullName: profile.full_name, perms };
}
