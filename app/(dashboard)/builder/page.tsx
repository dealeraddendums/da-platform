import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient, createAdminSupabaseClient } from "@/lib/supabase/server";
import { resolveSessionProfile } from "@/lib/profile-session";
import { verifyGhostToken } from "@/lib/ghost";
import BuilderPage from "@/components/builder/BuilderPage";

export const metadata = { title: "Document Builder — DA Platform" };

export default async function BuilderRoute({ searchParams }: { searchParams?: { group?: string; template?: string } }) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login?next=/builder");

  // Use admin client to bypass RLS — user-scoped client can return null if JWT is stale
  const admin = createAdminSupabaseClient();
  const profile = await resolveSessionProfile<{ dealer_id: string | null; role: string; group_id: string | null; active_dealer_id: string | null }>(admin, session, "dealer_id, role, group_id, active_dealer_id");

  const role = profile?.role ?? "dealer_user";
  const isGroupAdmin = role === "group_admin";
  const isGroupUser = role === "group_user";
  const isSuperAdmin = role === "super_admin";
  const isDealerRole = role === "dealer_admin" || role === "dealer_user" || role === "dealer_restricted";

  // Group-controlled dealers: dealer roles are redirected away from the
  // Builder. group_admin / super_admin always retain access. The flag is
  // only enforced when the dealer is actually in a group — a standalone
  // dealer with a stale "true" must not lose Builder access.
  if (isDealerRole && profile?.dealer_id) {
    const { data: dealerLock } = await admin
      .from("dealers")
      .select("group_id, group_controls_templates")
      .eq("dealer_id", profile.dealer_id)
      .maybeSingle<{ group_id: string | null; group_controls_templates: boolean | null }>();
    if (dealerLock?.group_controls_templates && dealerLock?.group_id) {
      redirect("/dashboard");
    }
  }

  // ?group=ID lets super_admin and the group's own group_admin open the Builder
  // scoped to that group. Other roles fall through to the dealer flow below.
  const groupParam = searchParams?.group ?? null;
  const templateParam = searchParams?.template ?? null;
  const explicitGroupId = groupParam && (isSuperAdmin || (isGroupAdmin && profile?.group_id === groupParam))
    ? groupParam
    : null;

  // Ghost mode: super_admin can view builder scoped to a ghost dealer
  const cookieStore = cookies();
  const ghostCtx = role === "super_admin"
    ? verifyGhostToken(cookieStore.get("da_ghost_token")?.value ?? "")
    : null;
  const ghostDealerId = ghostCtx?.dealer_text_id ?? null;
  // Group ghost mode: super_admin viewing a group sets ghostCtx.group_id and
  // has no dealer_text_id. Without this, the Builder previously fell through
  // to dealer mode with no dealer scope and the "All Templates" modal queried
  // /api/templates (dealer table) — never the group's saved templates.
  const ghostGroupId = ghostCtx?.group_id ?? null;

  // Resolve effective dealer_id
  let dealerId = ghostDealerId ?? profile?.dealer_id ?? null;
  if (!ghostDealerId && (isGroupAdmin || isGroupUser) && profile?.active_dealer_id) {
    const { data: activeDlr } = await admin
      .from("dealers")
      .select("dealer_id")
      .eq("id", profile.active_dealer_id)
      .maybeSingle<{ dealer_id: string }>();
    if (activeDlr) dealerId = activeDlr.dealer_id;
  }

  const groupId = explicitGroupId
    ?? ghostGroupId
    ?? ((isGroupAdmin && profile?.group_id) ? profile.group_id : null);

  type DealerData = { logo_url: string | null; name: string | null; address: string | null; city: string | null; state: string | null; zip: string | null; phone: string | null };

  const [{ data: customSizeRows }, { data: dealerData }] = await Promise.all([
    dealerId
      ? admin.from("dealer_custom_sizes").select("id, dealer_id, name, width_in, height_in, background_url, doc_type, created_at, updated_at").eq("dealer_id", dealerId).order("name")
      : Promise.resolve({ data: [] }),
    dealerId
      ? admin.from("dealers").select("logo_url, name, address, city, state, zip, phone").eq("dealer_id", dealerId).maybeSingle<DealerData>()
      : Promise.resolve({ data: null }),
  ]);

  const S3_LOGO = "https://new-dealer-logos.s3.us-east-1.amazonaws.com/";
  const rawLogo = dealerData?.logo_url ?? null;
  const resolvedLogo = rawLogo ? (rawLogo.startsWith("http") ? rawLogo : S3_LOGO + rawLogo) : null;

  const dealerInfo = dealerData ? {
    name: dealerData.name ?? null,
    address: dealerData.address ?? null,
    city: dealerData.city ?? null,
    state: dealerData.state ?? null,
    zip: dealerData.zip ?? null,
    phone: dealerData.phone ?? null,
  } : undefined;

  // Custom sizes: dealer_admin (own dealer), super_admin, and a switched-in
  // group_admin (active_dealer_id set → acting as that in-group dealer, which
  // POST /api/custom-sizes now authorizes). dealer_user stays excluded.
  // canAdminUpload remains super_admin-only — that gates the platform background
  // library, a separate concern from dealer-scoped sizes.
  const canAddCustomSize = role === 'super_admin' || role === 'dealer_admin'
    || ((isGroupAdmin || isGroupUser) && !!profile?.active_dealer_id);
  return <BuilderPage customSizes={customSizeRows ?? []} dealerId={dealerId ?? undefined} dealerLogoUrl={resolvedLogo} dealerInfo={dealerInfo} groupId={groupId ?? undefined} templateId={templateParam ?? undefined} canAddCustomSize={canAddCustomSize} canAdminUpload={role === 'super_admin'} />;
}
