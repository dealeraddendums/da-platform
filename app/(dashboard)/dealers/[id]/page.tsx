import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import type { ProfileRow, DealerRow } from "@/lib/db";
import DealerProfileCard from "@/components/DealerProfileCard";

type Props = { params: { id: string } };

export async function generateMetadata({ params }: Props) {
  return { title: `Dealer Profile — DA Platform` };
}

export default async function DealerPage({ params }: Props) {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) redirect("/login");

  const { data: profileData } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", session.user.id)
    .returns<ProfileRow[]>()
    .single();

  const profile = profileData as ProfileRow | null;
  const isSuperAdmin = profile?.role === "super_admin";
  const isDealerAdmin = profile?.role === "dealer_admin";

  // Fetch dealer — super_admin uses service role; others rely on RLS
  let dealer: DealerRow | null = null;

  if (isSuperAdmin) {
    const admin = createAdminSupabaseClient();
    const { data } = await admin
      .from("dealers")
      .select("*")
      .eq("id", params.id)
      .single();
    dealer = data as DealerRow | null;
  } else {
    const { data } = await supabase
      .from("dealers")
      .select("*")
      .eq("id", params.id)
      .returns<DealerRow[]>()
      .single();
    dealer = data as DealerRow | null;
  }

  if (!dealer) notFound();

  const canEdit = isSuperAdmin || isDealerAdmin;

  return (
    <div>
      {/* Breadcrumb */}
      {isSuperAdmin && (
        <nav className="mb-4">
          <Link
            href="/dealers"
            className="text-sm"
            style={{ color: "rgba(255,255,255,0.5)" }}
          >
            ← All Dealers
          </Link>
        </nav>
      )}

      <DealerProfileCard
        dealer={dealer}
        canEdit={canEdit}
        isSuperAdmin={isSuperAdmin}
      />
    </div>
  );
}
