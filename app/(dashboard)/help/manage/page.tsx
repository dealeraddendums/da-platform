import { redirect } from "next/navigation";
import { getServerProfile } from "@/lib/auth";
import HelpAdminClient from "@/components/HelpAdminClient";
import { getJwPublicConfig } from "@/lib/jwplayer";

export const dynamic = "force-dynamic";

// Help CMS — authoring is super_admin only (the support team is pinned to
// super_admin, migration 088).
export default async function HelpManagePage() {
  const ctx = await getServerProfile();
  if (!ctx?.profile) redirect("/login?next=/help/manage");
  if (ctx.profile.role !== "super_admin") redirect("/help");
  // Site + player id only — the JW API secret never leaves the server.
  return <HelpAdminClient jw={getJwPublicConfig()} />;
}
