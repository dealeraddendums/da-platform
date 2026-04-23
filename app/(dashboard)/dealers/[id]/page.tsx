import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerRow } from "@/lib/db";
import DealerProfileCard from "@/components/DealerProfileCard";
import { getPool } from "@/lib/aurora";
import type { RowDataPacket } from "mysql2/promise";

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

  // Look up HUBSPOT_COMPANY_ID from Aurora using inventory_dealer_id
  let hubspotCompanyId: number | null = null;
  if (dealer.inventory_dealer_id) {
    try {
      const [rows] = await getPool().execute<RowDataPacket[]>(
        "SELECT HUBSPOT_COMPANY_ID FROM dealer_dim WHERE DEALER_ID = ? LIMIT 1",
        [dealer.inventory_dealer_id]
      );
      if (rows.length > 0 && rows[0].HUBSPOT_COMPANY_ID) {
        hubspotCompanyId = rows[0].HUBSPOT_COMPANY_ID as number;
      }
    } catch { /* proceed without HubSpot link */ }
  }

  return (
    <div>
      {isSuperAdmin && (
        <nav className="mb-4">
          <Link href="/dealers" className="text-sm" style={{ color: "rgba(255,255,255,0.5)" }}>
            ← All Dealers
          </Link>
        </nav>
      )}
      <DealerProfileCard dealer={dealer} group={group} canEdit={canEdit} isSuperAdmin={isSuperAdmin} hubspotCompanyId={hubspotCompanyId} />
    </div>
  );
}
