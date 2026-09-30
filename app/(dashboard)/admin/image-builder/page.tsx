import { PageHeader } from "@/components/PageHeader";
import { gateImageBuilderPage } from "@/lib/image-builder/page-gate";
import DesignList from "@/components/image-builder/DesignList";

export const dynamic = "force-dynamic";
export const metadata = { title: "Image Builder — DA Platform" };

export default async function ImageBuilderPage() {
  await gateImageBuilderPage("/admin/image-builder");
  return (
    <div>
      <PageHeader
        title="Image Builder"
        subtitle="Design Image Library images in the platform, then save the rendered PNG to the library."
      />
      <DesignList />
    </div>
  );
}
