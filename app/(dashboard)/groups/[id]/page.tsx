import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";
import { readGhostContext } from "@/lib/ghost-containment";
import type { GroupRow } from "@/lib/db";
import GroupProfileCard, { GroupDealers } from "@/components/GroupProfileCard";
import GroupOptionsPanel from "@/components/GroupOptionsPanel";
import GroupImagesPanel from "@/components/GroupImagesPanel";
import GroupExportsPanel from "@/components/GroupExportsPanel";
import DesignList from "@/components/image-builder/DesignList";

type Props = { params: { id: string } };

export const metadata = { title: "Group Profile — DA Platform" };

export default async function GroupPage({ params }: Props) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  const admin = createAdminSupabaseClient();
  const profile = await resolveSessionProfile<{ role: string; group_id: string | null; active_dealer_id: string | null }>(admin, session, "role, group_id, active_dealer_id");

  const role = profile?.role
    ?? (session.user.app_metadata as Record<string, unknown>)?.role as string | undefined
    ?? "dealer_user";

  const isSuperAdmin = role === "super_admin";
  const isGroupAdmin = role === "group_admin";

  if (!isSuperAdmin && !isGroupAdmin) redirect("/dashboard");
  if (isGroupAdmin && profile?.group_id !== params.id) {
    redirect(`/groups/${profile?.group_id ?? ""}`);
  }

  // Ghost containment: a group ghost is confined to the group it ghosted —
  // another group's page is out of scope and bounces back, exactly as a real
  // group_admin's does above. A dealer ghost has no group page at all. In a
  // ghost session the session-level controls (Login as this group, Delete
  // Group) and the "← All Groups" link back to the platform list are hidden;
  // the APIs behind them refuse a ghost session too.
  const ghost = isSuperAdmin ? readGhostContext() : null;
  if (ghost?.dealer_text_id) redirect("/dashboard");
  const ghostGroupId = ghost?.group_id ?? null;
  if (ghostGroupId && ghostGroupId !== params.id) redirect(`/groups/${ghostGroupId}`);
  const inGhostSession = Boolean(ghostGroupId);

  const { data: groupData } = await admin.from("groups").select("*").eq("id", params.id).single();
  const group = groupData as GroupRow | null;
  if (!group) notFound();

  const canEdit = isSuperAdmin || isGroupAdmin;

  // Read hubspot_company_id directly from Supabase groups table
  const hubspotCompanyId = group.hubspot_company_id
    ? parseInt(group.hubspot_company_id, 10) || null
    : null;

  // Member-dealer count for the ETL-freeze blast-radius confirm (the lock
  // cascades to all members, active or not).
  const { count: memberCount } = await admin
    .from("dealers")
    .select("id", { count: "exact", head: true })
    .eq("group_id", params.id);

  // Resolve who froze this group's ETL sync → display name for the badge.
  let etlLockedByName: string | null = null;
  if (group.etl_locked && group.etl_locked_by) {
    const { data: locker } = await admin
      .from("profiles")
      .select("full_name, email")
      .eq("id", group.etl_locked_by)
      .maybeSingle<{ full_name: string | null; email: string | null }>();
    etlLockedByName = locker?.full_name || locker?.email || null;
  }

  return (
    <div>
      {isSuperAdmin && !inGhostSession && (
        <nav className="mb-4">
          <Link href="/groups" className="text-sm" style={{ color: "rgba(255,255,255,0.5)" }}>
            ← All Groups
          </Link>
        </nav>
      )}
      <GroupProfileCard
        group={group}
        canEdit={canEdit}
        isSuperAdmin={isSuperAdmin}
        isGroupAdmin={isGroupAdmin}
        inGhostSession={inGhostSession}
        hubspotCompanyId={hubspotCompanyId}
        memberCount={memberCount ?? 0}
        etlLockedByName={etlLockedByName}
      />
      {(isSuperAdmin || isGroupAdmin) && (
        // One tab bar; only the selected tab's content shows. Member Dealers,
        // the image library, Image Builder and Exports used to stack under the
        // tab bar all at once — they are tabs now, same components, same authz
        // (this page is super_admin / group_admin only; group_user never reaches it).
        <GroupOptionsPanel
          groupId={params.id}
          isSuperAdmin={isSuperAdmin}
          memberDealers={<GroupDealers groupId={params.id} isSuperAdmin={isSuperAdmin} isGroupAdmin={isGroupAdmin} isRestyler={(groupData as { is_restyler?: boolean } | null)?.is_restyler === true} />}
          imageLibrary={<GroupImagesPanel groupId={params.id} inTab />}
          imageBuilder={<DesignList groupId={params.id} />}
          exports={<GroupExportsPanel groupId={params.id} inTab />}
        />
      )}
    </div>
  );
}
