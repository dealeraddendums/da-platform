// DA-CRM Inbox — support@ and feeds@ (Microsoft 365) as one three-pane inbox:
// thread list | conversation | CompanyContextRail. Sync, matching and sending
// live in lib/crm/inbox-*.ts and lib/crm/graph.ts.
import { PageHeader } from "@/components/PageHeader";
import InboxClient from "@/components/crm/InboxClient";
import { requireCrmPage } from "@/lib/crm/page-guard";

export const metadata = { title: "Inbox — DA-CRM" };

export default async function InboxPage({ searchParams }: { searchParams: { view?: string; mailbox?: string; thread?: string; q?: string } }) {
  const { userId } = await requireCrmPage("/crm/communications/inbox");
  return (
    <div>
      <PageHeader title="Inbox" subtitle="support@ and feeds@ — reply from here and it goes out from the mailbox, threaded in Outlook." />
      <InboxClient meId={userId} initial={{ view: searchParams.view ?? "open", mailbox: searchParams.mailbox ?? "", thread: searchParams.thread ?? null, q: searchParams.q ?? "" }} />
    </div>
  );
}
