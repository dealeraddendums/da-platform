import { gateImageBuilderPage } from "@/lib/image-builder/page-gate";
import ImageBuilderEditor from "@/components/image-builder/Editor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Image Builder — DA Platform" };

export default async function ImageBuilderEditorPage({ params }: { params: { id: string } }) {
  await gateImageBuilderPage(`/admin/image-builder/${params.id}`);
  return <ImageBuilderEditor id={params.id} />;
}
