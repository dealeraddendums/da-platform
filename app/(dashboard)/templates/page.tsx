import { redirect } from "next/navigation";
import { createClient, createAdminSupabaseClient } from "@/lib/supabase/server";
import type { ProfileRow, TemplateRow } from "@/lib/db";
import TemplateList from "@/components/TemplateList";

export const metadata = { title: "Templates — DA Platform" };

export default async function TemplatesPage() {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) redirect("/login");

  const { data } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", session.user.id)
    .returns<ProfileRow[]>()
    .single();

  const profile = data as ProfileRow | null;
  if (!profile) redirect("/login");

  if (profile.role === "dealer_user") redirect("/dashboard");

  const isDealer = profile.role === "dealer_admin";
  const dealerId = isDealer ? profile.dealer_id : null;

  let initialTemplates: TemplateRow[] = [];
  if (dealerId) {
    const admin = createAdminSupabaseClient();
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
        role={profile.role}
        groupId={profile.group_id}
        initialTemplates={initialTemplates}
      />
    </div>
  );
}
