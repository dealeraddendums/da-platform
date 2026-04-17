import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import type { TemplateRow, UserRole } from "@/lib/db";
import TemplateList from "@/components/TemplateList";

export const metadata = { title: "Templates — DA Platform" };

export default async function TemplatesPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  const admin = createAdminSupabaseClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role, dealer_id, group_id")
    .eq("id", session.user.id)
    .single<{ role: string; dealer_id: string | null; group_id: string | null }>();

  const role = (profile?.role
    ?? (session.user.app_metadata as Record<string, unknown>)?.role as string | undefined
    ?? "dealer_user") as UserRole;

  if (role === "dealer_user") redirect("/dashboard");

  const isDealer = role === "dealer_admin";
  const dealerId = isDealer ? (profile?.dealer_id ?? null) : null;

  let initialTemplates: TemplateRow[] = [];
  if (dealerId) {
    const { data: t } = await admin
      .from("templates")
      .select("*")
      .eq("dealer_id", dealerId)
      .order("created_at", { ascending: false });
    initialTemplates = (t as TemplateRow[] | null) ?? [];
  }

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
        fixedDealerId={dealerId}
        role={role}
        groupId={profile?.group_id ?? null}
        initialTemplates={initialTemplates}
      />
    </div>
  );
}
