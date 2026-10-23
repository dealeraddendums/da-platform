// DA-CRM Communications → Feeds: the feed-order queue (Manual / Free →
// Automatic upgrades). Logic in lib/crm/feeds/*; runbook in CLAUDE.md → DA-CRM → Feeds.
import { PageHeader } from "@/components/PageHeader";
import FeedsQueueClient from "@/components/crm/FeedsQueueClient";
import { requireCrmPage } from "@/lib/crm/page-guard";

export const metadata = { title: "Feeds — DA-CRM" };

export default async function FeedsPage({ searchParams }: { searchParams: { view?: string; order?: string } }) {
  const { userId } = await requireCrmPage("/crm/communications/feeds");
  return (
    <div>
      <PageHeader title="Feeds" subtitle="Automatic inventory feed orders — requests and approvals go out from feeds@, and the Feed ID comes back the same way." />
      <FeedsQueueClient meId={userId} initialView={searchParams.view ?? "mine"} initialOrder={searchParams.order ?? null} />
    </div>
  );
}
