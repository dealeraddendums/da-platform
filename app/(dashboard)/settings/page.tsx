import { redirect } from "next/navigation";
import { createClient, createAdminSupabaseClient } from "@/lib/supabase/server";
import type { ProfileRow, DealerSettingsRow } from "@/lib/db";
import SettingsForm from "@/components/SettingsForm";

export const metadata = { title: "Settings — DA Platform" };

export default async function SettingsPage() {
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

  let initialSettings: DealerSettingsRow | null = null;
  if (dealerId) {
    const admin = createAdminSupabaseClient();
    const { data: s } = await admin
      .from("dealer_settings")
      .select("*")
      .eq("dealer_id", dealerId)
      .single();
    initialSettings = (s as DealerSettingsRow | null) ?? null;
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>
          Settings
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--text-muted)" }}>
          AI content defaults, template assignments, and printer margins
        </p>
      </div>
      <SettingsForm
        fixedDealerId={dealerId}
        role={profile.role}
        groupId={profile.group_id}
        initialSettings={initialSettings}
      />
    </div>
  );
}
