import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerRow } from "@/lib/db";
import DealerProfileCard from "@/components/DealerProfileCard";

type Props = { params: { id: string } };

export async function generateMetadata({ params: _params }: Props) {
  return { title: `Dealer Profile — DA Platform` };
}

export default async function DealerPage({ params }: Props) {
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

  const isSuperAdmin = role === "super_admin";
  const isDealerAdmin = role === "dealer_admin";

  const { data: rawDealer } = await admin
    .from("dealers")
    .select("*, groups(id, name)")
    .eq("id", params.id)
    .single();
  const dealer = rawDealer as DealerRow | null;
  if (!dealer) notFound();

  const group = rawDealer
    ? ((rawDealer as Record<string, unknown>).groups as { id: string; name: string } | null)
    : null;

  // dealer_admin / dealer_user may only view their own dealer
  if (!isSuperAdmin && role !== "group_admin") {
    if (profile?.dealer_id !== dealer.dealer_id) redirect("/dealers");
  }

  const canEdit = isSuperAdmin || isDealerAdmin;

  return (
    <div>
      {isSuperAdmin && (
        <nav className="mb-4">
          <Link href="/dealers" className="text-sm" style={{ color: "rgba(255,255,255,0.5)" }}>
            ← All Dealers
          </Link>
        </nav>
      )}
      <DealerProfileCard dealer={dealer} group={group} canEdit={canEdit} isSuperAdmin={isSuperAdmin} />
    </div>
  );
}
