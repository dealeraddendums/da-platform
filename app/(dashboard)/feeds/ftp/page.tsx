import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";

export const metadata = { title: "FTP Server — DA Platform" };

export default async function FtpServerPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  const admin = createAdminSupabaseClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", session.user.id)
    .single<{ role: string }>();

  const role =
    profile?.role ??
    ((session.user.app_metadata as Record<string, unknown>)?.role as string | undefined) ??
    "dealer_user";

  if (role !== "super_admin") redirect("/dashboard");

  return (
    <div>
      <h1 className="text-xl font-semibold mb-5" style={{ color: "var(--text-inverse)" }}>
        FTP Server
      </h1>
      <div className="card p-10 text-center" style={{ maxWidth: 480 }}>
        <div
          style={{
            width: 56,
            height: 56,
            margin: "0 auto 16px",
            color: "var(--text-muted)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
            <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
            <line x1="6" y1="6" x2="6.01" y2="6" strokeWidth="3" strokeLinecap="round" />
            <line x1="6" y1="18" x2="6.01" y2="18" strokeWidth="3" strokeLinecap="round" />
          </svg>
        </div>
        <h2 className="text-base font-semibold mb-2" style={{ color: "var(--text-primary)" }}>
          FTP Server
        </h2>
        <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
          FTP server management is coming soon.
        </p>
      </div>
    </div>
  );
}
