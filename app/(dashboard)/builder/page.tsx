import { redirect } from "next/navigation";
import { createClient, createAdminSupabaseClient } from "@/lib/supabase/server";
import BuilderPage from "@/components/builder/BuilderPage";

export const metadata = { title: "Document Builder — DA Platform" };

export default async function BuilderRoute() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login?next=/builder");

  // Use admin client to bypass RLS — user-scoped client can return null if JWT is stale
  const admin = createAdminSupabaseClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("dealer_id, role, group_id, active_dealer_id")
    .eq("id", session.user.id)
    .maybeSingle<{ dealer_id: string | null; role: string; group_id: string | null; active_dealer_id: string | null }>();

  const role = profile?.role ?? "dealer_user";
  const isGroupAdmin = role === "group_admin";

  // Resolve effective dealer_id: group_admin with active_dealer_id uses that dealer's text ID
  let dealerId = profile?.dealer_id ?? null;
  if (isGroupAdmin && profile?.active_dealer_id) {
    const { data: activeDlr } = await admin
      .from("dealers")
      .select("dealer_id")
      .eq("id", profile.active_dealer_id)
      .maybeSingle<{ dealer_id: string }>();
    if (activeDlr) dealerId = activeDlr.dealer_id;
  }

  const groupId = (isGroupAdmin && profile?.group_id) ? profile.group_id : null;

  const [{ data: customSizeRows }, { data: dealerData }] = await Promise.all([
    dealerId
      ? admin.from("dealer_custom_sizes").select("id, dealer_id, name, width_in, height_in, background_url, created_at, updated_at").eq("dealer_id", dealerId).order("name")
      : Promise.resolve({ data: [] }),
    dealerId
      ? admin.from("dealers").select("logo_url").eq("dealer_id", dealerId).maybeSingle<{ logo_url: string | null }>()
      : Promise.resolve({ data: null }),
  ]);

  const S3_LOGO = "https://new-dealer-logos.s3.us-east-1.amazonaws.com/";
  const rawLogo = dealerData?.logo_url ?? null;
  const resolvedLogo = rawLogo ? (rawLogo.startsWith("http") ? rawLogo : S3_LOGO + rawLogo) : null;

  return <BuilderPage customSizes={customSizeRows ?? []} dealerId={dealerId ?? undefined} dealerLogoUrl={resolvedLogo} groupId={groupId ?? undefined} />;
}
