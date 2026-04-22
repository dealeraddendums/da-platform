import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";

export const metadata = { title: "ETL Mapping — DA Platform" };

export default async function EtlMappingPage() {
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
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <iframe
        src="/ETL_Mapping_Editor.html"
        style={{
          flex: 1,
          border: "none",
          display: "block",
          width: "100%",
          minHeight: 0,
        }}
      />
    </div>
  );
}
