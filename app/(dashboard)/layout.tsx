import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import type { UserRole } from "@/lib/db";
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
  const activeDealerUuid = isGroupAdmin ? (profile?.active_dealer_id ?? null) : null;

  // ── Dealer name (dealer roles) ─────────────────────────────────────────────
  let dealerName: string | null = null;
  if (isDealerRole && profile?.dealer_id) {
    const { data: dealerData } = await admin
      .from("dealers")
      .select("name")
      .eq("dealer_id", profile.dealer_id)
      .maybeSingle<{ name: string }>();
    dealerName = dealerData?.name ?? null;
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
  // When a group_admin has selected a dealer, show them dealer nav items.
  const sidebarRole: UserRole = (isGroupAdmin && activeDealerUuid) ? "dealer_admin" : role;

  const userDisplay = {
    email: session.user.email ?? "",
    fullName: profile?.full_name ?? null,
    role,
    dealerName,
    groupName,
    activeDealerName,
    activeDealerId: activeDealerUuid,
    groupId: profile?.group_id ?? null,
  };

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar role={sidebarRole} />
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
