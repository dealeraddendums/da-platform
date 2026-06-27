import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";
import type { UserRole } from "@/lib/db";
import { verifyGhostToken } from "@/lib/ghost";
import { isPaidAccountType } from "@/lib/print-eligibility";
import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";
import ImpersonationBanner from "@/components/ImpersonationBanner";
import MainContent from "@/components/MainContent";
import ProductFruitsWidget from "@/components/ProductFruitsWidget";
import { BuilderBreadcrumbProvider } from "@/contexts/BuilderBreadcrumb";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  const admin = createAdminSupabaseClient();
  const profile = await resolveSessionProfile<{ role: string; dealer_id: string | null; full_name: string | null; group_id: string | null; active_dealer_id: string | null; created_at: string | null; }>(admin, session, "role, dealer_id, full_name, group_id, active_dealer_id, created_at");

  const role: UserRole = (profile?.role
    ?? (session.user.app_metadata as Record<string, unknown>)?.role as string | undefined
    ?? "dealer_user") as UserRole;

  const isDealerRole = role === "dealer_admin" || role === "dealer_user" || role === "dealer_restricted";
  const isGroupAdmin = role === "group_admin";
  const isGroupUser = role === "group_user";
  const isSuperAdmin = role === "super_admin";
  // A group_user (regional manager) switches into a tagged dealer the same way a
  // group_admin does — resolve their active dealer so the nav flips to dealer parity.
  const activeDealerUuid = (isGroupAdmin || isGroupUser) ? (profile?.active_dealer_id ?? null) : null;

  // ── Ghost mode (super_admin only) ──────────────────────────────────────────
  let ghostDealerName: string | null = null;
  let ghostGroupId: string | null = null;
  let ghostGroupName: string | null = null;
  let isGhostMode = false;
  if (isSuperAdmin) {
    const cookieStore = cookies();
    const ghostToken = cookieStore.get("da_ghost_token")?.value;
    if (ghostToken) {
      const ghostCtx = verifyGhostToken(ghostToken);
      if (ghostCtx) {
        isGhostMode = true;
        if (ghostCtx.group_id) {
          ghostGroupId = ghostCtx.group_id;
          ghostGroupName = ghostCtx.group_name ?? null;
        } else {
          ghostDealerName = ghostCtx.dealer_name ?? null;
        }
      }
    }
  }

  // ── Dealer name + template-lock flag (dealer roles) ───────────────────────
  // group_controls_templates is only meaningful when the dealer actually
  // belongs to a group — a standalone dealer with the flag stuck "true"
  // (e.g. from a prior group assignment that wasn't fully cleaned up)
  // would otherwise have Builder silently hidden from their nav and the
  // /builder page redirect them back to /dashboard.
  type DealerRow = {
    name: string;
    dealer_id: string | null;
    group_id: string | null;
    group_controls_templates: boolean | null;
    account_type: string | null;
    migration_status: string | null;
  };
  let dealerName: string | null = null;
  let templatesLocked = false;
  let dealerAccountType: string | null = null;
  let dealerData: DealerRow | null = null;
  if (isDealerRole && profile?.dealer_id) {
    ({ data: dealerData } = await admin
      .from("dealers")
      .select("name, dealer_id, group_id, group_controls_templates, account_type, migration_status")
      .eq("dealer_id", profile.dealer_id)
      .maybeSingle<DealerRow>());
    dealerName = dealerData?.name ?? null;
    templatesLocked = Boolean(dealerData?.group_controls_templates && dealerData?.group_id);
    dealerAccountType = dealerData?.account_type ?? null;
  }

  // ── V5.0 access gate ──────────────────────────────────────────────────────
  // A real dealer-role login may use the V5.0 dashboard only if it's V5-native
  // (self-serve dealer_id, "ss_" prefix) or explicitly migrated; everyone else
  // is still on Platform 4.0 and is bounced to /not-migrated. Super-admin
  // impersonation keeps role=super_admin (isDealerRole=false), so admins
  // previewing a dealer are unaffected. Fails open: if the dealer record
  // couldn't be read we don't lock anyone out.
  if (isDealerRole && dealerData) {
    const isV5Native = dealerData.dealer_id?.startsWith("ss_") === true;
    const isMigrated = dealerData.migration_status === "migrated";
    if (!isV5Native && !isMigrated) {
      redirect("/not-migrated");
    }
  }

  // ── Group context (group_admin) ────────────────────────────────────────────
  let groupName: string | null = null;
  let activeDealerName: string | null = null;

  if (isGroupAdmin || isGroupUser) {
    const fetches: Promise<void>[] = [];

    if (profile?.group_id) {
      fetches.push(
        Promise.resolve(
          admin.from("groups").select("name").eq("id", profile.group_id).maybeSingle<{ name: string }>()
            .then(({ data }) => { groupName = data?.name ?? null; })
        )
      );
    }
    if (activeDealerUuid) {
      fetches.push(
        Promise.resolve(
          admin.from("dealers").select("name").eq("id", activeDealerUuid).maybeSingle<{ name: string }>()
            .then(({ data }) => { activeDealerName = data?.name ?? null; })
        )
      );
    }

    await Promise.all(fetches);
  }

  // ── Sidebar role ───────────────────────────────────────────────────────────
  // When a group_admin has selected a dealer, or super_admin is in dealer ghost mode,
  // show dealer nav items. When super_admin is in group ghost mode, show group_admin nav.
  // A switched-in group_admin OR group_user gets the full dealer nav (dealer
  // parity). Otherwise a group_user keeps their own scoped nav (Dashboard ·
  // My Dealers · My Profile · Help) — handled by group_user entries in Sidebar.
  const sidebarRole: UserRole = ((isGroupAdmin || isGroupUser) && activeDealerUuid) ? "dealer_admin"
    : (isSuperAdmin && isGhostMode && !ghostGroupId) ? "dealer_admin"
    : (isSuperAdmin && ghostGroupId) ? "group_admin"
    : role;

  const userDisplay = {
    email: session.user.email ?? "",
    fullName: profile?.full_name ?? null,
    role,
    dealerName: (isGhostMode && !ghostGroupId) ? ghostDealerName : dealerName,
    groupName: ghostGroupId ? ghostGroupName : groupName,
    activeDealerName,
    activeDealerId: activeDealerUuid,
    groupId: profile?.group_id ?? null,
  };

  // Yellow "Upgrade Now" CTA — only a real dealer_admin on a non-paid plan
  // (Trial / Trial-Expired / Free / Downgraded). Gated on the real `role`, not
  // sidebarRole, so it never shows for group_admin/super_admin acting as a
  // dealer (active-dealer or ghost mode), nor for dealer_user/restricted.
  const showUpgrade = role === "dealer_admin" && !isPaidAccountType(dealerAccountType);

  // ProductFruits in-app tours — identify the signed-in user (real role/identity,
  // so tours can target by role). username = the stable Supabase auth user id.
  const [pfFirstName, ...pfRest] = (profile?.full_name ?? "").trim().split(/\s+/);
  const pfProps: Record<string, string> = {};
  if (profile?.dealer_id) pfProps.dealerId = profile.dealer_id;
  if (profile?.group_id) pfProps.groupId = profile.group_id;
  const productFruitsUser = {
    username: session.user.id,
    email: session.user.email ?? undefined,
    firstname: pfFirstName || undefined,
    lastname: pfRest.join(" ") || undefined,
    signUpAt: profile?.created_at ?? undefined,
    role,
    props: pfProps,
  };

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar role={sidebarRole} hideBuilder={isDealerRole && templatesLocked} showUpgrade={showUpgrade} />
      <div className="flex flex-col flex-1 overflow-hidden">
        <ImpersonationBanner />
        <BuilderBreadcrumbProvider>
          <Topbar user={userDisplay} />
          <MainContent>{children}</MainContent>
        </BuilderBreadcrumbProvider>
      </div>
      {/* ProductFruits — in-app tours/onboarding + the published "Vin" chat
          widget (replaces the old custom HelpWidget bubble). Client-only;
          initializes the SDK for the signed-in user. The full Help Center page
          + its /api/help routes remain for browsing articles. */}
      <ProductFruitsWidget user={productFruitsUser} />
    </div>
  );
}
