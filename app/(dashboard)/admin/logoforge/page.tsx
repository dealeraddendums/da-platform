// super_admin LogoForge dashboard: the make-logo library (browse + replace,
// live without a LogoForge deploy), brand templates (generate / create / edit)
// and usage stats. Server-gated here; every data call is a super_admin-gated
// proxy under /api/admin/logoforge/*.

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";
import { logoForgeAdminConfigured } from "@/lib/logoforge-admin";
import LogoForgeDashboard from "@/components/logoforge/LogoForgeDashboard";

export const dynamic = "force-dynamic";
export const metadata = { title: "LogoForge — DA Platform" };

export default async function LogoForgePage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login?next=/admin/logoforge");

  const admin = createAdminSupabaseClient();
  const profile = await resolveSessionProfile<{ role: string }>(admin, session, "role");
  const role = profile?.role
    ?? ((session.user.app_metadata as Record<string, unknown>)?.role as string | undefined);
  if (role !== "super_admin") redirect("/dashboard");

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-semibold" style={{ color: "var(--text-inverse)" }}>LogoForge</h1>
        <p className="text-sm mt-1" style={{ color: "rgba(255,255,255,0.6)" }}>
          The make-logo library, brand templates and how the logo service is being used. Changes here go live on the service immediately.
        </p>
      </div>
      {logoForgeAdminConfigured()
        ? <LogoForgeDashboard />
        : <div className="card" style={{ padding: 20, fontSize: 14 }}>LogoForge isn&apos;t configured on this server.</div>}
    </div>
  );
}
