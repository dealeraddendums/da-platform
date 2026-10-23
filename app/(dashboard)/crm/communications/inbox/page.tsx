// DA-CRM Inbox — support@ and feeds@ (Microsoft 365) as one three-pane inbox:
// thread list | conversation | CompanyContextRail. Sync, matching and sending
// live in lib/crm/inbox-*.ts and lib/crm/graph.ts.
import InboxClient from "@/components/crm/InboxClient";
import { requireCrmPage } from "@/lib/crm/page-guard";

export const metadata = { title: "Inbox — DA-CRM" };

export default async function InboxPage({ searchParams }: { searchParams: { view?: string; mailbox?: string; thread?: string; q?: string } }) {
  const { userId } = await requireCrmPage("/crm/communications/inbox");
  return (
    <div>
      <InboxClient meId={userId} initial={{ view: searchParams.view ?? "open", mailbox: searchParams.mailbox ?? "", thread: searchParams.thread ?? null, q: searchParams.q ?? "" }} />
    </div>
  );
}
