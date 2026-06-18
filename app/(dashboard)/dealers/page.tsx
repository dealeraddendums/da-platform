import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";
import { verifyGhostToken } from "@/lib/ghost";
import DealerList from "@/components/DealerList";
import GroupDealerList from "@/components/GroupDealerList";
import { PageHeader } from "@/components/PageHeader";

export const metadata = { title: "Dealers — DA Platform" };

export default async function DealersPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  const admin = createAdminSupabaseClient();
  const profile = await resolveSessionProfile<{ role: string; dealer_id: string | null; group_id: string | null }>(admin, session, "role, dealer_id, group_id");

  const role = profile?.role
    ?? (session.user.app_metadata as Record<string, unknown>)?.role as string | undefined
    ?? "dealer_user";

  if (role === "super_admin") {
    // Group-ghost: super_admin operating as a group_admin should see
    // only that group's dealers, same as a real group_admin would. The
    // ghost token is signed in app/api/admin/ghost/route.ts with
    // group_id; a dealer-ghost (dealer_text_id present) takes a
    // different code path elsewhere and shouldn't land here. The
    // sidebar + impersonation banner already honor this token.
    const ghostCtx = verifyGhostToken(cookies().get("da_ghost_token")?.value ?? "");
    if (ghostCtx?.group_id && !ghostCtx.dealer_text_id) {
      return <GroupDealerList groupId={ghostCtx.group_id} />;
    }
    return <DealerList role={role} />;
  }

  if (role === "group_admin") {
    return <GroupDealerList groupId={profile?.group_id ?? null} />;
  }

  // dealer_admin / dealer_user: redirect to own dealer profile
  if (profile?.dealer_id) {
    const { data: dealer } = await admin
      .from("dealers")
      .select("id")
      .eq("dealer_id", profile.dealer_id)
      .single<{ id: string }>();
    if (dealer) redirect(`/dealers/${dealer.id}`);
  }

  return (
    <div>
      <PageHeader title="Dealer Profile — Debug" />
      <div className="card p-6 font-mono text-sm space-y-1">
        <p>session.user.id: {session.user.id}</p>
        <p>session.user.email: {session.user.email}</p>
        <p>session.user.app_metadata.role: {String((session.user.app_metadata as Record<string,unknown>)?.role ?? "undefined")}</p>
        <p>profile?.role from DB: {profile?.role ?? "null — query returned no data"}</p>
        <p>computed role: {role}</p>
      </div>
    </div>
  );
}
