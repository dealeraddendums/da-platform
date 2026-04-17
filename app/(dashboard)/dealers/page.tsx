import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import type { ProfileRow, DealerRow } from "@/lib/db";
import DealerList from "@/components/DealerList";

export const metadata = { title: "Dealers — DA Platform" };

export default async function DealersPage() {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) redirect("/login");

  const { data } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", session.user.id)
    .returns<ProfileRow[]>()
    .single();

  const profile = data as ProfileRow | null;

  // Non-super-admin: redirect to their own dealer profile
  if (profile?.role !== "super_admin") {
    if (profile?.dealer_id) {
      const admin = createAdminSupabaseClient();
      const { data: dealer } = await admin
        .from("dealers")
        .select("id")
        .eq("dealer_id", profile.dealer_id)
        .returns<{ id: string }[]>()
        .single();
      if (dealer) {
        const d = dealer as { id: string };
        redirect(`/dealers/${d.id}`);
      }
    }
    return (
      <div>
        <h1 className="text-xl font-semibold mb-2" style={{ color: "var(--text-inverse)" }}>
          Dealer Profile
        </h1>
        <div className="card p-6">
          <p style={{ color: "var(--text-secondary)" }}>
            No dealer profile has been assigned to your account yet. Contact your administrator.
          </p>
        </div>
      </div>
    );
  }

  return <DealerList />;
}
