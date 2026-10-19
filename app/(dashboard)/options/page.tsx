import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";
import { resolveActiveDealer } from "@/lib/active-dealer";
import { verifyGhostToken } from "@/lib/ghost";
import OptionsLibrary from "@/components/OptionsLibrary";

export const metadata = { title: "Addendum Products — DA Platform" };

export default async function OptionsPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  const admin = createAdminSupabaseClient();
  const profile = await resolveSessionProfile<{ role: string; dealer_id: string | null; group_id: string | null; active_dealer_id: string | null }>(admin, session, "role, dealer_id, group_id, active_dealer_id");

  const role = profile?.role
    ?? (session.user.app_metadata as Record<string, unknown>)?.role as string | undefined
    ?? "dealer_user";

  const cookieStore = cookies();
  const ghostCtx = role === "super_admin"
    ? verifyGhostToken(cookieStore.get("da_ghost_token")?.value ?? "")
    : null;
  const ghostDealerId = ghostCtx?.dealer_text_id ?? null;

  // A group_admin OR group_user (regional manager) switched into a dealer acts
  // as that dealer here too.
  // Session-scoped active dealer (lib/active-dealer.ts) — the SAME resolver the
  // API layer uses, re-authorized per request, so this page's chrome can never
  // disagree with the data and writes it drives.
  const activeDealerTextId = (await resolveActiveDealer(admin, {
    userId: session.user.id,
    role,
    groupId: profile?.group_id ?? null,
  })).textId;

  const isDealerRole = role === "dealer_admin" || role === "dealer_user";
  if (!isDealerRole && !ghostDealerId && !activeDealerTextId) redirect("/dashboard");

  const effectiveDealerId = ghostDealerId ?? activeDealerTextId ?? profile?.dealer_id ?? null;

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
