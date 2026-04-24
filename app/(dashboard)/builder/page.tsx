import { redirect } from "next/navigation";
import { createClient, createAdminSupabaseClient } from "@/lib/supabase/server";
import BuilderPage from "@/components/builder/BuilderPage";

export const metadata = { title: "Document Builder — DA Platform" };

export default async function BuilderRoute() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login?next=/builder");

  // Use admin client to bypass RLS — user-scoped client can return null if JWT is stale
  const admin = createAdminSupabaseClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("dealer_id")
    .eq("id", session.user.id)
    .maybeSingle<{ dealer_id: string | null }>();

  const dealerId = profile?.dealer_id ?? null;

  const { data: customSizeRows } = dealerId
    ? await admin.from("dealer_custom_sizes").select("id, dealer_id, name, width_in, height_in, background_url, created_at, updated_at").eq("dealer_id", dealerId).order("name")
    : { data: [] };

  return <BuilderPage customSizes={customSizeRows ?? []} dealerId={dealerId ?? undefined} />;
}
