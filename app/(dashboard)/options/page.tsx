import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { verifyGhostToken } from "@/lib/ghost";
import OptionsLibrary from "@/components/OptionsLibrary";

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

  const cookieStore = cookies();
  const ghostCtx = role === "super_admin"
    ? verifyGhostToken(cookieStore.get("da_ghost_token")?.value ?? "")
    : null;
  const ghostDealerId = ghostCtx?.dealer_text_id ?? null;

  const isDealerRole = role === "dealer_admin" || role === "dealer_user";
  if (!isDealerRole && !ghostDealerId) redirect("/dashboard");

  const effectiveDealerId = ghostDealerId ?? profile?.dealer_id ?? null;

  if (!effectiveDealerId) {
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
      <OptionsLibrary dealerId={effectiveDealerId} />
    </div>
  );
}
