import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerSettingsRow, UserRole } from "@/lib/db";
import SettingsForm from "@/components/SettingsForm";

export const metadata = { title: "Settings — DA Platform" };

export default async function SettingsPage() {
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

  let initialSettings: DealerSettingsRow | null = null;
  if (dealerId) {
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
        role={role}
        groupId={profile?.group_id ?? null}
        initialSettings={initialSettings}
      />
    </div>
  );
}
