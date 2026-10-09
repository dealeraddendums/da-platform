import { gateDealerImageBuilderPage } from "@/lib/image-builder/page-gate";
import ImageBuilderEditor from "@/components/image-builder/Editor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Image Builder — DA Platform" };

export default async function DealerImageBuilderEditorPage({ params }: { params: { designId: string } }) {
  await gateDealerImageBuilderPage(`/image-builder/${params.designId}`);
  return <ImageBuilderEditor id={params.designId} dealerScope />;
}
