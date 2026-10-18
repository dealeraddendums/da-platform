// Admin "VIN / Stock Lookup" — super_admin diagnostic for "a dealer says this
// VIN is missing — why?". Server-gated here; the API route gates again.

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";
import { PageHeader } from "@/components/PageHeader";
import VinLookupClient from "@/components/VinLookupClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "VIN / Stock Lookup — DA Platform" };

export default async function VinLookupPage({ searchParams }: { searchParams?: { q?: string; dealer?: string } }) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login?next=/admin/vin-lookup");

  const admin = createAdminSupabaseClient();
  const profile = await resolveSessionProfile<{ role: string }>(admin, session, "role");
  const role = profile?.role
    ?? ((session.user.app_metadata as Record<string, unknown>)?.role as string | undefined);
  if (role !== "super_admin") redirect("/dashboard");

  return (
    <div>
      <PageHeader
        title="VIN / Stock Lookup"
        subtitle="Everything we know about a vehicle — 5.0 inventory, products, prints, S3 PDFs, feed, and 4.0 (Aurora). Read-only."
      />
      <VinLookupClient initialQuery={searchParams?.q ?? ""} initialDealer={searchParams?.dealer ?? ""} />
    </div>
  );
}
