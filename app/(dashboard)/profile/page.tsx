import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerRow } from "@/lib/db";
import ProfileClient from "./ProfileClient";

export const metadata = { title: "My Profile — DA Platform" };

export default async function ProfilePage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  const admin = createAdminSupabaseClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role, dealer_id, full_name, active_dealer_id, created_at")
    .eq("id", session.user.id)
    .single<{ role: string; dealer_id: string | null; full_name: string | null; active_dealer_id: string | null; created_at: string }>();

  const role = profile?.role ?? "dealer_user";
  const userEmail = session.user.email ?? "";
  const userName = profile?.full_name ?? userEmail;
  const memberSince = profile?.created_at ?? session.user.created_at;

  // super_admin / group_admin — no dealer; Security tab only
  if (role === "super_admin" || role === "group_admin") {
    return (
      <ProfileClient
        dealer={null}
        canEdit={false}
        userEmail={userEmail}
        userName={userName}
        userRole={role}
        memberSince={memberSince}
      />
    );
  }

  // Dealer roles: require a dealer_id
  if (!profile?.dealer_id) {
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
    .eq("dealer_id", profile.dealer_id)
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

  const canEdit = role === "dealer_admin";

  return (
    <ProfileClient
      dealer={dealer}
      canEdit={canEdit}
      userEmail={userEmail}
      userName={userName}
      userRole={role}
      memberSince={memberSince}
    />
  );
}
