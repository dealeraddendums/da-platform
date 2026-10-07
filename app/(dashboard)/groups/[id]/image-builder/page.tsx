import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { gateGroupImageBuilderPage } from "@/lib/image-builder/page-gate";
import { createAdminSupabaseClient } from "@/lib/db";
import DesignList from "@/components/image-builder/DesignList";

export const dynamic = "force-dynamic";
export const metadata = { title: "Image Builder — DA Platform" };

// Group Image Builder (migration 167): the group's own designs; saved images go
// to the group's image library. Also embedded in My Group → Image Builder.
export default async function GroupImageBuilderPage({ params }: { params: { id: string } }) {
  await gateGroupImageBuilderPage(params.id, `/groups/${params.id}/image-builder`);
  const { data: g } = await createAdminSupabaseClient().from("groups").select("name").eq("id", params.id).maybeSingle<{ name: string }>();
  return (
    <div>
      <PageHeader title="Image Builder" subtitle={`Design images for ${g?.name ?? "your group"}. Saved images go to the Group Image Library for every store in the group.`} />
      <DesignList groupId={params.id} />
      <p style={{ marginTop: 16 }}>
        <Link href={`/groups/${params.id}?tab=images`} style={{ color: "rgba(255,255,255,0.7)", fontSize: 13 }}>Group Image Library →</Link>
      </p>
    </div>
  );
}
