import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import type { UserRole } from "@/lib/db";
import { verifyGhostToken } from "@/lib/ghost";
import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";
import ImpersonationBanner from "@/components/ImpersonationBanner";
import MainContent from "@/components/MainContent";
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
  const { data: profile } = await admin
    .from("profiles")
    .select("role, dealer_id, full_name, group_id, active_dealer_id")
    .eq("id", session.user.id)
    .single<{
      role: string;
      dealer_id: string | null;
      full_name: string | null;
      group_id: string | null;
      active_dealer_id: string | null;
    }>();

  const role: UserRole = (profile?.role
    ?? (session.user.app_metadata as Record<string, unknown>)?.role as string | undefined
    ?? "dealer_user") as UserRole;

  const isDealerRole = role === "dealer_admin" || role === "dealer_user" || role === "dealer_restricted";
  const isGroupAdmin = role === "group_admin";
  const isSuperAdmin = role === "super_admin";
  const activeDealerUuid = isGroupAdmin ? (profile?.active_dealer_id ?? null) : null;

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
  let dealerName: string | null = null;
  let templatesLocked = false;
  if (isDealerRole && profile?.dealer_id) {
    const { data: dealerData } = await admin
      .from("dealers")
      .select("name, group_controls_templates")
      .eq("dealer_id", profile.dealer_id)
      .maybeSingle<{ name: string; group_controls_templates: boolean | null }>();
    dealerName = dealerData?.name ?? null;
    templatesLocked = Boolean(dealerData?.group_controls_templates);
  }

  // ── Group context (group_admin) ────────────────────────────────────────────
  let groupName: string | null = null;
  let activeDealerName: string | null = null;

  if (isGroupAdmin) {
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
  const sidebarRole: UserRole = (isGroupAdmin && activeDealerUuid) ? "dealer_admin"
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

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar role={sidebarRole} hideBuilder={isDealerRole && templatesLocked} />
      <div className="flex flex-col flex-1 overflow-hidden">
        <ImpersonationBanner />
        <BuilderBreadcrumbProvider>
          <Topbar user={userDisplay} />
          <MainContent>{children}</MainContent>
        </BuilderBreadcrumbProvider>
      </div>
    </div>
  );
}
