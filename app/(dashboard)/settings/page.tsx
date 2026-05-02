import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerSettingsRow, UserRole } from "@/lib/db";
import { verifyGhostToken } from "@/lib/ghost";
import SettingsForm from "@/components/SettingsForm";
import { PageHeader } from "@/components/PageHeader";

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

  const cookieStore = cookies();
  const ghostCtx = role === "super_admin"
    ? verifyGhostToken(cookieStore.get("da_ghost_token")?.value ?? "")
    : null;
  const ghostDealerId = ghostCtx?.dealer_text_id ?? null;

  const isDealer = role === "dealer_admin" || role === "dealer_user" || role === "dealer_restricted";
  const dealerId = isDealer ? (profile?.dealer_id ?? null) : (ghostDealerId ?? null);

  let initialSettings: DealerSettingsRow | null = null;
  let fixedDealerUuid: string | null = null;
  if (dealerId) {
    const [{ data: s }, { data: dRow }] = await Promise.all([
      admin.from("dealer_settings").select("*").eq("dealer_id", dealerId).single(),
      admin.from("dealers").select("id").eq("dealer_id", dealerId).maybeSingle(),
    ]);
    initialSettings = (s as DealerSettingsRow | null) ?? null;
    fixedDealerUuid = (dRow as { id: string } | null)?.id ?? null;
  }

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="AI content defaults, template assignments, and printer margins"
      />
      <SettingsForm
        fixedDealerId={dealerId}
        fixedDealerUuid={fixedDealerUuid}
        role={role}
        groupId={profile?.group_id ?? null}
        initialSettings={initialSettings}
      />
    </div>
  );
}
