import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";
import BiClient from "./BiClient";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  return { title: "Business Intelligence — DA Platform" };
}

// super_admin only — mirror the dealer-detail page's role gate. Non-super_admin
// is bounced to the dashboard (the nav entry is also super_admin-only, and the
// /api/admin/bi* routes are independently gated with requireSuperAdmin).
export default async function BiPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  const admin = createAdminSupabaseClient();
  const profile = await resolveSessionProfile<{ role: string; email: string | null }>(admin, session, "role, email");

  const role = profile?.role
    ?? (session.user.app_metadata as Record<string, unknown>)?.role as string | undefined
    ?? "dealer_user";

  if (role !== "super_admin") redirect("/dashboard");

  // Prefill the email recipient with the acting super_admin's address (Allan's
  // is allan@dealeraddendums.com); the to-field stays editable.
  const defaultRecipient = profile?.email ?? session.user.email ?? "allan@dealeraddendums.com";
  return <BiClient defaultRecipient={defaultRecipient} />;
}
