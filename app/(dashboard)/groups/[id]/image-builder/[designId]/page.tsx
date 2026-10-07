import { gateGroupImageBuilderPage } from "@/lib/image-builder/page-gate";
import ImageBuilderEditor from "@/components/image-builder/Editor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Image Builder — DA Platform" };

export default async function GroupImageBuilderEditorPage({ params }: { params: { id: string; designId: string } }) {
  await gateGroupImageBuilderPage(params.id, `/groups/${params.id}/image-builder/${params.designId}`);
  return <ImageBuilderEditor id={params.designId} groupId={params.id} />;
}
