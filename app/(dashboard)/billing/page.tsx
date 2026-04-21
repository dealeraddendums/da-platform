import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";

export const metadata = { title: "Billing — DA Platform" };

export default async function BillingPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  const admin = createAdminSupabaseClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", session.user.id)
    .single<{ role: string }>();

  const role = profile?.role ?? (session.user.app_metadata as Record<string, unknown>)?.role;
  if (role !== "super_admin") redirect("/dashboard");

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-xl font-semibold" style={{ color: "var(--text-inverse)" }}>Billing</h1>
        <p className="text-sm mt-1" style={{ color: "rgba(255,255,255,0.6)" }}>
          Manage dealer billing, invoices, and account status.
        </p>
      </div>

      <div
        className="rounded-lg p-10 flex flex-col items-center justify-center text-center"
        style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", minHeight: 280 }}
      >
        <div
          className="w-12 h-12 rounded-lg flex items-center justify-center mb-4"
          style={{ background: "var(--bg-subtle)" }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2">
            <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
            <line x1="1" y1="10" x2="23" y2="10" />
          </svg>
        </div>
        <h2 className="text-base font-semibold mb-2" style={{ color: "var(--text-primary)" }}>
          Billing — Phase 10
        </h2>
        <p className="text-sm max-w-xs" style={{ color: "var(--text-muted)" }}>
          Billing integration with da-billing is scheduled for Phase 10.
          Invoice management, account status, and MRR reporting will live here.
        </p>
      </div>
    </div>
  );
}
