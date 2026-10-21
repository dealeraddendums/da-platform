// DA-CRM Communications → Templates. Everyone can browse, preview (filled for
// a real company / contact, with their own signature) and use templates;
// crm_admin creates, edits, archives and imports from HubSpot.
import { PageHeader } from "@/components/PageHeader";
import TemplatesClient from "@/components/crm/TemplatesClient";
import { requireCrmPage } from "@/lib/crm/page-guard";

export const metadata = { title: "Templates — DA-CRM" };

export default async function CrmTemplatesPage() {
  const { perms } = await requireCrmPage("/crm/communications/templates");
  return (
    <div>
      <PageHeader title="Email templates" subtitle="Reusable emails with variables that fill in from the company, contact and sender. Your signature is added to every email automatically." />
      <TemplatesClient canEdit={perms.crmAdmin} />
    </div>
  );
}
