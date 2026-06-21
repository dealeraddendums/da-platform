import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";
import type { DealerSettingsRow, UserRole } from "@/lib/db";
import { verifyGhostToken } from "@/lib/ghost";
import SettingsForm from "@/components/SettingsForm";
import { PageHeader } from "@/components/PageHeader";

export const metadata = { title: "Print Settings — DA Platform" };

export default async function SettingsPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  const admin = createAdminSupabaseClient();
  const profile = await resolveSessionProfile<{ role: string; dealer_id: string | null; group_id: string | null; active_dealer_id: string | null }>(admin, session, "role, dealer_id, group_id, active_dealer_id");

  const role = (profile?.role
    ?? (session.user.app_metadata as Record<string, unknown>)?.role as string | undefined
    ?? "dealer_user") as UserRole;

  const cookieStore = cookies();
  const ghostCtx = role === "super_admin"
    ? verifyGhostToken(cookieStore.get("da_ghost_token")?.value ?? "")
    : null;
  const ghostDealerId = ghostCtx?.dealer_text_id ?? null;

  const isDealer = role === "dealer_admin" || role === "dealer_user" || role === "dealer_restricted";
  let dealerId = isDealer ? (profile?.dealer_id ?? null) : (ghostDealerId ?? null);

  // A group_admin OR group_user (regional manager) switched into a dealer edits
  // that dealer's settings. SettingsForm scopes its API calls by dealer_id and
  // /api/settings re-verifies scope (group + tags) — we just supply the id.
  if (!dealerId && (role === "group_admin" || role === "group_user") && profile?.active_dealer_id) {
    const { data: d } = await admin
      .from("dealers")
      .select("dealer_id")
      .eq("id", profile.active_dealer_id)
      .maybeSingle<{ dealer_id: string }>();
    dealerId = d?.dealer_id ?? null;
  }

  let initialSettings: DealerSettingsRow | null = null;
  let fixedDealerUuid: string | null = null;
  let initialLogoUrl: string | null = null;
  let templatesLocked = false;
  if (dealerId) {
    const [{ data: s }, { data: dRow }] = await Promise.all([
      admin.from("dealer_settings").select("*").eq("dealer_id", dealerId).single(),
      admin.from("dealers").select("id, logo_url, group_id, group_controls_templates").eq("dealer_id", dealerId).maybeSingle(),
    ]);
    initialSettings = (s as DealerSettingsRow | null) ?? null;
    const dealerRow = dRow as { id: string; logo_url: string | null; group_id: string | null; group_controls_templates: boolean | null } | null;
    fixedDealerUuid = dealerRow?.id ?? null;
    initialLogoUrl = dealerRow?.logo_url ?? null;
    // The flag is only meaningful when the dealer is actually in a group —
    // see app/(dashboard)/layout.tsx for the same gating.
    templatesLocked = Boolean(dealerRow?.group_controls_templates && dealerRow?.group_id);
  }

  return (
    <div>
      <PageHeader
        title="Print Settings"
        subtitle="AI content defaults, template assignments, and printer margins"
      />
      <SettingsForm
        fixedDealerId={dealerId}
        fixedDealerUuid={fixedDealerUuid}
        role={role}
        groupId={profile?.group_id ?? null}
        initialSettings={initialSettings}
        initialLogoUrl={initialLogoUrl}
        templatesLocked={templatesLocked}
      />
    </div>
  );
}
