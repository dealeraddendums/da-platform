import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import DealerList from "@/components/DealerList";

export const metadata = { title: "Dealers — DA Platform" };

export default async function DealersPage() {
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

  if (role === "super_admin" || role === "group_admin") {
    return <DealerList />;
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
      <h1 className="text-xl font-semibold mb-2" style={{ color: "var(--text-inverse)" }}>
        Dealer Profile — Debug
      </h1>
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
