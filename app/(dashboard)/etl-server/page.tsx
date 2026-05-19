import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { PageHeader } from "@/components/PageHeader";

export const metadata = { title: "ETL Server — DA Platform" };

export default async function EtlServerPage() {
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
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 56px)" }}>
      <div style={{ padding: "24px 24px 0" }}>
        <PageHeader title="ETL Server" subtitle="Feed processing jobs" />
      </div>
      <div style={{ flex: 1, padding: "0 24px 24px" }}>
        <iframe
          src="https://etl2.dealeraddendums.com/jobs"
          style={{ width: "100%", height: "100%", border: "none", borderRadius: 6, background: "#fff" }}
          title="ETL Server — Feed Processing Jobs"
        />
        <noscript>
          <div
            className="card p-6"
            style={{ textAlign: "center", color: "var(--text-muted)", marginTop: 16 }}
          >
            Unable to load ETL Server. Visit{" "}
            <a href="https://etl2.dealeraddendums.com/jobs" target="_blank" rel="noreferrer"
              style={{ color: "var(--blue)" }}>
              etl2.dealeraddendums.com/jobs
            </a>{" "}
            directly.
          </div>
        </noscript>
      </div>
    </div>
  );
}
