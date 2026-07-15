import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";
import { PageHeader } from "@/components/PageHeader";
import { RAW_FIELDS, COMPUTED_FIELDS, type ColumnMapping } from "@/lib/feed-export";
import FeedColumnsClient from "./FeedColumnsClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Feed Column Mapping — DA Platform" };

export default async function FeedColumnsPage({ params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect(`/login?next=/admin/feeds/${params.id}/columns`);

  const admin = createAdminSupabaseClient();
  const profile = await resolveSessionProfile<{ role: string }>(admin, session, "role");
  const role =
    profile?.role ??
    ((session.user.app_metadata as Record<string, unknown>)?.role as string | undefined);
  if (role !== "super_admin") redirect("/dashboard");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: feed } = await (admin as any)
    .from("feed_companies")
    .select("id, name, column_mappings")
    .eq("id", params.id)
    .maybeSingle() as { data: { id: string; name: string; column_mappings: ColumnMapping[] } | null };
  if (!feed) notFound();

  return (
    <div>
      <PageHeader
        title={`${feed.name} — Column Mapping`}
        subtitle="Map the recipient's column names to DA vehicle and computed fields."
      />
      <FeedColumnsClient
        feedId={feed.id}
        initialMappings={Array.isArray(feed.column_mappings) ? feed.column_mappings : []}
        rawFields={RAW_FIELDS}
        computedFields={[...COMPUTED_FIELDS]}
      />
    </div>
  );
}
