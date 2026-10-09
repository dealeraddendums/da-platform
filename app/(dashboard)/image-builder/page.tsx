import { PageHeader } from "@/components/PageHeader";
import { gateDealerImageBuilderPage } from "@/lib/image-builder/page-gate";
import DesignList from "@/components/image-builder/DesignList";

export const dynamic = "force-dynamic";
export const metadata = { title: "Image Builder — DA Platform" };

// Dealer Image Builder (2026-10-09): the same tool as the Group Image Builder,
// scoped to the session's dealer (?dealer=1 on every API call — the dealer is
// never named by the client). Saved images go to that dealer's My Images.
export default async function DealerImageBuilderPage() {
  const { dealerName } = await gateDealerImageBuilderPage("/image-builder");
  return (
    <div>
      <PageHeader title="Image Builder" subtitle={`Design images for ${dealerName}. Saved images go to My Images, ready to use as backgrounds and images in the Builder.`} />
      <DesignList dealerScope />
    </div>
  );
}
