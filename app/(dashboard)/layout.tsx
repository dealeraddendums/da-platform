import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { ProfileRow, UserRole } from "@/lib/db";
import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    redirect("/login");
  }

  const { data } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", session.user.id)
    .returns<ProfileRow[]>()
    .single();

  const profile = data as ProfileRow | null;

  // Prefer profiles table role; fall back to JWT app_metadata claim set by the hook
  const role: UserRole =
    profile?.role ??
    (session.user.app_metadata?.role as UserRole | undefined) ??
    "dealer_user";

  const userDisplay = {
    email: session.user.email ?? "",
    fullName: profile?.full_name ?? null,
    role,
  };

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar role={role} />
      <div className="flex flex-col flex-1 overflow-hidden">
        <Topbar user={userDisplay} />
        <main
          className="flex-1 overflow-auto p-6"
          style={{ background: "var(--bg-app)" }}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
