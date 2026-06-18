import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";
import type { UserRole } from "@/lib/db";
import TemplateList from "@/components/TemplateList";

export const metadata = { title: "Templates — DA Platform" };

export default async function TemplatesPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  const admin = createAdminSupabaseClient();
  const profile = await resolveSessionProfile<{ role: string; dealer_id: string | null; group_id: string | null }>(admin, session, "role, dealer_id, group_id");

  const role = (profile?.role
    ?? (session.user.app_metadata as Record<string, unknown>)?.role as string | undefined
    ?? "dealer_user") as UserRole;

  // Dealer roles manage templates inside the Builder — redirect there
  if (role === "dealer_admin" || role === "dealer_user" || (role as string) === "dealer_restricted") redirect("/builder");

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>
          Templates
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--text-muted)" }}>
          Saved addendum and infosheet layouts
        </p>
      </div>
      <TemplateList
        fixedDealerId={null}
        role={role}
        groupId={profile?.group_id ?? null}
        initialTemplates={[]}
      />
    </div>
  );
}
