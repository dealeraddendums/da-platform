import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";
import type { DealerRow } from "@/lib/db";
import { verifyGhostToken } from "@/lib/ghost";
import { getRecommendedAddendumPaperSizes } from "@/lib/recommended-labels";
import ProfileClient from "./ProfileClient";

export const metadata = { title: "My Profile — DA Platform" };

export default async function ProfilePage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  const admin = createAdminSupabaseClient();
  const profile = await resolveSessionProfile<{ role: string; dealer_id: string | null; full_name: string | null; active_dealer_id: string | null; created_at: string }>(admin, session, "role, dealer_id, full_name, active_dealer_id, created_at");

  const role = profile?.role ?? "dealer_user";
  const userEmail = session.user.email ?? "";
  const userName = profile?.full_name ?? userEmail;
  const memberSince = profile?.created_at ?? session.user.created_at;

  // Ghost mode: super_admin viewing a dealer's context — show that dealer's profile
  if (role === "super_admin") {
    const cookieStore = cookies();
    const ghostCtx = verifyGhostToken(cookieStore.get("da_ghost_token")?.value ?? "");
    const ghostDealerId = ghostCtx?.dealer_text_id ?? null;

    if (ghostDealerId) {
      const { data: rawDealer } = await admin
        .from("dealers")
        .select("*")
        .eq("dealer_id", ghostDealerId)
        .single();

      const dealer = rawDealer as DealerRow | null;
      return (
        <ProfileClient
          dealer={dealer}
          canEdit={false}
          canOrderLabels={false}
          recommendedPaperSizes={[]}
          userEmail={userEmail}
          userName={userName}
          userRole={role}
          memberSince={memberSince}
        />
      );
    }

    // super_admin not in ghost mode — Security tab only (no dealer context)
    return (
      <ProfileClient
        dealer={null}
        canEdit={false}
        canOrderLabels={false}
        recommendedPaperSizes={[]}
        userEmail={userEmail}
        userName={userName}
        userRole={role}
        memberSince={memberSince}
      />
    );
  }

  // group_admin acting as a selected dealer (active_dealer_id) sees that
  // dealer's profile — edit + Order Supplies — exactly like a dealer_admin for
  // it. Without an active dealer, group_admin gets the Security tab only.
  let effectiveDealerTextId: string | null = profile?.dealer_id ?? null;
  let actingAsDealer = false;
  // group_admin OR group_user (regional manager) acting as a switched-in dealer
  // sees that dealer's profile — edit, Order Supplies, and its billing.
  if (role === "group_admin" || role === "group_user") {
    let resolvedActive: string | null = null;
    if (profile?.active_dealer_id) {
      const { data: d } = await admin
        .from("dealers")
        .select("dealer_id")
        .eq("id", profile.active_dealer_id)
        .maybeSingle<{ dealer_id: string }>();
      resolvedActive = d?.dealer_id ?? null;
    }
    if (!resolvedActive) {
      return (
        <ProfileClient
          dealer={null}
          canEdit={false}
          canOrderLabels={false}
          recommendedPaperSizes={[]}
          userEmail={userEmail}
          userName={userName}
          userRole={role}
          memberSince={memberSince}
        />
      );
    }
    effectiveDealerTextId = resolvedActive;
    actingAsDealer = true;
  }

  // Dealer roles (and group_admin acting as a dealer): require a dealer_id
  if (!effectiveDealerTextId) {
    return (
      <div>
        <div
          style={{
            background: "#fff",
            border: "1px solid #e0e0e0",
            borderRadius: 6,
            padding: "32px 24px",
            maxWidth: 480,
          }}
        >
          <p style={{ color: "#78828c", fontSize: 14 }}>
            No dealership found for your account. Please contact support.
          </p>
        </div>
      </div>
    );
  }

  const { data: rawDealer } = await admin
    .from("dealers")
    .select("*")
    .eq("dealer_id", effectiveDealerTextId)
    .single();

  const dealer = rawDealer as DealerRow | null;
  if (!dealer) {
    return (
      <div>
        <div
          style={{
            background: "#fff",
            border: "1px solid #e0e0e0",
            borderRadius: 6,
            padding: "32px 24px",
            maxWidth: 480,
          }}
        >
          <p style={{ color: "#78828c", fontSize: 14 }}>
            Dealer profile not found. Please contact support.
          </p>
        </div>
      </div>
    );
  }

  // A group_admin acting as the dealer has dealer_admin-level rights for it.
  const canEdit = role === "dealer_admin" || actingAsDealer;
  // Label ordering is open to both dealer_admin AND dealer_user — the API
  // route at /api/orders/labels already allows the latter (and matches the
  // role table in CLAUDE-da-platform.md, where dealer_user has print/order
  // capability inside their dealer). dealer_restricted stays blocked at
  // the UI; editing dealer/shipping profile fields remains dealer_admin
  // only via the separate `canEdit` flag.
  const canOrderLabels = role === "dealer_admin" || role === "dealer_user" || actingAsDealer;

  const recommendedPaperSizes = await getRecommendedAddendumPaperSizes(admin, effectiveDealerTextId);

  return (
    <ProfileClient
      dealer={dealer}
      canEdit={canEdit}
      canOrderLabels={canOrderLabels}
      recommendedPaperSizes={recommendedPaperSizes}
      userEmail={userEmail}
      userName={userName}
      userRole={role}
      memberSince={memberSince}
    />
  );
}
