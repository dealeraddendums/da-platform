// DA-CRM (staff only). The dashboard layout above supplies the chrome; the
// Sidebar switches to the CRM nav on /crm routes. This gate keeps every /crm
// page behind super_admin + the 'crm' staff permission.
import { requireCrmPage } from "@/lib/crm/page-guard";

export const dynamic = "force-dynamic";

export default async function CrmLayout({ children }: { children: React.ReactNode }) {
  await requireCrmPage("/crm");
  return <>{children}</>;
}
