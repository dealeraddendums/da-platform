import { redirect } from "next/navigation";
import Link from "next/link";
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
    .select("role, dealer_id, full_name")
    .eq("id", session.user.id)
    .single<{ role: string; dealer_id: string | null; full_name: string | null }>();

  const role = profile?.role ?? "dealer_user";

  // Non-dealer roles: show a redirect card
  if (role === "super_admin" || role === "group_admin") {
    return (
      <div className="p-6">
        <div
          style={{
            background: "#fff",
            border: "1px solid #e0e0e0",
            borderRadius: 6,
            padding: "32px 24px",
            maxWidth: 480,
          }}
        >
          <h2 style={{ fontSize: 18, fontWeight: 600, color: "#2a2b3c", marginBottom: 8 }}>
            My Profile
          </h2>
          <p style={{ color: "#78828c", marginBottom: 20, fontSize: 14 }}>
            As a{role === "super_admin" ? " super admin" : " group admin"}, dealer profiles are
            managed from the Dealers section.
          </p>
          <Link
            href="/dealers"
            style={{
              display: "inline-block",
              background: "#1976d2",
              color: "#fff",
              padding: "8px 16px",
              borderRadius: 4,
              fontSize: 14,
              fontWeight: 500,
              textDecoration: "none",
            }}
          >
            Go to Dealers
          </Link>
        </div>
      </div>
    );
  }

  // Dealer roles: fetch the dealer record
  if (!profile?.dealer_id) {
    return (
      <div className="p-6">
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
      <div className="p-6">
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
  const userEmail = session.user.email ?? "";
  const userName = profile?.full_name ?? userEmail;

  return (
    <ProfileClient
      dealer={dealer}
      canEdit={canEdit}
      userEmail={userEmail}
      userName={userName}
    />
  );
}
