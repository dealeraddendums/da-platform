import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import OptionsLibrary from "@/components/OptionsLibrary";
import VehicleSubNav from "@/components/VehicleSubNav";

export const metadata = { title: "Addendum Options — DA Platform" };

export default async function OptionsPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  const admin = createAdminSupabaseClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role, dealer_id")
    .eq("id", session.user.id)
    .single<{ role: string; dealer_id: string | null }>();

  const role = profile?.role
    ?? (session.user.app_metadata as Record<string, unknown>)?.role as string | undefined
    ?? "dealer_user";

  if (role !== "dealer_admin" && role !== "dealer_user") redirect("/dashboard");

  if (!profile?.dealer_id) {
    return (
      <div>
        <div className="card p-6">
          <p style={{ color: "var(--text-secondary)" }}>
            No dealer assigned to your account. Contact your administrator.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <VehicleSubNav />
      <OptionsLibrary dealerId={profile.dealer_id} />
    </div>
  );
}
