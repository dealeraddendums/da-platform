import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import BuilderPage from "@/components/builder/BuilderPage";

export const metadata = { title: "Document Builder — DA Platform" };

export default async function BuilderRoute() {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    redirect("/login?next=/builder");
  }

  return <BuilderPage />;
}
